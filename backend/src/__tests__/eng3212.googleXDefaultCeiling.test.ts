/**
 * ENG-3212 — Google and X Toolkit budget writes have a built-in spend ceiling when their env var
 * is unset (prod EB cannot take more env vars): $500/day, at most 2x per change. A set env var
 * fully replaces the default; a malformed one still fails closed.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../mcp/zomaOnboarding', () => ({
  assertZomaWriteReady: jest.fn(),
  ZomaNotReadyError: class ZomaNotReadyError extends Error {},
}));

import {
  DEFAULT_GOOGLE_X_SPEND_CEILING, defaultGoogleToolkitWriteDeps, executeGoogleToolkitWrite, googleSpendCeilingPolicyFromEnv, type GoogleToolkitWriteDeps,
} from '../mcp/googleToolkitWrites';
import { defaultXAdsWriteDeps, executeXAdsWrite, type XAdsWriteDeps } from '../mcp/xAdsToolkitWrites';

const NOW = Date.parse('2026-11-27T00:00:00Z');
const CID = '1234567890';
const BUDGET = `customers/${CID}/campaignBudgets/55`;

function googleDeps(raw: string | undefined): GoogleToolkitWriteDeps & { dispatch: jest.Mock } {
  const budget = { resourceName: BUDGET, name: 'Daily', amountMicros: 200_000_000, explicitlyShared: false, referenceCount: 1 };
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u: string, _c: string, _k: string, rn: string) => (rn === BUDGET ? { ...budget } : null)),
    dispatch: jest.fn().mockResolvedValue({ success: true }),
    spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv(raw),
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
  };
}
const gCreate = (amount: number) => ({ customer_id: CID, entity_type: 'BUDGET', action: 'CREATE', name: 'New', amount });
const gUpdate = (amount: number) => ({ customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount });

const session = { accountId: 'acc1', credentials: { consumerKey: 'ck', consumerSecret: 'cs', token: 't', tokenSecret: 'ts' } };
function xDeps(raw: string | undefined): XAdsWriteDeps & { request: jest.Mock } {
  const lineItem = { id: 'l2', name: 'A', entity_status: 'PAUSED', campaign_id: 'c2', objective: 'ENGAGEMENTS', bid_strategy: 'AUTO', daily_budget_amount_local_micro: 200_000_000 };
  const request = jest.fn(async ({ method = 'GET', path }: any): Promise<any> => {
    if (method === 'GET' && path === '/accounts/acc1/line_items/l2') return { data: { ...lineItem } };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    request: request as any,
    listAll: jest.fn(async () => []),
    spendCeilingPolicy: () => googleSpendCeilingPolicyFromEnv(raw),
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
  };
}
const xUpdate = (daily_budget: number) => ({ entity_type: 'LINE_ITEM', action: 'UPDATE', line_item_id: 'l2', daily_budget });

describe('ENG-3212 built-in Google/X spend ceiling', () => {
  it('unset or empty env → $500/day, 2x default; a set value fully replaces it', () => {
    expect(DEFAULT_GOOGLE_X_SPEND_CEILING).toEqual({ maxDailyBudget: 500_000_000, maxChangeRatio: 2 });
    expect(googleSpendCeilingPolicyFromEnv(undefined)).toEqual({ maxDailyBudget: 500_000_000, maxChangeRatio: 2 });
    expect(googleSpendCeilingPolicyFromEnv('')).toEqual({ maxDailyBudget: 500_000_000, maxChangeRatio: 2 });
    expect(googleSpendCeilingPolicyFromEnv('{"maxDailyBudget":1000000000}')).toEqual({ maxDailyBudget: 1_000_000_000, maxChangeRatio: undefined });
    expect(googleSpendCeilingPolicyFromEnv('not json')).toEqual({ maxChangeRatio: -1 });
  });

  describe('default deps read their own env var', () => {
    const saved = { g: process.env.GOOGLE_TOOLKIT_SPEND_CEILING, x: process.env.X_ADS_TOOLKIT_SPEND_CEILING };
    afterEach(() => {
      for (const [k, v] of [['GOOGLE_TOOLKIT_SPEND_CEILING', saved.g], ['X_ADS_TOOLKIT_SPEND_CEILING', saved.x]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });

    it('both unset → both get the default', () => {
      delete process.env.GOOGLE_TOOLKIT_SPEND_CEILING;
      delete process.env.X_ADS_TOOLKIT_SPEND_CEILING;
      expect(defaultGoogleToolkitWriteDeps.spendCeilingPolicy()).toEqual(DEFAULT_GOOGLE_X_SPEND_CEILING);
      expect(defaultXAdsWriteDeps.spendCeilingPolicy()).toEqual(DEFAULT_GOOGLE_X_SPEND_CEILING);
    });

    it('a Google override does not leak into X (X unset keeps the default)', () => {
      process.env.GOOGLE_TOOLKIT_SPEND_CEILING = '{"maxDailyBudget":9000000000}';
      delete process.env.X_ADS_TOOLKIT_SPEND_CEILING;
      expect(defaultGoogleToolkitWriteDeps.spendCeilingPolicy()).toMatchObject({ maxDailyBudget: 9_000_000_000 });
      expect(defaultXAdsWriteDeps.spendCeilingPolicy()).toEqual(DEFAULT_GOOGLE_X_SPEND_CEILING);
    });

    it('X override applies to X only', () => {
      delete process.env.GOOGLE_TOOLKIT_SPEND_CEILING;
      process.env.X_ADS_TOOLKIT_SPEND_CEILING = '{"maxDailyBudget":7000000000}';
      expect(defaultXAdsWriteDeps.spendCeilingPolicy()).toMatchObject({ maxDailyBudget: 7_000_000_000 });
      expect(defaultGoogleToolkitWriteDeps.spendCeilingPolicy()).toEqual(DEFAULT_GOOGLE_X_SPEND_CEILING);
    });
  });

  describe('Google, env unset', () => {
    it('$600/day is refused, nothing sent', async () => {
      const d = googleDeps(undefined);
      await expect(executeGoogleToolkitWrite('u1', gCreate(600), 'USD', d)).rejects.toThrow(/ceiling/i);
      expect(d.dispatch).not.toHaveBeenCalled();
    });
    it('$5/day is allowed (previews)', async () => {
      const d = googleDeps(undefined);
      await expect(executeGoogleToolkitWrite('u1', gCreate(5), 'USD', d)).resolves.toMatchObject({ status: 'PREVIEW' });
      await expect(executeGoogleToolkitWrite('u1', gUpdate(5), 'USD', d)).resolves.toMatchObject({ status: 'PREVIEW' });
    });
    it('a >2x raise under $500 is refused ($200 → $450)', async () => {
      const d = googleDeps(undefined);
      await expect(executeGoogleToolkitWrite('u1', gUpdate(450), 'USD', d)).rejects.toThrow(/ceiling/i);
      await expect(executeGoogleToolkitWrite('u1', gUpdate(400), 'USD', d)).resolves.toMatchObject({ status: 'PREVIEW' });
      expect(d.dispatch).not.toHaveBeenCalled();
    });
    it('a set env var replaces the default ($600 allowed, ratio no longer enforced)', async () => {
      const d = googleDeps('{"maxDailyBudget":1000000000}');
      await expect(executeGoogleToolkitWrite('u1', gCreate(600), 'USD', d)).resolves.toMatchObject({ status: 'PREVIEW' });
      await expect(executeGoogleToolkitWrite('u1', gUpdate(900), 'USD', d)).resolves.toMatchObject({ status: 'PREVIEW' });
    });
  });

  describe('X, env unset', () => {
    it('$600/day is refused, nothing sent', async () => {
      const d = xDeps(undefined);
      await expect(executeXAdsWrite('u1', xUpdate(600), session, 'USD', d)).rejects.toThrow(/ceiling/i);
      expect(d.request.mock.calls.every(([o]) => (o.method ?? 'GET') === 'GET')).toBe(true);
    });
    it('$5/day is allowed (previews)', async () => {
      await expect(executeXAdsWrite('u1', xUpdate(5), session, 'USD', xDeps(undefined))).resolves.toMatchObject({ status: 'PREVIEW' });
    });
    it('a >2x raise under $500 is refused ($200 → $450)', async () => {
      await expect(executeXAdsWrite('u1', xUpdate(450), session, 'USD', xDeps(undefined))).rejects.toThrow(/ceiling/i);
      await expect(executeXAdsWrite('u1', xUpdate(400), session, 'USD', xDeps(undefined))).resolves.toMatchObject({ status: 'PREVIEW' });
    });
    it('a set env var replaces the default', async () => {
      const d = xDeps('{"maxDailyBudget":1000000000}');
      await expect(executeXAdsWrite('u1', xUpdate(600), session, 'USD', d)).resolves.toMatchObject({ status: 'PREVIEW' });
    });
  });
});
