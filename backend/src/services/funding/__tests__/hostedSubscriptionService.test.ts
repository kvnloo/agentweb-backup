/**
 * ENG-2110 PR 1c-ii/1d: the hosted subscription service against the REAL login-host server (real unix socket, fake provider)
 * and the in-memory table. These protect: no record without a home and no home without a record, the epoch order, a disconnect
 * that is never reported done before the host says so, and a plain revoke that can never orphan a home.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startHostServer, type HostServerHandle } from "../../../loginHost/server";
import { makeRig, type Rig } from "../../../loginHost/__tests__/helpers";
import { HostedSubscriptionError, HostedSubscriptionService, REVOKE_ALARM_ATTEMPTS, type HostedProvider } from "../hostedSubscriptionService";
import { LlmConnectionService } from "../llmConnectionService";
import { LoginHostClient, UnixSocketTransport } from "../loginHostClient";
import { FakeKms, makeDb } from "./llmConnectionTestKit";

const GOOD = "GOODCODE1#GOODSTATE1";
const codeOf = (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e instanceof HostedSubscriptionError ? e.code : `unexpected:${(e as Error)?.message}`));

describe("hosted subscription service", () => {
  let rig: Rig;
  let dir: string;
  let handle: HostServerHandle | undefined;
  let sock: string;
  let hostUp: boolean;
  let configured: boolean;
  let enabled: Set<string>;
  let svc: HostedSubscriptionService;
  let store: ReturnType<typeof makeDb>;
  let ids: number;
  const user = { userId: "user-1" };

  const provider = (): HostedProvider => ({ route: "claude", kind: "claude_subscription", recordProvider: "anthropic", hostProvider: "fake", isEnabledFor: async (u) => enabled.has(u) });
  const slots = () => store.dynamo.items("AW-LlmConnections" as never).find((r) => r.connectionId === "limit#user-1")?.activeCount ?? 0;
  const hostState = (id: string) => {
    try {
      return rig.mgr.status({ connectionId: id }).state;
    } catch {
      return "none";
    }
  };

  async function boot(over: Parameters<typeof makeRig>[0] = {}) {
    rig = makeRig(over);
    dir = mkdtempSync(join(tmpdir(), "hosted-svc-"));
    sock = join(dir, "host.sock");
    handle = await startHostServer(rig.mgr, { socketPath: sock, socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 });
    hostUp = true;
    configured = true;
    enabled = new Set(["user-1", "user-2"]);
    store = makeDb();
    ids = 0;
    svc = new HostedSubscriptionService({
      db: store.db,
      // A host that is "down" answers like an unreachable socket; "unconfigured" has no client at all.
      client: () => (configured ? new LoginHostClient(new UnixSocketTransport(hostUp ? sock : join(dir, "nobody.sock"))) : undefined),
      providers: { claude: provider() },
      now: () => Date.now(),
      newId: () => `conn-${++ids}`,
      sleep: async () => undefined,
    });
  }
  afterEach(async () => {
    await svc?.shutdown();
    await handle?.close();
    rig?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function connect(actor = user) {
    const started = await svc.startLogin(actor, "claude");
    return svc.completeLogin(actor, started.loginId, GOOD);
  }

  describe("sign-in", () => {
    beforeEach(() => boot({ config: { uidMax: 400_100 } }));

    it("creates a reference-only record at epoch 1 and a promoted home on the host", async () => {
      const started = await svc.startLogin(user, "claude");
      expect(started).toMatchObject({ ceremony: "paste_code", authorizeUrl: "https://example.test/authorize" });
      const view = await svc.completeLogin(user, started.loginId, GOOD);
      expect(view).toMatchObject({ kind: "claude_subscription", provider: "anthropic", status: "active", ownedByCaller: true, subscription: { plan: "max", needsReconnect: false } });
      const row = (await store.db.get(view.connectionId))!;
      expect(row).toMatchObject({ subHosted: true, subHostEpoch: 1, status: "active" });
      expect(row.sealed).toBeUndefined();
      expect(row.subVersion).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain(GOOD);
      expect(rig.mgr.status({ connectionId: view.connectionId })).toMatchObject({ state: "active", epoch: 1 });
      expect(slots()).toBe(1);
    });

    it("a wrong code is code_rejected, leaves no record, and the sign-in must be started again", async () => {
      rig.script.codeResult = "reject";
      const started = await svc.startLogin(user, "claude");
      expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("code_rejected");
      expect(store.rows()).toHaveLength(0);
      expect(slots()).toBe(0);
      expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("login_not_found");
    });

    it("a malformed code does not spend the sign-in", async () => {
      const started = await svc.startLogin(user, "claude");
      expect(await codeOf(svc.completeLogin(user, started.loginId, "bad code with spaces"))).toBe("bad_code_format");
      expect(await codeOf(svc.completeLogin(user, started.loginId, 12345 as never))).toBe("bad_code_format");
      expect(await svc.completeLogin(user, started.loginId, GOOD)).toMatchObject({ status: "active" });
    });

    it("refuses a delegated admin, an unflagged user, an unknown provider; another user's loginId reveals nothing and cancels nothing", async () => {
      expect(await codeOf(svc.startLogin({ userId: "user-1", adminId: "admin-1" }, "claude"))).toBe("forbidden");
      expect(await codeOf(svc.startLogin({ userId: "user-3" }, "claude"))).toBe("disabled");
      expect(await codeOf(svc.startLogin(user, "nope"))).toBe("unsupported_provider");
      expect(await codeOf(svc.startLogin(user, "constructor"))).toBe("unsupported_provider");
      const started = await svc.startLogin(user, "claude");
      expect(await codeOf(svc.completeLogin({ userId: "user-2" }, started.loginId, GOOD))).toBe("login_not_found");
      expect(await svc.completeLogin(user, started.loginId, GOOD)).toMatchObject({ status: "active" });
    });

    it("a second start for the same user cancels the first sign-in on the host", async () => {
      const first = await svc.startLogin(user, "claude");
      await svc.startLogin(user, "claude");
      expect(svc.pendingCount()).toBe(1);
      expect(await codeOf(svc.completeLogin(user, first.loginId, GOOD))).toBe("login_not_found");
      expect(rig.script.loginsCancelled).toBeGreaterThanOrEqual(1);
    });

    it("at the owner's connection cap no record is made and the host attempt is cancelled (no home without a record)", async () => {
      for (let i = 0; i < 10; i++) await connect();
      const started = await svc.startLogin(user, "claude");
      expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("limit_reached");
      expect(store.rows()).toHaveLength(10);
      expect(hostState(`conn-11`)).not.toBe("active");
      expect(rig.mgr.status({ connectionId: "conn-11" }).state).toBe("attempting");
      expect(rig.store.get().connections["conn-11"].attempt).toBeUndefined();
    });

    it("a promote that cannot finish rolls the record back through the disconnect path (no record without a home)", async () => {
      rig.fs.failPromote = true;
      const started = await svc.startLogin(user, "claude");
      expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("host_unavailable");
      const row = (await store.db.get("conn-1"))!;
      expect(["revoking", "revoked"]).toContain(row.status);
      expect(slots()).toBe(0);
      expect(hostState("conn-1")).not.toBe("active");
    });

    it("answers host_unavailable (never a hang or a 500) when no host is configured or it is down", async () => {
      configured = false;
      expect(await codeOf(svc.startLogin(user, "claude"))).toBe("host_unavailable");
      configured = true;
      hostUp = false;
      expect(await codeOf(svc.startLogin(user, "claude"))).toBe("host_unavailable");
    });
  });

  describe("reconnect", () => {
    beforeEach(() => boot());

    it("moves the record to epoch+1, then the host promotes it; the owner's sign-in state is cleared", async () => {
      const view = await connect();
      await store.db.hostedMarkNeedsReconnect(view.connectionId, 1, "dead", new Date().toISOString());
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "invalid", subNeedsReconnect: true });
      const started = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
      const after = await svc.completeLogin(user, started.loginId, GOOD);
      expect(after).toMatchObject({ connectionId: view.connectionId, status: "active", subscription: { needsReconnect: false } });
      expect((await store.db.get(view.connectionId))!).toMatchObject({ subHostEpoch: 2, status: "active" });
      expect(rig.mgr.status({ connectionId: view.connectionId })).toMatchObject({ state: "active", epoch: 2 });
      expect(slots()).toBe(1); // reconnect does not take another slot
    });

    it("a promote that fails leaves the record at the new epoch and flagged for another reconnect (never behind the host)", async () => {
      const view = await connect();
      rig.fs.failPromote = true;
      const started = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
      expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("host_unavailable");
      expect((await store.db.get(view.connectionId))!).toMatchObject({ subHostEpoch: 2, status: "invalid", subNeedsReconnect: true });
      rig.fs.failPromote = false;
      const again = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
      expect(await svc.completeLogin(user, again.loginId, GOOD)).toMatchObject({ status: "active" });
      expect((await store.db.get(view.connectionId))!.subHostEpoch).toBe(3);
    });

    it("cannot reconnect someone else's, a revoking, or a non-hosted connection", async () => {
      const view = await connect();
      expect(await codeOf(svc.startLogin({ userId: "user-2" }, "claude", { reconnectConnectionId: view.connectionId }))).toBe("not_found");
      await svc.revokeRecord(user, view.connectionId);
      expect(await codeOf(svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId }))).toBe("not_found");
      await store.db.create({ connectionId: "old-b3", ownerUserId: "user-1", kind: "claude_subscription", provider: "anthropic", status: "active", keyLast4: "", createdAt: "x", updatedAt: "x" });
      expect(await codeOf(svc.startLogin(user, "claude", { reconnectConnectionId: "old-b3" }))).toBe("not_found");
    });
  });

  describe("disconnect", () => {
    beforeEach(() => boot());

    it("fences at epoch+1, wipes the home on the host, then marks revoked, releasing the slot once", async () => {
      const view = await connect();
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoked");
      const row = (await store.db.get(view.connectionId))!;
      expect(row).toMatchObject({ status: "revoked", subHostEpoch: 2 });
      expect(row.revokedAt).toBeDefined();
      expect(rig.mgr.status({ connectionId: view.connectionId }).state).toBe("revoked");
      expect(rig.script.logouts).toBe(1);
      expect(slots()).toBe(0);
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoked"); // idempotent
      expect(slots()).toBe(0);
    });

    it("repeated and concurrent disconnects release the slot once (the other connection keeps its slot)", async () => {
      const keep = await connect();
      const view = await connect();
      expect(slots()).toBe(2);
      await Promise.all([svc.revokeRecord(user, view.connectionId), svc.revokeRecord(user, view.connectionId)]);
      await svc.revokeRecord(user, view.connectionId);
      expect(slots()).toBe(1);
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
      expect((await store.db.get(keep.connectionId))!.status).toBe("active");
    });

    it("is NOT reported revoked while the host says the wipe is still pending (it answers, but not 'revoked')", async () => {
      const view = await connect();
      rig.fs.failWipes = true;
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoking");
      expect((await store.db.get(view.connectionId))!.status).toBe("revoking");
      expect(rig.mgr.status({ connectionId: view.connectionId }).state).toBe("revoking");
      rig.fs.failWipes = false;
      expect((await svc.sweepOnce()).revoked).toBe(1);
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
    });

    it("is NOT reported revoked while the host is unreachable: it stays revoking (slot already free) and the sweeper finishes it", async () => {
      const view = await connect();
      hostUp = false;
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoking");
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "revoking", subHostEpoch: 2 });
      expect(slots()).toBe(0);
      expect((await svc.sweepOnce()).hostUnavailable).toBe(true);
      expect((await store.db.get(view.connectionId))!.status).toBe("revoking");
      hostUp = true;
      const pass = await svc.sweepOnce();
      expect(pass).toMatchObject({ revoking: 1, revoked: 1 });
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
      expect(rig.script.logouts).toBe(1);
    });

    it("a host that never heard of the connection counts as wiped", async () => {
      const view = await connect();
      await rig.mgr.revoke({ connectionId: view.connectionId, epoch: 2 });
      // Simulate the host having lost the connection entirely.
      delete rig.store.get().connections[view.connectionId];
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoked");
    });

    it("follows the host's epoch when the host is ahead of the record (a promote the record missed)", async () => {
      const view = await connect();
      const start = await rig.mgr.loginStart({ connectionId: view.connectionId, provider: "fake", reconnect: true });
      await rig.mgr.loginComplete({ connectionId: view.connectionId, loginRef: start.loginRef, code: GOOD });
      await rig.mgr.loginPromote({ connectionId: view.connectionId, loginRef: start.loginRef, epoch: 5 }); // record still says 1
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoked");
      expect(rig.mgr.status({ connectionId: view.connectionId }).state).toBe("revoked");
    });

    it("raises an alarm once a disconnect has failed REVOKE_ALARM_ATTEMPTS passes", async () => {
      const view = await connect();
      hostUp = false;
      await svc.revokeRecord(user, view.connectionId);
      const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
      let stuck = 0;
      for (let i = 0; i < REVOKE_ALARM_ATTEMPTS + 1; i++) stuck += (await svc.sweepOnce()).stuck;
      expect(stuck).toBeGreaterThan(0);
      expect(err.mock.calls.some((c) => String(c[0]).includes("ALARM revoke stuck"))).toBe(true);
      err.mockRestore();
    });

    it("the plain revoke write refuses a hosted row, and the generic service routes it through the host", async () => {
      const view = await connect();
      expect(await store.db.revoke(view.connectionId, { userId: "user-1" }, new Date().toISOString())).toBe(false);
      expect((await store.db.get(view.connectionId))!.status).toBe("active");
      const generic = new LlmConnectionService({
        db: store.db, kms: new FakeKms(), validateKey: async () => ({ ok: true }) as never, isByokEnabledFor: async () => true,
        getUser: async (userId) => ({ userId, orgId: undefined }) as never, getOrg: async () => null, now: () => new Date().toISOString(), newId: () => "x",
        revokeHosted: (actor, id) => svc.revokeRecord(actor, id),
      });
      await generic.revoke(user, view.connectionId);
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
      expect(rig.mgr.status({ connectionId: view.connectionId }).state).toBe("revoked");
      // A generic service with no hosted path must refuse rather than fall back to the plain write.
      const second = await connect();
      const bare = new LlmConnectionService({
        db: store.db, kms: new FakeKms(), validateKey: async () => ({ ok: true }) as never, isByokEnabledFor: async () => true,
        getUser: async (userId) => ({ userId, orgId: undefined }) as never, getOrg: async () => null, now: () => new Date().toISOString(), newId: () => "x",
      });
      await expect(bare.revoke(user, second.connectionId)).rejects.toMatchObject({ code: "forbidden" });
      expect((await store.db.get(second.connectionId))!.status).toBe("active");
    });
  });

  describe("sweeper reconcile", () => {
    beforeEach(() => boot());

    it("marks a record needing reconnect when the host lost it, and leaves healthy ones alone", async () => {
      const healthy = await connect();
      const lost = await connect();
      delete rig.store.get().connections[lost.connectionId];
      const pass = await svc.sweepOnce();
      expect(pass.markedNeedsReconnect).toBe(1);
      expect((await store.db.get(lost.connectionId))!).toMatchObject({ status: "invalid", subNeedsReconnect: true, subReconnectReason: "host_lost" });
      expect((await store.db.get(healthy.connectionId))!.status).toBe("active");
      expect((await svc.sweepOnce()).markedNeedsReconnect).toBe(0); // already flagged
    });

    it("marks a record whose epoch the host disagrees with as needing a reconnect (record and host must never drift apart)", async () => {
      const view = await connect();
      const start = await rig.mgr.loginStart({ connectionId: view.connectionId, provider: "fake", reconnect: true });
      await rig.mgr.loginComplete({ connectionId: view.connectionId, loginRef: start.loginRef, code: GOOD });
      await rig.mgr.loginPromote({ connectionId: view.connectionId, loginRef: start.loginRef, epoch: 4 });
      expect((await svc.sweepOnce()).markedNeedsReconnect).toBe(1);
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "invalid", subNeedsReconnect: true, subReconnectReason: "epoch_mismatch" });
    });

    it("follows the host when it retired a login without us: record goes revoking, slot freed, then revoked", async () => {
      const view = await connect();
      await rig.mgr.revoke({ connectionId: view.connectionId, epoch: 1 });
      await svc.sweepOnce();
      const row = (await store.db.get(view.connectionId))!;
      expect(["revoking", "revoked"]).toContain(row.status);
      expect(slots()).toBe(0);
      await svc.sweepOnce();
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
    });

    it("an unreachable host changes nothing", async () => {
      const view = await connect();
      hostUp = false;
      expect((await svc.sweepOnce()).hostUnavailable).toBe(true);
      expect((await store.db.get(view.connectionId))!.status).toBe("active");
    });

    it("with no host configured it only reports, and does not touch rows", async () => {
      const view = await connect();
      configured = false;
      const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
      expect((await svc.sweepOnce()).hostUnavailable).toBe(true);
      err.mockRestore();
      expect((await store.db.get(view.connectionId))!.status).toBe("active");
    });

    it("ignores old sealed (B3) rows", async () => {
      await store.db.create({ connectionId: "old-b3", ownerUserId: "user-1", kind: "claude_subscription", provider: "anthropic", status: "active", keyLast4: "", createdAt: "x", updatedAt: "x" });
      expect(await svc.sweepOnce()).toMatchObject({ revoking: 0, reconciled: 0 });
    });
  });
});
