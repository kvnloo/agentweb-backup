/**
 * Tests for usageAnalyticsService (admin shadow-usage read models).
 */

jest.mock('../services/usageRecordDb', () => ({
  usageRecordDb: {
    queryByUserDateRange: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

import { usageRecordDb } from '../services/usageRecordDb';
import { userDb } from '../services/db';
import {
  getUserUsageByModelDay,
  getUsageComparison,
} from '../services/usageAnalyticsService';

const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;
const mockGetUser = userDb.getUserById as jest.Mock;

const row = (overrides: any = {}) => ({
  userId: 'user-1',
  sk: '2026-06-02#gpt-5-chat-2#agent-chat',
  date: '2026-06-02',
  model: 'gpt-5-chat-2',
  feature: 'agent-chat',
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 1100,
  costMicroUsd: 3500,
  callCount: 3,
  billingUserId: 'user-1',
  updatedAt: '2026-06-02T01:00:00.000Z',
  ttl: 1780000000,
  ...overrides,
});

describe('usageAnalyticsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    mockGetUser.mockResolvedValue(null);
  });

  describe('getUserUsageByModelDay', () => {
    it('rejects malformed dates', async () => {
      await expect(getUserUsageByModelDay('u', 'June 1', '2026-06-30')).rejects.toThrow(
        'YYYY-MM-DD'
      );
      await expect(getUserUsageByModelDay('u', '2026-06-01', '06-30-2026')).rejects.toThrow(
        'YYYY-MM-DD'
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects an inverted range', async () => {
      await expect(getUserUsageByModelDay('u', '2026-06-30', '2026-06-01')).rejects.toThrow(
        'start must be <= end'
      );
    });

    it('returns sorted rows with USD conversion and aggregate totals', async () => {
      mockQuery.mockResolvedValue([
        row({ date: '2026-06-03', sk: '2026-06-03#gpt-5-chat-2#agent-chat', costMicroUsd: 1_000_000 }),
        row(),
        row({
          model: 'anthropic.claude-sonnet-4-6',
          sk: '2026-06-02#anthropic.claude-sonnet-4-6#emma',
          feature: 'emma',
          costMicroUsd: 500_000,
          callCount: 1,
        }),
      ]);

      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');

      expect(mockQuery).toHaveBeenCalledWith('user-1', '2026-06-01', '2026-06-30');
      expect(result.rows.map((r) => `${r.date}|${r.model}`)).toEqual([
        '2026-06-02|anthropic.claude-sonnet-4-6',
        '2026-06-02|gpt-5-chat-2',
        '2026-06-03|gpt-5-chat-2',
      ]);
      expect(result.rows[2].costUsd).toBe(1);
      expect(result.totals.totalTokens).toBe(3300);
      expect(result.totals.callCount).toBe(7);
      expect(result.totals.costMicroUsd).toBe(1_000_000 + 3500 + 500_000);
    });

    it('computes total cost exactly in micro USD', async () => {
      mockQuery.mockResolvedValue([
        row({ costMicroUsd: 1_000_000 }),
        row({ costMicroUsd: 500_000 }),
      ]);
      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');
      expect(result.totals.costMicroUsd).toBe(1_500_000);
      expect(result.totals.costUsd).toBe(1.5);
    });

    it('returns empty rows and zero totals for a user with no usage', async () => {
      const result = await getUserUsageByModelDay('user-1', '2026-06-01', '2026-06-30');
      expect(result.rows).toEqual([]);
      expect(result.totals).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        callCount: 0,
        costMicroUsd: 0,
        costUsd: 0,
      });
    });
  });

  describe('getUsageComparison', () => {
    it('rejects malformed months', async () => {
      await expect(getUsageComparison('u', '2026-6')).rejects.toThrow('YYYY-MM');
      await expect(getUsageComparison('u', 'June 2026')).rejects.toThrow('YYYY-MM');
    });

    it('compares shadow totals against the current-month legacy counter', async () => {
      mockQuery.mockResolvedValue([
        row({ totalTokens: 1100, costMicroUsd: 3500 }),
        row({ totalTokens: 900, costMicroUsd: 1500 }),
      ]);
      mockGetUser.mockResolvedValue({
        userId: 'user-1',
        tokenUsage: { month: '2026-06', totalTokens: 1800, totalCost: 0.004, resetDate: 'x' },
      });

      const result = await getUsageComparison('user-1', '2026-06');

      expect(mockQuery).toHaveBeenCalledWith('user-1', '2026-06-01', '2026-06-31');
      expect(result.shadow).toEqual({ totalTokens: 2000, costUsd: 0.005, callCount: 6 });
      expect(result.legacy).toEqual({ totalTokens: 1800, costUsd: 0.004, source: 'current' });
      expect(result.delta.totalTokens).toBe(200);
      expect(result.delta.costUsd).toBeCloseTo(0.001, 10);
    });

    it('falls back to tokenUsageHistory for past months', async () => {
      mockGetUser.mockResolvedValue({
        userId: 'user-1',
        tokenUsage: { month: '2026-06', totalTokens: 50, totalCost: 0.1, resetDate: 'x' },
        tokenUsageHistory: [
          { month: '2026-04', totalTokens: 10, totalCost: 0.01 },
          { month: '2026-05', totalTokens: 4000, totalCost: 0.02 },
        ],
      });

      const result = await getUsageComparison('user-1', '2026-05');
      expect(result.legacy).toEqual({ totalTokens: 4000, costUsd: 0.02, source: 'history' });
    });

    it('reports legacy source "none" for unknown users or untracked months', async () => {
      const result = await getUsageComparison('user-1', '2026-01');
      expect(result.legacy).toEqual({ totalTokens: 0, costUsd: 0, source: 'none' });
      expect(result.shadow).toEqual({ totalTokens: 0, costUsd: 0, callCount: 0 });
    });
  });
});
