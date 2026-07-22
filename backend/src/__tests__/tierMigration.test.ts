/**
 * Tests for:
 * 1. migrateUserTiers — tier migration script
 * 2. isBotEmail — bot detection patterns
 * 3. cleanupBotAccounts — bot cleanup script
 */

// ── Mock AWS SDK before anything imports it ──────────────────────────────

const mockScan = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();

jest.mock('aws-sdk', () => {
  const DocumentClient = jest.fn().mockImplementation(() => ({
    scan: jest.fn().mockImplementation((params: any) => ({
      promise: mockScan,
    })),
    update: jest.fn().mockImplementation((params: any) => ({
      promise: mockUpdate,
    })),
    delete: jest.fn().mockImplementation((params: any) => ({
      promise: mockDelete,
    })),
  }));

  const S3 = jest.fn().mockImplementation(() => ({
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    putObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  }));

  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient },
      S3,
      config: { update: jest.fn() },
    },
    DynamoDB: { DocumentClient },
    S3,
    config: { update: jest.fn() },
  };
});

// Force development mode so scripts don't abort
process.env.NODE_ENV = 'development';

import { isBotEmail } from '../scripts/cleanupBotAccounts';

describe('Tier Migration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── migrateUserTiers ─────────────────────────────────────────────────

  describe('migrateUserTiers', () => {
    let migrateUserTiers: typeof import('../scripts/migrateUserTiers').migrateUserTiers;

    beforeAll(async () => {
      const mod = await import('../scripts/migrateUserTiers');
      migrateUserTiers = mod.migrateUserTiers;
    });

    it('assigns Free tier to users with no subscription_status', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          { email: 'nosubscription@test.com', userId: 'u1' },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.migrated).toBe(1);
      expect(result.freeCount).toBe(1);
      expect(result.basicCount).toBe(0);
    });

    it('assigns Basic tier to active users with stripe subscription', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          {
            email: 'paid@test.com',
            userId: 'u2',
            subscription_status: 'active',
            stripe_subscription_id: 'sub_123',
          },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.migrated).toBe(1);
      expect(result.basicCount).toBe(1);
      expect(result.freeCount).toBe(0);
    });

    it('assigns Free tier to canceled users', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          {
            email: 'canceled@test.com',
            userId: 'u3',
            subscription_status: 'canceled',
            stripe_subscription_id: 'sub_456',
          },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.migrated).toBe(1);
      expect(result.freeCount).toBe(1);
    });

    it('assigns Free tier to past_due users', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          {
            email: 'pastdue@test.com',
            userId: 'u4',
            subscription_status: 'past_due',
          },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.migrated).toBe(1);
      expect(result.freeCount).toBe(1);
    });

    it('assigns Basic tier to trialing users with stripe subscription', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          {
            email: 'trial@test.com',
            userId: 'u-trial',
            subscription_status: 'trialing',
            stripe_subscription_id: 'sub_trial_789',
          },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.migrated).toBe(1);
      expect(result.basicCount).toBe(1);
      expect(result.freeCount).toBe(0);
    });

    it('assigns Basic tier to canceling users (period not ended)', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          {
            email: 'canceling@test.com',
            userId: 'u-canceling',
            subscription_status: 'canceling',
            stripe_subscription_id: 'sub_cancel_abc',
          },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.migrated).toBe(1);
      expect(result.basicCount).toBe(1);
      expect(result.freeCount).toBe(0);
    });

    it('is idempotent — skips users who already have subscriptionType + allowedPages', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          {
            email: 'already@test.com',
            userId: 'u5',
            subscriptionType: 'Basic',
            allowedPages: ['/'],
          },
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await migrateUserTiers();

      expect(result.skipped).toBe(1);
      expect(result.migrated).toBe(0);
      // No updates should have been attempted
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('back-fills allowedPages when subscriptionType exists but allowedPages is missing', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          {
            email: 'halfmigrated@test.com',
            userId: 'u6',
            subscriptionType: 'Basic',
            // No allowedPages
          },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.backfilled).toBe(1);
      expect(result.migrated).toBe(0);
    });

    it('handles mixed batch of users correctly', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          // Already configured
          { email: 'done@test.com', userId: 'u1', subscriptionType: 'Free', allowedPages: ['/'] },
          // Needs migration (active paid)
          { email: 'active@test.com', userId: 'u2', subscription_status: 'active', stripe_subscription_id: 'sub_1' },
          // Needs migration (no status)
          { email: 'new@test.com', userId: 'u3' },
          // Needs back-fill
          { email: 'partial@test.com', userId: 'u4', subscriptionType: 'Super Premium' },
        ],
        LastEvaluatedKey: undefined,
      });
      mockUpdate.mockResolvedValue({});

      const result = await migrateUserTiers();

      expect(result.total).toBe(4);
      expect(result.skipped).toBe(1);
      expect(result.migrated).toBe(2);
      expect(result.backfilled).toBe(1);
      expect(result.basicCount).toBe(1);
      expect(result.freeCount).toBe(1);
    });

    it('skips users with no email', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [{ userId: 'u-no-email' }],
        LastEvaluatedKey: undefined,
      });

      const result = await migrateUserTiers();

      expect(result.skipped).toBe(1);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  // ─── isBotEmail ───────────────────────────────────────────────────────

  describe('isBotEmail', () => {
    it('detects excessive-dot pattern', () => {
      expect(isBotEmail('l.i.j.o.ba.yug.ido.4.7@gmail.com')).toBe(true);
      expect(isBotEmail('a.b.c.d.e@gmail.com')).toBe(true);
    });

    it('does not flag normal gmail addresses with a few dots', () => {
      expect(isBotEmail('john.smith@gmail.com')).toBe(false);
      expect(isBotEmail('first.last@example.com')).toBe(false);
    });

    it('detects high digit ratio in local part', () => {
      expect(isBotEmail('a1b2c3d4e5@gmail.com')).toBe(true);
      expect(isBotEmail('x123456@hotmail.com')).toBe(true);
    });

    it('does not flag normal emails with some digits', () => {
      expect(isBotEmail('john123@example.com')).toBe(false);
      expect(isBotEmail('user42@company.com')).toBe(false);
    });

    it('detects known disposable email domains', () => {
      expect(isBotEmail('test@mailinator.com')).toBe(true);
      expect(isBotEmail('test@yopmail.com')).toBe(true);
      expect(isBotEmail('test@guerrillamail.com')).toBe(true);
    });

    it('returns false for null/undefined/empty', () => {
      expect(isBotEmail('')).toBe(false);
      expect(isBotEmail(null as any)).toBe(false);
      expect(isBotEmail(undefined as any)).toBe(false);
    });

    it('returns false for legitimate emails', () => {
      expect(isBotEmail('someuser@gmail.com')).toBe(false);
      expect(isBotEmail('test@example.com')).toBe(false);
      expect(isBotEmail('harsha@agentweb.pro')).toBe(false);
    });
  });

  // ─── cleanupBotAccounts ───────────────────────────────────────────────

  describe('cleanupBotAccounts', () => {
    let cleanupBotAccounts: typeof import('../scripts/cleanupBotAccounts').cleanupBotAccounts;

    beforeAll(async () => {
      const mod = await import('../scripts/cleanupBotAccounts');
      cleanupBotAccounts = mod.cleanupBotAccounts;
    });

    it('dry-run lists bot accounts without deleting', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          { email: 'l.i.j.o.ba.yug.ido.4.7@gmail.com', userId: 'bot1' },
          { email: 'legit@example.com', userId: 'u1' },
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await cleanupBotAccounts(false);

      expect(result.botCount).toBe(1);
      expect(result.deleted).toBe(0);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('execute mode deletes bot accounts', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          { email: 'a.b.c.d.e.f@gmail.com', userId: 'bot1' },
          { email: 'legit@example.com', userId: 'u1' },
        ],
        LastEvaluatedKey: undefined,
      });
      mockDelete.mockResolvedValue({});

      const result = await cleanupBotAccounts(true);

      expect(result.botCount).toBe(1);
      expect(result.deleted).toBe(1);
    });

    it('never deletes admin accounts even in execute mode', async () => {
      mockScan.mockResolvedValueOnce({
        Items: [
          { email: 'a.b.c.d.e.f@gmail.com', userId: 'admin1', isAdmin: true },
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await cleanupBotAccounts(true);

      expect(result.botCount).toBe(1);
      expect(result.deleted).toBe(0);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
