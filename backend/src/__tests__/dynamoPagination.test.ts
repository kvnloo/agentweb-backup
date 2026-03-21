import AWS from 'aws-sdk';
import { paginatedQuery, paginatedScan, paginatedCount } from '../utils/dynamoPagination';

function createMockClient(queryResults: any[], scanResults: any[] = []) {
  let queryCallIndex = 0;
  let scanCallIndex = 0;

  const client = {
    query: jest.fn(() => ({
      promise: jest.fn().mockImplementation(() => {
        return Promise.resolve(queryResults[queryCallIndex++]);
      }),
    })),
    scan: jest.fn(() => ({
      promise: jest.fn().mockImplementation(() => {
        return Promise.resolve(scanResults[scanCallIndex++]);
      }),
    })),
  } as unknown as AWS.DynamoDB.DocumentClient;

  return client;
}

describe('paginatedQuery', () => {
  it('should return all items from a single page', async () => {
    const client = createMockClient([
      { Items: [{ id: '1' }, { id: '2' }] },
    ]);

    const result = await paginatedQuery(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
    });

    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('should paginate through multiple pages', async () => {
    const client = createMockClient([
      {
        Items: [{ id: '1' }, { id: '2' }],
        LastEvaluatedKey: { pk: 'val', sk: '2' },
      },
      {
        Items: [{ id: '3' }, { id: '4' }],
        LastEvaluatedKey: { pk: 'val', sk: '4' },
      },
      {
        Items: [{ id: '5' }],
      },
    ]);

    const result = await paginatedQuery(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
    });

    expect(result).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }]);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('should return empty array when no items found', async () => {
    const client = createMockClient([{ Items: [] }]);

    const result = await paginatedQuery(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
    });

    expect(result).toEqual([]);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('should handle undefined Items in response', async () => {
    const client = createMockClient([{}]);

    const result = await paginatedQuery(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
    });

    expect(result).toEqual([]);
  });

  it('should pass ExclusiveStartKey from previous page', async () => {
    const lastKey = { pk: 'val', sk: '2' };
    const client = createMockClient([
      { Items: [{ id: '1' }], LastEvaluatedKey: lastKey },
      { Items: [{ id: '2' }] },
    ]);

    const params = {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
    };

    await paginatedQuery(client, params);

    // Second call should include ExclusiveStartKey
    const secondCallArgs = (client.query as jest.Mock).mock.calls[1][0];
    expect(secondCallArgs.ExclusiveStartKey).toEqual(lastKey);
  });

  it('should not mutate the original params', async () => {
    const client = createMockClient([
      { Items: [{ id: '1' }], LastEvaluatedKey: { pk: 'val', sk: '1' } },
      { Items: [{ id: '2' }] },
    ]);

    const params = {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
    };

    const paramsCopy = { ...params };
    await paginatedQuery(client, params);

    expect(params).toEqual(paramsCopy);
    expect(params).not.toHaveProperty('ExclusiveStartKey');
  });

  it('should handle empty page with LastEvaluatedKey', async () => {
    const client = createMockClient([
      { Items: [], LastEvaluatedKey: { pk: 'val', sk: '0' } },
      { Items: [{ id: '1' }] },
    ]);

    const result = await paginatedQuery(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
    });

    expect(result).toEqual([{ id: '1' }]);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});

describe('paginatedScan', () => {
  it('should return all items from a single page', async () => {
    const client = createMockClient([], [
      { Items: [{ id: '1' }, { id: '2' }] },
    ]);

    const result = await paginatedScan(client, { TableName: 'TestTable' });

    expect(result).toEqual([{ id: '1' }, { id: '2' }]);
    expect(client.scan).toHaveBeenCalledTimes(1);
  });

  it('should paginate through multiple pages', async () => {
    const client = createMockClient([], [
      {
        Items: [{ id: '1' }],
        LastEvaluatedKey: { pk: '1' },
      },
      {
        Items: [{ id: '2' }],
        LastEvaluatedKey: { pk: '2' },
      },
      {
        Items: [{ id: '3' }],
      },
    ]);

    const result = await paginatedScan(client, { TableName: 'TestTable' });

    expect(result).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
    expect(client.scan).toHaveBeenCalledTimes(3);
  });

  it('should return empty array when no items found', async () => {
    const client = createMockClient([], [{ Items: [] }]);

    const result = await paginatedScan(client, { TableName: 'TestTable' });

    expect(result).toEqual([]);
  });

  it('should not mutate the original params', async () => {
    const client = createMockClient([], [
      { Items: [{ id: '1' }], LastEvaluatedKey: { pk: '1' } },
      { Items: [{ id: '2' }] },
    ]);

    const params = { TableName: 'TestTable' };
    const paramsCopy = { ...params };
    await paginatedScan(client, params);

    expect(params).toEqual(paramsCopy);
  });
});

describe('paginatedCount', () => {
  it('should return count from a single page', async () => {
    const client = createMockClient([{ Count: 42 }]);

    const result = await paginatedCount(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
      Select: 'COUNT',
    });

    expect(result).toBe(42);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('should sum counts across multiple pages', async () => {
    const client = createMockClient([
      { Count: 100, LastEvaluatedKey: { pk: 'val', sk: '100' } },
      { Count: 100, LastEvaluatedKey: { pk: 'val', sk: '200' } },
      { Count: 50 },
    ]);

    const result = await paginatedCount(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
      Select: 'COUNT',
    });

    expect(result).toBe(250);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('should return 0 when Count is undefined', async () => {
    const client = createMockClient([{}]);

    const result = await paginatedCount(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
      Select: 'COUNT',
    });

    expect(result).toBe(0);
  });

  it('should return 0 for empty table', async () => {
    const client = createMockClient([{ Count: 0 }]);

    const result = await paginatedCount(client, {
      TableName: 'TestTable',
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'val' },
      Select: 'COUNT',
    });

    expect(result).toBe(0);
  });
});
