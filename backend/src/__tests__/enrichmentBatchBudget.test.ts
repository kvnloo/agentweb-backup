jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(), TURN_ADMISSION: { recordAdmission: true },
}));
import { checkTokenUsage } from '../services/tokenUsageService';
import { buildEnrichmentBudgetCheck, estimateEnrichmentBatchMicroUsd } from '../services/enrichmentBatchBudget';
import type { EnrichmentConfig } from '../services/crmEnrichmentServiceV3';
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
