process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../services/modelRoles', () => ({ resolveModelForUser: jest.fn() }));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(), TURN_ADMISSION: { recordAdmission: true },
}));
import { checkTokenUsage } from '../services/tokenUsageService';
import { resolveModelForUser } from '../services/modelRoles';
import { buildEnrichmentBudgetCheck, estimateEnrichmentBatchMicroUsd, projectAllowance, admissionEstimateMicroUsd, effectiveFieldCount, wantsEnigma, enigmaFetchUsd, enigmaApplies, webFieldGuardUsd, expectedFieldCostUsd } from '../services/enrichmentBatchBudget';
import type { EnrichmentConfig } from '../services/crmEnrichmentServiceV3';
import { estimateEnrichmentCost } from '../services/enrichmentCostEstimate';
const config: EnrichmentConfig = { fields: [], globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1, updatedAt: '', updatedBy: '' };
const check = checkTokenUsage as jest.Mock;
beforeEach(() => {
  check.mockReset().mockResolvedValue({ allowed: true, month: '2026-10', costUsed: 10 });
  (resolveModelForUser as jest.Mock).mockReset().mockResolvedValue('openrouter/openai/gpt-5.6-luna');
});
it('does not reserve the full preflight estimate; reserves batches against a stale ledger', async () => {
  const budget = buildEnrichmentBudgetCheck('owner');
  await budget({ config, leadCount: 45, phase: 'preflight' });
  await budget({ config, leadCount: 20, phase: 'batch' });
  await budget({ config, leadCount: 20, phase: 'batch' });
  const forecasts = check.mock.calls.filter(([, options]) => options?.projectedCostMicroUsd);
  expect(forecasts.map(([, options]) => options.minimumCostUsedMicroUsd)).toEqual([
    10_000_000, 10_000_000, 10_000_000 + estimateEnrichmentBatchMicroUsd(config, 20),
  ]);
  expect(check.mock.calls.filter(([, options]) => options?.recordAdmission)).toHaveLength(2);
});
it('refuses forecast beyond cap without making an admission write', async () => {
  check.mockResolvedValueOnce({ allowed: true, month: '2026-10', costUsed: 10 })
    .mockResolvedValueOnce({ allowed: false, month: '2026-10' });
  expect(await buildEnrichmentBudgetCheck('owner')({ config, leadCount: 20, phase: 'batch' })).toBe(false);
  expect(check).toHaveBeenCalledTimes(2);
});
it('fails closed if the month rolls between snapshot and forecast', async () => {
  check.mockResolvedValueOnce({ allowed: true, month: '2026-10', costUsed: 10 })
    .mockResolvedValueOnce({ allowed: true, month: '2026-11' });
  expect(await buildEnrichmentBudgetCheck('owner')({ config, leadCount: 20, phase: 'batch' })).toBe(false);
});
describe('projectAllowance (ENG-2715/2720): a quote as percentage points of the allowance, never dollars', () => {
  const status = (over: Record<string, unknown>) => ({ allowed: true, month: '2026-10', costAllowance: 100, costUsed: 10, costPercentUsed: 10, ...over });

  it('reports the extra points the expected cost uses, and never records admission', async () => {
    check.mockReset().mockResolvedValue(status({ costAllowance: 100 }));
    const out = await projectAllowance('owner', 2_340_000);
    expect(out).toEqual({ percent: 2.3, withinAllowance: true });
    expect(check).toHaveBeenCalledWith('owner');
    expect(check).toHaveBeenCalledWith('owner', { projectedCostMicroUsd: 2_340_000 });
    expect(check.mock.calls.some(([, o]) => o?.recordAdmission)).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/usd|cost/i);
  });

  it('decides "within allowance" on the conservative reserve, not the expected cost', async () => {
    check.mockReset().mockImplementation(async (_u: string, o?: { projectedCostMicroUsd?: number }) =>
      status({ allowed: (o?.projectedCostMicroUsd ?? 0) < 5_000_000, costUsed: 10 + (o?.projectedCostMicroUsd ?? 0) / 1e6 }));
    expect((await projectAllowance('owner', 1_000_000, 9_000_000)).withinAllowance).toBe(false);
    expect((await projectAllowance('owner', 1_000_000, 2_000_000)).withinAllowance).toBe(true);
  });

  it('keeps a small run visible instead of rounding it to a whole point (a $0.60 run on a $150 allowance)', async () => {
    check.mockReset().mockResolvedValue(status({ costAllowance: 150 }));
    expect((await projectAllowance('owner', 600_000)).percent).toBe(0.4);
    check.mockReset().mockResolvedValue(status({ costAllowance: 1000 }));
    expect((await projectAllowance('owner', 600_000)).percent).toBe(0.06);
  });

  it('treats a zero-dollar allowance as fully used by any run', async () => {
    check.mockReset().mockResolvedValue(status({ costAllowance: 0 }));
    expect((await projectAllowance('owner', 1_000_000)).percent).toBe(100);
  });

  it('returns null points for a plan with no dollar allowance', async () => {
    check.mockReset().mockResolvedValue(status({ costAllowance: null, costUsed: 0, costPercentUsed: 0 }));
    expect((await projectAllowance('owner', 1_000_000)).percent).toBeNull();
  });

  it('ignores the ledger spend entirely, so a racing or failed-open read cannot skew the percent', async () => {
    // spend read as $10 on one call and $0 (a read failing open) on the other: the quote must not move
    check.mockReset()
      .mockResolvedValueOnce(status({ costAllowance: 150, costUsed: 10 }))
      .mockResolvedValueOnce(status({ costAllowance: 150, costUsed: 0 }));
    expect((await projectAllowance('owner', 600_000)).percent).toBe(0.4);
    check.mockReset()
      .mockResolvedValueOnce(status({ costAllowance: 150, costUsed: 0 }))
      .mockResolvedValueOnce(status({ costAllowance: 150, costUsed: 140 }));
    expect((await projectAllowance('owner', 600_000)).percent).toBe(0.4);
  });

  it('uses two read-only usage checks, not three, and never records admission', async () => {
    check.mockReset().mockResolvedValue(status({}));
    await projectAllowance('owner', 1_000_000, 9_000_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledWith('owner');
    expect(check).toHaveBeenCalledWith('owner', { projectedCostMicroUsd: 9_000_000 });
    expect(check.mock.calls.some(([, o]) => o?.recordAdmission)).toBe(false);
  });

  it('skips the usage read for a zero-cost quote', async () => {
    check.mockReset();
    expect(await projectAllowance('owner', 0)).toEqual({ percent: 0, withinAllowance: true });
    expect(check).not.toHaveBeenCalled();
  });

  it('counts smart-field dependencies as fields, at least one', () => {
    expect(effectiveFieldCount(config)).toBe(1);
    const smart: EnrichmentConfig = { ...config, fields: [
      { name: 'a', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', smartDependencies: ['x', 'y'] },
      { name: 'b', type: 'string', instruction: '', include: false, overwritePolicy: 'fill_if_empty' },
    ] };
    expect(effectiveFieldCount(smart)).toBe(3);
  });

  it('admissionEstimateMicroUsd is zero for no leads and uses the resolved model otherwise', async () => {
    expect(await admissionEstimateMicroUsd('owner', config, 0)).toBe(0);
    (resolveModelForUser as jest.Mock).mockResolvedValue('gpt-5.5');
    expect(await admissionEstimateMicroUsd('owner', config, 10)).toBe(estimateEnrichmentBatchMicroUsd(config, 10, 'gpt-5.5'));
  });
});
describe('admission estimate tracks what a run books (ENG-2720)', () => {
  const withFields = (n: number, over: Record<string, unknown> = {}): EnrichmentConfig => ({
    ...config,
    fields: Array.from({ length: n }, (_, i) => ({
      name: `f${i}`, type: 'string' as const, instruction: '', include: true, overwritePolicy: 'fill_if_empty' as const, ...over,
    })),
  });
  const named = (...names: string[]): EnrichmentConfig => ({
    ...config,
    fields: names.map(name => ({ name, type: 'string' as const, instruction: '', include: true, overwritePolicy: 'fill_if_empty' as const })),
  });
  const usd = (cfg: EnrichmentConfig, leads: number, model?: string) => estimateEnrichmentBatchMicroUsd(cfg, leads, model) / 1e6;

  // What a lead actually books on the real Opiner list (prod/env1 ledger, ENG-2720): Apollo match $0.0495,
  // waterfall $0.445, org $0.0495, one You.com query $0.0125, and ~$0.0018 per web field (tokens + search fee).
  const measuredPerLead = (fields: number) => 0.0495 + 0.445 + 0.0495 + 0.0125 + fields * 0.0018;

  it.each([3, 10, 20])('with %i fields it reserves at least 1.1x what a lead that triggers the broker measurably books', (n) => {
    expect(usd(withFields(n), 1)).toBeGreaterThanOrEqual(measuredPerLead(n) * 1.1);
  });

  it.each([3, 10, 20, 40])('with %i fields it stays within 8x of the field-matched customer estimate', (n) => {
    const quote = estimateEnrichmentCost('l', 112, { fieldCount: n }).totalUsd;
    expect(usd(withFields(n), 112)).toBeGreaterThanOrEqual(quote);
    expect(usd(withFields(n), 112)).toBeLessThanOrEqual(quote * 8);
  });

  it('no longer asks for ~$27 of headroom for 5 leads with a 20-field config (the old formula would ask ~$40 at the 9-credit rate)', () => {
    expect(usd(withFields(20), 5)).toBeLessThan(8);
  });

  it('reserves nothing for the unused enrich.so phone finder', () => {
    // identity ~$0.62 (Apollo match + waterfall + org, enrich.so, You.com) + one field $0.02; the old $0.25 phone-finder line is gone
    expect(usd(withFields(1), 1)).toBeLessThan(0.70);
  });

  it('reserves one WORST-CASE Enigma fetch only when a card-revenue field is configured, by name (how real configs carry them)', () => {
    const plain = usd(named('Industry', 'Employees'), 10);
    const withRevenue = usd(named('Industry', 'card_revenue_12m'), 10);
    const worstCase = 4 * 0.1 + 6 * 0.02; // 4 card rows at the 12m rate + a name and 5 websites (enigmaGraphql.ts ceiling: 52 credits)
    expect(withRevenue - plain).toBeCloseTo(worstCase * 10, 4);
    // any card field triggers the same single fetch, and several of them do not stack
    expect(usd(named('Industry', 'card_revenue_period_end'), 10) - plain).toBeCloseTo(worstCase * 10, 4);
    const threePlain = usd(named('Industry', 'Employees', 'Founded'), 10);
    expect(usd(named('Industry', 'card_revenue_12m', 'card_revenue_yoy_growth'), 10) - threePlain).toBeCloseTo(worstCase * 10, 4);
  });

  it('reserves no Enigma for a user who cannot buy it (not on the allowlist)', () => {
    const cfg = named('Industry', 'card_revenue_12m');
    expect(estimateEnrichmentBatchMicroUsd(cfg, 10, undefined, false)).toBe(estimateEnrichmentBatchMicroUsd(named('Industry', 'Employees'), 10));
    expect(estimateEnrichmentBatchMicroUsd(cfg, 10, undefined, true)).toBeGreaterThan(estimateEnrichmentBatchMicroUsd(cfg, 10, undefined, false));
  });

  it('enigmaApplies needs both a card-revenue field and the user on the Enigma allowlist', () => {
    const env = { ...process.env };
    try {
      process.env.ENIGMA_ENRICHMENT_ENABLED = 'true';
      process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST = 'owner,other';
      expect(enigmaApplies(named('card_revenue_12m'), 'owner')).toBe(true);
      expect(enigmaApplies(named('card_revenue_12m'), 'stranger')).toBe(false);
      expect(enigmaApplies(named('Industry'), 'owner')).toBe(false);
      process.env.ENIGMA_ENRICHMENT_ENABLED = 'false';
      expect(enigmaApplies(named('card_revenue_12m'), 'owner')).toBe(false);
    } finally {
      process.env.ENIGMA_ENRICHMENT_ENABLED = env.ENIGMA_ENRICHMENT_ENABLED;
      process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST = env.ENIGMA_ENRICHMENT_USER_ALLOWLIST;
      if (env.ENIGMA_ENRICHMENT_ENABLED === undefined) delete process.env.ENIGMA_ENRICHMENT_ENABLED;
      if (env.ENIGMA_ENRICHMENT_USER_ALLOWLIST === undefined) delete process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST;
    }
  });

  describe('the Enigma allowlist reaches the admission reserve (review: a wiring mutation survived every test)', () => {
    const cfgWithRevenue = named('Industry', 'card_revenue_12m');
    const plainCfg = named('Industry', 'Employees');
    const withEnv = async (allowlist: string | undefined, fn: () => Promise<void>) => {
      const saved = { e: process.env.ENIGMA_ENRICHMENT_ENABLED, l: process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST };
      process.env.ENIGMA_ENRICHMENT_ENABLED = 'true';
      if (allowlist === undefined) delete process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST; else process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST = allowlist;
      try { await fn(); } finally {
        if (saved.e === undefined) delete process.env.ENIGMA_ENRICHMENT_ENABLED; else process.env.ENIGMA_ENRICHMENT_ENABLED = saved.e;
        if (saved.l === undefined) delete process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST; else process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST = saved.l;
      }
    };
    const projected = () => check.mock.calls.filter(([, o]) => o?.projectedCostMicroUsd).map(([, o]) => o.projectedCostMicroUsd as number);
    const worst = Math.round(0.52 * 10 * 1_000_000);

    it('buildEnrichmentBudgetCheck reserves the Enigma fetch for an allowlisted user and not for anyone else', async () => {
      await withEnv('owner', async () => {
        check.mockClear();
        await buildEnrichmentBudgetCheck('owner')({ config: cfgWithRevenue, leadCount: 10, phase: 'preflight' });
        const forOwner = projected()[0];
        check.mockClear();
        await buildEnrichmentBudgetCheck('stranger')({ config: cfgWithRevenue, leadCount: 10, phase: 'preflight' });
        const forStranger = projected()[0];
        expect(forOwner - forStranger).toBeGreaterThanOrEqual(worst - 10);
        expect(forOwner - forStranger).toBeLessThanOrEqual(worst + 10);
        expect(forStranger).toBe(estimateEnrichmentBatchMicroUsd(plainCfg, 10, undefined) + Math.round(0.02 * 0));
      });
    });

    it('admissionEstimateMicroUsd applies the same allowlist gate', async () => {
      await withEnv('owner', async () => {
        const owner = await admissionEstimateMicroUsd('owner', cfgWithRevenue, 10);
        const stranger = await admissionEstimateMicroUsd('stranger', cfgWithRevenue, 10);
        expect(owner).toBeGreaterThan(stranger);
        expect(stranger).toBe(await admissionEstimateMicroUsd('stranger', plainCfg, 10));
      });
      await withEnv(undefined, async () => {
        expect(await admissionEstimateMicroUsd('owner', cfgWithRevenue, 10)).toBe(await admissionEstimateMicroUsd('owner', plainCfg, 10));
      });
    });
  });

  it('wantsEnigma ignores excluded card fields; the expected fetch sits between typical and worst case', () => {
    const off: EnrichmentConfig = { ...config, fields: [{ name: 'card_revenue_12m', type: 'string', instruction: '', include: false, overwritePolicy: 'fill_if_empty' }] };
    expect(wantsEnigma(off)).toBe(false);
    expect(wantsEnigma(named('Industry'))).toBe(false);
    expect(wantsEnigma(named('Industry', 'card_revenue_period_end'))).toBe(true);
    expect(enigmaFetchUsd('expected')).toBeCloseTo(0.1 + 0.1 + 4 * 0.02, 6);
    expect(enigmaFetchUsd('worstCase')).toBeCloseTo(0.52, 6);
    expect(enigmaFetchUsd()).toBe(enigmaFetchUsd('expected'));
    expect(enigmaFetchUsd('expected')).toBeGreaterThan(0.19); // ~19 credits typical (enigmaGraphql.ts)
    expect(enigmaFetchUsd('expected')).toBeLessThan(enigmaFetchUsd('worstCase'));
  });

  it('the expected field cost is model-aware and never below the measured Luna figure', () => {
    expect(expectedFieldCostUsd()).toBeCloseTo(0.002, 6);
    expect(expectedFieldCostUsd('openrouter/openai/gpt-5.6-luna')).toBeCloseTo(0.002, 6);
    expect(expectedFieldCostUsd('gpt-5.5')).toBeGreaterThan(0.008);
    expect(expectedFieldCostUsd('no-such-model-xyz')).toBe(expectedFieldCostUsd('gpt-5.5'));
  });

  it('reserves the Apollo email waterfall once at the booked rate (prod shows ~one broker request per emailless lead)', () => {
    const one = usd(withFields(1), 1);
    // person_match + waterfall $0.445 + org + enrich.so find + reverse + 2 You.com + one field guard
    expect(one).toBeCloseTo(0.0495 + 0.445 + 0.0495 + 0.005 + 0.05 + 0.025 + 0.02, 3);
  });

  it('routes by aliasFor || name like the orchestrator does', () => {
    const aliased: EnrichmentConfig = { ...config, fields: [{ name: 'Revenue', aliasFor: 'card_revenue_12m', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }] };
    expect(usd(aliased, 10)).toBeGreaterThan(usd(named('Revenue'), 10));
  });

  it('scales linearly with leads', () => {
    expect(usd(withFields(5), 40)).toBeCloseTo(2 * usd(withFields(5), 20), 4);
  });

  describe('model-aware per-field reserve', () => {
    it('reserves the floor for Luna and proportionally more for a premium or unpriced model', () => {
      expect(webFieldGuardUsd()).toBeCloseTo(0.02, 6);
      expect(webFieldGuardUsd('openrouter/openai/gpt-5.6-luna')).toBeCloseTo(0.02, 6);
      expect(webFieldGuardUsd('gpt-5.5')).toBeGreaterThan(0.08);
      expect(webFieldGuardUsd('no-such-model-xyz')).toBe(webFieldGuardUsd('gpt-5.5'));
      expect(usd(withFields(10), 20, 'gpt-5.5')).toBeGreaterThan(usd(withFields(10), 20) * 1.5);
    });

    it('buildEnrichmentBudgetCheck reserves for the model the org actually runs, and the env override wins', async () => {
      (resolveModelForUser as jest.Mock).mockResolvedValue('gpt-5.5');
      await buildEnrichmentBudgetCheck('owner')({ config: withFields(10), leadCount: 20, phase: 'preflight' });
      const projected = check.mock.calls.filter(([, o]) => o?.projectedCostMicroUsd).map(([, o]) => o.projectedCostMicroUsd);
      expect(projected[0]).toBe(estimateEnrichmentBatchMicroUsd(withFields(10), 20, 'gpt-5.5'));
      expect(projected[0]).toBeGreaterThan(estimateEnrichmentBatchMicroUsd(withFields(10), 20));

      check.mockClear();
      process.env.CRM_ENRICH_V3_WEB_SEARCH_MODEL = 'openrouter/openai/gpt-5.6-luna';
      try {
        await buildEnrichmentBudgetCheck('owner')({ config: withFields(10), leadCount: 20, phase: 'preflight' });
      } finally { delete process.env.CRM_ENRICH_V3_WEB_SEARCH_MODEL; }
      const envProjected = check.mock.calls.filter(([, o]) => o?.projectedCostMicroUsd).map(([, o]) => o.projectedCostMicroUsd);
      expect(envProjected[0]).toBe(estimateEnrichmentBatchMicroUsd(withFields(10), 20));
    });

    it('stays conservative if the enrichment model cannot be resolved', async () => {
      (resolveModelForUser as jest.Mock).mockRejectedValue(new Error('db down'));
      expect(await admissionEstimateMicroUsd('owner', withFields(10), 20)).toBeGreaterThan(estimateEnrichmentBatchMicroUsd(withFields(10), 20));
    });
  });
});
