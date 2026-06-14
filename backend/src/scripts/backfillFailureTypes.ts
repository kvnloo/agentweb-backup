/**
 * Backfill `dimensions.failureType` onto historical agent_tool_failed events in
 * the loop events table, using the same classifier the recorder now applies to
 * new failures (utils/toolFailureType). Lets the scorecard run off failure TYPE
 * across the existing history, not just events recorded after the wiring shipped.
 *
 * Dry-run (default): scans, classifies, prints the distribution, writes nothing.
 *   npx ts-node src/scripts/backfillFailureTypes.ts
 * Apply:
 *   npx ts-node src/scripts/backfillFailureTypes.ts --apply
 *
 * Idempotent: a ConditionExpression skips any event already tagged, so re-runs
 * are safe and only fill gaps. Additive — only ever adds one nested attribute.
 */
import { DynamoDB } from 'aws-sdk';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { EVT_TOOL_FAILED } from '../loops/instances/agent-mode/eventTypes';
import { classifyToolFailureType } from '../utils/toolFailureType';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const APPLY = process.argv.includes('--apply');
// --force re-tags events that already carry a failureType (use after tuning the
// classifier). Without it the run only fills gaps (the original idempotent path).
const FORCE = process.argv.includes('--force');

async function main(): Promise<void> {
  let lastKey: DynamoDB.DocumentClient.Key | undefined;
  let failedEvents = 0;
  let tagged = 0;
  let alreadyTagged = 0;
  let changed = 0;
  const distribution: Record<string, number> = {};

  do {
    const res = await doc
      .scan({
        TableName: LOOP_EVENTS_TABLE,
        FilterExpression: '#et = :failed',
        ExpressionAttributeNames: { '#et': 'eventType' },
        ExpressionAttributeValues: { ':failed': EVT_TOOL_FAILED },
        ExclusiveStartKey: lastKey,
      })
      .promise();

    for (const item of res.Items || []) {
      failedEvents++;
      const dims = (item.dimensions || {}) as Record<string, unknown>;
      const existing = typeof dims.failureType === 'string' ? dims.failureType : undefined;
      const ft = classifyToolFailureType(dims.errorClass as string, dims.errorMessage as string);
      distribution[ft] = (distribution[ft] || 0) + 1;
      if (existing && existing !== ft) changed++;

      if (existing && !FORCE) {
        alreadyTagged++;
        continue;
      }
      if (!APPLY) continue;

      try {
        await doc
          .update({
            TableName: LOOP_EVENTS_TABLE,
            Key: { loopId: item.loopId, tsSession: item.tsSession },
            UpdateExpression: 'SET dimensions.#ft = :v',
            // gap-fill keeps the idempotent guard; --force overwrites unconditionally
            ...(FORCE ? {} : { ConditionExpression: 'attribute_exists(dimensions) AND attribute_not_exists(dimensions.#ft)' }),
            ExpressionAttributeNames: { '#ft': 'failureType' },
            ExpressionAttributeValues: { ':v': ft },
          })
          .promise();
        tagged++;
      } catch (err) {
        if ((err as { code?: string }).code === 'ConditionalCheckFailedException') {
          alreadyTagged++;
        } else {
          throw err;
        }
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  console.log(
    JSON.stringify(
      { mode: `${APPLY ? 'apply' : 'dry-run'}${FORCE ? ' (force)' : ''}`, table: LOOP_EVENTS_TABLE, failedEvents, tagged, alreadyTagged, changedCategory: changed, distribution },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('[backfillFailureTypes] failed:', e);
  process.exit(1);
});
