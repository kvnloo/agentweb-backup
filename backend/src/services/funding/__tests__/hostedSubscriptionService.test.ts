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
import { HostedSubscriptionError, HostedSubscriptionService, RECONCILE_GRACE_MS, REVOKE_ALARM_ATTEMPTS, type HostedProvider } from "../hostedSubscriptionService";
import { LlmConnectionService } from "../llmConnectionService";
import { LoginHostClient, LoginHostError, UnixSocketTransport, type HostTransport } from "../loginHostClient";
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
  let nowMs: number;
  let promoteLoses: boolean;
  let completeLostBeforeSend: boolean;
  let statusLostBeforeSend: boolean;
  let workerProto: number | undefined;
  let sent: Array<{ route: string; body: Record<string, unknown> }> = [];
  let revokeBegun: string[] = [];
  let revokeHookThrows = false;
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
    nowMs = rig.clock.nowMs(); // the test host runs on a manual clock; sign-in tokens carry the host's expiry, so the backend's clock must agree
    promoteLoses = false;
    completeLostBeforeSend = false;
    statusLostBeforeSend = false;
    workerProto = 3;
    sent = [];
    revokeBegun = [];
    revokeHookThrows = false;
    svc = new HostedSubscriptionService({
      db: store.db,
      // A host that is "down" answers like an unreachable socket; "unconfigured" has no client at all. `promoteLoses`: the host
      // applies a promote but its reply never arrives.
      client: () => {
        if (!configured) return undefined;
        const real = new UnixSocketTransport(hostUp ? sock : join(dir, "nobody.sock"));
        return new LoginHostClient({
          stream: (r, b) => real.stream(r, b),
          json: async (r, b) => {
            sent.push({ route: r, body: b as Record<string, unknown> });
            if (completeLostBeforeSend && r === "login.complete") throw new LoginHostError("UNREACHABLE"); // the request never reaches the host
            if (statusLostBeforeSend && r === "login.status") throw new LoginHostError("UNREACHABLE");
            const reply = await real.json(r, b);
            if (promoteLoses && r === "login.promote") throw new LoginHostError("UNREACHABLE");
            return reply;
          },
        });
      },
      providers: { claude: provider() },
      workerProtocol: () => workerProto,
      now: () => nowMs,
      newId: () => `conn-${++ids}`,
      sleep: async () => undefined,
      onRevokeBegun: (id) => {
        if (revokeHookThrows) throw new Error("registry unavailable");
        revokeBegun.push(id);
      },
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

    it("a double-submitted complete sends the single-use code once; the loser sees login_not_found and nothing is torn down", async () => {
      const started = await svc.startLogin(user, "claude");
      const results = await Promise.all([codeOf(svc.completeLogin(user, started.loginId, GOOD)), codeOf(svc.completeLogin(user, started.loginId, GOOD))]);
      expect(results.sort()).toEqual(["login_not_found", "resolved"]);
      expect(store.rows()).toHaveLength(1);
      expect((await store.db.get("conn-1"))!.status).toBe("active");
      expect(rig.mgr.status({ connectionId: "conn-1" }).state).toBe("active");
      // The host would also refuse the second code, so the result above does not prove the in-process guard: count what was sent.
      expect(sent.filter((x) => x.route === "login.complete")).toHaveLength(1);
    });

    it("expiry follows the backend clock: a backend an hour ahead of the host still completes a fresh sign-in", async () => {
      nowMs += 60 * 60 * 1000;
      const started = await svc.startLogin(user, "claude");
      (svc as unknown as { pending: Map<string, unknown> }).pending.clear(); // as if another instance, so only the token's expiry is in play
      expect(await svc.completeLogin(user, started.loginId, GOOD)).toMatchObject({ status: "active" });
    });

    it("a sign-in whose token cannot be made is cancelled on the host, so it does not block the next one", async () => {
      const saved = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      try {
        await expect(svc.startLogin(user, "claude")).rejects.toThrow();
      } finally {
        if (saved === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = saved;
      }
      expect(rig.script.loginsCancelled).toBe(1);
      expect(await codeOf(svc.startLogin(user, "claude"))).toBe("resolved");
    });

    it("a sign-in started by an instance that is then SHUT DOWN (a deploy's SIGTERM) can still be finished, and shutdown sent the host no cancel", async () => {
      const started = await svc.startLogin(user, "claude");
      sent.length = 0;
      await svc.shutdown();
      expect(sent.filter((x) => x.route === "login.cancel")).toHaveLength(0);
      const view = await svc.completeLogin(user, started.loginId, GOOD); // the token is enough: the user pastes the code after the swap
      expect(view.status).toBe("active");
      expect(rig.mgr.status({ connectionId: view.connectionId })).toMatchObject({ state: "active", epoch: 1 });
    });

    describe("a sign-in outlives the instance that started it (deploys, a second instance)", () => {
      // Dropping the in-memory map is what a replaced or different backend instance looks like to a `complete`.
      const otherInstance = () => (svc as unknown as { pending: Map<string, unknown> }).pending.clear();

      it("completes on an instance that never saw the start", async () => {
        const started = await svc.startLogin(user, "claude");
        otherInstance();
        const view = await svc.completeLogin(user, started.loginId, GOOD);
        expect(view.status).toBe("active");
        expect(rig.mgr.status({ connectionId: view.connectionId })).toMatchObject({ state: "active", epoch: 1 });
      });

      it("a reconnect started before the swap finishes after it", async () => {
        const view = await connect();
        const started = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
        otherInstance();
        await svc.completeLogin(user, started.loginId, GOOD);
        expect(rig.mgr.status({ connectionId: view.connectionId })).toMatchObject({ state: "active", epoch: 2 });
        expect((await store.db.get(view.connectionId))!.subHostEpoch).toBe(2);
      });

      it("the token is opaque: it does not show the host's login reference or the connection id", async () => {
        const started = await svc.startLogin(user, "claude");
        const text = Buffer.from(started.loginId, "base64url").toString("utf8");
        expect(text).not.toContain("conn-1");
        expect(started.loginId).toMatch(/^[A-Za-z0-9_-]+$/);
      });

      it("a tampered, truncated, foreign or expired token is login_not_found and makes no record", async () => {
        const started = await svc.startLogin(user, "claude");
        otherInstance();
        const flipped = started.loginId.slice(0, 20) + (started.loginId[20] === "A" ? "B" : "A") + started.loginId.slice(21);
        for (const bad of [flipped, started.loginId.slice(0, -4), "", "x".repeat(2000), "not a token!", 12345 as never]) {
          expect(await codeOf(svc.completeLogin(user, bad, GOOD))).toBe("login_not_found");
        }
        expect(await codeOf(svc.completeLogin({ userId: "user-2" }, started.loginId, GOOD))).toBe("login_not_found");
        nowMs += 11 * 60 * 1000;
        expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("login_not_found");
        expect(store.rows()).toHaveLength(0);
      });

      it("a used token cannot be replayed, on this instance or another", async () => {
        const started = await svc.startLogin(user, "claude");
        await svc.completeLogin(user, started.loginId, GOOD);
        expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("login_not_found");
        otherInstance();
        expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("login_not_found");
        expect(store.rows()).toHaveLength(1);
      });

      it("two completes for one sign-in on a rebuilt entry send the code once", async () => {
        const started = await svc.startLogin(user, "claude");
        otherInstance();
        const results = await Promise.all([codeOf(svc.completeLogin(user, started.loginId, GOOD)), codeOf(svc.completeLogin(user, started.loginId, GOOD))]);
        expect(results.sort()).toEqual(["login_not_found", "resolved"]);
        expect(store.rows()).toHaveLength(1);
      });

      it("a cancel that arrives while a complete is in flight does not discard the host's login", async () => {
        const started = await svc.startLogin(user, "claude");
        otherInstance();
        const done = svc.completeLogin(user, started.loginId, GOOD);
        await svc.cancelLogin(user, started.loginId);
        expect((await done).status).toBe("active");
        expect(rig.script.loginsCancelled).toBe(0);
      });

      it("a malformed code on a rebuilt sign-in leaves it completable with the corrected code", async () => {
        const started = await svc.startLogin(user, "claude");
        otherInstance();
        expect(await codeOf(svc.completeLogin(user, started.loginId, "bad code with spaces"))).toBe("bad_code_format");
        expect((await svc.completeLogin(user, started.loginId, GOOD)).status).toBe("active");
      });

      describe("protocol 3: the host tells whose complete took the code, and a stray cancel cannot discard a ready login", () => {
        const rawClient = () => new LoginHostClient(new UnixSocketTransport(sock));
        const loginRefOf = async (loginId: string) => (svc as unknown as { lookup(id: string): { pending: { loginRef: string; connectionId: string } } | undefined }).lookup(loginId)!.pending;

        it("sends the nonce and onlyIfPending to a protocol-3 worker, and neither to an older one", async () => {
          const s1 = await svc.startLogin(user, "claude");
          await svc.completeLogin(user, s1.loginId, GOOD);
          expect(sent.find((x) => x.route === "login.complete")!.body.completionNonce).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
          const s2 = await svc.startLogin(user, "claude");
          await svc.cancelLogin(user, s2.loginId);
          expect(sent.filter((x) => x.route === "login.cancel").pop()!.body.onlyIfPending).toBe(true);
          sent.length = 0;
          workerProto = 2;
          const s3 = await svc.startLogin(user, "claude");
          await svc.cancelLogin(user, s3.loginId);
          const s4 = await svc.startLogin(user, "claude");
          await svc.completeLogin(user, s4.loginId, GOOD);
          for (const x of sent) {
            expect(x.body.completionNonce).toBeUndefined();
            expect(x.body.onlyIfPending).toBeUndefined();
          }
          workerProto = undefined; // unknown yet: the same as older
          const s5 = await svc.startLogin(user, "claude");
          await svc.cancelLogin(user, s5.loginId);
          expect(sent.filter((x) => x.route === "login.cancel").pop()!.body.onlyIfPending).toBeUndefined();
        });

        it("the loser of a double submit whose reply was lost stands down: login_not_found, no cancel, and the winner's ready login survives and can be promoted", async () => {
          const started = await svc.startLogin(user, "claude");
          const { loginRef, connectionId } = await loginRefOf(started.loginId);
          // the winner: another instance's complete (modelled with a raw client) took the code and the attempt is ready
          await rawClient().loginComplete({ connectionId, loginRef, code: GOOD, completionNonce: "winner-nonce-0001" });
          otherInstance();
          completeLostBeforeSend = true; // the loser's own complete never reaches the host and times out
          const cancelsBefore = rig.script.loginsCancelled;
          expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("login_not_found");
          expect(rig.script.loginsCancelled).toBe(cancelsBefore); // it did NOT cancel
          expect(rig.mgr.status({ connectionId }).state).toBe("attempting");
          await expect(rawClient().loginPromote({ connectionId, loginRef, epoch: 1 })).resolves.toMatchObject({ state: "active", epoch: 1 });
        });

        it("the winner is an OLDER backend instance (it sends no nonce, as in a rolling deploy): the loser still stands down and the old winner can promote", async () => {
          const started = await svc.startLogin(user, "claude");
          const { loginRef, connectionId } = await loginRefOf(started.loginId);
          await rawClient().loginComplete({ connectionId, loginRef, code: GOOD }); // no nonce
          otherInstance();
          completeLostBeforeSend = true;
          expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("login_not_found");
          expect(store.rows()).toHaveLength(0); // the loser created no record
          await expect(rawClient().loginPromote({ connectionId, loginRef, epoch: 1 })).resolves.toMatchObject({ state: "active" });
        });

        it("the loser's reply AND its status read are both lost: it answers complete_timeout WITHOUT discarding the winner's ready login", async () => {
          const started = await svc.startLogin(user, "claude");
          const { loginRef, connectionId } = await loginRefOf(started.loginId);
          await rawClient().loginComplete({ connectionId, loginRef, code: GOOD, completionNonce: "winner-nonce-0003" });
          otherInstance();
          completeLostBeforeSend = true;
          statusLostBeforeSend = true;
          expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("complete_timeout");
          expect(sent.filter((x) => x.route === "login.cancel").every((x) => x.body.onlyIfPending === true)).toBe(true);
          await expect(rawClient().loginPromote({ connectionId, loginRef, epoch: 1 })).resolves.toMatchObject({ state: "active" });
        });

        it("a lost reply to the request that DID take the code is still a success (its own nonce comes back)", async () => {
          const started = await svc.startLogin(user, "claude");
          const { connectionId } = await loginRefOf(started.loginId);
          // the service's own complete reaches the host and takes the code; only its reply is lost
          const deps = (svc as unknown as { deps: { client: () => LoginHostClient | undefined } }).deps;
          const baseClient = deps.client;
          deps.client = () => {
            const c = baseClient();
            if (!c) return c;
            const complete = c.loginComplete.bind(c);
            c.loginComplete = async (input) => {
              await complete(input);
              throw new LoginHostError("UNREACHABLE");
            };
            return c;
          };
          const view = await svc.completeLogin(user, started.loginId, GOOD);
          expect(view.status).toBe("active");
          expect(rig.mgr.status({ connectionId })).toMatchObject({ state: "active", epoch: 1 });
        });

        it("a user's cancel (onlyIfPending) arriving after the code was taken leaves the ready login, which can still be promoted", async () => {
          const started = await svc.startLogin(user, "claude");
          const { loginRef, connectionId } = await loginRefOf(started.loginId);
          await rawClient().loginComplete({ connectionId, loginRef, code: GOOD, completionNonce: "winner-nonce-0002" });
          otherInstance();
          await svc.cancelLogin(user, started.loginId); // the stray cancel from another instance
          await expect(rawClient().loginPromote({ connectionId, loginRef, epoch: 1 })).resolves.toMatchObject({ state: "active" });
        });
      });

      it("cancel works from another instance and ends the host attempt", async () => {
        const started = await svc.startLogin(user, "claude");
        otherInstance();
        await svc.cancelLogin({ userId: "user-2" }, started.loginId); // someone else's: nothing happens
        expect(rig.script.loginsCancelled).toBe(0);
        await svc.cancelLogin(user, started.loginId);
        expect(rig.script.loginsCancelled).toBe(1);
        expect(await codeOf(svc.completeLogin(user, started.loginId, GOOD))).toBe("login_not_found");
      });
    });

    it("a promote whose reply was lost but which landed is a success, not a second sign-in", async () => {
      promoteLoses = true;
      const view = await connect();
      expect(view.status).toBe("active");
      expect(rig.mgr.status({ connectionId: view.connectionId })).toMatchObject({ state: "active", epoch: 1 });
      expect((await store.db.get(view.connectionId))!.status).toBe("active");
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

    it("a store failure after the code was spent cancels the ready attempt, so the owner can sign in again at once", async () => {
      const view = await connect();
      const spy = jest.spyOn(store.db, "hostedAdvanceEpoch").mockRejectedValueOnce(new Error("dynamo blip"));
      const started = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
      await expect(svc.completeLogin(user, started.loginId, GOOD)).rejects.toThrow("dynamo blip");
      spy.mockRestore();
      const again = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
      expect(await svc.completeLogin(user, again.loginId, GOOD)).toMatchObject({ status: "active" });
    });

    it("a host that keeps the replaced login disabled is accepted as a successful reconnect and the record stays disabled", async () => {
      const view = await connect();
      await rig.mgr.disable({ connectionId: view.connectionId, epoch: 1 });
      const started = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
      const after = await svc.completeLogin(user, started.loginId, GOOD);
      expect(after.status).toBe("disabled");
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "disabled", subHostEpoch: 2, subNeedsReconnect: false });
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

    it("stops the running turns of the connection after the record is fenced and before the host is asked to wipe it", async () => {
      const view = await connect();
      revokeBegun = [];
      const stoppedWhenFenced: number[] = [];
      const stoppedWhenWiped: number[] = [];
      const realBegin = store.db.hostedBeginRevoke.bind(store.db);
      jest.spyOn(store.db, "hostedBeginRevoke").mockImplementation(async (...args: Parameters<typeof realBegin>) => {
        const r = await realBegin(...args);
        stoppedWhenFenced.push(revokeBegun.length);
        return r;
      });
      const realRevoke = rig.mgr.revoke.bind(rig.mgr);
      jest.spyOn(rig.mgr, "revoke").mockImplementation(((...args: Parameters<typeof realRevoke>) => {
        stoppedWhenWiped.push(revokeBegun.length);
        return realRevoke(...args);
      }) as typeof rig.mgr.revoke);
      await svc.revokeRecord(user, view.connectionId);
      expect(revokeBegun).toEqual([view.connectionId]);
      expect(stoppedWhenFenced).toEqual([0]); // not before the fence...
      expect(stoppedWhenWiped).toEqual([1]); // ...and before the wipe
    });

    it("a hook that fails never blocks the disconnect", async () => {
      const view = await connect();
      revokeHookThrows = true;
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoked");
    });

    it("does not call the hook for a connection that is not the caller's", async () => {
      const view = await connect();
      revokeBegun = [];
      await expect(svc.revokeRecord({ userId: "user-2" }, view.connectionId)).rejects.toThrow();
      expect(revokeBegun).toEqual([]);
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

    it("a disconnect racing a reconnect fences above the reconnect's epoch and still ends revoked with the slot freed", async () => {
      const view = await connect();
      const realGet = store.db.get.bind(store.db);
      let raced = false;
      jest.spyOn(store.db, "get").mockImplementation(async (id: string) => {
        const row = await realGet(id);
        if (!raced) {
          raced = true;
          await store.db.hostedAdvanceEpoch(id, 1, 2, new Date().toISOString()); // a reconnect moves the record after we read epoch 1
        }
        return row;
      });
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoked");
      jest.restoreAllMocks();
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "revoked", subHostEpoch: 3 });
      expect(rig.mgr.status({ connectionId: view.connectionId }).state).toBe("revoked");
      expect(slots()).toBe(0);
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

    it("does not say revoked when its own write did not make the record revoked", async () => {
      const view = await connect();
      jest.spyOn(store.db, "hostedMarkRevoked").mockResolvedValueOnce(false);
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoking");
      jest.restoreAllMocks();
      expect((await svc.sweepOnce()).revoked).toBe(1); // the next pass completes it
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
    });

    it("a failed slot release leaves the row revoking, never revoked; a retry or the sweeper gives the slot back exactly once", async () => {
      const view = await connect();
      const spy = jest.spyOn(store.db, "hostedReleaseSlot").mockRejectedValueOnce(new Error("dynamo blip"));
      await expect(svc.revokeRecord(user, view.connectionId)).rejects.toThrow("dynamo blip");
      expect((await store.db.get(view.connectionId))!.status).toBe("revoking");
      expect(slots()).toBe(1);
      expect((await svc.sweepOnce()).revoked).toBe(1); // the sweeper releases the slot, then finishes the wipe
      spy.mockRestore();
      expect(slots()).toBe(0);
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "revoked", subSlotReleased: true });
      expect(await svc.revokeRecord(user, view.connectionId)).toBe("revoked");
      expect(slots()).toBe(0);
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
    beforeEach(async () => {
      await boot();
    });
    const pastGrace = () => {
      nowMs += RECONCILE_GRACE_MS + 1_000;
    };
    // The sweeper leaves very recent rows alone; most tests want it to judge a row that has settled.
    const sweepLater = () => {
      pastGrace();
      return svc.sweepOnce();
    };

    it("marks a record needing reconnect when the host lost it, and leaves healthy ones alone", async () => {
      const healthy = await connect();
      const lost = await connect();
      delete rig.store.get().connections[lost.connectionId];
      const pass = await sweepLater();
      expect(pass.markedNeedsReconnect).toBe(1);
      expect((await store.db.get(lost.connectionId))!).toMatchObject({ status: "invalid", subNeedsReconnect: true, subReconnectReason: "host_lost" });
      expect((await store.db.get(healthy.connectionId))!.status).toBe("active");
      expect((await sweepLater()).markedNeedsReconnect).toBe(0); // already flagged
    });

    it("marks a record whose epoch the host disagrees with as needing a reconnect (record and host must never drift apart)", async () => {
      const view = await connect();
      const start = await rig.mgr.loginStart({ connectionId: view.connectionId, provider: "fake", reconnect: true });
      await rig.mgr.loginComplete({ connectionId: view.connectionId, loginRef: start.loginRef, code: GOOD });
      await rig.mgr.loginPromote({ connectionId: view.connectionId, loginRef: start.loginRef, epoch: 4 });
      expect((await sweepLater()).markedNeedsReconnect).toBe(1);
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "invalid", subNeedsReconnect: true, subReconnectReason: "epoch_mismatch" });
    });

    it("follows the host when it retired a login without us: record goes revoking, slot freed, then revoked", async () => {
      const view = await connect();
      await rig.mgr.revoke({ connectionId: view.connectionId, epoch: 1 });
      await sweepLater();
      const row = (await store.db.get(view.connectionId))!;
      expect(["revoking", "revoked"]).toContain(row.status);
      expect(slots()).toBe(0);
      await sweepLater();
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
    });

    it("does not judge a row written within the grace window (its own sign-in may still be completing)", async () => {
      const view = await connect();
      delete rig.store.get().connections[view.connectionId]; // looks lost, but the row is brand new
      expect((await svc.sweepOnce()).markedNeedsReconnect).toBe(0);
      expect((await store.db.get(view.connectionId))!.status).toBe("active");
      pastGrace();
      expect((await svc.sweepOnce()).markedNeedsReconnect).toBe(1);
    });

    it("a flagged record whose host login was retired is disconnected (slot freed), not left waiting for a reconnect that can never work", async () => {
      const view = await connect();
      pastGrace();
      await store.db.hostedMarkNeedsReconnect(view.connectionId, 1, "dead", new Date(nowMs).toISOString());
      await rig.mgr.revoke({ connectionId: view.connectionId, epoch: 1 });
      pastGrace();
      await svc.sweepOnce();
      expect(slots()).toBe(0);
      await svc.sweepOnce();
      expect((await store.db.get(view.connectionId))!.status).toBe("revoked");
    });

    it("a record the host lost can be reconnected: the host starts a fresh connection and the epoch still moves up", async () => {
      const view = await connect();
      delete rig.store.get().connections[view.connectionId];
      const started = await svc.startLogin(user, "claude", { reconnectConnectionId: view.connectionId });
      const after = await svc.completeLogin(user, started.loginId, GOOD);
      expect(after.status).toBe("active");
      expect((await store.db.get(view.connectionId))!.subHostEpoch).toBe(2);
      expect(rig.mgr.status({ connectionId: view.connectionId })).toMatchObject({ state: "active", epoch: 2 });
    });

    it("the sweeper's verdict is conditional on the row it read (a later write wins)", async () => {
      const view = await connect();
      pastGrace();
      delete rig.store.get().connections[view.connectionId];
      const row = (await store.db.get(view.connectionId))!;
      const spy = jest.spyOn(store.db, "hostedMarkNeedsReconnect");
      await svc.sweepOnce();
      expect(spy).toHaveBeenCalledWith(view.connectionId, 1, "host_lost", expect.any(String), row.updatedAt);
      spy.mockRestore();
    });

    it("heals a record flagged by a lost final write when the host is serving it at the same epoch", async () => {
      const view = await connect();
      pastGrace();
      await store.db.hostedMarkNeedsReconnect(view.connectionId, 1, "reconnect_write_lost", new Date(nowMs).toISOString());
      pastGrace();
      await svc.sweepOnce();
      expect((await store.db.get(view.connectionId))!).toMatchObject({ status: "active", subNeedsReconnect: false });
    });

    it("an unreachable host changes nothing", async () => {
      const view = await connect();
      hostUp = false;
      expect((await sweepLater()).hostUnavailable).toBe(true);
      expect((await store.db.get(view.connectionId))!.status).toBe("active");
    });

    it("with no host configured it only reports, and does not touch rows", async () => {
      const view = await connect();
      configured = false;
      const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
      expect((await sweepLater()).hostUnavailable).toBe(true);
      err.mockRestore();
      expect((await store.db.get(view.connectionId))!.status).toBe("active");
    });

    it("ignores old sealed (B3) rows", async () => {
      await store.db.create({ connectionId: "old-b3", ownerUserId: "user-1", kind: "claude_subscription", provider: "anthropic", status: "active", keyLast4: "", createdAt: "x", updatedAt: "x" });
      expect(await sweepLater()).toMatchObject({ revoking: 0, reconciled: 0 });
    });
  });
});

describe("protocol guard: ENOTFOUND means 'nothing to wipe / the host lost it' ONLY from a worker verified to speak our protocol", () => {
  // An OLDER worker that lacks a route answered ENOTFOUND for it; a stub that always says ENOTFOUND stands for that (and for a real lost connection).
  const notFound: HostTransport = { json: async () => ({ status: 404, json: { error: "ENOTFOUND" } }), stream: async () => { throw new Error("n/a"); } };
  const DAY = 24 * 60 * 60 * 1000;
  function setup(proto: () => boolean) {
    const store = makeDb();
    let t = Date.now();
    const svc = new HostedSubscriptionService({
      db: store.db,
      client: () => new LoginHostClient(notFound),
      providers: { claude: { route: "claude", kind: "claude_subscription", recordProvider: "anthropic", hostProvider: "fake", isEnabledFor: async () => true } },
      now: () => t,
      newId: () => "x",
      workerSpeaksOurProtocol: proto,
    });
    const row = async (status: "active" | "revoking" = "active") => {
      const iso = new Date(t - DAY).toISOString();
      await store.db.create({ connectionId: "h1", ownerUserId: "user-1", kind: "claude_subscription", provider: "anthropic", status, keyLast4: "", createdAt: iso, updatedAt: iso, subHosted: true, subHostEpoch: 1, subNeedsReconnect: false });
    };
    return { store, svc, row, advance: (ms: number) => void (t += ms) };
  }
  const user = { userId: "user-1" };
  beforeEach(() => void jest.spyOn(console, "error").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("a disconnect is NOT confirmed by an ENOTFOUND from a worker whose protocol is not verified: it stays revoking (and the alarm path keeps counting)", async () => {
    const { store, svc, row } = setup(() => false);
    await row();
    expect(await svc.revokeRecord(user, "h1")).toBe("revoking");
    const after = (await store.db.get("h1"))!;
    expect(after.status).toBe("revoking");
    expect(after.subRevokeAttempts).toBe(1);
  });

  it("the same ENOTFOUND from a verified worker means nothing to wipe: revoked", async () => {
    const { store, svc, row } = setup(() => true);
    await row();
    expect(await svc.revokeRecord(user, "h1")).toBe("revoked");
    expect((await store.db.get("h1"))!.status).toBe("revoked");
  });

  it("the sweeper does not mark a customer 'host_lost' on an ENOTFOUND from an unverified worker, but does from a verified one", async () => {
    const unverified = setup(() => false);
    await unverified.row();
    expect((await unverified.svc.sweepOnce()).markedNeedsReconnect).toBe(0);
    expect((await unverified.store.db.get("h1"))!.status).toBe("active");
    const verified = setup(() => true);
    await verified.row();
    expect((await verified.svc.sweepOnce()).markedNeedsReconnect).toBe(1);
    expect((await verified.store.db.get("h1"))!).toMatchObject({ status: "invalid", subReconnectReason: "host_lost" });
  });

  it("a verified-then-unverified worker (a redeploy to another protocol) flips the behaviour with no restart", async () => {
    let ok = true;
    const { store, svc, row } = setup(() => ok);
    await row("revoking");
    ok = false;
    expect((await svc.sweepOnce()).revoked).toBe(0);
    expect((await store.db.get("h1"))!.status).toBe("revoking");
    ok = true;
    expect((await svc.sweepOnce()).revoked).toBe(1);
  });
});
