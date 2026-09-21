/**
 * ENG-926 §F — storage for send-side CAPI identity-key coverage.
 *
 * Kept separate from `metaCapiKeyCoverage.ts` so the unit tests of the aggregation never
 * pull in the DynamoDB client — the same split `metaAttributionCoverage` uses.
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────────────
 *
 *   HASH  pixelId  "1430870751246428"
 *   RANGE sk       "2026-08-19#Lead"      <date>#<eventName>
 *
 *   sends                    12
 *   em / ph / fn / ln        12 / 0 / 11 / 11
 *   fbc / fbp                9 / 7
 *   client_ip_address        3
 *   client_user_agent        3
 *   updatedAt
 *
 * One item per pixel, per UTC day, per event name. Roughly 16k items a year across the
 * whole fleet, so no TTL and no archival tier is warranted.
 *
 * `date` and `eventName` are NOT stored: both are derivable from `sk`, and a derived value
 * cannot drift from the key that indexes it. `updatedAt` is stored because it is the only
 * way to tell a bucket that stopped being written from one that was never written.
 */

import AWS from 'aws-sdk';
import {
  CAPI_IDENTITY_KEYS,
  parseCoverageSortKey,
  type CapiKeyCoverageRow,
} from './metaCapiKeyCoverage';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
export const CAPI_KEY_COVERAGE_TABLE = `${TABLE_PREFIX}AW-MetaCapiKeyCoverage`;

const dynamodb = new AWS.DynamoDB.DocumentClient();

/** One page per round trip. A single pixel-month is ~90 items, so this is one call. */
const PAGE_SIZE = 500;

/**
 * Atomically increment the counters for one accepted send.
 *
 * `ADD` rather than read-modify-write: many conversions can land in the same bucket in the
 * same second, and a read-then-put would silently lose all but the last. `ADD` on a missing
 * attribute creates it at the increment value, so a bucket needs no initialisation and a
 * newly-added identity key needs no migration.
 *
 * ⚠ Throws on failure BY DESIGN. The never-throw contract belongs to `recordCapiKeySend`,
 * which wraps this — putting it here too would hide a real, fixable storage fault from the
 * warning that is supposed to surface it.
 */
export async function addCapiKeyCounters(args: {
  pixelId: string;
  sortKey: string;
  increments: Record<string, number>;
}): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, any> = { ':updatedAt': new Date().toISOString() };
  const addClauses: string[] = [];

  for (const [field, amount] of Object.entries(args.increments)) {
    // Placeholders for every field: `sends` is safe today, but the identity keys are a
    // moving list and DynamoDB's reserved-word set is long enough not to audit by eye.
    const nameRef = `#${field}`;
    const valueRef = `:${field}`;
    names[nameRef] = field;
    values[valueRef] = amount;
    addClauses.push(`${nameRef} ${valueRef}`);
  }

  names['#updatedAt'] = 'updatedAt';

  await dynamodb
    .update({
      TableName: CAPI_KEY_COVERAGE_TABLE,
      Key: { pixelId: args.pixelId, sk: args.sortKey },
      UpdateExpression: `ADD ${addClauses.join(', ')} SET #updatedAt = :updatedAt`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
    .promise();
}

/**
 * Every row for one pixel from `oldestDate` onward.
 *
 * The range condition compares against the bare date rather than a full sort key, which
 * works because `"2026-07-20" < "2026-07-20#Lead"` lexically — so the bound includes every
 * event name on that day without having to enumerate them.
 *
 * Pages to exhaustion. A truncated read would under-report coverage, and under-reported
 * coverage reads as a tracking regression that is not happening.
 */
export async function queryCapiKeyCoverageRows(
  pixelId: string,
  oldestDate: string,
): Promise<CapiKeyCoverageRow[]> {
  const rows: CapiKeyCoverageRow[] = [];
  let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await dynamodb
      .query({
        TableName: CAPI_KEY_COVERAGE_TABLE,
        KeyConditionExpression: 'pixelId = :p AND sk >= :oldest',
        ExpressionAttributeValues: { ':p': pixelId, ':oldest': oldestDate },
        Limit: PAGE_SIZE,
        ExclusiveStartKey: startKey,
      })
      .promise();

    for (const item of result.Items || []) {
      const { date, eventName } = parseCoverageSortKey(String(item.sk));
      const row: CapiKeyCoverageRow = {
        pixelId: String(item.pixelId),
        date,
        eventName,
        sends: Number(item.sends) || 0,
      };
      for (const key of CAPI_IDENTITY_KEYS) {
        if (item[key] !== undefined) (row as any)[key] = Number(item[key]) || 0;
      }
      rows.push(row);
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return rows;
}
