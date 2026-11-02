jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(), TURN_ADMISSION: { recordAdmission: true },
}));
import { checkTokenUsage } from '../services/tokenUsageService';
import { buildEnrichmentBudgetCheck, estimateEnrichmentBatchMicroUsd } from '../services/enrichmentBatchBudget';
import type { EnrichmentConfig } from '../services/crmEnrichmentServiceV3';
import { estimateEnrichmentCost } from '../services/enrichmentCostEstimate';
const config: EnrichmentConfig = { fields: [], globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1, updatedAt: '', updatedBy: '' };
const check = checkTokenUsage as jest.Mock;
beforeEach(() => {
  check.mockReset().mockResolvedValue({ allowed: true, month: '2026-10', costUsed: 10 });
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
  const usd = (cfg: EnrichmentConfig, leads: number) => estimateEnrichmentBatchMicroUsd(cfg, leads) / 1e6;

  it.each([3, 10, 20])('with %i fields it stays above the customer estimate but within a small multiple of it', (n) => {
    const admission = usd(withFields(n), 112);
    const customer = estimateEnrichmentCost('l', 112).totalUsd;
    expect(admission).toBeGreaterThanOrEqual(customer);
    expect(admission).toBeLessThanOrEqual(customer * 8);
  });

  it('no longer asks for ~$27 of headroom for 5 leads with a 20-field config', () => {
    expect(usd(withFields(20), 5)).toBeLessThan(5);
  });

  it('reserves nothing for the unused enrich.so phone finder', () => {
    // identity (~$0.28) + one field ($0.02): well under the old $0.25 phone-finder line alone plus the rest.
    expect(usd(withFields(1), 1)).toBeLessThan(0.35);
  });

  it('charges an Enigma fill only for card-revenue fields', () => {
    const plain = usd(withFields(2), 10);
    const revenue = usd(withFields(2, { aliasFor: 'card_revenue_12m' }), 10);
    expect(revenue - plain).toBeCloseTo(2 * 0.1 * 10, 6);
  });

  it('scales linearly with leads', () => {
    expect(usd(withFields(5), 40)).toBeCloseTo(2 * usd(withFields(5), 20), 4);
  });
});
