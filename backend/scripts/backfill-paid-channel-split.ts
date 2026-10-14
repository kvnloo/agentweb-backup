/**
 * Backfill the 2.1.0 paid channel split onto stored tracker sessions in AW-Leads.
 *
 * Rows classified before 2.1.0 with customFields.trafficType = 'paid' and channelKey
 * 'google_search' / 'youtube' are relabelled 'Google Ads' / 'YouTube Ads' via the same pure
 * splitPaidChannel() used at ingest. Organic rows and every other channel are untouched.
 * The previous values are kept in customFields.channelPreSplit / channelKeyPreSplit, so the
 * change is reversible (--revert). Writes are conditional on the row still holding the old value.
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-paid-channel-split.ts                    # dry-run (counts only)
 *   npx ts-node backend/scripts/backfill-paid-channel-split.ts --list=<listId>    # scope to one list
 *   npx ts-node backend/scripts/backfill-paid-channel-split.ts --apply            # write
 *   npx ts-node backend/scripts/backfill-paid-channel-split.ts --revert --apply   # undo
 * Env: NODE_ENV=development -> Dev-AW-Leads; otherwise AW-Leads.
 */
/* eslint-disable no-console */
import AWS from 'aws-sdk';
import { splitPaidChannel, PAID_CHANNEL_SPLIT } from '../src/utils/trafficSource';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REVERT = argv.includes('--revert');
const LIST_FILTER = argv.find((a) => a.startsWith('--list='))?.split('=')[1] ?? null;
const LEADS_TABLE = `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-Leads`;
const ddb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });

async function main(): Promise<void> {
  const counts: Record<string, number> = {};
  const perList: Record<string, number> = {};
  let scanned = 0;
  let written = 0;
  let key: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await ddb
      .scan({
        TableName: LEADS_TABLE,
        ExclusiveStartKey: key,
        ProjectionExpression: 'listId, leadId, customFields.trafficType, customFields.channel, customFields.channelKey, customFields.channelKeyPreSplit, customFields.channelPreSplit',
        FilterExpression: REVERT
          ? 'attribute_exists(customFields.channelKeyPreSplit)'
          : 'customFields.trafficType = :paid AND (customFields.channelKey IN (:g, :y) OR (attribute_not_exists(customFields.channelKey) AND customFields.channel IN (:gn, :yn)))',
        ExpressionAttributeValues: REVERT ? undefined : { ':paid': 'paid', ':g': 'google_search', ':y': 'youtube', ':gn': 'Google Search', ':yn': 'YouTube' },
      })
      .promise();
    scanned += page.ScannedCount ?? 0;
    for (const item of page.Items ?? []) {
      if (LIST_FILTER && item.listId !== LIST_FILTER) continue;
      const cf = item.customFields ?? {};
      // V1 rows (pre-2.0) carry only the channel name; derive the key the classifier would have set.
      const hadKey = typeof cf.channelKey === 'string';
      if (!hadKey && !REVERT) cf.channelKey = cf.channel === 'YouTube' ? 'youtube' : 'google_search';
      const label = REVERT ? `${cf.channelKey} -> ${cf.channelKeyPreSplit}` : `${cf.channelKey} -> ${PAID_CHANNEL_SPLIT[cf.channelKey]?.key}`;
      counts[label] = (counts[label] ?? 0) + 1;
      perList[item.listId] = (perList[item.listId] ?? 0) + 1;
      if (!APPLY) continue;
      const params = REVERT && cf.channelKeyPreSplit === ''
        ? {
            UpdateExpression: 'SET customFields.channel = :oc REMOVE customFields.channelKey, customFields.channelPreSplit, customFields.channelKeyPreSplit',
            ConditionExpression: 'customFields.channelKey = :cur',
            ExpressionAttributeValues: { ':oc': cf.channelPreSplit, ':cur': cf.channelKey },
          }
        : REVERT
        ? {
            UpdateExpression: 'SET customFields.channel = :oc, customFields.channelKey = :ok REMOVE customFields.channelPreSplit, customFields.channelKeyPreSplit',
            ConditionExpression: 'customFields.channelKey = :cur',
            ExpressionAttributeValues: { ':oc': cf.channelPreSplit, ':ok': cf.channelKeyPreSplit, ':cur': cf.channelKey },
            // channelKeyPreSplit = '' marks a V1 row that had no channelKey; revert restores that by removing it.
          }
        : (() => {
            const next = splitPaidChannel(cf.channel, cf.channelKey, true);
            return {
              UpdateExpression: 'SET customFields.channel = :nc, customFields.channelKey = :nk, customFields.channelPreSplit = :oc, customFields.channelKeyPreSplit = :okStored',
              ConditionExpression: hadKey
                ? 'customFields.channelKey = :ok AND customFields.trafficType = :paid'
                : 'attribute_not_exists(customFields.channelKey) AND customFields.channel = :oc AND customFields.trafficType = :paid',
              ExpressionAttributeValues: {
                ':nc': next.channel, ':nk': next.channelKey, ':oc': cf.channel, ':paid': 'paid',
                ':okStored': hadKey ? cf.channelKey : '',
                ...(hadKey ? { ':ok': cf.channelKey } : {}),
              },
            };
          })();
      try {
        await ddb.update({ TableName: LEADS_TABLE, Key: { listId: item.listId, leadId: item.leadId }, ...params }).promise();
        written++;
      } catch (e: any) {
        if (e?.code !== 'ConditionalCheckFailedException') throw e;
      }
    }
    key = page.LastEvaluatedKey;
  } while (key);
  console.log(JSON.stringify({ table: LEADS_TABLE, mode: APPLY ? (REVERT ? 'revert' : 'apply') : 'dry-run', scanned, counts, perList, written }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
