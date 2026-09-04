/**
 * ENG-1550 — outcome ledger: storage half.
 *
 * ─── Shape ──────────────────────────────────────────────────────────────────────────────────
 *
 *   HASH  entityKey        "meta#1842363582956923"        <platform>#<accountId>
 *   RANGE recommendationId "rec_abc123"
 *
 *   hypothesis, predictedMetric, predictedDirection, predictedMagnitudePct, evaluationDate,
 *   createdAt, createdBy, adopted, status, scoredAt, actualDirection, actualMagnitudePct,
 *   verdict, verdictReason
 *
 * `platform`/`accountId` are not stored as their own attributes — same reasoning as
 * `AW-AdsThresholds`: both are derivable from `entityKey`, so there is nothing for them to drift
 * against.
 *
 * A GSI on `status`+`evaluationDate` lets a future scoring cron find "pending, past due" rows
 * without a table scan — the same reasoning CLAUDE.md documents for `AW-TaskExecutions`. No
 * cron reads it yet; the routes in `outcomeLedger.ts`'s route layer expose manual create/score
 * for now, same staged approach ENG-918 used (store + API first, consumer wired separately).
 */

import AWS from 'aws-sdk';
import { paginatedQuery } from '../utils/dynamoPagination';
import {
  buildOutcomeEntityKey,
  parseOutcomeEntityKey,
  type Recommendation,
  type OutcomePlatform,
  type PredictedDirection,
  type ActualDirection,
  type OutcomeVerdict,
} from './outcomeLedger';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
export const OUTCOME_LEDGER_TABLE = `${TABLE_PREFIX}AW-AdsOutcomeLedger`;
export const STATUS_EVALUATION_DATE_INDEX = 'StatusEvaluationDateIndex';

const dynamodb = new AWS.DynamoDB.DocumentClient();

const PAGE_SIZE = 200;

/** Raised when a stored item cannot be trusted. */
export class OutcomeLedgerCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeLedgerCorruptionError';
  }
}

const PREDICTED_DIRECTIONS: ReadonlyArray<PredictedDirection> = ['increase', 'decrease'];
const ACTUAL_DIRECTIONS: ReadonlyArray<ActualDirection> = ['increase', 'decrease', 'flat'];
const VERDICTS: ReadonlyArray<OutcomeVerdict> = ['correct', 'incorrect', 'unscoreable'];

/** Exported for direct unit testing — pure, touches no AWS SDK state. */
export function itemToRecommendation(item: AWS.DynamoDB.DocumentClient.AttributeMap): Recommendation | null {
  const parsed = parseOutcomeEntityKey(String(item.entityKey));
  if (!parsed) return null;

  if (!PREDICTED_DIRECTIONS.includes(item.predictedDirection)) {
    throw new OutcomeLedgerCorruptionError(
      `${OUTCOME_LEDGER_TABLE} item '${item.entityKey}'/'${item.recommendationId}' has an invalid ` +
        `predictedDirection (${String(item.predictedDirection)})`,
    );
  }
  if (
    item.predictedMagnitudePct == null ||
    !Number.isFinite(Number(item.predictedMagnitudePct))
  ) {
    throw new OutcomeLedgerCorruptionError(
      `${OUTCOME_LEDGER_TABLE} item '${item.entityKey}'/'${item.recommendationId}' has a non-finite ` +
        `predictedMagnitudePct (${String(item.predictedMagnitudePct)})`,
    );
  }
  if (item.status !== 'pending' && item.status !== 'scored') {
    throw new OutcomeLedgerCorruptionError(
      `${OUTCOME_LEDGER_TABLE} item '${item.entityKey}'/'${item.recommendationId}' has an invalid ` +
        `status (${String(item.status)})`,
    );
  }
  if (item.actualDirection != null && !ACTUAL_DIRECTIONS.includes(item.actualDirection)) {
    throw new OutcomeLedgerCorruptionError(
      `${OUTCOME_LEDGER_TABLE} item '${item.entityKey}'/'${item.recommendationId}' has an invalid ` +
        `actualDirection (${String(item.actualDirection)})`,
    );
  }
  if (item.verdict != null && !VERDICTS.includes(item.verdict)) {
    throw new OutcomeLedgerCorruptionError(
      `${OUTCOME_LEDGER_TABLE} item '${item.entityKey}'/'${item.recommendationId}' has an invalid ` +
        `verdict (${String(item.verdict)})`,
    );
  }

  return {
    accountId: parsed.accountId,
    platform: parsed.platform,
    recommendationId: String(item.recommendationId),
    hypothesis: String(item.hypothesis),
    predictedMetric: String(item.predictedMetric),
    predictedDirection: item.predictedDirection,
    predictedMagnitudePct: Number(item.predictedMagnitudePct),
    evaluationDate: String(item.evaluationDate),
    createdAt: String(item.createdAt),
    createdBy: String(item.createdBy),
    adopted: item.adopted == null ? null : Boolean(item.adopted),
    status: item.status,
    scoredAt: item.scoredAt ? String(item.scoredAt) : null,
    actualDirection: item.actualDirection ?? null,
    actualMagnitudePct: item.actualMagnitudePct == null ? null : Number(item.actualMagnitudePct),
    verdict: item.verdict ?? null,
    verdictReason: item.verdictReason ? String(item.verdictReason) : null,
  };
}

export async function getRecommendation(
  platform: OutcomePlatform,
  accountId: string,
  recommendationId: string,
): Promise<Recommendation | null> {
  const result = await dynamodb
    .get({
      TableName: OUTCOME_LEDGER_TABLE,
      Key: { entityKey: buildOutcomeEntityKey(platform, accountId), recommendationId },
    })
    .promise();

  return result.Item ? itemToRecommendation(result.Item) : null;
}

export async function getRecommendationsForAccount(
  platform: OutcomePlatform,
  accountId: string,
): Promise<Recommendation[]> {
  const items = await paginatedQuery<AWS.DynamoDB.DocumentClient.AttributeMap>(dynamodb, {
    TableName: OUTCOME_LEDGER_TABLE,
    KeyConditionExpression: 'entityKey = :e',
    ExpressionAttributeValues: { ':e': buildOutcomeEntityKey(platform, accountId) },
    Limit: PAGE_SIZE,
  });

  const rows: Recommendation[] = [];
  for (const item of items) {
    const rec = itemToRecommendation(item);
    if (rec) rows.push(rec);
  }
  return rows;
}

/**
 * Stores a recommendation. `attribute_not_exists(entityKey)` guards creation only — recording is
 * a create-once operation (a recommendation id is minted once, by the surface that made the
 * prediction), scoring is a distinct, explicit `putScoredRecommendation` call below, so there is
 * no legitimate concurrent-writer race to compare-and-swap against here the way
 * `adsThresholdsDb.putThreshold` has to.
 */
export async function putNewRecommendation(recommendation: Recommendation): Promise<void> {
  if (recommendation.status !== 'pending') {
    throw new Error('outcomeLedgerDb: putNewRecommendation requires a pending recommendation');
  }
  try {
    await dynamodb
      .put({
        TableName: OUTCOME_LEDGER_TABLE,
        Item: {
          entityKey: buildOutcomeEntityKey(recommendation.platform, recommendation.accountId),
          recommendationId: recommendation.recommendationId,
          hypothesis: recommendation.hypothesis,
          predictedMetric: recommendation.predictedMetric,
          predictedDirection: recommendation.predictedDirection,
          predictedMagnitudePct: recommendation.predictedMagnitudePct,
          evaluationDate: recommendation.evaluationDate,
          createdAt: recommendation.createdAt,
          createdBy: recommendation.createdBy,
          status: 'pending',
        },
        ConditionExpression: 'attribute_not_exists(entityKey)',
      })
      .promise();
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      throw new Error(
        `outcomeLedgerDb: recommendation '${recommendation.recommendationId}' already exists`,
      );
    }
    throw error;
  }
}

/**
 * Writes a scored recommendation. Requires the item to currently be `pending` — scoring is
 * one-shot per recommendation; re-scoring an already-scored row would silently overwrite a
 * verdict that may already have been read into an accuracy report.
 */
export async function putScoredRecommendation(recommendation: Recommendation): Promise<void> {
  if (recommendation.status !== 'scored') {
    throw new Error('outcomeLedgerDb: putScoredRecommendation requires a scored recommendation');
  }
  const item: Record<string, unknown> = {
    entityKey: buildOutcomeEntityKey(recommendation.platform, recommendation.accountId),
    recommendationId: recommendation.recommendationId,
    hypothesis: recommendation.hypothesis,
    predictedMetric: recommendation.predictedMetric,
    predictedDirection: recommendation.predictedDirection,
    predictedMagnitudePct: recommendation.predictedMagnitudePct,
    evaluationDate: recommendation.evaluationDate,
    createdAt: recommendation.createdAt,
    createdBy: recommendation.createdBy,
    status: 'scored',
    adopted: recommendation.adopted,
    scoredAt: recommendation.scoredAt,
    verdict: recommendation.verdict,
  };
  if (recommendation.actualDirection != null) item.actualDirection = recommendation.actualDirection;
  if (recommendation.actualMagnitudePct != null) item.actualMagnitudePct = recommendation.actualMagnitudePct;
  if (recommendation.verdictReason != null) item.verdictReason = recommendation.verdictReason;

  try {
    await dynamodb
      .put({
        TableName: OUTCOME_LEDGER_TABLE,
        Item: item,
        ConditionExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': 'pending' },
      })
      .promise();
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      throw new Error(
        `outcomeLedgerDb: recommendation '${recommendation.recommendationId}' is not pending (already scored, or does not exist)`,
      );
    }
    throw error;
  }
}
