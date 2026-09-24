import AWS from 'aws-sdk';

const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const db = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
  maxRetries: 0,
  httpOptions: { timeout: 2000, connectTimeout: 2000 },
});

/** Abort the actual SDK request at the caller's deadline, including pending network work. */
async function read<T>(signal: AbortSignal, create: () => AWS.Request<T, AWS.AWSError>): Promise<T> {
  signal.throwIfAborted();
  const request = create();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  try { return await request.promise(); }
  finally { signal.removeEventListener('abort', abort); }
}

/** Notification-only reads: one request each, no pagination/retries, incomplete queries fail closed. */
export const notificationLookup = {
  /** Get by primary key when supplied; otherwise evaluate at most 25 pages in the owner's index. */
  async pages(userId: string, pageId: string, signal: AbortSignal): Promise<unknown[]> {
    const TableName = `${prefix}AW-LandingPages`;
    const ProjectionExpression = 'id, userId, #name, customDomainUrl, deployedUrl, archived';
    const ExpressionAttributeNames = { '#name': 'name' };
    if (pageId) {
      const result = await read(signal, () => db.get({ TableName, Key: { id: pageId }, ProjectionExpression, ExpressionAttributeNames }));
      // Ownership and archive state are checked by the caller before using any fields.
      return result.Item ? [result.Item] : [];
    }
    const result = await read(signal, () => db.query({
      TableName, IndexName: 'UserIdIndex', KeyConditionExpression: 'userId = :owner',
      ExpressionAttributeValues: { ':owner': userId }, ProjectionExpression, ExpressionAttributeNames,
      Limit: 25,
    }));
    return result.LastEvaluatedKey ? [] : Array.isArray(result.Items) ? result.Items : [];
  },
  /** Evaluate at most 100 owner/date snapshot rows; never use a partial set to infer uniqueness. */
  async campaigns(userId: string, since: string, until: string, signal: AbortSignal) {
    const result = await read(signal, () => db.query({
      TableName: `${prefix}AW-AdsMetricsSnapshots`, IndexName: 'userId-date-index',
      KeyConditionExpression: 'userId = :owner AND #date BETWEEN :since AND :until',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':owner': userId, ':since': since, ':until': until },
      ProjectionExpression: 'userId, rowType, campaignId, campaignName, entityKey, #date', Limit: 100,
    }));
    return { rows: result.Items, truncated: Boolean(result.LastEvaluatedKey) };
  },
};
