import {
  estimateEnrichmentCost,
  checkEstimateConfirmation,
  normalizeLeadSelection,
  ENRICHMENT_COST_RATES_USD,
} from '../enrichmentCostEstimate';
import { getAllocatedRate } from '../../utils/vendorRateCard';

describe('estimateEnrichmentCost (ENG-2716)', () => {
  // ENG-2720: this used to pin the pre-fix $31.60 (Apollo at $0.445 per broker request,
  // gpt-5.5 at $8.47 per 112 leads). Now: 34 broker requests x $0.099 = $3.37, 112 x
  // $0.004 Luna = $0.45, lookups $3.61, web $1.37, unattributed $3.02.
  it('estimates the Opiner reference run (112 leads) at the corrected rates: ~$11.8, down from $31.60', () => {
    const e = estimateEnrichmentCost('list-1', 112);
    expect(e.breakdownUsd.apollo).toBe(3.37);
    expect(e.breakdownUsd.llm).toBe(0.45);
    expect(e.breakdownUsd.lookups).toBe(3.61);
    expect(e.breakdownUsd.webSearch).toBe(1.37);
    expect(e.totalUsd).toBe(11.81);
    expect(e.totalUsd).toBeLessThan(31.6 * 0.4);
    expect(e.leadCount).toBe(112);
  });

  it('prices the Apollo line from the vendor rate card, so a rate change cannot leave the estimate stale', () => {
    const rate = getAllocatedRate('apollo', 'waterfall_email')!;
    expect(rate).toBeCloseTo(0.099, 6);
    const e = estimateEnrichmentCost('l', 112);
    expect(e.breakdownUsd.apollo).toBeCloseTo(112 * rate * ENRICHMENT_COST_RATES_USD.apolloRevealRate, 2);
  });

  it('scales linearly and handles zero/invalid counts', () => {
    expect(estimateEnrichmentCost('l', 224).totalUsd).toBe(23.63);
    expect(estimateEnrichmentCost('l', 0).totalUsd).toBe(0);
    expect(estimateEnrichmentCost('l', NaN as any).leadCount).toBe(0);
  });

  it('token binds to list, count and total', () => {
    const a = estimateEnrichmentCost('l', 10).confirmationToken;
    expect(estimateEnrichmentCost('l', 10).confirmationToken).toBe(a);
    expect(estimateEnrichmentCost('l', 11).confirmationToken).not.toBe(a);
    expect(estimateEnrichmentCost('m', 10).confirmationToken).not.toBe(a);
  });
});

describe('checkEstimateConfirmation', () => {
  const est = estimateEnrichmentCost('l', 10);
  it('accepts the current token', () => {
    expect(checkEstimateConfirmation(est.confirmationToken, est, true)).toEqual({ ok: true });
  });
  it('rejects a stale token even when not required', () => {
    const old = estimateEnrichmentCost('l', 5).confirmationToken;
    expect(checkEstimateConfirmation(old, est, false)).toEqual({ ok: false, reason: 'stale' });
  });
  it('missing token: allowed when optional, rejected when required', () => {
    expect(checkEstimateConfirmation(undefined, est, false)).toEqual({ ok: true });
    expect(checkEstimateConfirmation(undefined, est, true)).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('normalizeLeadSelection (ENG-2716 Opslane P1)', () => {
  it('treats an empty selection as the whole list so a $0 token cannot start a full run', () => {
    expect(normalizeLeadSelection([])).toBeUndefined();
    expect(normalizeLeadSelection([1, null])).toBeUndefined();
    expect(normalizeLeadSelection(undefined)).toBeUndefined();
  });
  it('keeps string ids of a non-empty selection', () => {
    expect(normalizeLeadSelection(['a', 2, 'b'])).toEqual(['a', 'b']);
  });
});
