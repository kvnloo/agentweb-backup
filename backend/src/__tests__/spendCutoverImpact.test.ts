/**
 * ENG-2010 — the §9 cutover-impact model.
 *
 * The load-bearing claim, and the one I got wrong by hand before this existed:
 * the cutover compares spend against the CAP, not vendor-spend against
 * LLM-spend. So the risk is small caps (Free tier), not big-ratio whales. Every
 * assertion here is against the cap.
 */
import { classifyCutoverImpact, CutoverAccountInput } from '../services/spendCutoverImpact';

const M = 1_000_000;
const acct = (over: Partial<CutoverAccountInput> = {}): CutoverAccountInput => ({
  billingUserId: 'owner-1',
  tier: 'Pro',
  llmMicroUsd: 10 * M,
  vendorMicroUsd: 1 * M,
  capMicroUsd: 200 * M,
  ...over,
});

describe('classifyCutoverImpact', () => {
  it('the whale that looks scary but is nowhere near its cap is NOT newly paused', () => {
    // $0.82 LLM, $34.69 vendor = +4000% ratio, but against a $200 cap it is 18%.
    const s = classifyCutoverImpact([
      acct({ tier: 'Super Premium', llmMicroUsd: 820_000, vendorMicroUsd: 34_690_000, capMicroUsd: 200 * M }),
    ]);
    expect(s.newlyPaused).toBe(0);
    expect(s.accounts[0].percentAfter).toBeCloseTo(17.76, 1);
  });

  it('the Free-tier account IS the real exposure — a small cap makes vendor spend large', () => {
    // $0.27 LLM, $2.00 vendor against a $5 cap: 5% -> 45%.
    const s = classifyCutoverImpact([
      acct({ tier: 'Free', llmMicroUsd: 270_000, vendorMicroUsd: 2 * M, capMicroUsd: 5 * M }),
    ]);
    expect(s.accounts[0].percentNow).toBeCloseTo(5.4, 1);
    expect(s.accounts[0].percentAfter).toBeCloseTo(45.4, 1);
    expect(s.newlyPaused).toBe(0); // close, but not over
  });

  it('flags an account the cutover pushes over its cap as newly paused', () => {
    const s = classifyCutoverImpact([
      acct({ llmMicroUsd: 150 * M, vendorMicroUsd: 60 * M, capMicroUsd: 200 * M }), // 75% -> 105%
    ]);
    expect(s.newlyPaused).toBe(1);
    expect(s.accounts[0].newlyPaused).toBe(true);
    expect(s.accounts[0].pausedNow).toBe(false);
    expect(s.accounts[0].pausedAfter).toBe(true);
  });

  it('an account already over its cap is alreadyPaused, not newlyPaused', () => {
    const s = classifyCutoverImpact([
      acct({ llmMicroUsd: 210 * M, vendorMicroUsd: 5 * M, capMicroUsd: 200 * M }),
    ]);
    expect(s.alreadyPaused).toBe(1);
    expect(s.newlyPaused).toBe(0);
  });

  it('an uncapped tier never pauses and has null percentages', () => {
    const s = classifyCutoverImpact([
      acct({ tier: 'Unlimited', llmMicroUsd: 999 * M, vendorMicroUsd: 999 * M, capMicroUsd: null }),
    ]);
    expect(s.uncapped).toBe(1);
    expect(s.capped).toBe(0);
    expect(s.newlyPaused).toBe(0);
    expect(s.accounts[0].percentNow).toBeNull();
    expect(s.accounts[0].percentAfter).toBeNull();
  });

  it('counts an account pushed from under half its cap to at-or-past half', () => {
    const s = classifyCutoverImpact([
      acct({ llmMicroUsd: 80 * M, vendorMicroUsd: 40 * M, capMicroUsd: 200 * M }), // 40% -> 60%
    ]);
    expect(s.pushedPast50).toBe(1);
  });

  it('does NOT count a pushed-past-50 account that actually paused', () => {
    const s = classifyCutoverImpact([
      acct({ llmMicroUsd: 90 * M, vendorMicroUsd: 130 * M, capMicroUsd: 200 * M }), // 45% -> 110% (paused)
    ]);
    expect(s.pushedPast50).toBe(0);
    expect(s.newlyPaused).toBe(1);
  });

  it('aggregates a mixed population correctly', () => {
    const s = classifyCutoverImpact([
      acct({ billingUserId: 'a', llmMicroUsd: 210 * M }), // already paused
      acct({ billingUserId: 'b', llmMicroUsd: 150 * M, vendorMicroUsd: 60 * M }), // newly paused
      acct({ billingUserId: 'c', llmMicroUsd: 10 * M, vendorMicroUsd: 1 * M }), // fine
      acct({ billingUserId: 'd', capMicroUsd: null }), // uncapped
    ]);
    expect(s).toMatchObject({ assessed: 4, capped: 3, uncapped: 1, alreadyPaused: 1, newlyPaused: 1 });
  });

  it('orders accounts by post-cutover cap fraction, uncapped last', () => {
    const s = classifyCutoverImpact([
      acct({ billingUserId: 'low', llmMicroUsd: 10 * M, vendorMicroUsd: 0, capMicroUsd: 200 * M }), // 5%
      acct({ billingUserId: 'uncapped', capMicroUsd: null }),
      acct({ billingUserId: 'high', llmMicroUsd: 150 * M, vendorMicroUsd: 0, capMicroUsd: 200 * M }), // 75%
    ]);
    expect(s.accounts.map((a) => a.billingUserId)).toEqual(['high', 'low', 'uncapped']);
  });
});
