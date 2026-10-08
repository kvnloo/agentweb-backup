import type { DynamoDB } from 'aws-sdk';
import { isEvaluationUser } from './evaluationPolicy';

type Db = Pick<DynamoDB.DocumentClient, 'put' | 'update' | 'transactWrite'>;
type Write = { Put: DynamoDB.DocumentClient.Put } | { Update: DynamoDB.DocumentClient.Update };

/** Fence artifact writes against the root lifecycle transition, in the SAME transaction. */
export function activeEvaluationCondition(userId: string, tablePrefix: string): DynamoDB.DocumentClient.TransactWriteItem {
  return { ConditionCheck: {
    TableName: `${tablePrefix}AW-Evaluations`, Key: { evaluationKey: `evaluation/${userId}` },
    ConditionExpression: 'userId = :user AND #status = :active AND attribute_not_exists(lifecycleState) AND expiresAt > :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':user': userId, ':active': 'active', ':now': Date.now() },
  } };
}

/** Ordinary principals retain their existing single-item persistence path. */
export async function writeWithEvaluationGuard(db: Db, userId: string | undefined, tablePrefix: string, write: Write): Promise<void> {
  if (isEvaluationUser(userId)) {
    await db.transactWrite({ TransactItems: [activeEvaluationCondition(userId!, tablePrefix), write] }).promise();
  } else if ('Put' in write) {
    await db.put(write.Put).promise();
  } else {
    await db.update(write.Update).promise();
  }
}

export function isTransactionConditionFailure(error: unknown): boolean {
  const err = error as { code?: string; CancellationReasons?: { Code?: string }[] };
  return err?.code === 'TransactionCanceledException' && Array.isArray(err.CancellationReasons) &&
    err.CancellationReasons.some(reason => reason?.Code === 'ConditionalCheckFailed');
}
