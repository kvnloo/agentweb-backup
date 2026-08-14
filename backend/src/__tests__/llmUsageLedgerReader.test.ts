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

/**
 * A ledger row. `billingUserId` defaults to the acting user because that is what
 * production rows actually carry: `recordUsage` falls back to `ctx.billingUserId
 * || userId`, and no agent-mode call site passed one until ENG-1217. A row whose
 * `billingUserId` differs from its `userId` is therefore a DELIBERATE record of
 * where the spend was billed, which is exactly what makes it trustworthy.
 */
const row = (userId: string, costMicroUsd: number, billingUserId?: string) => ({
  userId,
  date: "2026-08-01",
  sk: "2026-08-01#anthropic.claude-opus-5#agent_task",
  model: "anthropic.claude-opus-5",
  feature: "agent_task",
  costMicroUsd,
  billingUserId: billingUserId ?? userId,
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

  it("returns a self-payer's partition as a CANDIDATE, not as pooled spend", async () => {
    // ENG-1084 decides whose spend counts, but that is a per-ROW question and it
    // is answered in `readPooledLedgerRows`. Discovery only answers "which
    // partitions could hold a row billed to this subject", and a self-payer's
    // partition can: they may have been pooling earlier in the same cycle.
    // Excluding them here is what made the window unreadable at a transition —
    // the partition was never queried, so those rows could not be recovered by
    // any later filter.
    mockUser.mockResolvedValue({ userId: ROOT, orgId: ORG });
    mockOrg.mockResolvedValue({ orgId: ORG, ownerUserId: ROOT });
    mockMembers.mockResolvedValue([
      { userId: ROOT, orgId: ORG },
      { userId: "self-payer", orgId: ORG, subscription_status: "active" },
      { userId: "trialing-self-payer", orgId: ORG, subscription_status: "trialing" },
      { userId: "pooled", orgId: ORG, subscription_status: "past_due" },
    ]);
    const ids = await resolvePooledLedgerUserIds(ROOT);
    expect(new Set(ids)).toEqual(
      new Set([ROOT, "self-payer", "trialing-self-payer", "pooled"]),
    );
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

/**
 * Which ROWS in those partitions belong to the subject.
 *
 * Discovery is a current-state question and can only ever be one; membership is
 * not versioned anywhere. Attribution is a historical question, and answering it
 * from current state is what breaks at a transition: a member who starts their
 * own subscription mid-cycle takes their whole cycle's history out of the org's
 * burn, and a member who cancels theirs mid-cycle hands the org a whole cycle it
 * was never billed for. Both move the forecast, and the first moves it in the
 * dangerous direction — burn drops, runway lengthens, the customer is reassured
 * and then stops.
 *
 * So the row decides, whenever the row knows: a recorded `billingUserId` that
 * differs from the acting user is a statement made at write time about where that
 * spend landed. Where the row does not know — every row written before ENG-1217
 * tagged the agent-mode path — current membership is the honest fallback, and it
 * is no worse than what it replaces.
 */
describe("readPooledLedgerRows — attribution within a partition", () => {
  const orgWith = (members: Array<{ userId: string; subscription_status?: string }>) => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: ORG });
    mockOrg.mockResolvedValue({ orgId: ORG, ownerUserId: ROOT });
    mockMembers.mockResolvedValue(members.map((m) => ({ ...m, orgId: ORG })));
  };

  it("keeps a member's rows that recorded this subject as the payer", async () => {
    orgWith([{ userId: ROOT }, { userId: "member-a" }]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === ROOT ? [row(ROOT, 10)] : [row("member-a", 90, ROOT)],
    );
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows.reduce((s, r) => s + r.costMicroUsd, 0)).toBe(100);
  });

  it("drops a member's rows that recorded somebody else as the payer", async () => {
    // The member is in the org and currently pools, but these particular rows say
    // they were billed elsewhere. The record outranks the inference.
    orgWith([{ userId: ROOT }, { userId: "member-a" }]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === ROOT ? [row(ROOT, 10)] : [row("member-a", 90, "some-other-root")],
    );
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].costMicroUsd).toBe(10);
  });

  it("recovers the pre-transition history of a member who now self-pays", async () => {
    // THE regression this exists for. `inheritsOrgBilling` is false for them
    // today, so the old reader never queried their partition and the org's burn
    // silently lost the first half of its own cycle.
    orgWith([{ userId: ROOT }, { userId: "switcher", subscription_status: "active" }]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === ROOT
        ? [row(ROOT, 10)]
        : [
            // Written while they still pooled onto the org.
            row("switcher", 70, ROOT),
            // Written after they started paying for themselves.
            row("switcher", 500),
          ],
    );
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows.reduce((s, r) => s + r.costMicroUsd, 0)).toBe(80);
  });

  it("never lends a self-payer's own spend to the org (ENG-1084 still holds)", async () => {
    orgWith([{ userId: ROOT }, { userId: "self-payer", subscription_status: "active" }]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === ROOT ? [row(ROOT, 10)] : [row("self-payer", 900)],
    );
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ROOT);
  });

  it("falls back to current membership for rows written before the tag", async () => {
    // Untagged rows carry `billingUserId === userId` and say nothing. A member who
    // pools today is assumed to have pooled then — the same assumption the reader
    // made for every row before this change, now confined to the rows that
    // genuinely cannot answer for themselves.
    orgWith([{ userId: ROOT }, { userId: "member-a", subscription_status: "canceled" }]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === ROOT ? [row(ROOT, 10)] : [row("member-a", 90)],
    );
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows.reduce((s, r) => s + r.costMicroUsd, 0)).toBe(100);
  });

  it("always keeps the subject's own partition, whatever the rows claim", async () => {
    // `inheritsOrgBilling` is false for the billing root by construction
    // (`isBillingRoot`), so using it as the row test unguarded would throw away
    // the root's own spend — the largest partition in most orgs.
    orgWith([{ userId: ROOT }, { userId: "member-a" }]);
    mockQuery.mockImplementation(async (uid: string) =>
      uid === ROOT ? [row(ROOT, 42)] : [],
    );
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].costMicroUsd).toBe(42);
  });

  it("keeps a solo user's rows without consulting membership at all", async () => {
    mockUser.mockResolvedValue({ userId: ROOT, orgId: null });
    mockQuery.mockResolvedValue([row(ROOT, 5)]);
    const rows = await readPooledLedgerRows(ROOT, "2026-08-01", "2026-08-11");
    expect(rows).toHaveLength(1);
    expect(mockMembers).not.toHaveBeenCalled();
  });
});
