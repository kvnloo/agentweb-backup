import { classifyBoundList } from "../scripts/backfill-eng967-lead-list-public-access";

/**
 * ENG-967: the backfill repairs production data in bulk, so the policy deciding WHICH
 * bound lead lists get written is pinned here rather than inferred from a dry run.
 *
 * The boundary that matters: only a page-bound list that is not publicly submittable is
 * ever written. An already-public list is never touched — including the empty one that
 * proves public access was never its problem (list_1779822422539_l5yvansu2).
 */
describe("backfill-eng967-lead-list-public-access — classifyBoundList", () => {
  it("repairs a bound list with publicAccessEnabled=false (the ENG-967 failure)", () => {
    expect(classifyBoundList({ publicAccessEnabled: false, leadCount: 0 })).toEqual({
      action: "repair",
      reason: "private-list-bound-to-page",
    });
  });

  it("repairs a bound list that has no publicAccessEnabled attribute at all", () => {
    // forward-lead demands `=== true`, so an absent attribute drops leads exactly like false.
    expect(classifyBoundList({}).action).toBe("repair");
  });

  it("does not treat a truthy-but-not-true value as public", () => {
    expect(classifyBoundList({ publicAccessEnabled: "true" as any }).action).toBe("repair");
  });

  it("flags a referenced list that does not exist for diagnosis, never a write", () => {
    for (const missing of [null, undefined]) {
      expect(classifyBoundList(missing)).toEqual({
        action: "needs-diagnosis",
        reason: "list-missing",
      });
    }
  });

  it("flags an already-public list with zero leads for diagnosis instead of rewriting it", () => {
    // list_1779822422539_l5yvansu2: public in prod today and still empty — a different cause.
    expect(classifyBoundList({ publicAccessEnabled: true, leadCount: 0 })).toEqual({
      action: "needs-diagnosis",
      reason: "already-public-but-empty",
    });
    expect(classifyBoundList({ publicAccessEnabled: true }).reason).toBe("already-public-but-empty");
  });

  it("leaves an already-public list that is capturing leads alone", () => {
    expect(classifyBoundList({ publicAccessEnabled: true, leadCount: 42 })).toEqual({
      action: "ok",
      reason: "already-public",
    });
  });
});
