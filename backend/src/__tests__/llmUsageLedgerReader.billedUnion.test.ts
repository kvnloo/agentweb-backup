/**
 * ENG-1251 — the itemized ledger must be the UNION of both read strategies.
 *
 * Two paths exist for reading an org's usage, and each is blind to rows the
 * other sees:
 *
 *  - **Partition fan-out** (`readPooledLedgerRows`) queries every member's
 *    partition and falls back to org inheritance when `billingUserId` is
 *    missing. It therefore finds HISTORICAL rows written before the attribute
 *    was stamped — but only for people who are members RIGHT NOW.
 *  - **Attribute scan** (`queryByBillingUserDateRange`) filters on the stamped
 *    `billingUserId`. It therefore finds rows belonging to FORMER members, who
 *    the fan-out no longer reaches — but only rows that carry the attribute.
 *
 * Neither is complete. `/usage/itemized` used the scan alone and undercounted
 * the founders org by 60.5% over Aug 12-15 ($86.23 seen against a true $218.13),
 * because most historical rows predate the write-time stamp.
 *
 * The union is the whole ledger, and it needs no backfill: both strategies read
 * data exactly as it already exists. Dedupe is on `{userId, sk}`, the table's
 * own primary key, so a row seen by both paths is counted once. Counting it
 * twice would overstate spend, which on a billing surface is a worse failure
 * than the undercount being fixed.
 */

jest.mock("../services/paymentHistoryDb", () => ({
  // ENG-1210: attribution for untagged rows is resolved per ROW DATE from the
  // payment-event timeline. Empty here means "no record", which the reader
  // falls back from to current-state inference -- the behaviour these suites
  // already assert.
  paymentHistoryDb: { getByUserId: jest.fn(async () => []) },
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));
jest.mock("../services/usageRecordDb", () => ({
  usageRecordDb: {
    queryByUserDateRange: jest.fn(),
    queryByBillingUserDateRange: jest.fn(),
  },
}));

import { readBilledLedgerRows } from "../services/llmUsageLedgerReader";
import { userDb, orgDb } from "../services/db";
import { usageRecordDb } from "../services/usageRecordDb";

const OWNER = "owner-1";
const MEMBER = "member-1";
const FORMER = "former-1";
const ORG = "org-1";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  userId: OWNER,
  sk: "2026-08-12#anthropic.claude-opus-5#agent_task",
  date: "2026-08-12",
  model: "anthropic.claude-opus-5",
  feature: "agent_task",
  costMicroUsd: 1_000_000,
  callCount: 1,
  billingUserId: OWNER,
  ...over,
});

const asOrgOwner = () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: OWNER, orgId: ORG });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: ORG, ownerUserId: OWNER });
  (orgDb.getOrgMembers as jest.Mock).mockResolvedValue([
    { userId: OWNER },
    { userId: MEMBER, subscription_status: "none" },
  ]);
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("readBilledLedgerRows — ENG-1251 union of fan-out and attribute scan", () => {
  it("keeps a historical row the scan cannot see because it carries no billingUserId", async () => {
    // The undercount in production: written before the write-time stamp, so the
    // attribute filter never matches it. Only the fan-out reaches it.
    asOrgOwner();
    const legacy = row({ userId: MEMBER, billingUserId: undefined, costMicroUsd: 7_000_000 });
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockImplementation(async (uid: string) =>
      uid === MEMBER ? [legacy] : [],
    );
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockResolvedValue([]);

    const rows = await readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15");

    expect(rows).toHaveLength(1);
    expect(rows[0].costMicroUsd).toBe(7_000_000);
  });

  it("keeps a former member's row the fan-out cannot see because they have left the org", async () => {
    // Stamped correctly while they were pooled, but they are no longer in
    // getOrgMembers, so no partition query reaches them. Only the scan does.
    asOrgOwner();
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockResolvedValue([]);
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockResolvedValue([
      row({ userId: FORMER, billingUserId: OWNER, costMicroUsd: 3_000_000 }),
    ]);

    const rows = await readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15");

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(FORMER);
  });

  it("counts a row seen by BOTH paths exactly once", async () => {
    // The overlap is the common case, not the edge case: a current member with
    // the attribute stamped is returned by the fan-out AND the scan. Summing
    // both would double this org's bill.
    asOrgOwner();
    const shared = row({ userId: MEMBER, billingUserId: OWNER, costMicroUsd: 5_000_000 });
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockImplementation(async (uid: string) =>
      uid === MEMBER ? [shared] : [],
    );
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockResolvedValue([{ ...shared }]);

    const rows = await readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15");

    expect(rows).toHaveLength(1);
    expect(rows.reduce((sum, r) => sum + r.costMicroUsd, 0)).toBe(5_000_000);
  });

  it("distinguishes rows that share a sort key but belong to different actors", async () => {
    // `sk` is date#model#feature, so two people doing the same work on the same
    // day collide on it. The dedupe key must be the table's real primary key.
    asOrgOwner();
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockImplementation(async (uid: string) => [
      row({ userId: uid, billingUserId: OWNER, costMicroUsd: 2_000_000 }),
    ]);
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockResolvedValue([]);

    const rows = await readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15");

    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, r) => sum + r.costMicroUsd, 0)).toBe(4_000_000);
  });

  it("does not pull in a member who pays for their own subscription", async () => {
    // ENG-1084: a member with a live subscription does not pool onto the org, so
    // their spend is not the owner's to see. The union must not become a way
    // around the inheritance predicate.
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: OWNER, orgId: ORG });
    (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: ORG, ownerUserId: OWNER });
    (orgDb.getOrgMembers as jest.Mock).mockResolvedValue([
      { userId: OWNER },
      { userId: MEMBER, subscription_status: "active" },
    ]);
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockImplementation(async (uid: string) =>
      uid === MEMBER ? [row({ userId: MEMBER, billingUserId: undefined })] : [],
    );
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockResolvedValue([]);

    const rows = await readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15");

    expect(rows).toHaveLength(0);
  });

  it("rejects rather than returning a partial ledger when the scan fails", async () => {
    // Half a bill presented as a whole one is the ENG-1251 defect restated. An
    // error is recoverable; a confidently low total is not.
    asOrgOwner();
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockResolvedValue([]);
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockRejectedValue(
      new Error("scan failed"),
    );

    await expect(readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15")).rejects.toThrow(
      "scan failed",
    );
  });

  it("rejects rather than returning a partial ledger when a partition read fails", async () => {
    asOrgOwner();
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockRejectedValue(new Error("query failed"));
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockResolvedValue([]);

    await expect(readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15")).rejects.toThrow(
      "query failed",
    );
  });

  it("reads only the caller's own partition for a solo account", async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: OWNER, orgId: undefined });
    (usageRecordDb.queryByUserDateRange as jest.Mock).mockResolvedValue([row()]);
    (usageRecordDb.queryByBillingUserDateRange as jest.Mock).mockResolvedValue([]);

    const rows = await readBilledLedgerRows(OWNER, "2026-08-12", "2026-08-15");

    expect(rows).toHaveLength(1);
    expect(usageRecordDb.queryByUserDateRange).toHaveBeenCalledTimes(1);
    expect(usageRecordDb.queryByUserDateRange).toHaveBeenCalledWith(
      OWNER,
      "2026-08-12",
      "2026-08-15",
    );
  });
});
