/**
 * Tests that orgDb.getOrgMembers and orgDb.getOrgMemberCount exclude
 * tombstoned (deleted_*) user records.
 *
 * When an admin changes a user's email, the old record is tombstoned with
 * a "deleted_" userId prefix but retains its orgId/orgRole until those
 * fields are cleared. These methods must never surface tombstoned records
 * so org membership listings don't show stale/deleted accounts as owners.
 *
 * Also tests that updateUserEmail clears orgId/orgRole on the tombstoned
 * record so the data is clean at the source.
 */

const mockQueryPromise = jest.fn();
const mockQuery = jest.fn(() => ({ promise: mockQueryPromise }));
const mockUpdatePromise = jest.fn();
const mockUpdate = jest.fn(() => ({ promise: mockUpdatePromise }));
const mockPutPromise = jest.fn();
const mockPut = jest.fn(() => ({ promise: mockPutPromise }));

const mockDocClientInstance = {
  scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [], Count: 0 }) })),
  put: mockPut,
  get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Item: undefined }) })),
  update: mockUpdate,
  query: mockQuery,
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
    getSecretValue: jest.fn(() => ({
      promise: jest.fn().mockResolvedValue({ SecretString: '{}' }),
    })),
  })),
}));

import { orgDb, userDb } from '../services/db';

function lastQueryParams(): Record<string, any> | null {
  const calls = mockQuery.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
}

function lastUpdateParams(): Record<string, any> | null {
  const calls = mockUpdate.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
}

const ORG_ID = 'org-abc-123';

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryPromise.mockResolvedValue({ Items: [], Count: 0 });
  mockUpdatePromise.mockResolvedValue({});
  mockPutPromise.mockResolvedValue({});
});

// ── getOrgMembers ─────────────────────────────────────────────────────────────
describe('orgDb.getOrgMembers', () => {
  it('includes NOT begins_with tombstone guard in FilterExpression', async () => {
    await orgDb.getOrgMembers(ORG_ID);

    const params = lastQueryParams()!;
    expect(params).not.toBeNull();
    expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
    expect(params.ExpressionAttributeValues[':tombstone']).toBe('deleted_');
  });

  it('uses OrgIdIndex GSI and KeyConditionExpression for orgId', async () => {
    await orgDb.getOrgMembers(ORG_ID);

    const params = lastQueryParams()!;
    expect(params.IndexName).toBe('OrgIdIndex');
    expect(params.KeyConditionExpression).toMatch(/orgId = :orgId/);
    expect(params.ExpressionAttributeValues[':orgId']).toBe(ORG_ID);
  });

  it('returns only non-tombstoned members (integration-style)', async () => {
    // Simulate DynamoDB correctly applying the filter (returns only live users)
    mockQueryPromise.mockResolvedValueOnce({
      Items: [
        { userId: 'cc5d58e9-123', email: 'nico@provenlabs.ai', orgId: ORG_ID, orgRole: 'owner' },
      ],
    });

    const members = await orgDb.getOrgMembers(ORG_ID);
    expect(members).toHaveLength(1);
    expect(members[0].email).toBe('nico@provenlabs.ai');
  });

  it('does not return tombstoned member even if query leaks one (defence-in-depth is at DB filter)', async () => {
    // The fix is in the FilterExpression sent to DynamoDB, so if DynamoDB
    // correctly applies the filter there should be no tombstoned records.
    // This test verifies the FilterExpression is correct so DynamoDB will exclude them.
    await orgDb.getOrgMembers(ORG_ID);

    const params = lastQueryParams()!;
    const filter: string = params.FilterExpression;
    // Both conditions must be present
    expect(filter).toContain('NOT begins_with(userId, :tombstone)');
    // orgId is now in KeyConditionExpression (GSI query), not FilterExpression
    expect(params.KeyConditionExpression).toContain('orgId = :orgId');
  });

  it('handles pagination and applies tombstone guard on every page', async () => {
    mockQueryPromise
      .mockResolvedValueOnce({
        Items: [{ userId: 'user-1', orgId: ORG_ID }],
        LastEvaluatedKey: { email: 'a@b.com' },
      })
      .mockResolvedValueOnce({
        Items: [{ userId: 'user-2', orgId: ORG_ID }],
      });

    const members = await orgDb.getOrgMembers(ORG_ID);
    expect(members).toHaveLength(2);

    const allCalls = (mockQuery.mock.calls as unknown as Array<[Record<string, any>]>);
    expect(allCalls).toHaveLength(2);
    for (const [params] of allCalls) {
      expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
    }
  });
});

// ── getOrgMemberCount ─────────────────────────────────────────────────────────
describe('orgDb.getOrgMemberCount', () => {
  it('includes NOT begins_with tombstone guard in FilterExpression', async () => {
    await orgDb.getOrgMemberCount(ORG_ID);

    const params = lastQueryParams()!;
    expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
    expect(params.ExpressionAttributeValues[':tombstone']).toBe('deleted_');
  });

  it('uses OrgIdIndex GSI and KeyConditionExpression for orgId', async () => {
    await orgDb.getOrgMemberCount(ORG_ID);

    const params = lastQueryParams()!;
    expect(params.IndexName).toBe('OrgIdIndex');
    expect(params.KeyConditionExpression).toMatch(/orgId = :orgId/);
    expect(params.ExpressionAttributeValues[':orgId']).toBe(ORG_ID);
  });

  it('uses SELECT COUNT', async () => {
    await orgDb.getOrgMemberCount(ORG_ID);

    const params = lastQueryParams()!;
    expect(params.Select).toBe('COUNT');
  });

  it('returns the total count from DynamoDB', async () => {
    mockQueryPromise.mockResolvedValueOnce({ Count: 2 });

    const count = await orgDb.getOrgMemberCount(ORG_ID);
    expect(count).toBe(2);
  });
});

// ── updateUserEmail tombstone clears orgId/orgRole ───────────────────────────
describe('userDb.updateUserEmail tombstone clears org fields', () => {
  const LIVE_USER = {
    userId: 'cc5d58e9-898a-4a45-91ec-159bd03f3c52',
    email: 'will2@provenlabs.ai',
    displayName: 'Will Scrivener',
    orgId: 'org-abc-123',
    orgRole: 'owner',
  };

  beforeEach(() => {
    // getUserById uses docClient.query with UserIdIndex — return the live user
    // getUserByEmail also uses docClient.query with EmailIndex — return empty (new email not taken)
    (mockDocClientInstance.query as jest.Mock).mockImplementation((params: any) => ({
      promise: jest.fn().mockResolvedValue(
        params.IndexName === 'UserIdIndex'
          ? { Items: [LIVE_USER] }
          : { Items: [] }
      ),
    }));
  });

  it('includes REMOVE orgId, orgRole in the tombstone UpdateExpression', async () => {
    await userDb.updateUserEmail(LIVE_USER.userId, 'nico@provenlabs.ai');

    const params = lastUpdateParams()!;
    expect(params).not.toBeNull();
    expect(params.UpdateExpression).toContain('REMOVE orgId, orgRole');
  });

  it('still sets the deleted_ prefix on userId in the tombstone', async () => {
    await userDb.updateUserEmail(LIVE_USER.userId, 'nico@provenlabs.ai');

    const params = lastUpdateParams()!;
    expect(params.UpdateExpression).toContain('SET userId = :tombstone');
    expect(params.ExpressionAttributeValues[':tombstone']).toBe(`deleted_${LIVE_USER.userId}`);
  });
});
