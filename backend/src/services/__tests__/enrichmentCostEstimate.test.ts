process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
import { createHash } from 'crypto';
import {
  estimateEnrichmentCost,
  checkEstimateConfirmation,
  normalizeLeadSelection,
  toCustomerEstimate,
  ENRICHMENT_COST_RATES_USD,
} from '../enrichmentCostEstimate';
import { getAllocatedRate } from '../../utils/vendorRateCard';

describe('estimateEnrichmentCost (ENG-2716)', () => {
  // ENG-2720: this used to pin the pre-fix $31.60 (gpt-5.5 at $8.47 per 112 leads). Apollo stays at $0.445
  // per broker request (owner decision 2026-11-02): 34 requests x $0.445 = $15.13, and the LLM line is the
  // measured Luna cost, 112 x $0.02 (tokens + OpenRouter web-search fee) = $2.24, lookups $3.61, web
  // $1.37, unattributed $3.02 => $25.37.
  it('estimates the Opiner reference run (112 leads): ~$25.4, down from $31.60 (only the LLM line changed)', () => {
    const e = estimateEnrichmentCost('list-1', 112);
    expect(e.breakdownUsd.apollo).toBe(15.13);
    expect(e.breakdownUsd.llm).toBe(2.24);
    expect(e.breakdownUsd.lookups).toBe(3.61);
    expect(e.breakdownUsd.webSearch).toBe(1.37);
    expect(e.totalUsd).toBe(25.37);
    expect(e.totalUsd).toBeLessThan(31.6);
    expect(e.leadCount).toBe(112);
  });

  it('prices the Apollo line from the vendor rate card, so a rate change cannot leave the estimate stale', () => {
    const rate = getAllocatedRate('apollo', 'waterfall_email')!;
    expect(rate).toBe(0.445);
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

  it('adds one Enigma fetch per lead only when the config asks for a card-revenue field', () => {
    const base = estimateEnrichmentCost('l', 10);
    const withEnigma = estimateEnrichmentCost('l', 10, { enigmaPerLeadUsd: 0.28 });
    expect(withEnigma.totalUsd - base.totalUsd).toBeCloseTo(2.8, 2);
    expect(withEnigma.breakdownUsd.other - base.breakdownUsd.other).toBeCloseTo(2.8, 2);
    for (const bad of [0, -1, NaN]) expect(estimateEnrichmentCost('l', 10, { enigmaPerLeadUsd: bad }).totalUsd).toBe(base.totalUsd);
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
    expect(estimateEnrichmentCost('l', 224).totalUsd).toBe(50.74);
    expect(estimateEnrichmentCost('l', 0).totalUsd).toBe(0);
    expect(estimateEnrichmentCost('l', NaN as any).leadCount).toBe(0);
  });

  it('token binds to list, count and total', () => {
    const a = estimateEnrichmentCost('l', 10).confirmationToken;
    expect(estimateEnrichmentCost('l', 10).confirmationToken).toBe(a);
    expect(estimateEnrichmentCost('l', 11).confirmationToken).not.toBe(a);
    expect(estimateEnrichmentCost('m', 10).confirmationToken).not.toBe(a);
  });

  // Review finding: the token was sha256(listId:count:total) with no key, so a customer could brute-force it
  // back into the dollar total (recovered in milliseconds), leaking our allocated rates through the quote that hides them.
  describe('confirmation token does not leak the dollar total', () => {
    it('is bound to the user, so one user\'s token cannot confirm another\'s run', () => {
      const a = estimateEnrichmentCost('l', 10, { userId: 'u1' }).confirmationToken;
      expect(estimateEnrichmentCost('l', 10, { userId: 'u1' }).confirmationToken).toBe(a);
      expect(estimateEnrichmentCost('l', 10, { userId: 'u2' }).confirmationToken).not.toBe(a);
    });

    it('is not the old unkeyed hash, so it cannot be inverted by trying every cent total', () => {
      const est = estimateEnrichmentCost('list-1', 112, { userId: 'u1' });
      const unkeyed = (total: number) => createHash('sha256').update(`enrich-v3-estimate:v1:list-1:112:${total.toFixed(2)}`).digest('hex').slice(0, 32);
      expect(est.confirmationToken).not.toBe(unkeyed(est.totalUsd));
      let recovered: number | undefined;
      for (let cents = 0; cents <= 100_000; cents++) {
        if (unkeyed(cents / 100) === est.confirmationToken) { recovered = cents / 100; break; }
      }
      expect(recovered).toBeUndefined();
    });

    it('changes with the server secret (a different instance secret cannot validate it)', () => {
      const before = estimateEnrichmentCost('l', 10, { userId: 'u1' }).confirmationToken;
      const saved = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'another-secret';
      try {
        expect(estimateEnrichmentCost('l', 10, { userId: 'u1' }).confirmationToken).not.toBe(before);
      } finally { process.env.JWT_SECRET = saved; }
    });

    it('fails loud rather than minting a guessable token if the secret is missing', () => {
      const saved = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      try { expect(() => estimateEnrichmentCost('l', 10)).toThrow(/JWT_SECRET/); } finally { process.env.JWT_SECRET = saved; }
    });
  });

  it('a model-aware field cost lifts the LLM line, and a bad one falls back to the Luna figure', () => {
    const base = estimateEnrichmentCost('l', 10);
    expect(estimateEnrichmentCost('l', 10, { fieldCostUsd: 0.009 }).breakdownUsd.llm).toBeGreaterThan(base.breakdownUsd.llm * 4);
    for (const bad of [0, -1, NaN]) expect(estimateEnrichmentCost('l', 10, { fieldCostUsd: bad }).totalUsd).toBe(base.totalUsd);
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
