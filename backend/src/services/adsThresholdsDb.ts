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
 *   defaultValue          3.5
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
 * `AW-MetaCapiKeyCoverage`'s `date`/`eventName`.
 */

import AWS from 'aws-sdk';
import {
  buildThresholdEntityKey,
  parseThresholdEntityKey,
  type AdsThreshold,
  type AdsPlatform,
  type ThresholdRevision,
  type ThresholdSource,
} from './adsThresholds';

// ⚠ Matches every other table in this codebase, and inherits the same FAIL-OPEN hazard: an unset
// or misspelled NODE_ENV resolves to the PRODUCTION table rather than erroring. Kept consistent
// deliberately — a table whose prefix rule differs from all 60+ others is the more dangerous
// surprise. Any SCRIPT that writes here should assert NODE_ENV explicitly rather than rely on it.
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
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

function itemToParameter(item: AWS.DynamoDB.DocumentClient.AttributeMap): AdsThreshold | null {
  const parsed = parseThresholdEntityKey(String(item.entityKey));
  if (!parsed) return null;

  return {
    accountId: parsed.accountId,
    platform: parsed.platform,
    paramKey: String(item.paramKey),
    currentValue: Number(item.currentValue),
    defaultValue: Number(item.defaultValue),
    source: String(item.source) as ThresholdSource,
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
 * Pages to exhaustion. A short read would silently drop overrides and resolve those parameters
 * back to their defaults — which reads as "nobody ever set anything" rather than as a failed
 * read, and would quietly undo a customer's configuration at the point of use.
 */
export async function getThresholdsForAccount(
  platform: AdsPlatform,
  accountId: string,
): Promise<AdsThreshold[]> {
  const rows: AdsThreshold[] = [];
  let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await dynamodb
      .query({
        TableName: ADS_THRESHOLDS_TABLE,
        KeyConditionExpression: 'entityKey = :e',
        ExpressionAttributeValues: { ':e': buildThresholdEntityKey(platform, accountId) },
        Limit: PAGE_SIZE,
        ExclusiveStartKey: startKey,
      })
      .promise();

    for (const item of result.Items || []) {
      const parameter = itemToParameter(item);
      if (parameter) rows.push(parameter);
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

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
    defaultValue: parameter.defaultValue,
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
