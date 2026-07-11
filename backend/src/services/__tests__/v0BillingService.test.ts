/**
 * Tests for v0BillingService — normalization of real v0 API shapes,
 * warn-level thresholds, 5-minute cache TTL, and loud failure on API errors.
 *
 * Fixture shapes were pinned against the live v0 API (2026-07-11):
 *   GET https://api.v0.dev/v1/user/plan
 *   GET https://api.v0.dev/v1/user/billing
 *   GET https://api.v0.dev/v1/rate-limits
 */

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../utils/secretsManager', () => ({
  getV0ApiKey: jest.fn().mockResolvedValue('v0-test-key'),
}));

import axios from 'axios';
import {
  getV0Credits,
  computeWarnLevel,
  __resetV0CreditsCacheForTests,
  LOW_TOTAL_SPENDABLE_USD,
  CRITICAL_TOTAL_SPENDABLE_USD,
  LOW_MONTHLY_REMAINING_FRACTION,
  V0_CREDITS_CACHE_TTL_MS,
} from '../v0BillingService';

const mockedGet = axios.get as jest.Mock;

// ── Fixtures: exact shapes observed from the live v0 API ─────────────────────

const PLAN_FIXTURE = {
  object: 'plan',
  plan: 'v0-team',
  billingCycle: { start: 1781938800000, end: 1784530800000 },
  balance: { remaining: 2, total: 30 },
};

const BILLING_FIXTURE = {
  billingType: 'token',
  data: {
    plan: 'v0-team',
    role: 'OWNER',
    billingCycle: { start: 1781938800000, end: 1784530800000 },
    balance: { remaining: 2, total: 30 },
    onDemand: {
      balance: 10.7621578,
      blocks: [
        {
          expirationDate: 1814400000000,
          effectiveDate: 1782909195324,
          originalBalance: 50,
          currentBalance: 10.7621578,
        },
      ],
    },
  },
};

const RATE_LIMITS_FIXTURE = {
  remaining: 250,
  reset: 1783814400000,
  limit: 250,
  dailyLimit: { limit: 7, remaining: 7, reset: 1783814400000, isWithinGracePeriod: false },
};

/** Route each endpoint URL to its fixture (deep-cloned so tests can mutate). */
function mockV0Api(overrides?: {
  billing?: any;
  plan?: any;
  rateLimits?: any;
  failEndpoint?: 'billing' | 'plan' | 'rate-limits';
}) {
  mockedGet.mockImplementation((url: string) => {
    if (url.includes('/user/billing')) {
      if (overrides?.failEndpoint === 'billing') {
        return Promise.reject(new Error('v0 billing 500'));
      }
      return Promise.resolve({
        data: overrides?.billing ?? JSON.parse(JSON.stringify(BILLING_FIXTURE)),
      });
    }
    if (url.includes('/user/plan')) {
      if (overrides?.failEndpoint === 'plan') {
        return Promise.reject(new Error('v0 plan 500'));
      }
      return Promise.resolve({
        data: overrides?.plan ?? JSON.parse(JSON.stringify(PLAN_FIXTURE)),
      });
    }
    if (url.includes('/rate-limits')) {
      if (overrides?.failEndpoint === 'rate-limits') {
        return Promise.reject(new Error('v0 rate-limits 500'));
      }
      return Promise.resolve({
        data: overrides?.rateLimits ?? JSON.parse(JSON.stringify(RATE_LIMITS_FIXTURE)),
      });
    }
    return Promise.reject(new Error(`Unexpected URL in test: ${url}`));
  });
}

describe('v0BillingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetV0CreditsCacheForTests();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('normalization from real API shapes', () => {
    it('maps plan/billing/rate-limits responses into the stable DTO', async () => {
      mockV0Api();

      const dto = await getV0Credits();

      expect(dto.plan).toBe('v0-team');
      expect(dto.billingCycle).toEqual({ start: 1781938800000, end: 1784530800000 });
      expect(dto.monthly).toEqual({ remaining: 2, total: 30 });
      // remaining from onDemand.balance, total from sum of blocks' originalBalance
      expect(dto.onDemand).toEqual({ remaining: 10.7621578, total: 50 });
      // 2 + 10.7621578, rounded to cents
      expect(dto.totalSpendableUsd).toBe(12.76);
      expect(dto.rateLimits).toEqual({
        limit: 250,
        remaining: 250,
        reset: 1783814400000,
        daily: { limit: 7, remaining: 7, reset: 1783814400000 },
      });
      expect(dto.fetchedAt).toBe('2026-07-11T00:00:00.000Z');
      // $12.76 spendable is below the $25 low-water mark
      expect(dto.warnLevel).toBe('low');
    });

    it('sends the API key as a Bearer token and never as a query param', async () => {
      mockV0Api();
      await getV0Credits();

      expect(mockedGet).toHaveBeenCalledTimes(3);
      for (const [url, config] of mockedGet.mock.calls) {
        expect(url).not.toContain('v0-test-key');
        expect(config.headers.Authorization).toBe('Bearer v0-test-key');
      }
    });

    it('treats a missing onDemand section as zero on-demand balance (still real data)', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      delete billing.data.onDemand;
      mockV0Api({ billing });

      const dto = await getV0Credits();
      expect(dto.onDemand).toEqual({ remaining: 0, total: 0 });
      expect(dto.totalSpendableUsd).toBe(2);
    });

    it('falls back to the plan endpoint balance when billing omits it', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      delete billing.data.balance;
      mockV0Api({ billing });

      const dto = await getV0Credits();
      expect(dto.monthly).toEqual({ remaining: 2, total: 30 });
    });
  });

  describe('warnLevel thresholds', () => {
    it('exports the documented threshold constants', () => {
      expect(LOW_TOTAL_SPENDABLE_USD).toBe(25);
      expect(CRITICAL_TOTAL_SPENDABLE_USD).toBe(10);
      expect(LOW_MONTHLY_REMAINING_FRACTION).toBe(0.2);
    });

    it('returns ok when balances are healthy', () => {
      expect(computeWarnLevel(80, { remaining: 30, total: 30 })).toBe('ok');
    });

    it('returns low when total spendable is under $25', () => {
      expect(computeWarnLevel(24.99, { remaining: 30, total: 30 })).toBe('low');
    });

    it('returns low when monthly remaining is under 20%', () => {
      expect(computeWarnLevel(105, { remaining: 5, total: 30 })).toBe('low');
    });

    it('returns critical when total spendable is under $10', () => {
      expect(computeWarnLevel(9.99, { remaining: 30, total: 30 })).toBe('critical');
    });

    it('returns critical when the monthly allowance is exhausted', () => {
      expect(computeWarnLevel(100, { remaining: 0, total: 30 })).toBe('critical');
    });

    it('boundary: exactly $25 total and exactly 20% monthly is still ok', () => {
      expect(computeWarnLevel(25, { remaining: 6, total: 30 })).toBe('ok');
    });

    it('end-to-end: healthy fixture balances produce warnLevel ok', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      billing.data.balance = { remaining: 30, total: 30 };
      billing.data.onDemand.balance = 50;
      mockV0Api({ billing });

      const dto = await getV0Credits();
      expect(dto.warnLevel).toBe('ok');
    });

    it('end-to-end: exhausted monthly allowance produces warnLevel critical', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      billing.data.balance = { remaining: 0, total: 30 };
      billing.data.onDemand.balance = 100;
      mockV0Api({ billing });

      const dto = await getV0Credits();
      expect(dto.warnLevel).toBe('critical');
    });
  });

  describe('cache TTL (5 minutes)', () => {
    it('serves the cached DTO within the TTL without re-hitting v0', async () => {
      mockV0Api();

      const first = await getV0Credits();
      jest.setSystemTime(new Date('2026-07-11T00:04:59.000Z'));
      const second = await getV0Credits();

      expect(mockedGet).toHaveBeenCalledTimes(3); // one fetch of 3 endpoints total
      expect(second).toEqual(first);
    });

    it('refetches after the TTL expires', async () => {
      mockV0Api();

      await getV0Credits();
      jest.setSystemTime(new Date(Date.now() + V0_CREDITS_CACHE_TTL_MS + 1));
      const dto = await getV0Credits();

      expect(mockedGet).toHaveBeenCalledTimes(6);
      expect(dto.fetchedAt).toBe(new Date(Date.now()).toISOString());
    });

    it('forceRefresh bypasses a fresh cache', async () => {
      mockV0Api();

      await getV0Credits();
      await getV0Credits({ forceRefresh: true });

      expect(mockedGet).toHaveBeenCalledTimes(6);
    });
  });

  describe('failure handling — loud, never fabricated', () => {
    it.each(['billing', 'plan', 'rate-limits'] as const)(
      'rejects when the %s endpoint fails',
      async (failEndpoint) => {
        mockV0Api({ failEndpoint });
        await expect(getV0Credits()).rejects.toThrow(/v0/i);
      }
    );

    it('does not cache failures — the next call retries', async () => {
      mockV0Api({ failEndpoint: 'billing' });
      await expect(getV0Credits()).rejects.toThrow();

      mockV0Api();
      const dto = await getV0Credits();
      expect(dto.totalSpendableUsd).toBe(12.76);
    });

    it('rejects (rather than fabricating zeros) when no balance data exists anywhere', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      delete billing.data.balance;
      const plan = JSON.parse(JSON.stringify(PLAN_FIXTURE));
      delete plan.balance;
      mockV0Api({ billing, plan });

      await expect(getV0Credits()).rejects.toThrow(/balance/i);
    });

    it('rejects when getV0ApiKey fails', async () => {
      const { getV0ApiKey } = jest.requireMock('../../utils/secretsManager');
      (getV0ApiKey as jest.Mock).mockRejectedValueOnce(new Error('secrets down'));
      mockV0Api();

      await expect(getV0Credits()).rejects.toThrow('secrets down');
    });
  });
});
