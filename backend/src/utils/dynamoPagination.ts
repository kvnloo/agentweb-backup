import AWS from 'aws-sdk';

type DocumentClient = AWS.DynamoDB.DocumentClient;
type QueryInput = AWS.DynamoDB.DocumentClient.QueryInput;
type ScanInput = AWS.DynamoDB.DocumentClient.ScanInput;
type Key = AWS.DynamoDB.DocumentClient.Key;

export async function paginatedQuery<T = any>(
  client: DocumentClient,
  params: QueryInput
): Promise<T[]> {
  const allItems: T[] = [];
  let lastEvaluatedKey: Key | undefined;

  do {
    const result = await client.query({
      ...params,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }).promise();

    if (result.Items) {
      allItems.push(...(result.Items as T[]));
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return allItems;
}

export async function paginatedScan<T = any>(
  client: DocumentClient,
  params: ScanInput
): Promise<T[]> {
  const allItems: T[] = [];
  let lastEvaluatedKey: Key | undefined;

  do {
    const result = await client.scan({
      ...params,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }).promise();

    if (result.Items) {
      allItems.push(...(result.Items as T[]));
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return allItems;
}

export async function paginatedCount(
  client: DocumentClient,
  params: QueryInput
): Promise<number> {
  let totalCount = 0;
  let lastEvaluatedKey: Key | undefined;

  do {
    const result = await client.query({
      ...params,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }).promise();

    totalCount += result.Count || 0;
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return totalCount;
}
