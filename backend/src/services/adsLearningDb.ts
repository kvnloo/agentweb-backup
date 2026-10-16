/** Existing ledger + account-memory tables; no new table/index. All writes are conditional. */
import AWS from 'aws-sdk';
import { cleanAccountId } from './metaAccountCredentials';
import { isEvaluationUser } from './evaluationPolicy';
import { OUTCOME_LEDGER_TABLE, itemToRecommendation, ledgerRequest, getRecommendation } from './outcomeLedgerDb';
import { buildOutcomeEntityKey, hasLearningContext, validateRecommendationContext, type Recommendation } from './outcomeLedger';
import { buildOutcomeLesson, resolveScopedLessons, LEARNING_PREFIX, type LearningScope, type ScopedLesson } from './adsScopedLearning';
import type { ExecutionReceipt } from './adsOutcomeEvaluator';
import { TABLE_PREFIX } from '../config/constants';
const db = new AWS.DynamoDB.DocumentClient();
const MEMORY_TABLE = `${TABLE_PREFIX}AW-AccountMemory`;
export async function getDueRecommendations(now: Date, cursor?: AWS.DynamoDB.DocumentClient.Key) {
  const result = await ledgerRequest(db.query({ TableName: OUTCOME_LEDGER_TABLE, IndexName: 'StatusEvaluationDateIndex',
    KeyConditionExpression: '#status = :pending AND evaluationDate <= :due', ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':pending': 'pending', ':due': new Date(now.getTime() - 28 * 86400000).toISOString() },
    // 50 × (1.5s reread + 3s metrics + 5s transaction + 1.5s conflict read)
    // + 5s page read = at most 555s of request budgets, below the 900s tick.
    Limit: 50, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }), 5000);
  if (result.Items !== undefined && !Array.isArray(result.Items)) throw new Error('Malformed due page');
  const rows: Recommendation[] = [];
  for (const item of result.Items ?? []) {
    try { const r = itemToRecommendation(item); if (r && r.platform === 'meta' && hasLearningContext(r)) rows.push(r); }
    catch { console.error('[AdsLearning] corrupt due record', { recommendationId: item?.recommendationId }); }
  }
  return { rows, cursor: result.LastEvaluatedKey };
}
export async function getScopedLearning(scope: LearningScope): Promise<ScopedLesson[]> {
  const result = await ledgerRequest(db.query({ TableName: MEMORY_TABLE,
    KeyConditionExpression: 'userId = :userId AND begins_with(memoryId, :prefix)',
    ExpressionAttributeValues: { ':userId': scope.userId, ':prefix': LEARNING_PREFIX }, Limit: 100 }), 1500);
  if (result.Items !== undefined && !Array.isArray(result.Items)) throw new Error('Malformed learning page');
  if (result.LastEvaluatedKey) console.warn('[AdsLearning] retrieval limited', { limit: 100 });
  return resolveScopedLessons(result.Items ?? [], scope);
}
/** Atomic score + qualitative projection. A crash can never strand the score without its lesson. */
export async function completeEvaluation(r: Recommendation): Promise<void> {
  if (r.status !== 'scored' || !r.scoredAt) throw new Error('Expected scored outcome');
  if (r.platform !== 'meta' || !hasLearningContext(r)) throw new Error('Expected Meta ENG-502 context');
  const lesson = buildOutcomeLesson(r);
  const { platform, accountId, ...fields } = r;
  const item = { ...fields, entityKey: buildOutcomeEntityKey(platform, accountId) };
  try {
    await ledgerRequest(db.transactWrite({ TransactItems: [
      { Put: { TableName: OUTCOME_LEDGER_TABLE, Item: item, ConditionExpression: '#status = :pending AND #context = :context',
        ExpressionAttributeNames: { '#status': 'status', '#context': 'context' }, ExpressionAttributeValues: { ':pending': 'pending', ':context': r.context } } },
      ...(lesson ? [{ Put: { TableName: MEMORY_TABLE, Item: lesson, ConditionExpression: 'attribute_not_exists(memoryId)' } }] : []),
    ] }), 5000);
  } catch (error: any) {
    if (error?.code === 'TransactionCanceledException') {
      const fresh = await getRecommendation(platform, accountId, r.recommendationId, 1500);
      if (fresh?.status === 'scored') return; // Another evaluator atomically completed it.
    }
    throw error;
  }
}
/** Receipts are produced only by server-side verified execution, never metric changes. */
export async function attachExecutionReceipt(r: Recommendation, receipt: ExecutionReceipt, timeoutMs = 100): Promise<void> {
  if (!r.context || receipt.recommendationId !== r.recommendationId || receipt.platform !== r.platform || receipt.accountId !== r.accountId) {
    throw new Error('Receipt scope mismatch');
  }
  validateRecommendationContext({ ...r.context, execution: receipt });
  await ledgerRequest(db.update({ TableName: OUTCOME_LEDGER_TABLE,
    Key: { entityKey: buildOutcomeEntityKey(r.platform, r.accountId), recommendationId: r.recommendationId },
    UpdateExpression: 'SET #context.#execution = :receipt',
    ConditionExpression: '#status = :pending AND attribute_not_exists(#context.#execution) AND #context.#client = :client',
    ExpressionAttributeNames: { '#status': 'status', '#context': 'context', '#execution': 'execution', '#client': 'clientUserId' },
    ExpressionAttributeValues: { ':pending': 'pending', ':receipt': receipt, ':client': r.context.clientUserId } }), timeoutMs);
}

export async function getLearningMetrics(platform: string, accountId: string, campaignId: string, since: string, until: string, timeoutMs = 1500) {
  const { ADS_METRICS_TABLE, buildEntityKey } = await import('./adsMetricsDb');
  const result = await ledgerRequest(db.query({ TableName: ADS_METRICS_TABLE,
    KeyConditionExpression: 'entityKey = :entityKey AND #date BETWEEN :since AND :until',
    ExpressionAttributeNames: { '#date': 'date' }, ExpressionAttributeValues: {
      ':entityKey': buildEntityKey(platform as any, accountId, campaignId), ':since': since, ':until': until }, Limit: 28 }), timeoutMs);
  if (result.Items !== undefined && !Array.isArray(result.Items)) throw new Error('Malformed metric page');
  return { rows: (result.Items ?? []) as import('./adsMetricsDb').AdsMetricsSnapshotRow[], truncated: !!result.LastEvaluatedKey };
}
export async function getLearningRecommendations(platform: string, accountId: string, timeoutMs = 1500) {
  const result = await ledgerRequest(db.query({ TableName: OUTCOME_LEDGER_TABLE,
    KeyConditionExpression: 'entityKey = :e', ExpressionAttributeValues: { ':e': `${platform}#${accountId}` }, Limit: 100 }), timeoutMs);
  if (result.Items !== undefined && !Array.isArray(result.Items)) throw new Error('Malformed ledger page');
  return { rows: (result.Items ?? []).map(itemToRecommendation).filter((r): r is Recommendation => !!r), truncated: !!result.LastEvaluatedKey };
}

export async function getLearningItem(userId: string, memoryId: string): Promise<ScopedLesson | null> {
  if (!memoryId.startsWith(LEARNING_PREFIX)) return null;
  const result = await ledgerRequest(db.get({ TableName: MEMORY_TABLE, Key: { userId, memoryId }, ConsistentRead: true }), 1500);
  return (result.Item as ScopedLesson) ?? null;
}
export async function commitLearningReview(lesson: ScopedLesson, previous: ScopedLesson,
  parameter: import('./adsThresholds').AdsThreshold | null, expectedParameterTime: string | null): Promise<void> {
  if (parameter && lesson.learning.scope !== 'client') throw new Error('Account parameter requires explicit client scope');
  const { ADS_THRESHOLDS_TABLE } = await import('./adsThresholdsDb');
  const { accountId, platform, ...fields } = parameter ?? {};
  await ledgerRequest(db.transactWrite({ TransactItems: [
    ...(parameter ? [{ Put: { TableName: ADS_THRESHOLDS_TABLE, Item: { ...fields, entityKey: `${platform}#${accountId}` },
      ConditionExpression: expectedParameterTime ? '#updatedAt = :expected' : 'attribute_not_exists(entityKey)',
      ...(expectedParameterTime ? { ExpressionAttributeNames: { '#updatedAt': 'updatedAt' }, ExpressionAttributeValues: { ':expected': expectedParameterTime } } : {}) } }] : []),
    { Put: { TableName: MEMORY_TABLE, Item: lesson, ConditionExpression: '#updatedAt = :expected AND #learning.#state = :state',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt', '#learning': 'learning', '#state': 'reviewState' },
      ExpressionAttributeValues: { ':expected': previous.updatedAt, ':state': previous.learning.reviewState } } },
  ] }), 5000);
}

/** Sole-owner proof without the admin dashboard's unrelated count scans.
 * No ownership index exists: bound the projected scan to 2,000 evaluated users,
 * 20 pages and one 5-second deadline. Any incomplete/malformed read fails closed. */
export async function getLearningAccountOwners(accountId: string): Promise<Set<string>> {
  const deadline = Date.now() + 5000;
  const owners = new Set<string>();
  let cursor: AWS.DynamoDB.DocumentClient.Key | undefined;
  for (let page = 0; page < 20; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Ownership read deadline exceeded');
    const result = await ledgerRequest(db.scan({
      TableName: `${TABLE_PREFIX}AW-Users`,
      ProjectionExpression: 'userId, adAccount, connected_accounts',
      ConsistentRead: true, Limit: 100, ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }), remaining);
    if (!Array.isArray(result.Items)) throw new Error('Ownership page malformed');
    for (const user of result.Items) {
      if (!user || typeof user.userId !== 'string' || !user.userId) throw new Error('Ownership identity malformed');
      if (user.userId.startsWith('deleted_') || isEvaluationUser(user.userId)) continue;
      if (user.adAccount != null && typeof user.adAccount !== 'string') throw new Error('Ownership account malformed');
      if (user.connected_accounts != null && !Array.isArray(user.connected_accounts)) throw new Error('Ownership connections malformed');
      for (const account of user.connected_accounts ?? []) {
        if (!account || typeof account !== 'object' || Array.isArray(account) ||
          (account.config != null && (typeof account.config !== 'object' || Array.isArray(account.config))) ||
          [account.platform, account.account_id, account.config?.ad_account_id, account.config?.account_type].some(value => value != null && typeof value !== 'string')) {
          throw new Error('Ownership connection malformed');
        }
      }
      if ((typeof user.adAccount === 'string' && cleanAccountId(user.adAccount) === accountId) ||
        (user.connected_accounts ?? []).some((account: any) =>
          (account.platform === 'meta' || account.platform === 'facebook') && account.config?.account_type === 'ad_account' &&
          cleanAccountId(account.account_id || account.config?.ad_account_id || '') === accountId)) owners.add(user.userId);
      if (owners.size > 1) return owners; // Already enough evidence to refuse account-wide promotion.
    }
    cursor = result.LastEvaluatedKey;
    if (!cursor) return owners;
  }
  throw new Error('Ownership read incomplete');
}
