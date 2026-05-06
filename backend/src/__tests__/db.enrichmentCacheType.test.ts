// Tests for the cacheType discriminator on putEnrichmentCacheItem.
// The discriminator lets enrich.so cache rows live alongside the existing
// field-group rows in AW-EnrichmentRawCache without ambiguity.

import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    put: jest.fn(),
    get: jest.fn(),
  };
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => ({})),
    config: { update: jest.fn() },
  };
});

import { crmDb } from '../services/db';

describe('crmDb.putEnrichmentCacheItem — cacheType discriminator', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
  });

  const baseItem = {
    canonicalId: 'abc123',
    fieldGroup: 'company_financial#v1',
    canonicalKey: 'company:acme.com',
    entityKey: 'company:acme.com',
    entityType: 'company',
    cacheType: 'field_group' as const,
    rawData: { foo: 'bar' },
    queryUsed: 'acme funding',
    sourcesUsed: ['web'],
    resultCount: 5,
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  };

  it('writes cacheType "field_group" when explicitly provided', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem(baseItem as any);
    expect(mockDynamoDB.put).toHaveBeenCalledTimes(1);
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.Item.cacheType).toBe('field_group');
  });

  it('writes cacheType "enrichso" when explicitly provided', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem({ ...baseItem, cacheType: 'enrichso' } as any);
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.Item.cacheType).toBe('enrichso');
  });

  it('cacheType is now a required field — TypeScript would reject omission (regression check)', async () => {
    // This test documents the C1 fix: cacheType is no longer optional with a
    // 'field_group' default. Callers MUST declare which producer owns the row.
    // Verified by the type system at compile time; this runtime check just
    // confirms we don't silently default if a caller bypasses types via `as any`.
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    const { cacheType, ...withoutCacheType } = baseItem;
    void cacheType;
    await crmDb.putEnrichmentCacheItem(withoutCacheType as any);
    const args = mockDynamoDB.put.mock.calls[0][0];
    // No silent default — the field is simply missing from the written row.
    expect(args.Item.cacheType).toBeUndefined();
  });

  it('preserves the ConditionExpression race-protection clause', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem({ ...baseItem, cacheType: 'enrichso' } as any);
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.ConditionExpression).toMatch(/attribute_not_exists\(canonicalId\)/);
    expect(args.ConditionExpression).toMatch(/expiresAt < :now/);
    expect(args.ExpressionAttributeValues[':now']).toBeGreaterThan(0);
  });

  it('swallows ConditionalCheckFailedException (race winner already wrote) for both cacheTypes', async () => {
    const err: any = new Error('conflict');
    err.code = 'ConditionalCheckFailedException';
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockRejectedValue(err) });
    await expect(crmDb.putEnrichmentCacheItem(baseItem as any)).resolves.toBeUndefined();
    await expect(
      crmDb.putEnrichmentCacheItem({ ...baseItem, cacheType: 'enrichso' } as any),
    ).resolves.toBeUndefined();
  });

  it('writes the row to AW-EnrichmentRawCache regardless of cacheType', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem({ ...baseItem, cacheType: 'enrichso' } as any);
    const args = mockDynamoDB.put.mock.calls[0][0];
    // TABLE_PREFIX is appended at runtime; just confirm the suffix.
    expect(args.TableName).toMatch(/AW-EnrichmentRawCache$/);
  });

  it('round-trips all base attributes alongside cacheType', async () => {
    mockDynamoDB.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    await crmDb.putEnrichmentCacheItem({ ...baseItem, cacheType: 'enrichso' } as any);
    const args = mockDynamoDB.put.mock.calls[0][0];
    expect(args.Item).toEqual(expect.objectContaining({
      canonicalId: 'abc123',
      fieldGroup: 'company_financial#v1',
      canonicalKey: 'company:acme.com',
      entityKey: 'company:acme.com',
      entityType: 'company',
      cacheType: 'enrichso',
      rawData: { foo: 'bar' },
    }));
  });
});
