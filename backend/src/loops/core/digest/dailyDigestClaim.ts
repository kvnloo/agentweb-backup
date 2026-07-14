import { LOOP_EVENTS_TABLE } from '../sensors/eventTableEventSource';
import type { DynamoAttributeMap, DynamoPort } from '../ports';

export interface DailyDigestClaimArgs {
  loopId: string;
  digestDate: string;
  slackUserId: string;
  runId: string;
  now?: Date;
}

export interface DailyDigestClaimItem {
  loopId: string;
  tsSession: string;
  eventType: 'digest_posted';
  subjectId: string;
  ts: string;
  dimensions: {
    digestDate: string;
    loopId: string;
    runId: string;
    slackUserId: string;
  };
}

export function buildDailyDigestClaimItem(args: DailyDigestClaimArgs): DailyDigestClaimItem {
  const now = args.now ?? new Date();
  return {
    loopId: `${args.loopId}#daily-digest`,
    tsSession: args.digestDate,
    eventType: 'digest_posted',
    subjectId: args.slackUserId,
    ts: now.toISOString(),
    dimensions: {
      digestDate: args.digestDate,
      loopId: args.loopId,
      runId: args.runId,
      slackUserId: args.slackUserId,
    },
  };
}

export async function claimLoopDailyDigestPost(
  dynamo: DynamoPort,
  args: DailyDigestClaimArgs,
): Promise<boolean> {
  const item = buildDailyDigestClaimItem(args) as unknown as DynamoAttributeMap;
  const key = { loopId: item.loopId, tsSession: item.tsSession } as DynamoAttributeMap;

  if (dynamo.putItemIfAbsent) {
    return dynamo.putItemIfAbsent(LOOP_EVENTS_TABLE, item, ['loopId', 'tsSession']);
  }

  const existing = await dynamo.getItem(LOOP_EVENTS_TABLE, key);
  if (existing) return false;
  await dynamo.putItem(LOOP_EVENTS_TABLE, item);
  return true;
}
