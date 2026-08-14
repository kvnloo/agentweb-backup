/**
 * ENG-1212 / ENG-1213 — the ledger must be read for the whole billing subject.
 *
 * Both runway and drivers resolved the BILLING USER correctly and then queried
 * `AW-UsageRecords` with that id as the PARTITION key. That is not the same
 * thing: `recordUsage` writes each row under the **acting** user's `userId` and
 * carries `billingUserId` only as an attribute, and the table has no GSI on it.
 * So an org root's partition holds the root's own calls and nothing else.
 *
 * The damage compounds rather than merely omitting rows. `costUsedMicroUsd` comes
 * from `getUserTokenUsage(billingUserId)`, and `incrementUserTokenUsage` resolves
 * to the billing root before incrementing — so the numerator IS pooled while the
 * daily burn read from the ledger is not. The forecast then divides a whole
 * account's consumption by one person's burn rate and reports a runway several
 * times too long, which is the exact surprise-exhaustion failure ENG-1200 exists
 * to prevent.
 *
 * `usageAnalyticsService`'s admin rollup already solved this shape (ENG-200
 * follow-up) by summing across `orgDb.getOrgMembers`. This reader is that same
 * pattern for the customer-facing path, with one required difference: ENG-1084
 * means a member paying for their own live subscription does NOT pool onto the
 * root, so charging their spend to the org's runway would be its own defect.
 * The membership predicate is therefore `inheritsOrgBilling` — the same one
 * `resolveBillingUserId` uses — so the two cannot drift.
 */

jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));
jest.mock("../services/usageRecordDb", () => ({
  usageRecordDb: { queryByUserDateRange: jest.fn() },
}));

import {
  resolvePooledLedgerUserIds,
  readPooledLedgerRows,
} from "../services/llmUsageLedgerReader";
import { userDb, orgDb } from "../services/db";
import { usageRecordDb } from "../services/usageRecordDb";

const mockUser = userDb.getUserById as jest.Mock;
const mockOrg = orgDb.getOrgById as jest.Mock;
const mockMembers = orgDb.getOrgMembers as jest.Mock;
const mockQuery = usageRecordDb.queryByUserDateRange as jest.Mock;

const ROOT = "billing-root";
const ORG = "org-1";

const row = (userId: string, costMicroUsd: number) => ({
  userId,
  date: "2026-08-01",
  sk: "2026-08-01#anthropic.claude-opus-5#agent_task",
  model: "anthropic.claude-opus-5",
  feature: "agent_task",
  costMicroUsd,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([]);
});

describe("resolvePooledLedgerUserIds", () => {
  it("returns just the user when they belong to no org", async () => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: null });
    expect(await resolvePooledLedgerUserIds(ROOT)).toEqual([ROOT]);
    expect(mockMembers).not.toHaveBeenCalled();
  });

  it("includes every member that pools onto the root", async () => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: ORG });
    mockOrg.mockResolvedValue({ orgId: ORG, ownerUserId: ROOT });
    mockMembers.mockResolvedValue([
      { userId: ROOT, orgId: ORG },
      { userId: "member-a", orgId: ORG },
      { userId: "member-b", orgId: ORG, subscription_status: "canceled" },
    ]);
    const ids = await resolvePooledLedgerUserIds(ROOT);
    expect(new Set(ids)).toEqual(new Set([ROOT, "member-a", "member-b"]));
  });

  it("excludes a member paying for their own live subscription (ENG-1084)", async () => {
    // Their spend is billed to them, not to the org. Counting it against the
    // org's runway would charge the org for usage someone else pays for.
    mockUser.mockResolvedValue({ userId: ROOT, orgId: ORG });
    mockOrg.mockResolvedValue({ orgId: ORG, ownerUserId: ROOT });
    mockMembers.mockResolvedValue([
      { userId: ROOT, orgId: ORG },
      { userId: "self-payer", orgId: ORG, subscription_status: "active" },
      { userId: "trialing-self-payer", orgId: ORG, subscription_status: "trialing" },
      { userId: "pooled", orgId: ORG, subscription_status: "past_due" },
    ]);
    const ids = await resolvePooledLedgerUserIds(ROOT);
    expect(new Set(ids)).toEqual(new Set([ROOT, "pooled"]));
  });

  it("never returns a duplicate id, even though getOrgMembers includes the owner", async () => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: ORG });
    mockOrg.mockResolvedValue({ orgId: ORG, ownerUserId: ROOT });
    mockMembers.mockResolvedValue([{ userId: ROOT, orgId: ORG }, { userId: ROOT, orgId: ORG }]);
    expect(await resolvePooledLedgerUserIds(ROOT)).toEqual([ROOT]);
  });

  it("reads only the subject's own partition when it is not the billing root", async () => {
    // Defensive: callers resolve the billing subject first, so this should not
    // happen. If it does, pulling in an org's whole ledger for someone who does
    // not own it would be a cross-tenant disclosure, so narrow rather than widen.
    mockUser.mockResolvedValue({ userId: "member-a", orgId: ORG });
    mockOrg.mockResolvedValue({ orgId: ORG, ownerUserId: ROOT });
    expect(await resolvePooledLedgerUserIds("member-a")).toEqual(["member-a"]);
    expect(mockMembers).not.toHaveBeenCalled();
  });

  it("falls back to the subject alone when the org record cannot be resolved", async () => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: ORG });
    mockOrg.mockResolvedValue(null);
    expect(await resolvePooledLedgerUserIds(ROOT)).toEqual([ROOT]);
  });
});

describe("readPooledLedgerRows", () => {
  const orgOfTwo = () => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: ORG });
    mockOrg.mockResolvedValue({ orgId: ORG, ownerUserId: ROOT });
    mockMembers.mockResolvedValue([
      { userId: ROOT, orgId: ORG },
      { userId: "member-a", orgId: ORG },
    ]);
  };

  it("merges rows from every pooled partition", async () => {
    orgOfTwo();
    mockQuery.mockImplementation(async (uid: string) =>
      uid === ROOT ? [row(ROOT, 10)] : [row("member-a", 90)],
    );
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.costMicroUsd, 0)).toBe(100);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledWith("member-a", "2026-08-01", "2026-08-11");
  });

  it("fails loud when one member's partition cannot be read", async () => {
    // Swallowing the error into empty rows would understate burn and overstate
    // runway — confidently wrong beats visibly broken only if you never have to
    // explain it to the customer who ran out early.
    orgOfTwo();
    mockQuery.mockImplementation(async (uid: string) => {
      if (uid === "member-a") throw new Error("dynamo throttled");
      return [row(ROOT, 10)];
    });
    await expect(readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11")).rejects.toThrow(
      /throttled/,
    );
  });

  it("issues exactly one query for a solo user", async () => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: null });
    mockQuery.mockResolvedValue([row(ROOT, 5)]);
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows).toHaveLength(1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
