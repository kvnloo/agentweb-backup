/**
 * Tests that UserDB scan methods exclude tombstoned (deleted_*) records.
 *
 * When an admin changes a user's email, the old record is tombstoned by
 * prefixing its userId with "deleted_". These methods must never return
 * tombstone records so Stripe webhooks and other lookups always hit the
 * live account.
 *
 * Strategy: mock the full aws-sdk and import the real UserDB class to verify
 * the FilterExpression built for each scan includes the tombstone guard.
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

describe('UserDB tombstone exclusion', () => {

  // ── scanWithFilter ────────────────────────────────────────────────────────
  describe('scanWithFilter', () => {
    it('prepends NOT begins_with(userId, :_tombstone_prefix) to caller filter', async () => {
      await (userDb as any).scanWithFilter('stripe_customer_id = :cid', { ':cid': 'cus_abc' });

      const params = lastScanParams()!;
      expect(params).not.toBeNull();
      expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :_tombstone_prefix\)/);
      expect(params.ExpressionAttributeValues[':_tombstone_prefix']).toBe('deleted_');
    });

    it('preserves the caller filter expression alongside the tombstone guard', async () => {
      await (userDb as any).scanWithFilter('stripe_customer_id = :cid', { ':cid': 'cus_abc' });

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/stripe_customer_id = :cid/);
      expect(params.ExpressionAttributeValues[':cid']).toBe('cus_abc');
    });

    it('returns items from the scan result', async () => {
      mockScanPromise.mockResolvedValueOnce({
        Items: [{ userId: 'user-123', email: 'live@example.com' }],
      });

      const results = await (userDb as any).scanWithFilter('stripe_customer_id = :cid', { ':cid': 'cus_abc' });
      expect(results).toHaveLength(1);
      expect(results[0].userId).toBe('user-123');
    });
  });

  // ── getUserByStripeCustomerId ─────────────────────────────────────────────
  describe('getUserByStripeCustomerId', () => {
    it('includes NOT begins_with tombstone guard in FilterExpression', async () => {
      await userDb.getUserByStripeCustomerId('cus_xyz');

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
      expect(params.ExpressionAttributeValues[':tombstone']).toBe('deleted_');
    });

    it('filters by stripe_customer_id', async () => {
      await userDb.getUserByStripeCustomerId('cus_xyz');

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/stripe_customer_id = :scid/);
      expect(params.ExpressionAttributeValues[':scid']).toBe('cus_xyz');
    });

    it('returns null when scan returns no items', async () => {
      const result = await userDb.getUserByStripeCustomerId('cus_xyz');
      expect(result).toBeNull();
    });
  });

  // ── getUserByStripeConnectedAccountId ─────────────────────────────────────
  describe('getUserByStripeConnectedAccountId', () => {
    it('includes NOT begins_with tombstone guard in FilterExpression', async () => {
      await userDb.getUserByStripeConnectedAccountId('acct_abc');

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
      expect(params.ExpressionAttributeValues[':tombstone']).toBe('deleted_');
    });

    it('filters by stripeConnectedAccountId', async () => {
      await userDb.getUserByStripeConnectedAccountId('acct_abc');

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/stripeConnectedAccountId = :cid/);
      expect(params.ExpressionAttributeValues[':cid']).toBe('acct_abc');
    });
  });

  // ── getUserByResetToken ───────────────────────────────────────────────────
  describe('getUserByResetToken', () => {
    it('includes NOT begins_with tombstone guard in FilterExpression', async () => {
      await userDb.getUserByResetToken('some-token');

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
      expect(params.ExpressionAttributeValues![':tombstone']).toBe('deleted_');
    });

    it('returns null when token belongs to tombstoned account', async () => {
      // DynamoDB expression excludes tombstones, so Items is empty
      const result = await userDb.getUserByResetToken('stale-token');
      expect(result).toBeNull();
    });
  });

  // ── getUsersByEmailDomain ─────────────────────────────────────────────────
  describe('getUsersByEmailDomain', () => {
    it('includes NOT begins_with tombstone guard in FilterExpression', async () => {
      await userDb.getUsersByEmailDomain('okareo.com');

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/NOT begins_with\(userId, :tombstone\)/);
      expect(params.ExpressionAttributeValues![':tombstone']).toBe('deleted_');
    });

    it('filters by emailDomain', async () => {
      await userDb.getUsersByEmailDomain('okareo.com');

      const params = lastScanParams()!;
      expect(params.FilterExpression).toMatch(/emailDomain = :emailDomain/);
      expect(params.ExpressionAttributeValues![':emailDomain']).toBe('okareo.com');
    });
  });
});
