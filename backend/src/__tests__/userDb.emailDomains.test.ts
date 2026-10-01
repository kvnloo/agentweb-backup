/**
 * ENG-265: getUsersByEmailDomain must find a matching user whether the domain
 * lives on the legacy scalar `emailDomain` field or in the new multi-domain
 * `emailDomains[]` array, so the domain-uniqueness collision check (crm.ts
 * POST /email-domain(s)) can't be bypassed by registering the same domain as
 * a second/third entry once a user already has one.
 *
 * Strategy matches userDb.tombstoneExclusion.test.ts: mock aws-sdk, import
 * the real UserDB class, inspect the Scan params it builds and the items it
 * returns.
 */

const mockScanPromise = jest.fn();
const mockScan = jest.fn(() => ({ promise: mockScanPromise }));
const mockDocClientInstance = {
  scan: mockScan,
  put: jest.fn(() => ({ promise: jest.fn() })),
  get: jest.fn(() => ({ promise: jest.fn() })),
  update: jest.fn(() => ({ promise: jest.fn() })),
  query: jest.fn(() => ({ promise: jest.fn() })),
  delete: jest.fn(() => ({ promise: jest.fn() })),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocClientInstance),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(() => ({ promise: jest.fn() })),
    getObject: jest.fn(() => ({ promise: jest.fn() })),
    deleteObject: jest.fn(() => ({ promise: jest.fn() })),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) })),
  })),
}));

import { userDb } from '../services/db';

function lastScanParams(): Record<string, any> | null {
  const calls = mockScan.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScanPromise.mockResolvedValue({ Items: [], Count: 0 });
});

describe('UserDB.getUsersByEmailDomain — multi-domain (ENG-265)', () => {
  it('still filters on the legacy scalar emailDomain field', async () => {
    await userDb.getUsersByEmailDomain('okareo.com');

    const params = lastScanParams()!;
    expect(params.FilterExpression).toMatch(/emailDomain = :emailDomain/);
    expect(params.ExpressionAttributeValues![':emailDomain']).toBe('okareo.com');
  });

  it('also filters via contains() on the denormalized emailDomainList array', async () => {
    await userDb.getUsersByEmailDomain('okareo.com');

    const params = lastScanParams()!;
    expect(params.FilterExpression).toMatch(/contains\(emailDomainList, :emailDomain\)/);
  });

  it('preserves the tombstone exclusion guard', async () => {
    await userDb.getUsersByEmailDomain('okareo.com');

    const params = lastScanParams()!;
    expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
    expect(params.ExpressionAttributeValues![':tombstone']).toBe('deleted_');
  });

  it('returns a user whose match is only in emailDomains[], not the legacy scalar', async () => {
    mockScanPromise.mockResolvedValueOnce({
      Items: [{
        userId: 'user-multi',
        email: 'multi@example.com',
        emailDomains: [
          { id: 'domain-1', domain: 'first.example.com', status: 'verified', addedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'domain-2', domain: 'second.example.com', status: 'verified', addedAt: '2026-02-01T00:00:00.000Z' },
        ],
        emailDomainList: ['first.example.com', 'second.example.com'],
      }],
    });

    const results = await userDb.getUsersByEmailDomain('second.example.com');

    expect(results).toHaveLength(1);
    expect(results[0].userId).toBe('user-multi');
  });

  it('normalizes the input domain to lowercase/trimmed before filtering', async () => {
    await userDb.getUsersByEmailDomain('  Okareo.Com  ');

    const params = lastScanParams()!;
    expect(params.ExpressionAttributeValues![':emailDomain']).toBe('okareo.com');
  });
});
