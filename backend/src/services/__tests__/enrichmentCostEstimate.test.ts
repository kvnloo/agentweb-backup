import {
  estimateEnrichmentCost,
  checkEstimateConfirmation,
  normalizeLeadSelection,
  toCustomerEstimate,
  ENRICHMENT_COST_RATES_USD,
} from '../enrichmentCostEstimate';
import { getAllocatedRate } from '../../utils/vendorRateCard';

describe('estimateEnrichmentCost (ENG-2716)', () => {
  // ENG-2720: this used to pin the pre-fix $31.60 (Apollo at $0.445 per broker request,
  // gpt-5.5 at $8.47 per 112 leads). Now: 34 broker requests x $0.099 = $3.37, 112 x
  // $0.02 Luna tokens + OpenRouter web-search fee = $2.24, lookups $3.61, web $1.37,
  // unattributed $3.02.
  it('estimates the Opiner reference run (112 leads) at the corrected rates: ~$13.6, down from $31.60', () => {
    const e = estimateEnrichmentCost('list-1', 112);
    expect(e.breakdownUsd.apollo).toBe(3.37);
    expect(e.breakdownUsd.llm).toBe(2.24);
    expect(e.breakdownUsd.lookups).toBe(3.61);
    expect(e.breakdownUsd.webSearch).toBe(1.37);
    expect(e.totalUsd).toBe(13.61);
    expect(e.totalUsd).toBeLessThan(31.6 * 0.5);
    expect(e.leadCount).toBe(112);
  });

  it('prices the Apollo line from the vendor rate card, so a rate change cannot leave the estimate stale', () => {
    const rate = getAllocatedRate('apollo', 'waterfall_email')!;
    expect(rate).toBeCloseTo(0.099, 6);
    const e = estimateEnrichmentCost('l', 112);
    expect(e.breakdownUsd.apollo).toBeCloseTo(112 * rate * ENRICHMENT_COST_RATES_USD.apolloRevealRate, 2);
  });

  it('scales the LLM line with the config field count (Opslane: a 40-field config was under-quoted)', () => {
    const ref = estimateEnrichmentCost('l', 6);
    const wide = estimateEnrichmentCost('l', 6, { fieldCount: 40 });
    expect(wide.breakdownUsd.llm).toBeCloseTo(6 * 40 * ENRICHMENT_COST_RATES_USD.llmPerFieldPerLead, 2);
    expect(wide.breakdownUsd.llm).toBeCloseTo(ref.breakdownUsd.llm * 4, 2);
    expect(estimateEnrichmentCost('l', 6, { fieldCount: ENRICHMENT_COST_RATES_USD.referenceFieldCount }).totalUsd).toBe(ref.totalUsd);
    expect(estimateEnrichmentCost('l', 6, { fieldCount: 0 }).totalUsd).toBe(ref.totalUsd);
    expect(estimateEnrichmentCost('l', 6, { fieldCount: NaN }).totalUsd).toBe(ref.totalUsd);
  });

  it('quotes no Apollo line when every lead already has an email (Opslane), and never more than before', () => {
    const none = estimateEnrichmentCost('l', 6, { emaillessCount: 0 });
    const all = estimateEnrichmentCost('l', 6, { emaillessCount: 6 });
    const unknown = estimateEnrichmentCost('l', 6);
    expect(none.breakdownUsd.apollo).toBe(0);
    expect(all.breakdownUsd.apollo).toBe(unknown.breakdownUsd.apollo);
    expect(estimateEnrichmentCost('l', 6, { emaillessCount: 3 }).breakdownUsd.apollo).toBeCloseTo(unknown.breakdownUsd.apollo / 2, 2);
    // clamped: cannot exceed the lead count or go negative
    expect(estimateEnrichmentCost('l', 6, { emaillessCount: 99 }).breakdownUsd.apollo).toBe(unknown.breakdownUsd.apollo);
    expect(estimateEnrichmentCost('l', 6, { emaillessCount: -4 }).breakdownUsd.apollo).toBe(0);
  });

  it('the customer view carries a percent and the token, and no dollar figure or vendor breakdown (ENG-1212)', () => {
    const est = estimateEnrichmentCost('list-1', 112);
    const view = toCustomerEstimate(est, { percent: 2.3, withinAllowance: true });
    expect(view).toEqual({ leadCount: 112, estimatedPercentOfAllowance: 2.3, withinAllowance: true, confirmationToken: est.confirmationToken });
    expect(Object.keys(view).sort()).toEqual(['confirmationToken', 'estimatedPercentOfAllowance', 'leadCount', 'withinAllowance']);
    expect(JSON.stringify(view)).not.toMatch(/usd|breakdown|apollo|perLead|total/i);
    expect(toCustomerEstimate(est, { percent: null, withinAllowance: false }).estimatedPercentOfAllowance).toBeNull();
  });

  it('scales linearly and handles zero/invalid counts', () => {
    expect(estimateEnrichmentCost('l', 224).totalUsd).toBe(27.21);
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
