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
  // ENG-2720 recalibration (2026-11-12): pinned to what prod actually booked, not to a single reference run.
  // Customer runs since the 11-04 changes: 118 contacts, $8.09 booked (lists of 5-12 fields, ~8 on average;
  // 30 emailless contacts, none with a name to send to the Apollo broker, 1 broker request booked).
  it('backtest: the Nov 4+ customer runs (118 contacts) quote within 5% of the $8.09 prod booked', () => {
    const e = estimateEnrichmentCost('l', 118, { emaillessCount: 30, brokerEligibleCount: 0, fieldCount: 8 });
    expect(e.totalUsd).toBeGreaterThan(8.09 * 0.95);
    expect(e.totalUsd).toBeLessThan(8.09 * 1.05);
    // the old constants quoted ~$14.8 for the same runs
    expect(e.breakdownUsd.apollo).toBeCloseTo(0.45, 2);
  });

  // 2026-11-03: one list, 146 emailless contacts that all had a name and company; 60 broker requests; $37.19 booked.
  it('backtest: a 146-contact list of broker-eligible emailless leads quotes within 5% of the $37.19 booked', () => {
    const e = estimateEnrichmentCost('l', 146, { emaillessCount: 146, brokerEligibleCount: 146, fieldCount: 10 });
    expect(e.totalUsd).toBeGreaterThan(37.19 * 0.95);
    expect(e.totalUsd).toBeLessThan(37.19 * 1.05);
    expect(e.breakdownUsd.apollo).toBeCloseTo(60 * 0.445, 1);
  });

  it('has no unattributed per-lead remainder any more (that was gpt-5.5-era spend)', () => {
    const e = estimateEnrichmentCost('l', 100, { emaillessCount: 0 });
    expect(e.breakdownUsd.other).toBe(0);
    expect(e.perLeadUsd).toBeCloseTo(ENRICHMENT_COST_RATES_USD.lookupPerLead + ENRICHMENT_COST_RATES_USD.webSearchPerLead + 10 * ENRICHMENT_COST_RATES_USD.llmPerFieldPerLead, 2);
  });

  it('prices the Apollo line from the vendor rate card, so a rate change cannot leave the estimate stale', () => {
    const rate = getAllocatedRate('apollo', 'waterfall_email')!;
    expect(rate).toBe(0.445);
    const e = estimateEnrichmentCost('l', 112);
    expect(e.breakdownUsd.apollo).toBeCloseTo(112 * rate * ENRICHMENT_COST_RATES_USD.apolloEligibleRate, 2);
  });

  it('prices broker-eligible emailless leads at the eligible rate and the rest at the low rate', () => {
    const rate = getAllocatedRate('apollo', 'waterfall_email')!;
    const r = ENRICHMENT_COST_RATES_USD;
    const e = estimateEnrichmentCost('l', 50, { emaillessCount: 40, brokerEligibleCount: 10 });
    expect(e.breakdownUsd.apollo).toBeCloseTo((10 * r.apolloEligibleRate + 30 * r.apolloOtherRate) * rate, 2);
    // eligible defaults to every emailless lead; clamped to [0, emailless]
    expect(estimateEnrichmentCost('l', 50, { emaillessCount: 40 }).breakdownUsd.apollo).toBeCloseTo(40 * r.apolloEligibleRate * rate, 2);
    expect(estimateEnrichmentCost('l', 50, { emaillessCount: 40, brokerEligibleCount: 99 }).breakdownUsd.apollo).toBeCloseTo(40 * r.apolloEligibleRate * rate, 2);
    expect(estimateEnrichmentCost('l', 50, { emaillessCount: 40, brokerEligibleCount: -3 }).breakdownUsd.apollo).toBeCloseTo(40 * r.apolloOtherRate * rate, 2);
    expect(estimateEnrichmentCost('l', 50, { emaillessCount: 0, brokerEligibleCount: 10 }).breakdownUsd.apollo).toBe(0);
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
    expect(estimateEnrichmentCost('l', 224).totalUsd).toBeCloseTo(estimateEnrichmentCost('l', 112).totalUsd * 2, 1);
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

    it('does not collide when a delimiter appears inside the user or list id', () => {
      const a = estimateEnrichmentCost('c', 10, { userId: 'a:b' }).confirmationToken;
      const b = estimateEnrichmentCost('b:c', 10, { userId: 'a' }).confirmationToken;
      expect(a).not.toBe(b);
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

    it('is not the plain HMAC of the message under the raw secret (a derived subkey separates it from JWT signing)', () => {
      const { createHmac } = require('crypto');
      const est = estimateEnrichmentCost('list-1', 112, { userId: 'u1' });
      const direct = createHmac('sha256', process.env.JWT_SECRET as string)
        .update(JSON.stringify(['enrich-v3-estimate:v3', 'u1', 'list-1', 112, est.totalUsd.toFixed(2)])).digest('hex').slice(0, 32);
      expect(est.confirmationToken).not.toBe(direct);
    });

    it('compares in constant time and treats any wrong-length or non-string token as stale or missing without throwing', () => {
      const est = estimateEnrichmentCost('l', 10, { userId: 'u1' });
      for (const bad of ['', 'x', 'x'.repeat(31), 'x'.repeat(33), 'é'.repeat(32), est.confirmationToken.slice(0, 31) + 'z']) {
        expect(checkEstimateConfirmation(bad, est, true)).toEqual({ ok: false, reason: bad === '' ? 'missing' : 'stale' });
      }
      expect(checkEstimateConfirmation(est.confirmationToken, est, true)).toEqual({ ok: true });
      expect(checkEstimateConfirmation(12345 as unknown, est, true)).toEqual({ ok: false, reason: 'missing' });
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
  it('de-duplicates, keeping first-seen order (a repeated id is neither quoted nor run twice)', () => {
    expect(normalizeLeadSelection(['b', 'a', 'b', 'a', 'c', 'b'])).toEqual(['b', 'a', 'c']);
    expect(normalizeLeadSelection(['x', 'x', 'x'])).toEqual(['x']);
  });
});
