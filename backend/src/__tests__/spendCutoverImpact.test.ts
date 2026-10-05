/**
 * ENG-2010 — the §9 cutover-impact model.
 *
 * The load-bearing claim, and the one I got wrong by hand before this existed:
 * the cutover compares spend against the CAP, not vendor-spend against
 * LLM-spend. So the risk is small caps (Free tier), not big-ratio whales. Every
 * assertion here is against the cap.
 */
import { classifyCutoverImpact, CutoverAccountInput, poolSpendByOwner } from '../services/spendCutoverImpact';

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

/**
 * ENG-2286 — the model must measure what the GATE measures.
 *
 * The gate resolves an org member onto the org's billing root and never looks at
 * the member's own id. Summing by the recorded id (which was often the member's)
 * modelled a gate that does not exist, and flagged three accounts as "newly
 * paused" on 2026-10-05 — every one of them an org member.
 */
describe('poolSpendByOwner', () => {
  const spend = (llm: number, vendor: number) => ({ llm: llm * M, vendor: vendor * M });
  const subjects = (entries: Array<[string, { llm: number; vendor: number }]>) => new Map(entries);

  it("folds a member's spend into its owner and the member stops being its own subject", () => {
    const pooled = poolSpendByOwner(
      subjects([
        ['owner', spend(22, 0)],
        ['member', spend(0, 30)],
      ]),
      new Map([['member', 'owner']]),
    );

    expect([...pooled.keys()]).toEqual(['owner']);
    expect(pooled.get('owner')).toMatchObject({ billingUserId: 'owner', llm: 22 * M, vendor: 30 * M });
    expect(pooled.get('owner')!.pooledFrom).toEqual([{ id: 'member', llm: 0, vendor: 30 * M }]);
  });

  it("pools several members onto one owner and lists each contribution", () => {
    const pooled = poolSpendByOwner(
      subjects([
        ['owner', spend(10, 1)],
        ['m1', spend(1, 2)],
        ['m2', spend(3, 4)],
      ]),
      new Map([
        ['m1', 'owner'],
        ['m2', 'owner'],
      ]),
    );

    expect(pooled.get('owner')).toMatchObject({ llm: 14 * M, vendor: 7 * M });
    expect(pooled.get('owner')!.pooledFrom.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it("an owner with no spend of its own still appears, built from its members", () => {
    const pooled = poolSpendByOwner(subjects([['member', spend(0, 5)]]), new Map([['member', 'idle-owner']]));

    expect(pooled.get('idle-owner')).toMatchObject({ billingUserId: 'idle-owner', llm: 0, vendor: 5 * M });
    expect(pooled.has('member')).toBe(false);
  });

  it("an id absent from the owner map, or mapped to itself, stays its own subject", () => {
    const pooled = poolSpendByOwner(
      subjects([
        ['solo', spend(1, 1)],
        ['self', spend(2, 2)],
      ]),
      new Map([['self', 'self']]),
    );

    expect(pooled.get('solo')).toMatchObject({ llm: 1 * M, vendor: 1 * M, pooledFrom: [] });
    expect(pooled.get('self')).toMatchObject({ llm: 2 * M, vendor: 2 * M, pooledFrom: [] });
  });

  it("does not mutate its inputs", () => {
    const input = subjects([
      ['owner', spend(1, 1)],
      ['member', spend(2, 2)],
    ]);
    const owners = new Map([['member', 'owner']]);
    poolSpendByOwner(input, owners);

    expect(input.get('owner')).toEqual({ llm: 1 * M, vendor: 1 * M });
    expect(input.size).toBe(2);
    expect([...owners.entries()]).toEqual([['member', 'owner']]);
  });

  it("THE ARTIFACT: a Free org member that looked paused against its own $5 cap is not, once pooled onto its Starter owner", () => {
    // 2026-10-05: 0d1b79d9 (Free) had $30.72 of vendor spend recorded against itself
    // and was reported as 614% of a $5 cap. The gate measures it against its
    // owner's pool: Starter, $80 cap, $22.35 used.
    const perRecorded = subjects([
      ['owner', spend(22.35, 0)],
      ['free-member', spend(0, 30.72)],
    ]);

    // Un-pooled (the old model): the member is its own Free account, paused.
    const before = classifyCutoverImpact([
      { billingUserId: 'owner', tier: 'Starter', llmMicroUsd: 22.35 * M, vendorMicroUsd: 0, capMicroUsd: 80 * M },
      { billingUserId: 'free-member', tier: 'Free', llmMicroUsd: 0, vendorMicroUsd: 30.72 * M, capMicroUsd: 5 * M },
    ]);
    expect(before.newlyPaused).toBe(1);

    // Pooled (the gate): one Starter subject at $53.07 of $80 — nobody pauses.
    const pooled = poolSpendByOwner(perRecorded, new Map([['free-member', 'owner']]));
    const o = pooled.get('owner')!;
    const after = classifyCutoverImpact([
      { billingUserId: 'owner', tier: 'Starter', llmMicroUsd: o.llm, vendorMicroUsd: o.vendor, capMicroUsd: 80 * M },
    ]);
    expect(after.assessed).toBe(1);
    expect(after.newlyPaused).toBe(0);
    expect(after.accounts[0].percentAfter).toBeCloseTo(66.3, 1);
  });

  it("pooling can CREATE a real pause the un-pooled view hid", () => {
    // The other direction matters just as much: members' vendor spend pushing an
    // owner over its cap is exactly what the gate will enforce.
    const pooled = poolSpendByOwner(
      subjects([
        ['owner', spend(60, 0)],
        ['member', spend(0, 30)],
      ]),
      new Map([['member', 'owner']]),
    );
    const o = pooled.get('owner')!;
    const s = classifyCutoverImpact([
      { billingUserId: 'owner', tier: 'Starter', llmMicroUsd: o.llm, vendorMicroUsd: o.vendor, capMicroUsd: 80 * M },
    ]);

    expect(s.newlyPaused).toBe(1); // 60 llm alone is under $80; 90 all-in is over
  });
});
