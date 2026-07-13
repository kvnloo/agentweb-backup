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

const mockIncrementUserTokenUsage = jest.fn();
jest.mock('../services/tokenUsageService', () => ({
  incrementUserTokenUsage: (...a: any[]) => mockIncrementUserTokenUsage(...a),
}));

import { usageRecordDb } from '../services/usageRecordDb';
import {
  recordUsage,
  meterUserUsage,
  computeCostMicroUsd,
  __resetErrorLogThrottleForTests,
} from '../services/usageRecorderService';
import { __resetUnknownModelWarnsForTests } from '../utils/llmPricing';

const mockIncrement = usageRecordDb.incrementUsage as jest.Mock;

const flush = () => new Promise((r) => setImmediate(r));

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
    mockIncrementUserTokenUsage.mockReset().mockResolvedValue(undefined);
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

    it('logs a non-Error rejection value without throwing', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIncrement.mockRejectedValue('plain string failure');

      await expect(recordUsage(baseCtx)).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
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

    it('records an explicit costUsdOverride verbatim (per-generation image/video, not token-priced)', async () => {
      // gemini image model: getModelPrice returns null → token cost would be 0.
      await recordUsage({
        ...baseCtx,
        model: 'gemini-2.5-flash-image',
        inputTokens: 0,
        outputTokens: 0,
        costUsdOverride: 0.039,
      });
      const inc = mockIncrement.mock.calls[0][0];
      expect(inc.costMicroUsd).toBe(39000); // 0.039 USD → microdollars, not 0
      expect(Number.isInteger(inc.costMicroUsd)).toBe(true);
    });

    it('sanitizes negative / fractional token counts', async () => {
      await recordUsage({ ...baseCtx, inputTokens: -5, outputTokens: 10.6 });
      const inc = mockIncrement.mock.calls[0][0];
      expect(inc.inputTokens).toBe(0);
      expect(inc.outputTokens).toBe(11);
    });

    it('treats zero / undefined token counts as 0', async () => {
      await recordUsage({
        ...baseCtx,
        inputTokens: 0,
        outputTokens: undefined as any,
      });
      const inc = mockIncrement.mock.calls[0][0];
      expect(inc.inputTokens).toBe(0);
      expect(inc.outputTokens).toBe(0);
    });

    it('defaults model and feature to "unknown" when both are missing', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      await recordUsage({ ...baseCtx, model: undefined as any, feature: undefined as any });
      const inc = mockIncrement.mock.calls[0][0];
      expect(inc.model).toBe('unknown');
      expect(inc.feature).toBe('unknown');
    });
  });

  describe('meterUserUsage (shadow + enforced per-user cap)', () => {
    it('records to the shadow table AND charges the per-user cap with summed tokens + dollar cost', async () => {
      meterUserUsage({ ...baseCtx, cacheReadTokens: 100, cacheWriteTokens: 40 });
      await flush();

      // Shadow record still happens.
      expect(mockIncrement).toHaveBeenCalledTimes(1);
      // Cap charged: totalTokens = 1000+200+100+40 = 1340; cost = 6180 microUsd = 0.00618 USD.
      expect(mockIncrementUserTokenUsage).toHaveBeenCalledTimes(1);
      const [userId, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(tokens).toBe(1340);
      expect(cost).toBeCloseTo(0.00618, 8);
    });

    it('does NOT charge the cap when no user is attributable (shadow still records under system)', async () => {
      meterUserUsage({ ...baseCtx, userId: undefined });
      await flush();

      expect(mockIncrement).toHaveBeenCalledTimes(1);
      expect(mockIncrement.mock.calls[0][0].userId).toBe('system');
      expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
    });

    it('charges tokens with cost 0 for an unknown model (tokens trustworthy, cost best-effort)', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      meterUserUsage({ ...baseCtx, model: 'mystery-model-x' });
      await flush();

      const [, tokens, cost] = mockIncrementUserTokenUsage.mock.calls[0];
      expect(tokens).toBe(1200); // 1000 + 200
      expect(cost).toBe(0);
    });

    it('skips the cap charge entirely when there is no usage (no tokens, no cost)', async () => {
      meterUserUsage({ ...baseCtx, inputTokens: 0, outputTokens: 0, model: 'mystery-model-x' });
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      await flush();

      expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
    });

    it('never throws when the cap charge rejects (fail-open)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockIncrementUserTokenUsage.mockRejectedValue(new Error('cap write failed'));

      expect(() => meterUserUsage(baseCtx)).not.toThrow();
      await flush();
      expect(errorSpy).toHaveBeenCalled();
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
      // opus 4.6: in $5/M → cacheRead $0.5/M (10%), cacheWrite $6.25/M (125%)
      expect(
        computeCostMicroUsd('anthropic.claude-opus-4-6-v1', 0, 0, 1000, 1000)
      ).toBe(Math.round(1000 * 0.5 + 1000 * 6.25));
    });

    it('prices the deep-research agents (so their per-run cost is counted, not 0)', () => {
      // Priced at Gemini Pro rates: in $1.25/M, out $10/M.
      expect(computeCostMicroUsd('deep-research-preview-04-2026', 1_000_000, 100_000)).toBe(
        1_250_000 + 1_000_000
      );
      expect(computeCostMicroUsd('deep-research-max-preview-04-2026', 1_000_000, 0)).toBe(1_250_000);
    });

    it('returns 0 for unknown models', () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(computeCostMicroUsd('nope-model', 1_000_000, 1_000_000)).toBe(0);
    });

    it('derives cache prices from input price when the entry omits them', () => {
      // text-embedding-3-large is a literal price entry with NO explicit
      // cacheReadPerM/cacheWritePerM, so the `?? inPerM*0.1` / `?? inPerM*1.25`
      // fallbacks apply. in $0.13/M → cacheRead $0.013/M, cacheWrite $0.1625/M.
      expect(
        computeCostMicroUsd('text-embedding-3-large', 0, 0, 1_000_000, 1_000_000)
      ).toBe(Math.round(1_000_000 * 0.013 + 1_000_000 * 0.1625));
    });
  });
});
