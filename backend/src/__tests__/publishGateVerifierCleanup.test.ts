import {
  planVerifierCleanup,
  VERIFIER_FIXTURE_TAG,
  VERIFIER_BRANCH_PREFIX,
} from "../services/publishGateVerifierCleanup";

const ORG = "verifier-org";
const now = new Date("2026-11-04T00:00:00Z");
const old = "2026-11-01T00:00:00Z";

describe("planVerifierCleanup (ENG-2795)", () => {
  it("selects only tagged pages in the fixture org and never a non-verifier page", () => {
    const plan = planVerifierCleanup(
      [
        { id: "fixture", organizationId: ORG, tags: [VERIFIER_FIXTURE_TAG], createdAt: old },
        { id: "customer-untagged", organizationId: "cust", tags: ["promo"], createdAt: old },
        { id: "customer-tagged", organizationId: "cust", tags: [VERIFIER_FIXTURE_TAG], createdAt: old },
        { id: "same-org-untagged", organizationId: ORG, tags: [], createdAt: old },
        { id: "no-tags", organizationId: ORG, createdAt: old },
        { id: "near-tag", organizationId: ORG, tags: ["publish-gate-verifier-x"], createdAt: old },
      ],
      { fixtureOrganizationId: ORG, now }
    );
    expect(plan.dryRun).toBe(true);
    expect(plan.delete.map((d) => d.pageId)).toEqual(["fixture"]);
    expect(plan.skipped.map((s) => s.pageId)).toEqual([
      "customer-untagged", "customer-tagged", "same-org-untagged", "no-tags", "near-tag",
    ]);
  });

  it("selects nothing when the fixture org is empty", () => {
    const plan = planVerifierCleanup(
      [{ id: "p", organizationId: "", tags: [VERIFIER_FIXTURE_TAG], createdAt: old }],
      { fixtureOrganizationId: "", now }
    );
    expect(plan.delete).toEqual([]);
  });

  it("skips recent or undated fixture pages and keeps only verifier branches", () => {
    const plan = planVerifierCleanup(
      [
        { id: "recent", organizationId: ORG, tags: [VERIFIER_FIXTURE_TAG], createdAt: "2026-11-03T23:00:00Z" },
        { id: "undated", organizationId: ORG, tags: [VERIFIER_FIXTURE_TAG] },
        {
          id: "old", organizationId: ORG, tags: [VERIFIER_FIXTURE_TAG], createdAt: old,
          branches: [`${VERIFIER_BRANCH_PREFIX}abc`, "main", "draft/customer"],
        },
      ],
      { fixtureOrganizationId: ORG, now }
    );
    expect(plan.delete).toEqual([{ pageId: "old", branches: [`${VERIFIER_BRANCH_PREFIX}abc`] }]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["too_recent_or_unknown_age", "too_recent_or_unknown_age"]);
  });
});
