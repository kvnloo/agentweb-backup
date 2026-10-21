/** ENG-2110 (1c): the conditional writes behind a hosted login, on the in-memory table. Each condition is an invariant the sweeper and routes rely on. */
import type { LlmConnectionRecord } from "../llmConnectionDb";
import { makeDb } from "./llmConnectionTestKit";

const NOW = "2026-10-21T10:00:00.000Z";
const LATER = "2026-10-21T11:00:00.000Z";
function hosted(over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord {
  return { connectionId: "h-1", ownerUserId: "user-1", kind: "claude_subscription", provider: "anthropic", status: "active", keyLast4: "", createdAt: NOW, updatedAt: NOW, subHosted: true, subHostEpoch: 1, subNeedsReconnect: false, subType: "max", ...over };
}
const by = { userId: "user-1" };

describe("hostedBeginRevoke", () => {
  it.each(["active", "invalid", "disabled", "expired"] as const)("starts from %s: fences at the new epoch, becomes revoking, drops the org share", async (status) => {
    const { db } = makeDb();
    await db.create(hosted({ status, orgId: "org-1" }));
    expect((await db.hostedBeginRevoke("h-1", 2, by, LATER)).result).toBe("started");
    const row = (await db.get("h-1"))!;
    expect(row).toMatchObject({ status: "revoking", subHostEpoch: 2, subRevokeStartedAt: LATER, revokedByUserId: "user-1" });
    expect(row.orgId).toBeUndefined();
    expect(row.revokedAt).toBeUndefined(); // revoked only when the host says so
  });

  it("is 'already' for revoking and revoked rows, 'missing' for none, 'not_hosted' for an old sealed row", async () => {
    const { db } = makeDb();
    await db.create(hosted({ status: "revoking" }));
    await db.create(hosted({ connectionId: "h-2", status: "revoked", revokedAt: NOW }));
    await db.create(hosted({ connectionId: "b3", subHosted: undefined, subHostEpoch: undefined }));
    expect((await db.hostedBeginRevoke("h-1", 2, by, LATER)).result).toBe("already");
    expect((await db.hostedBeginRevoke("h-2", 2, by, LATER)).result).toBe("already");
    expect((await db.hostedBeginRevoke("nope", 2, by, LATER)).result).toBe("missing");
    expect((await db.hostedBeginRevoke("b3", 2, by, LATER)).result).toBe("not_hosted");
    expect((await db.get("b3"))!.status).toBe("active");
  });

  it("a caller with a stale epoch fences ABOVE the current one instead of being refused or lowering it", async () => {
    const { db } = makeDb();
    await db.create(hosted({ subHostEpoch: 5 }));
    expect(await db.hostedBeginRevoke("h-1", 3, by, LATER)).toEqual({ result: "started", epoch: 6 });
    expect((await db.get("h-1"))!).toMatchObject({ status: "revoking", subHostEpoch: 6 });
  });

  it("reports the epoch of an already-revoking row and never changes it", async () => {
    const { db } = makeDb();
    await db.create(hosted({ status: "revoking", subHostEpoch: 4 }));
    expect(await db.hostedBeginRevoke("h-1", 9, by, LATER)).toEqual({ result: "already", epoch: 4 });
    expect((await db.get("h-1"))!.subHostEpoch).toBe(4);
  });

  it("records the delegated admin", async () => {
    const { db } = makeDb();
    await db.create(hosted());
    await db.hostedBeginRevoke("h-1", 2, { userId: "user-1", adminId: "admin-1" }, LATER);
    expect((await db.get("h-1"))!.revokedByAdminId).toBe("admin-1");
  });
});

describe("hostedMarkRevoked", () => {
  it("moves only revoking -> revoked", async () => {
    const { db } = makeDb();
    await db.create(hosted());
    expect(await db.hostedMarkRevoked("h-1", LATER)).toBe(false);
    expect((await db.get("h-1"))!.status).toBe("active");
    await db.hostedBeginRevoke("h-1", 2, by, LATER);
    expect(await db.hostedMarkRevoked("h-1", LATER)).toBe(true);
    expect((await db.get("h-1"))!).toMatchObject({ status: "revoked", revokedAt: LATER });
    expect(await db.hostedMarkRevoked("h-1", LATER)).toBe(false);
  });

  it("never touches an old sealed row", async () => {
    const { db } = makeDb();
    await db.create(hosted({ connectionId: "b3", subHosted: undefined, status: "revoking" }));
    expect(await db.hostedMarkRevoked("b3", LATER)).toBe(false);
  });
});

describe("the plain revoke write", () => {
  it("refuses a hosted row (its home must be wiped by the host first) but still revokes an API key", async () => {
    const { db } = makeDb();
    await db.create(hosted());
    await db.create({ connectionId: "k-1", ownerUserId: "user-1", kind: "api_key", provider: "openai", status: "active", keyLast4: "abcd", createdAt: NOW, updatedAt: NOW });
    expect(await db.revoke("h-1", by, LATER)).toBe(false);
    expect((await db.get("h-1"))!.status).toBe("active");
    expect(await db.revoke("k-1", by, LATER)).toBe(true);
  });
});

describe("hostedAdvanceEpoch / hostedMarkNeedsReconnect / hostedMarkReconnected", () => {
  it("advance is conditional on the epoch read, and never on a revoking or revoked row", async () => {
    const { db } = makeDb();
    await db.create(hosted());
    expect(await db.hostedAdvanceEpoch("h-1", 9, 10, LATER)).toBe(false);
    expect(await db.hostedAdvanceEpoch("h-1", 1, 2, LATER)).toBe(true);
    expect(await db.hostedAdvanceEpoch("h-1", 1, 2, LATER)).toBe(false); // a second racer loses
    await db.hostedBeginRevoke("h-1", 3, by, LATER);
    expect(await db.hostedAdvanceEpoch("h-1", 3, 4, LATER)).toBe(false);
  });

  it("needs-reconnect applies only at the record's own epoch, and reconnected clears it and refreshes the plan", async () => {
    const { db } = makeDb();
    await db.create(hosted({ subHostEpoch: 2 }));
    expect(await db.hostedMarkNeedsReconnect("h-1", 1, "x", LATER)).toBe(false);
    expect(await db.hostedMarkNeedsReconnect("h-1", 2, "host_lost", LATER)).toBe(true);
    expect((await db.get("h-1"))!).toMatchObject({ status: "invalid", subNeedsReconnect: true, subReconnectReason: "host_lost" });
    expect(await db.hostedMarkReconnected("h-1", 3, { plan: "pro" }, LATER)).toBe(false);
    expect(await db.hostedMarkReconnected("h-1", 2, { plan: "pro", refreshExpiresAtMs: 123, fingerprint: "fp" }, LATER)).toBe(true);
    const row = (await db.get("h-1"))!;
    expect(row).toMatchObject({ status: "active", subNeedsReconnect: false, subType: "pro", subRefreshExpiresAtMs: 123, subAccountFingerprint: "fp" });
    expect(row.subReconnectReason).toBeUndefined();
  });

  it("the sweeper's needs-reconnect loses to any write made after it read the row", async () => {
    const { db } = makeDb();
    await db.create(hosted());
    expect(await db.hostedMarkNeedsReconnect("h-1", 1, "epoch_mismatch", LATER, "2000-01-01T00:00:00.000Z")).toBe(false);
    expect((await db.get("h-1"))!.status).toBe("active");
    expect(await db.hostedMarkNeedsReconnect("h-1", 1, "epoch_mismatch", LATER, NOW)).toBe(true);
  });

  it("an expired hosted login can be reconnected", async () => {
    const { db } = makeDb();
    await db.create(hosted({ status: "expired" }));
    expect(await db.hostedAdvanceEpoch("h-1", 1, 2, LATER)).toBe(true);
    expect(await db.hostedMarkReconnected("h-1", 2, {}, LATER)).toBe(true);
    expect((await db.get("h-1"))!.status).toBe("active");
  });
});

describe("revoke attempts and listing", () => {
  it("counts attempts only while revoking, and lists hosted rows only", async () => {
    const { db } = makeDb();
    await db.create(hosted());
    await db.create(hosted({ connectionId: "b3", subHosted: undefined }));
    await db.hostedNoteRevokeAttempt("h-1", LATER);
    expect((await db.get("h-1"))!.subRevokeAttempts).toBeUndefined();
    await db.hostedBeginRevoke("h-1", 2, by, LATER);
    await db.hostedNoteRevokeAttempt("h-1", LATER);
    await db.hostedNoteRevokeAttempt("h-1", LATER);
    expect((await db.get("h-1"))!).toMatchObject({ subRevokeAttempts: 2, subLastRevokeAttemptAt: LATER });
    expect((await db.listHosted()).map((r) => r.connectionId)).toEqual(["h-1"]);
  });
});

describe("hostedReleaseSlot", () => {
  const counter = (dynamo: ReturnType<typeof makeDb>["dynamo"]) => dynamo.items("AW-LlmConnections" as never).find((r) => r.connectionId === "limit#user-1")?.activeCount;

  it("gives the slot back exactly once, flag and counter in one transaction", async () => {
    const { db, dynamo } = makeDb();
    expect(await db.createWithinLimit(hosted(), 10)).toBe(true);
    expect(await db.createWithinLimit(hosted({ connectionId: "h-2" }), 10)).toBe(true);
    expect(counter(dynamo)).toBe(2);
    expect(await db.hostedReleaseSlot("h-1", "user-1")).toBe("released");
    expect(await db.hostedReleaseSlot("h-1", "user-1")).toBe("already");
    expect(counter(dynamo)).toBe(1);
    expect((await db.get("h-1"))!.subSlotReleased).toBe(true);
    expect((await db.get("h-2"))!.subSlotReleased).toBeUndefined();
  });

  it("with the counter already at zero it only records the release", async () => {
    const { db, dynamo } = makeDb();
    await db.createWithinLimit(hosted(), 10);
    await db.releaseSlot("user-1");
    expect(counter(dynamo)).toBe(0);
    expect(await db.hostedReleaseSlot("h-1", "user-1")).toBe("released");
    expect(counter(dynamo)).toBe(0);
    expect((await db.get("h-1"))!.subSlotReleased).toBe(true);
  });

  it("never touches the counter for an old sealed row or a missing row", async () => {
    const { db, dynamo } = makeDb();
    await db.createWithinLimit(hosted(), 10);
    await db.create(hosted({ connectionId: "b3", subHosted: undefined }));
    expect(await db.hostedReleaseSlot("b3", "user-1")).toBe("already");
    expect(await db.hostedReleaseSlot("nope", "user-1")).toBe("already");
    expect(counter(dynamo)).toBe(1);
  });
});
