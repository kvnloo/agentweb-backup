import { estimateEnrichmentCost, checkEstimateConfirmation, normalizeLeadSelection } from '../enrichmentCostEstimate';

describe('estimateEnrichmentCost (ENG-2716)', () => {
  it('reproduces the Opiner reference run: 112 leads -> $31.60', () => {
    const e = estimateEnrichmentCost('list-1', 112);
    expect(e.totalUsd).toBe(31.6);
    expect(e.breakdownUsd.apollo).toBe(15.13);
    expect(e.leadCount).toBe(112);
  });

  it('scales linearly and handles zero/invalid counts', () => {
    expect(estimateEnrichmentCost('l', 224).totalUsd).toBe(63.2);
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
