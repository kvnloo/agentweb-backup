/**
 * AWS SDK adapters for the framework's injected ports.
 *
 * The framework's `loops/core/ports.ts` defines storage / cloud interfaces
 * without depending on any specific SDK. This file binds those interfaces to
 * the `aws-sdk` v2 client the agentweb backend already uses. Lives in
 * `loops/adapters/` (a SIBLING of `loops/core/`) so the package boundary
 * stays clean — `loops/core/` itself never imports from this file.
 *
 * Production code wires the orchestrator with these adapters; tests + the
 * smoke harness use the in-memory equivalents directly.
 */

import AWS from 'aws-sdk';
import type {
  S3Port,
  S3GetObjectResult,
  S3PutObjectResult,
  DynamoPort,
  DynamoAttributeMap,
  DynamoQueryParams,
  DynamoQueryResult,
  SlackPort,
  SlackMessageHandle,
  ClockPort,
  LoggerPort,
  BedrockPort,
  LoopPorts,
} from '../core/ports';
import { WebClient } from '@slack/web-api';

// ---------------------------------------------------------------------------
// S3 adapter — versioning-aware get + put
// ---------------------------------------------------------------------------

export function awsS3Adapter(region = process.env.AWS_REGION || 'us-west-2'): S3Port {
  const s3 = new AWS.S3({ region });
  return {
    async getObject(bucket: string, key: string): Promise<S3GetObjectResult> {
      const r = await s3.getObject({ Bucket: bucket, Key: key }).promise();
      return {
        body: r.Body?.toString('utf-8') ?? '',
        versionId: r.VersionId ?? '',
      };
    },
    async putObject(bucket, key, body, contentType): Promise<S3PutObjectResult> {
      const r = await s3
        .putObject({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType ?? 'application/json',
        })
        .promise();
      return { versionId: r.VersionId ?? '' };
    },
  };
}

// ---------------------------------------------------------------------------
// DynamoDB adapter — get + put + paginated query
// ---------------------------------------------------------------------------

export function awsDynamoAdapter(region = process.env.AWS_REGION || 'us-west-2'): DynamoPort {
  const doc = new AWS.DynamoDB.DocumentClient({ region });
  return {
    async putItem(tableName: string, item: DynamoAttributeMap): Promise<void> {
      await doc.put({ TableName: tableName, Item: item as Record<string, unknown> }).promise();
    },
    async putItemIfAbsent(
      tableName: string,
      item: DynamoAttributeMap,
      keyAttributes: readonly string[],
    ): Promise<boolean> {
      try {
        await doc
          .put({
            TableName: tableName,
            Item: item as Record<string, unknown>,
            ConditionExpression: keyAttributes
              .map((attr) => `attribute_not_exists(#${attr})`)
              .join(' AND '),
            ExpressionAttributeNames: Object.fromEntries(
              keyAttributes.map((attr) => [`#${attr}`, attr]),
            ),
          })
          .promise();
        return true;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: unknown }).code === 'ConditionalCheckFailedException'
        ) {
          return false;
        }
        throw err;
      }
    },
    async getItem(tableName: string, key: DynamoAttributeMap): Promise<DynamoAttributeMap | null> {
      const r = await doc.get({ TableName: tableName, Key: key as Record<string, unknown> }).promise();
      return (r.Item as DynamoAttributeMap | undefined) ?? null;
    },
    async query(params: DynamoQueryParams): Promise<DynamoQueryResult> {
      const out: DynamoAttributeMap[] = [];
      let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
      do {
        const r = await doc
          .query({
            TableName: params.tableName,
            IndexName: params.indexName,
            KeyConditionExpression: params.keyConditionExpression,
            FilterExpression: params.filterExpression,
            ExpressionAttributeNames: params.expressionAttributeNames as Record<string, string> | undefined,
            ExpressionAttributeValues: params.expressionAttributeValues as Record<string, unknown> | undefined,
            Limit: params.limit,
            ExclusiveStartKey: lastKey,
          })
          .promise();
        out.push(...((r.Items ?? []) as DynamoAttributeMap[]));
        lastKey = r.LastEvaluatedKey;
      } while (lastKey && !params.limit);
      return { items: out };
    },
  };
}

// ---------------------------------------------------------------------------
// Slack adapter — wraps @slack/web-api WebClient (same library the backend
// already uses for slackService.ts + onboardingLoopApproval.ts).
// ---------------------------------------------------------------------------

let slackClientSingleton: WebClient | null = null;

function getSlackClient(): WebClient {
  if (slackClientSingleton) return slackClientSingleton;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN env var required for Slack adapter');
  slackClientSingleton = new WebClient(token);
  return slackClientSingleton;
}

/**
 * Loop Slack egress gate. Side effects that leave the system (DMs to humans)
 * must be structurally impossible outside prod, independent of the per-loop
 * enable flag — a dev/test backend with a loop flag flipped on must NOT be able
 * to DM real people via the shared bot token (the "Emma Dev yaps" incident,
 * 2026-06-13). Overridable for intentional dev testing with
 * LOOP_SLACK_ALLOW_NONPROD=true.
 */
export function shouldSuppressLoopSlackPost(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NODE_ENV === 'production') return false;
  return env.LOOP_SLACK_ALLOW_NONPROD !== 'true';
}

export function awsSlackAdapter(): SlackPort {
  return {
    async postMessage(channelOrUserId: string, markdown: string): Promise<SlackMessageHandle> {
      if (shouldSuppressLoopSlackPost()) {
        console.log(
          `[loop-slack] suppressed post to ${channelOrUserId} (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}; set LOOP_SLACK_ALLOW_NONPROD=true to allow non-prod loop DMs)`,
        );
        return { channel: channelOrUserId, ts: '' };
      }
      const r = await getSlackClient().chat.postMessage({
        channel: channelOrUserId,
        text: markdown,
        mrkdwn: true,
      });
      return { channel: (r.channel as string) ?? channelOrUserId, ts: (r.ts as string) ?? '' };
    },
  };
}

// ---------------------------------------------------------------------------
// Bedrock adapter — minimal Claude invocation. Used by future Generator /
// Critic agents (not the current synchronous orchestrator path).
// ---------------------------------------------------------------------------

export function awsBedrockAdapter(_region = process.env.AWS_REGION || 'us-west-2'): BedrockPort {
  // Lazy import so tests that don't need Bedrock don't pay the cold-start
  // cost of loading the SDK module. Implementation deferred until Generator
  // + Critic agents are wired into the cron path.
  return {
    async invoke(call) {
      throw new Error(
        `[awsBedrockAdapter] Bedrock invocation not yet wired in production cron path. ` +
          `Called with model="${call.model}". Implement via @aws-sdk/client-bedrock-runtime when Generator/Critic agents land.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Clock + Logger — trivial real impls
// ---------------------------------------------------------------------------

export const realClock: ClockPort = { now: () => new Date() };

export const consoleLogger: LoggerPort = {
  log(level, message, context) {
    if (level === 'debug' && process.env.LOOPS_DEBUG !== '1') return;
    const ctxStr = context ? ` ${JSON.stringify(context)}` : '';
    if (level === 'error' || level === 'warn') {
      console.error(`[loops:${level}] ${message}${ctxStr}`);
    } else {
      console.log(`[loops:${level}] ${message}${ctxStr}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Convenience factory — full production LoopPorts bundle
// ---------------------------------------------------------------------------

export function productionLoopPorts(): LoopPorts {
  return {
    s3: awsS3Adapter(),
    dynamo: awsDynamoAdapter(),
    bedrock: awsBedrockAdapter(),
    slack: awsSlackAdapter(),
    clock: realClock,
    logger: consoleLogger,
  };
}
