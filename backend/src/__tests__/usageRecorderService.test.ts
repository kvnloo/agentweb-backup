/**
 * Tests for the fire-and-forget usage recorder.
 *
 * ACCEPTANCE CRITERION (Ship 1): usage analytics must never break chat — when
 * the db adapter throws (sync or async), recordUsage resolves without throwing.
 */

jest.mock('../services/usageRecordDb', () => ({
  usageRecordDb: {
    incrementUsage: jest.fn(),
  },
}));

import { usageRecordDb } from '../services/usageRecordDb';
import {
  recordUsage,
  computeCostMicroUsd,
  __resetErrorLogThrottleForTests,
} from '../services/usageRecorderService';
import { __resetUnknownModelWarnsForTests } from '../utils/llmPricing';

const mockIncrement = usageRecordDb.incrementUsage as jest.Mock;

const baseCtx = {
  userId: 'user-1',
  model: 'anthropic.claude-sonnet-4-6',
  provider: 'bedrock',
  feature: 'agent-chat',
  inputTokens: 1000,
  outputTokens: 200,
};

describe('usageRecorderService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    __resetErrorLogThrottleForTests();
    __resetUnknownModelWarnsForTests();
    mockIncrement.mockResolvedValue(undefined);
  });

  describe('fail-open behavior (acceptance criterion)', () => {
    it('resolves without throwing when the db adapter rejects', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIncrement.mockRejectedValue(new Error('DynamoDB is down'));

      await expect(recordUsage(baseCtx)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('resolves without throwing when the db adapter throws synchronously', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIncrement.mockImplementation(() => {
        throw new Error('sync explosion');
      });

      await expect(recordUsage(baseCtx)).resolves.toBeUndefined();
    });

    it('logs at most once per minute on repeated failure', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIncrement.mockRejectedValue(new Error('still down'));

      await recordUsage(baseCtx);
      await recordUsage(baseCtx);
      await recordUsage(baseCtx);

      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('recording', () => {
    it('writes the increment with computed integer microdollar cost', async () => {
      await recordUsage({ ...baseCtx, cacheReadTokens: 100, cacheWriteTokens: 40 });

      expect(mockIncrement).toHaveBeenCalledTimes(1);
      const inc = mockIncrement.mock.calls[0][0];
      // Sonnet: in $3/M, out $15/M, cacheRead $0.3/M, cacheWrite $3.75/M
      // microUsd = 1000*3 + 200*15 + 100*0.3 + 40*3.75 = 3000+3000+30+150 = 6180
      expect(inc.costMicroUsd).toBe(6180);
      expect(Number.isInteger(inc.costMicroUsd)).toBe(true);
      expect(inc.userId).toBe('user-1');
      expect(inc.model).toBe('anthropic.claude-sonnet-4-6');
      expect(inc.feature).toBe('agent-chat');
      expect(inc.inputTokens).toBe(1000);
      expect(inc.outputTokens).toBe(200);
      expect(inc.cacheReadTokens).toBe(100);
      expect(inc.cacheWriteTokens).toBe(40);
      expect(inc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('records under userId "system" when userId is missing (platform overhead stays visible)', async () => {
      await recordUsage({ ...baseCtx, userId: undefined });
      const inc = mockIncrement.mock.calls[0][0];
      expect(inc.userId).toBe('system');
      expect(inc.billingUserId).toBe('system');
    });

    it('defaults billingUserId to userId, and respects an explicit billingUserId / onBehalfOf', async () => {
      await recordUsage(baseCtx);
      expect(mockIncrement.mock.calls[0][0].billingUserId).toBe('user-1');

      await recordUsage({ ...baseCtx, billingUserId: 'org-owner', onBehalfOf: 'client-7' });
      const inc = mockIncrement.mock.calls[1][0];
      expect(inc.billingUserId).toBe('org-owner');
      expect(inc.onBehalfOf).toBe('client-7');
    });

    it('records cost 0 (with a pricing warn) for unknown models — tokens still counted', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await recordUsage({ ...baseCtx, model: 'mystery-model-x' });

      const inc = mockIncrement.mock.calls[0][0];
      expect(inc.costMicroUsd).toBe(0);
      expect(inc.inputTokens).toBe(1000);
      expect(inc.outputTokens).toBe(200);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('sanitizes negative / fractional token counts', async () => {
      await recordUsage({ ...baseCtx, inputTokens: -5, outputTokens: 10.6 });
      const inc = mockIncrement.mock.calls[0][0];
      expect(inc.inputTokens).toBe(0);
      expect(inc.outputTokens).toBe(11);
    });
  });

  describe('computeCostMicroUsd', () => {
    it('computes token cost in integer microdollars', () => {
      // gpt-5-chat-2: in $2.5/M, out $10/M
      expect(computeCostMicroUsd('gpt-5-chat-2', 1_000_000, 100_000)).toBe(
        2_500_000 + 1_000_000
      );
    });

    it('prices cache reads and writes when present', () => {
      // opus: in $15/M → cacheRead $1.5/M, cacheWrite $18.75/M
      expect(
        computeCostMicroUsd('anthropic.claude-opus-4-6-v1', 0, 0, 1000, 1000)
      ).toBe(Math.round(1000 * 1.5 + 1000 * 18.75));
    });

    it('returns 0 for unknown models', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(computeCostMicroUsd('nope-model', 1_000_000, 1_000_000)).toBe(0);
    });
  });
});
