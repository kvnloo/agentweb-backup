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
  checkAndAlert,
  computeWarnLevel,
  __resetV0CreditsCacheForTests,
  LOW_TOTAL_SPENDABLE_USD,
  CRITICAL_TOTAL_SPENDABLE_USD,
  V0_CREDITS_CACHE_TTL_MS,
  V0_ALERT_REALERT_WINDOW_MS,
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
      // $12.76 spendable is above the $10 low-water mark (ENG-585)
      expect(dto.warnLevel).toBe('ok');
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

  describe('warnLevel thresholds (ENG-585: total spendable is the ONLY trigger)', () => {
    it('exports the documented threshold constants', () => {
      expect(LOW_TOTAL_SPENDABLE_USD).toBe(10);
      expect(CRITICAL_TOTAL_SPENDABLE_USD).toBe(5);
    });

    it('returns ok when balances are healthy', () => {
      expect(computeWarnLevel(80)).toBe('ok');
    });

    it('returns low when total spendable is under $10', () => {
      expect(computeWarnLevel(9.99)).toBe('low');
    });

    it('returns critical when total spendable is under $5', () => {
      expect(computeWarnLevel(4.99)).toBe('critical');
    });

    it('boundary: exactly $10 total is still ok', () => {
      expect(computeWarnLevel(10)).toBe('ok');
    });

    it('boundary: exactly $5 total is low, not critical', () => {
      expect(computeWarnLevel(5)).toBe('low');
    });

    it('end-to-end: healthy fixture balances produce warnLevel ok', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      billing.data.balance = { remaining: 30, total: 30 };
      billing.data.onDemand.balance = 50;
      mockV0Api({ billing });

      const dto = await getV0Credits();
      expect(dto.warnLevel).toBe('ok');
    });

    // AC #1 (ENG-585): the exact state behind the daily 2026-07-27 alert —
    // monthly $2.00/$30.00, on-demand $51.81 → $53.81 spendable — must be ok.
    it('end-to-end: $53.81 spendable with a nearly-exhausted monthly bucket is ok', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      billing.data.balance = { remaining: 2, total: 30 };
      billing.data.onDemand.balance = 51.81;
      mockV0Api({ billing });

      const dto = await getV0Credits();
      expect(dto.totalSpendableUsd).toBe(53.81);
      expect(dto.warnLevel).toBe('ok');
    });

    // AC #3 (ENG-585): a fully exhausted monthly allowance alone never alerts —
    // on-demand credit covers generation, so this state was pure daily noise.
    it('end-to-end: exhausted monthly allowance with on-demand credit left is ok', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      billing.data.balance = { remaining: 0, total: 30 };
      billing.data.onDemand.balance = 100;
      mockV0Api({ billing });

      const dto = await getV0Credits();
      expect(dto.warnLevel).toBe('ok');
    });

    it('end-to-end: exhausted monthly AND near-empty on-demand is critical', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      billing.data.balance = { remaining: 0, total: 30 };
      billing.data.onDemand.balance = 3.5;
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

  describe('in-flight dedup (cache stampede)', () => {
    /** Mock every endpoint with a deferred resolver so the fetch stays in flight
     *  until the test explicitly releases it. */
    function mockV0ApiDeferred() {
      const deferred: Array<{ url: string; resolve: (v: any) => void }> = [];
      mockedGet.mockImplementation(
        (url: string) => new Promise((resolve) => deferred.push({ url, resolve }))
      );
      const release = () => {
        for (const d of deferred) {
          if (d.url.includes('/user/billing')) {
            d.resolve({ data: JSON.parse(JSON.stringify(BILLING_FIXTURE)) });
          } else if (d.url.includes('/user/plan')) {
            d.resolve({ data: JSON.parse(JSON.stringify(PLAN_FIXTURE)) });
          } else {
            d.resolve({ data: JSON.parse(JSON.stringify(RATE_LIMITS_FIXTURE)) });
          }
        }
      };
      return { release };
    }

    const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

    it('two concurrent callers share ONE v0 fetch', async () => {
      const { release } = mockV0ApiDeferred();

      const p1 = getV0Credits();
      const p2 = getV0Credits();
      await flushMicrotasks(); // let both reach the HTTP layer

      // One set of 3 endpoint requests — not 6.
      expect(mockedGet).toHaveBeenCalledTimes(3);

      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(mockedGet).toHaveBeenCalledTimes(3);
      expect(r1).toEqual(r2);
      expect(r1.totalSpendableUsd).toBe(12.76);
    });

    it('forceRefresh racing an in-flight fetch joins it instead of stampeding', async () => {
      const { release } = mockV0ApiDeferred();

      const natural = getV0Credits(); // e.g. dashboard load after natural expiry
      const refresh = getV0Credits({ forceRefresh: true }); // refresh button racing it
      await flushMicrotasks();

      expect(mockedGet).toHaveBeenCalledTimes(3);

      release();
      const [r1, r2] = await Promise.all([natural, refresh]);
      expect(r1).toEqual(r2);
    });

    it('clears the in-flight slot after failure so the next call retries', async () => {
      mockV0Api({ failEndpoint: 'billing' });
      await expect(getV0Credits()).rejects.toThrow();

      mockV0Api();
      const dto = await getV0Credits();
      expect(dto.totalSpendableUsd).toBe(12.76);
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

  describe('checkAndAlert — low-credit alerting', () => {
    /** Billing fixture tuned to produce a specific warnLevel. */
    function billingAtLevel(level: 'ok' | 'low' | 'critical') {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      if (level === 'ok') {
        billing.data.balance = { remaining: 30, total: 30 };
        billing.data.onDemand.balance = 50; // $80 spendable
      } else if (level === 'low') {
        billing.data.balance = { remaining: 2, total: 30 };
        billing.data.onDemand.balance = 6; // $8 spendable → low
      } else {
        billing.data.balance = { remaining: 0, total: 30 };
        billing.data.onDemand.balance = 3; // $3 spendable → critical
      }
      return billing;
    }

    /** Switch the mocked v0 account to a level AND expire the credits cache. */
    function setLevelAndExpireCache(level: 'ok' | 'low' | 'critical') {
      mockV0Api({ billing: billingAtLevel(level) });
      jest.setSystemTime(new Date(Date.now() + V0_CREDITS_CACHE_TTL_MS + 1));
    }

    let transport: jest.Mock;

    beforeEach(() => {
      transport = jest.fn().mockResolvedValue(undefined);
      mockV0Api({ billing: billingAtLevel('low') });
    });

    it('fires once on transition into low, with the balances and action line', async () => {
      const result = await checkAndAlert({ transport });

      expect(result).toEqual({ warnLevel: 'low', alerted: true, recovered: false });
      expect(transport).toHaveBeenCalledTimes(1);
      const [subject, message] = transport.mock.calls[0];
      expect(subject).toContain('LOW');
      expect(subject).toContain('$8.00');
      expect(message).toContain('Plan: v0-team');
      expect(message).toContain('Total spendable: $8.00');
      expect(message).toContain('Monthly allowance: $2.00 of $30.00');
      expect(message).toContain('top up v0 credits');
    });

    // AC #1 (ENG-585): the daily-noise state — $53.81 spendable, monthly bucket
    // nearly exhausted — must send NOTHING through the oncall transport.
    it('sends no alert at $53.81 spendable even with the monthly bucket at $2.00/$30.00', async () => {
      const billing = JSON.parse(JSON.stringify(BILLING_FIXTURE));
      billing.data.balance = { remaining: 2, total: 30 };
      billing.data.onDemand.balance = 51.81;
      mockV0Api({ billing });

      const result = await checkAndAlert({ transport });

      expect(result).toEqual({ warnLevel: 'ok', alerted: false, recovered: false });
      expect(transport).not.toHaveBeenCalled();
    });

    // ENG-358: the alert context must carry the intake gate's clustering keys so every occurrence
    // dedupes onto the ONE open canonical regardless of the balance in the subject line.
    it('low alert context carries Alert Class "v0-credits" + Alert Priority "high" (ENG-358)', async () => {
      await checkAndAlert({ transport });
      const context = transport.mock.calls[0][2];
      expect(context).toMatchObject({ 'Alert Class': 'v0-credits', 'Alert Priority': 'high' });
    });

    it('critical alert context escalates Alert Priority to "urgent" under the same Alert Class (ENG-358)', async () => {
      mockV0Api({ billing: billingAtLevel('critical') });
      await checkAndAlert({ transport });
      const context = transport.mock.calls[0][2];
      expect(context).toMatchObject({ 'Alert Class': 'v0-credits', 'Alert Priority': 'urgent' });
    });

    it('does not re-fire for the same level within the 24h window', async () => {
      await checkAndAlert({ transport });

      // Same tick cadence as the cron: an hour later, still low.
      jest.setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
      const second = await checkAndAlert({ transport });

      expect(second).toEqual({ warnLevel: 'low', alerted: false, recovered: false });
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it('re-fires for the same level once the 24h window elapses', async () => {
      await checkAndAlert({ transport });

      jest.setSystemTime(new Date(Date.now() + V0_ALERT_REALERT_WINDOW_MS + 1));
      const result = await checkAndAlert({ transport });

      expect(result.alerted).toBe(true);
      expect(transport).toHaveBeenCalledTimes(2);
    });

    it('fires immediately on escalation low → critical', async () => {
      await checkAndAlert({ transport });

      setLevelAndExpireCache('critical');
      const result = await checkAndAlert({ transport });

      expect(result).toEqual({ warnLevel: 'critical', alerted: true, recovered: false });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[1][0]).toContain('CRITICAL');
    });

    it('recovery to ok resets state (and sends an all-clear) so a later dip re-alerts', async () => {
      await checkAndAlert({ transport });
      expect(transport).toHaveBeenCalledTimes(1);

      setLevelAndExpireCache('ok');
      const recovery = await checkAndAlert({ transport });
      expect(recovery).toEqual({ warnLevel: 'ok', alerted: false, recovered: true });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(transport.mock.calls[1][0]).toContain('recovered');

      // Dip again — state was reset, so it alerts immediately (no 24h suppression).
      setLevelAndExpireCache('low');
      const dip = await checkAndAlert({ transport });
      expect(dip.alerted).toBe(true);
      expect(transport).toHaveBeenCalledTimes(3);
    });

    it('stays quiet when the account is ok and nothing was previously alerted', async () => {
      mockV0Api({ billing: billingAtLevel('ok') });

      const result = await checkAndAlert({ transport });

      expect(result).toEqual({ warnLevel: 'ok', alerted: false, recovered: false });
      expect(transport).not.toHaveBeenCalled();
    });

    it('logs (console.error) and does not throw when the alert transport fails — and retries next tick', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      transport.mockRejectedValueOnce(new Error('slack down'));

      const failed = await checkAndAlert({ transport });
      expect(failed).toEqual({ warnLevel: 'low', alerted: false, recovered: false });
      expect(consoleError).toHaveBeenCalledWith(
        '[v0CreditAlert] Failed to send low-credit alert:',
        expect.any(Error)
      );

      // State was NOT advanced — the next tick retries and succeeds.
      const retried = await checkAndAlert({ transport });
      expect(retried.alerted).toBe(true);

      consoleError.mockRestore();
    });

    it('propagates v0 API failures to the caller (the cron wrapper logs them)', async () => {
      mockV0Api({ failEndpoint: 'billing' });

      await expect(checkAndAlert({ transport })).rejects.toThrow(/v0/i);
      expect(transport).not.toHaveBeenCalled();
    });
  });
});
