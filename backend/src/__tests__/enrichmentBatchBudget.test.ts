jest.mock('../services/modelRoles', () => ({ resolveModelForUser: jest.fn() }));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(), TURN_ADMISSION: { recordAdmission: true },
}));
import { checkTokenUsage } from '../services/tokenUsageService';
import { resolveModelForUser } from '../services/modelRoles';
import { buildEnrichmentBudgetCheck, estimateEnrichmentBatchMicroUsd, estimateEnrichmentRun, webFieldGuardUsd } from '../services/enrichmentBatchBudget';
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
describe('estimateEnrichmentRun (ENG-2715)', () => {
  const { estimateEnrichmentRun } = jest.requireActual('../services/enrichmentBatchBudget');
  it('returns the cap-consistent estimate in dollars and never records admission', async () => {
    check.mockReset().mockResolvedValue({ allowed: true, month: '2026-10' });
    const out = await estimateEnrichmentRun('owner', config, 112);
    const micro = estimateEnrichmentBatchMicroUsd(config, 112);
    expect(out).toEqual({ leadCount: 112, estimatedCostUsd: Math.ceil(micro / 10_000) / 100, withinAllowance: true });
    expect(out.estimatedCostUsd).toBeGreaterThan(0);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith('owner', { projectedCostMicroUsd: micro });
    expect(check.mock.calls.some(([, o]) => o?.recordAdmission)).toBe(false);
  });
  it('reports withinAllowance=false when the forecast exceeds the cap', async () => {
    check.mockReset().mockResolvedValue({ allowed: false, month: '2026-10' });
    expect((await estimateEnrichmentRun('owner', config, 20)).withinAllowance).toBe(false);
  });
  it('zero leads costs nothing and skips the usage read', async () => {
    check.mockReset();
    expect(await estimateEnrichmentRun('owner', config, 0)).toEqual({ leadCount: 0, estimatedCostUsd: 0, withinAllowance: true });
    expect(check).not.toHaveBeenCalled();
  });
});

// ENG-2720: admission used to reserve ~50x what a run books ($27.25 for 5 leads against a customer
// estimate of $0.55): a phantom enrich.so phone_finder line, Enigma on every field, You.com four times
// per field and a gpt-5.5-sized LLM band. These pin the two estimators to each other so a future
// rate or model change cannot silently pull them apart again.
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
  // waterfall $0.099, org $0.0495, one You.com query $0.0125, and ~$0.0018 per web field (tokens + search fee).
  const measuredPerLead = (fields: number) => 0.0495 + 0.099 + 0.0495 + 0.0125 + fields * 0.0018;

  it.each([3, 10, 20])('with %i fields it reserves at least 1.5x what a lead measurably books', (n) => {
    expect(usd(withFields(n), 1)).toBeGreaterThanOrEqual(measuredPerLead(n) * 1.5);
  });

  it.each([3, 10, 20])('with %i fields it stays within 8x of the customer-facing estimate', (n) => {
    expect(usd(withFields(n), 112)).toBeLessThanOrEqual(estimateEnrichmentCost('l', 112).totalUsd * 8);
  });

  it('no longer asks for ~$27 of headroom for 5 leads with a 20-field config', () => {
    expect(usd(withFields(20), 5)).toBeLessThan(5);
  });

  it('reserves nothing for the unused enrich.so phone finder', () => {
    expect(usd(withFields(1), 1)).toBeLessThan(0.35);
  });

  it('reserves one Enigma fetch only when a card-revenue field is configured, by name (how real configs carry them)', () => {
    const plain = usd(named('Industry', 'Employees'), 10);
    const withRevenue = usd(named('Industry', 'card_revenue_12m'), 10);
    const perLeadEnigma = 0.1 + 0.1 + 4 * 0.02;
    expect(withRevenue - plain).toBeCloseTo(perLeadEnigma * 10, 6);
    // any card field triggers the same single fetch, and several of them do not stack
    expect(usd(named('Industry', 'card_revenue_period_end'), 10) - plain).toBeCloseTo(perLeadEnigma * 10, 6);
    const threePlain = usd(named('Industry', 'Employees', 'Founded'), 10);
    expect(usd(named('Industry', 'card_revenue_12m', 'card_revenue_yoy_growth'), 10) - threePlain).toBeCloseTo(perLeadEnigma * 10, 6);
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
      const out = await estimateEnrichmentRun('owner', withFields(10), 20);
      expect(out.estimatedCostUsd).toBeGreaterThan(usd(withFields(10), 20));
    });
  });
});
