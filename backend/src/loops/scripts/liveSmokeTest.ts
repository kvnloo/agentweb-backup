/**
 * Live-DDB smoke test for the closed-loop framework.
 *
 * Reads events DIRECTLY from the production Dev-AW-LoopEvents DynamoDB
 * table via the eventTableEventSource sensor + a real AWS SDK adapter.
 * Runs the orchestrator and reports what rules fired against whatever's
 * actually in the table.
 *
 * Run with:
 *   cd backend && npx ts-node src/loops/scripts/liveSmokeTest.ts
 *
 * Optional flag: --seed-fake-events
 *   Puts 10 synthetic events into Dev-AW-LoopEvents BEFORE running the loop
 *   so you can verify the sensor → policy → tools chain end-to-end against
 *   real DDB without waiting for production traffic. Cleans up after itself.
 */

import AWS from 'aws-sdk';
import { runLoop } from '../core/orchestrator';
import type { LoopPorts, S3Port, DynamoPort, BedrockPort, SlackPort, ClockPort, LoggerPort, DynamoAttributeMap, DynamoQueryParams, DynamoQueryResult } from '../core/ports';
import { _resetRegistryForTesting, registerLoop, registerSensor, registerRuleSet, registerTools, registerLearningStore } from '../index';
import { aiEvalManifest } from '../instances/ai-eval-funnel/manifest';
import { aiEvalRules } from '../instances/ai-eval-funnel/rules';
import { EventTableEventSource, LOOP_EVENTS_TABLE, eventToItem } from '../core/sensors/eventTableEventSource';
import { DslRuleSet } from '../core/policy/dslRuleSet';
import { SpecOutputTool } from '../core/tools/specOutputTool';
import { InMemoryLearningStore } from '../core/learning/inMemoryLearningStore';
import { asLoopId, asSubjectId } from '../core/types';
import type { NormalizedEvent } from '../core/types';

const REGION = process.env.AWS_REGION || 'us-west-2';
const awsDynamo = new AWS.DynamoDB.DocumentClient({ region: REGION });

// Real AWS adapter that implements the framework's DynamoPort.
const realDynamoPort: DynamoPort = {
  async putItem(tableName: string, item: DynamoAttributeMap): Promise<void> {
    await awsDynamo.put({ TableName: tableName, Item: item as Record<string, unknown> }).promise();
  },
  async getItem(tableName: string, key: DynamoAttributeMap): Promise<DynamoAttributeMap | null> {
    const r = await awsDynamo.get({ TableName: tableName, Key: key as Record<string, unknown> }).promise();
    return (r.Item as DynamoAttributeMap | undefined) ?? null;
  },
  async query(params: DynamoQueryParams): Promise<DynamoQueryResult> {
    const out: DynamoQueryResult = { items: [] };
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const r = await awsDynamo
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
      (out.items as DynamoAttributeMap[]).push(...((r.Items ?? []) as DynamoAttributeMap[]));
      lastKey = r.LastEvaluatedKey;
    } while (lastKey && !params.limit);
    return out;
  },
};

// Stubbed ports the orchestrator doesn't actually call in this smoke run.
const noopS3: S3Port = {
  async getObject() { throw new Error('S3 not used'); },
  async putObject() { return { versionId: 'smoke' }; },
};
const noopBedrock: BedrockPort = {
  async invoke() { return { text: '[smoke-stub]', inputTokens: 0, outputTokens: 0, costUsd: 0 }; },
};
const noopSlack: SlackPort = {
  async postMessage() { return { channel: 'smoke', ts: 'smoke' }; },
};
const realClock: ClockPort = { now: () => new Date() };
const stderrLogger: LoggerPort = {
  log(level, msg, ctx) {
    if (level === 'debug' && process.env.LOOPS_DEBUG !== '1') return;
    process.stderr.write(`[${level}] ${msg} ${ctx ? JSON.stringify(ctx) : ''}\n`);
  },
};
const ports: LoopPorts = { s3: noopS3, dynamo: realDynamoPort, bedrock: noopBedrock, slack: noopSlack, clock: realClock, logger: stderrLogger };

// ---------------------------------------------------------------------------
// Optional: seed fake events directly into Dev-AW-LoopEvents so we can verify
// the sensor without waiting for real traffic.
// ---------------------------------------------------------------------------

const SEED_TAG = 'live-smoke-seed';

async function seedFakeEvents(): Promise<NormalizedEvent[]> {
  const loopId = aiEvalManifest.loopId;
  const baseTs = Date.now();
  // 5 early-dippers + 2 completers + 2 failures + 1 timeout
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      subjectId: asSubjectId(`${SEED_TAG}-dipper-${i}`),
      eventType: 'landed',
      ts: new Date(baseTs - (60 + i * 30) * 60 * 1000),
      dimensions: { seed: SEED_TAG },
    });
  }
  for (let i = 0; i < 2; i++) {
    const sid = `${SEED_TAG}-completer-${i}`;
    const base = baseTs - (30 + i * 20) * 60 * 1000;
    events.push({ subjectId: asSubjectId(sid), eventType: 'landed', ts: new Date(base), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'form_submitted', ts: new Date(base + 30 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'eval_started', ts: new Date(base + 60 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'eval_completed', ts: new Date(base + 5 * 60 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'report_viewed', ts: new Date(base + 6 * 60 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'signup_clicked', ts: new Date(base + 7 * 60 * 1000), dimensions: { seed: SEED_TAG } });
  }
  for (let i = 0; i < 2; i++) {
    const sid = `${SEED_TAG}-failure-${i}`;
    const base = baseTs - (45 + i * 15) * 60 * 1000;
    events.push({ subjectId: asSubjectId(sid), eventType: 'landed', ts: new Date(base), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'form_submitted', ts: new Date(base + 30 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'eval_started', ts: new Date(base + 60 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({
      subjectId: asSubjectId(sid),
      eventType: 'eval_failed',
      ts: new Date(base + 3 * 60 * 1000),
      dimensions: {
        seed: SEED_TAG,
        errorMessage: 'Seeded failure: Playwright timed out scraping seeded-url.com after 60s',
      },
    });
  }
  {
    const sid = `${SEED_TAG}-timeout-0`;
    const base = baseTs - 90 * 60 * 1000;
    events.push({ subjectId: asSubjectId(sid), eventType: 'landed', ts: new Date(base), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'form_submitted', ts: new Date(base + 30 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({ subjectId: asSubjectId(sid), eventType: 'eval_started', ts: new Date(base + 60 * 1000), dimensions: { seed: SEED_TAG } });
    events.push({
      subjectId: asSubjectId(sid),
      eventType: 'eval_abandoned',
      ts: new Date(base + 6 * 60 * 1000),
      dimensions: { seed: SEED_TAG, elapsedMs: 300000, lastPollStatus: 'AI is generating your report...' },
    });
  }

  for (const e of events) {
    const item = eventToItem(loopId, e);
    await awsDynamo.put({ TableName: LOOP_EVENTS_TABLE, Item: item as Record<string, unknown> }).promise();
  }
  process.stderr.write(`[liveSmoke] seeded ${events.length} fake events tagged '${SEED_TAG}'\n`);
  return events;
}

async function cleanupSeededEvents(): Promise<number> {
  // Query everything for the loopId and delete items tagged with seed dimension.
  const result = await awsDynamo
    .query({
      TableName: LOOP_EVENTS_TABLE,
      KeyConditionExpression: 'loopId = :l',
      ExpressionAttributeValues: { ':l': aiEvalManifest.loopId },
    })
    .promise();
  let deleted = 0;
  for (const item of result.Items ?? []) {
    const it = item as { tsSession?: string; dimensions?: { seed?: string }; loopId?: string };
    if (it.dimensions?.seed === SEED_TAG && it.loopId && it.tsSession) {
      await awsDynamo
        .delete({ TableName: LOOP_EVENTS_TABLE, Key: { loopId: it.loopId, tsSession: it.tsSession } })
        .promise();
      deleted++;
    }
  }
  process.stderr.write(`[liveSmoke] cleaned up ${deleted} seeded events\n`);
  return deleted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const wantSeed = process.argv.includes('--seed-fake-events');
  const wantCleanup = process.argv.includes('--cleanup-only');

  if (wantCleanup) {
    const n = await cleanupSeededEvents();
    process.stdout.write(JSON.stringify({ cleanedUp: n }) + '\n');
    return;
  }

  let seededCount = 0;
  if (wantSeed) {
    const seeded = await seedFakeEvents();
    seededCount = seeded.length;
    // small pause so DDB consistency settles
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Register everything against the LIVE DDB sensor (not in-memory).
  _resetRegistryForTesting();
  const sensor = new EventTableEventSource(realDynamoPort, aiEvalManifest.loopId);
  registerSensor('aiEvalSensor', sensor);
  registerRuleSet('aiEvalRules', new DslRuleSet(aiEvalManifest.loopId, aiEvalRules) as never);
  registerTools('aiEvalSpecTool', new SpecOutputTool(aiEvalManifest.loopId) as never);
  registerLearningStore('aiEvalLearning', new InMemoryLearningStore());
  registerLoop(aiEvalManifest);

  // 30-day window
  const now = new Date();
  const window = {
    start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    end: now,
  };

  const result = await runLoop(aiEvalManifest, ports, { window });

  const report = {
    source: `LIVE ${LOOP_EVENTS_TABLE} (region ${REGION})`,
    seededFakeEventsCount: seededCount,
    eventsScannedFromDdb: result.eventsScanned,
    rulesFired: result.proposals.map((p) => ({
      ruleId: p.sourceRuleId,
      hypothesis: p.hypothesis,
      kind: p.kind,
      triggeringStats: p.triggeringStats,
    })),
    mutationCount: result.mutations.length,
    blocked: result.blocked,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (wantSeed) {
    await cleanupSeededEvents();
  }
}

main().catch((err) => {
  console.error('[liveSmoke] fatal:', err);
  process.exit(2);
});
