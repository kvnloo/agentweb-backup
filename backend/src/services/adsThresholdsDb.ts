/**
 * ENG-918 — per-account ads-threshold store: the storage half.
 *
 * Split from `adsThresholds.ts` so the precedence/clamping rules can be unit-tested without
 * pulling in the DynamoDB client — the same split `metaCapiKeyCoverage` and
 * `metaAttributionCoverage` already use.
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────────────────────
 *
 *   HASH  entityKey  "meta#1842363582956923"                <platform>#<accountId>
 *   RANGE paramKey   "creativeFatigue.frequencyCritical"
 *
 *   currentValue          3.5
 *   source                'default' | 'user' | 'learned'
 *   updatedAt             ISO
 *   learnedCooldownUntil  ISO | absent
 *   revisions             [ { value, previousValue, source, evidence, sampleSize, changedAt, changedBy } ]
 *
 * One item per ad account, per parameter — a few dozen per account at most, so no GSI and no TTL.
 * The key is the AD ACCOUNT, not the user: one account can sit on several user records, and
 * per-user thresholds would resolve differently depending on which record was read. Full
 * reasoning in `adsThresholds.ts`.
 *
 * `platform` and `accountId` are NOT stored as their own attributes: both are derivable from
 * `entityKey`, and a derived value cannot drift from the key that indexes it. Same reasoning as
 * `AW-MetaCapiKeyCoverage`'s `date`/`eventName`. `defaultValue` is not stored at all — see
 * `adsThresholds.ts`'s `buildThresholdRevert` doc comment for why that field was removed rather
 * than merely documented as untrustworthy.
 */

import AWS from 'aws-sdk';
import { paginatedQuery } from '../utils/dynamoPagination';
import {
  buildThresholdEntityKey,
  parseThresholdEntityKey,
  type AdsThreshold,
  type AdsPlatform,
  type ThresholdRevision,
} from './adsThresholds';
import { TABLE_PREFIX } from '../config/constants';

// ⚠ Matches every other table in this codebase, and inherits the same FAIL-OPEN hazard: an unset
// or misspelled NODE_ENV resolves to the PRODUCTION table rather than erroring. Kept consistent
// deliberately — a table whose prefix rule differs from all 60+ others is the more dangerous
// surprise. Any SCRIPT that writes here should assert NODE_ENV explicitly rather than rely on it.
export const ADS_THRESHOLDS_TABLE = `${TABLE_PREFIX}AW-AdsThresholds`;

const dynamodb = new AWS.DynamoDB.DocumentClient();

/** One page per round trip. An account holds a few dozen parameters, so this is always one call. */
const PAGE_SIZE = 200;

/** Raised when a compare-and-swap write loses to a concurrent writer. */
export class ThresholdConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThresholdConflictError';
  }
}

/** Raised when a stored item cannot be trusted — e.g. a non-finite currentValue. */
export class ThresholdCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThresholdCorruptionError';
  }
}

/**
 * Convert a raw DynamoDB item into an `AdsThreshold`, or throw if it cannot be trusted.
 *
 * `Number(item.currentValue)` on a missing or malformed attribute silently produces `NaN`
 * rather than an error, and `NaN` defeats validation the same way it does everywhere else in
 * this module: every bounds/movement-cap comparison against `NaN` is `false`, so a corrupted
 * item would silently bypass every guarantee this store exists to provide. Throwing surfaces
 * the corruption immediately — the route layer's existing `try/catch` turns it into a clear
 * logged 500 rather than a silently-wrong 200.
 */
/** Exported for direct unit testing — pure, touches no AWS SDK state. */
export function itemToParameter(item: AWS.DynamoDB.DocumentClient.AttributeMap): AdsThreshold | null {
  if (!item || typeof item !== 'object') throw new ThresholdCorruptionError('Invalid parameter item');
  if (item.revisions != null && (!Array.isArray(item.revisions) || !item.revisions.every((r: any) =>
    r && typeof r === 'object' && typeof r.evidence === 'string' && r.evidence.length <= 2000 &&
    typeof r.changedBy === 'string' && r.changedBy.length > 0 && typeof r.changedAt === 'string' && Number.isFinite(Date.parse(r.changedAt)) &&
    ['default', 'user', 'learned'].includes(r.source) && typeof r.value === 'number' && Number.isFinite(r.value) &&
    (r.previousValue == null || (typeof r.previousValue === 'number' && Number.isFinite(r.previousValue))) &&
    (r.sampleSize == null || (Number.isInteger(r.sampleSize) && r.sampleSize >= 0))))) {
    throw new ThresholdCorruptionError('Invalid parameter revision');
  }

  const parsed = parseThresholdEntityKey(String(item.entityKey));
  if (!parsed) return null;

  // `item.currentValue == null` is checked explicitly, separately from Number.isFinite: `Number(null)`
  // is `0`, not `NaN` — a missing/null attribute would otherwise convert to a plausible-looking
  // real number instead of failing the finiteness check below.
  if (!((typeof item.currentValue === 'number' || (typeof item.currentValue === 'string' && item.currentValue.trim() !== '')) && Number.isFinite(Number(item.currentValue)))) {
    throw new ThresholdCorruptionError(
      `${ADS_THRESHOLDS_TABLE} item '${item.entityKey}'/'${item.paramKey}' has a non-finite ` +
        `currentValue (${String(item.currentValue)})`,
    );
  }
  const currentValue = Number(item.currentValue);

  // `source` gates the precedence rule (a `learned` write may never overwrite a `user` one) —
  // the ONE guarantee this whole store exists for. A corrupted or blank `source` attribute would
  // cast to a string that matches neither 'user' nor 'learned' nor 'default', so
  // `currentSource === 'user'` in evaluateThresholdWrite would silently read as false and let a
  // learned write overwrite what was actually a human-set value. Validated the same way
  // currentValue is: an unrecognised value throws rather than being trusted.
  if (item.source !== 'default' && item.source !== 'user' && item.source !== 'learned') {
    throw new ThresholdCorruptionError(
      `${ADS_THRESHOLDS_TABLE} item '${item.entityKey}'/'${item.paramKey}' has an invalid ` +
        `source (${String(item.source)})`,
    );
  }

  return {
    accountId: parsed.accountId,
    platform: parsed.platform,
    paramKey: String(item.paramKey),
    currentValue,
    source: item.source,
    updatedAt: String(item.updatedAt),
    learnedCooldownUntil: item.learnedCooldownUntil ? String(item.learnedCooldownUntil) : null,
    revisions: Array.isArray(item.revisions) ? (item.revisions as ThresholdRevision[]) : [],
  };
}

export async function getThreshold(
  platform: AdsPlatform,
  accountId: string,
  paramKey: string,
): Promise<AdsThreshold | null> {
  const result = await dynamodb
    .get({
      TableName: ADS_THRESHOLDS_TABLE,
      Key: { entityKey: buildThresholdEntityKey(platform, accountId), paramKey },
    })
    .promise();

  return result.Item ? itemToParameter(result.Item) : null;
}

/**
 * Every stored parameter for one ad account.
 *
 * Pages to exhaustion via the shared `paginatedQuery` helper (also used by 12+ other services in
 * this codebase) rather than a one-off loop, so a future pagination fix lands here automatically
 * instead of needing to be found and re-applied by hand. A short read would silently drop
 * overrides and resolve those parameters back to their defaults — which reads as "nobody ever
 * set anything" rather than as a failed read, and would quietly undo a customer's configuration
 * at the point of use.
 */
export async function getThresholdsForAccount(
  platform: AdsPlatform,
  accountId: string,
): Promise<AdsThreshold[]> {
  const items = await paginatedQuery<AWS.DynamoDB.DocumentClient.AttributeMap>(dynamodb, {
    TableName: ADS_THRESHOLDS_TABLE,
    KeyConditionExpression: 'entityKey = :e',
    ExpressionAttributeValues: { ':e': buildThresholdEntityKey(platform, accountId) },
    Limit: PAGE_SIZE,
  });

  const rows: AdsThreshold[] = [];
  for (const item of items) {
    const parameter = itemToParameter(item);
    if (parameter) rows.push(parameter);
  }
  return rows;
}

/**
 * Store a parameter, refusing the write if another writer moved it first.
 *
 * Compare-and-swap on `updatedAt` rather than a bare put. Two writers matter here and they are
 * not hypothetical: a person editing a threshold in the portal and a learning loop fitting the
 * same one on its daily tick — and, because the key is the ad account, two people on different
 * user records who both reach that account. A last-write-wins put would let one land on top of
 * another with no trace, which is precisely what the source-precedence rule exists to prevent;
 * enforcing precedence in the pure layer while allowing a blind overwrite in the storage layer
 * would leave the guarantee half-implemented.
 *
 * `expectedUpdatedAt` is null for a first write, which asserts the item does not yet exist.
 *
 * ⚠ Throws `ThresholdConflictError` on a lost race BY DESIGN. The caller must re-read and
 * re-evaluate: the losing value was computed against a baseline that no longer holds, so
 * retrying it blindly would apply a movement cap measured from a stale current value.
 */
export async function putThreshold(
  parameter: AdsThreshold,
  expectedUpdatedAt: string | null,
): Promise<void> {
  const item: Record<string, unknown> = {
    entityKey: buildThresholdEntityKey(parameter.platform, parameter.accountId),
    paramKey: parameter.paramKey,
    currentValue: parameter.currentValue,
    source: parameter.source,
    updatedAt: parameter.updatedAt,
    revisions: parameter.revisions,
  };

  // Omitted rather than written as null: a null cooldown and an absent one mean the same thing,
  // and DynamoDB stores the null, so writing it would make every never-reverted parameter carry
  // a field whose only purpose is to be falsy.
  if (parameter.learnedCooldownUntil) {
    item.learnedCooldownUntil = parameter.learnedCooldownUntil;
  }

  try {
    await dynamodb
      .put({
        TableName: ADS_THRESHOLDS_TABLE,
        Item: item,
        ConditionExpression: expectedUpdatedAt
          ? '#updatedAt = :expected'
          : 'attribute_not_exists(entityKey)',
        ExpressionAttributeNames: expectedUpdatedAt ? { '#updatedAt': 'updatedAt' } : undefined,
        ExpressionAttributeValues: expectedUpdatedAt
          ? { ':expected': expectedUpdatedAt }
          : undefined,
      })
      .promise();
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      throw new ThresholdConflictError(
        `'${parameter.paramKey}' was modified by another writer; re-read and re-evaluate before retrying`,
      );
    }
    throw error;
  }
}
