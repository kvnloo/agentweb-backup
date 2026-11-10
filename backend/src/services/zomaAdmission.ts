import AWS from 'aws-sdk';

const db = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const table = () => `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-Waitlist`;
const counterKey = { email: '__zoma_free_capacity__' };
export const zomaAdmissionEnabled = () => process.env.ZOMA_WAITLIST_ENABLED === 'true';
export function zomaCapacity(): number {
  const cap = Number(process.env.ZOMA_FREE_USER_CAP ?? '60');
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('Invalid ZOMA_FREE_USER_CAP');
  return cap;
}
export const waitlistedResponse = {
  code: 'waitlisted', status: 'waitlisted',
  message: 'You are on the waitlist. We will notify you when access is approved.',
};
async function entry(email: string): Promise<any> {
  return (await db.get({ TableName: table(), Key: { email }, ConsistentRead: true }).promise()).Item;
}
export async function zomaApprovedCount() {
  const row = await entry(counterKey.email);
  // Explicit bootstrap is required: never silently start at zero with existing users.
  if (!Number.isSafeInteger(row?.approvedCount) || row.approvedCount < 0) {
    throw new Error('Zoma capacity counter is not initialized');
  }
  return { approvedCount: row.approvedCount, capacity: zomaCapacity() };
}

/** A durable per-email decision and counter increment commit together. Reservations
 * survive failed account creation, so retries cannot consume a second seat. */
export async function admitZoma(emailInput: string, actor?: string): Promise<string> {
  const email = emailInput.toLowerCase();
  if (email === counterKey.email) throw new Error('Invalid admission email');
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await entry(email);
    if (current?.zomaStatus === 'approved') return 'approved';
    if (current?.zomaStatus && !actor) return current.zomaStatus;
    if (actor && current?.zomaStatus !== 'waitlisted') return current?.zomaStatus ?? 'not_found';
    const { approvedCount, capacity } = await zomaApprovedCount();
    const now = new Date().toISOString();
    if (approvedCount >= capacity) {
      if (actor) return 'capacity_exhausted';
      try {
        await db.update({ TableName: table(), Key: { email },
          UpdateExpression: 'SET zomaStatus = :pending, joinedAt = if_not_exists(joinedAt, :now)',
          ConditionExpression: 'attribute_not_exists(zomaStatus)',
          ExpressionAttributeValues: { ':pending': 'waitlisted', ':now': now },
        }).promise();
        return 'waitlisted';
      } catch (err: any) {
        if (err.code === 'ConditionalCheckFailedException') continue;
        throw err;
      }
    }
    try {
      await db.transactWrite({ TransactItems: [
        { Update: { TableName: table(), Key: counterKey,
          UpdateExpression: 'SET approvedCount = approvedCount + :one',
          ConditionExpression: 'attribute_exists(approvedCount) AND approvedCount < :cap',
          ExpressionAttributeValues: { ':one': 1, ':cap': capacity } } },
        { Update: { TableName: table(), Key: { email },
          UpdateExpression: 'SET zomaStatus = :approved, approvedAt = :now, approvedBy = :actor, joinedAt = if_not_exists(joinedAt, :now)',
          ConditionExpression: actor ? 'zomaStatus = :pending' : 'attribute_not_exists(zomaStatus)',
          ExpressionAttributeValues: { ':approved': 'approved', ':now': now, ':actor': actor ?? 'system:capacity', ...(actor ? { ':pending': 'waitlisted' } : {}) } } },
      ] }).promise();
      return 'approved';
    } catch (err: any) {
      if (err.code !== 'TransactionCanceledException') throw err;
      if (err.CancellationReasons?.some((r: any) => !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code))) throw err;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error('Zoma admission contention; retry request');
}
export async function rejectZoma(emailInput: string, actor: string): Promise<string> {
  const email = emailInput.toLowerCase();
  try {
    await db.update({ TableName: table(), Key: { email },
      UpdateExpression: 'SET zomaStatus = :rejected, rejectedBy = :actor, rejectedAt = :now',
      ConditionExpression: 'zomaStatus = :pending',
      ExpressionAttributeValues: { ':pending': 'waitlisted', ':rejected': 'rejected', ':actor': actor, ':now': new Date().toISOString() },
    }).promise();
    return 'rejected';
  } catch (err: any) {
    if (err.code !== 'ConditionalCheckFailedException') throw err;
    return (await entry(email))?.zomaStatus ?? 'not_found';
  }
}
