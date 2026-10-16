import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { HostError } from "../protocol";
import { StateStore } from "../stateStore";
import { drain, makeRig, signIn, turnReq, type Rig } from "./helpers";

async function code<T>(p: Promise<T> | T): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof HostError ? e.code + (e.detail ? `:${e.detail}` : "") : `OTHER:${(e as Error).message}`;
  }
}

describe("ConnectionManager", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  describe("sign-in (paste_code)", () => {
    beforeEach(() => (rig = makeRig()));

    it("start -> complete -> promote makes the attempt the home, moves the uid to the connection and prepares the home", async () => {
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      expect(start).toMatchObject({ ceremony: "paste_code", url: "https://example.test/authorize" });
      const ready = await rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
      expect(ready).toMatchObject({ status: "ready", planLabel: "max" });
      expect(ready.refreshExpiresAtMs).toBeGreaterThan(rig.clock.nowMs());
      await expect(rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 })).resolves.toEqual({ state: "active", epoch: 1 });
      const c = rig.store.get().connections.c1;
      expect(c).toMatchObject({ state: "active", epoch: 1 });
      expect(c.attempt).toBeUndefined();
      expect(rig.store.get().uidOwners[String(c.uid)]).toBe("c1");
      expect([...rig.fs.dirs].filter((d) => d.startsWith("home:"))).toHaveLength(1);
      expect([...rig.fs.dirs].filter((d) => d.startsWith("attempt:"))).toHaveLength(0);
      expect(rig.script.prepared).toBe(1);
    });

    it("a wrong code discards the attempt, wipes it, frees its uid, and lets the user try again", async () => {
      rig.script.codeResult = "reject";
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      expect(await code(rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" }))).toBe("EINVALID:code_rejected");
      expect(rig.store.get().connections.c1.attempt).toBeUndefined();
      expect(rig.fs.wipes.some((w) => w.startsWith("attempt:"))).toBe(true);
      expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(0); // uid back in the pool
      rig.script.codeResult = "ok";
      await expect(rig.mgr.loginStart({ connectionId: "c1", provider: "fake" })).resolves.toMatchObject({ ceremony: "paste_code" });
    });

    it("a discarded sign-in kills every process of its uid immediately before wiping, and frees the uid after", async () => {
      rig.script.codeResult = "reject";
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      const uid = Number(Object.keys(rig.store.get().uidOwners)[0]);
      rig.fs.log.length = 0;
      await code(rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" }));
      const mine = rig.fs.log.filter((l) => l.endsWith(`:${uid}`));
      const wipeAt = mine.indexOf(`wipe:attempt:${uid}`);
      expect(wipeAt).toBeGreaterThan(0);
      expect(mine[wipeAt - 1]).toBe(`kill:${uid}`);
      expect(rig.store.get().uidOwners[String(uid)]).toBeUndefined();
    });

    it("refuses a second sign-in while one is pending, and a plain start on an existing connection", async () => {
      await signIn(rig);
      expect(await code(rig.mgr.loginStart({ connectionId: "conn1", provider: "fake" }))).toBe("ESTATE:exists_use_reconnect");
      const re = await rig.mgr.loginStart({ connectionId: "conn1", provider: "fake", reconnect: true });
      expect(re.loginRef).toBeTruthy();
      expect(await code(rig.mgr.loginStart({ connectionId: "conn1", provider: "fake", reconnect: true }))).toBe("ESTATE:login_pending");
    });

    it("unknown, expired and someone else's login all answer the same ENOTFOUND", async () => {
      const a = await rig.mgr.loginStart({ connectionId: "a", provider: "fake" });
      await rig.mgr.loginStart({ connectionId: "b", provider: "fake" });
      const body = { code: "abcdefgh#12345678" };
      expect(await code(rig.mgr.loginComplete({ connectionId: "a", loginRef: "nope", ...body }))).toBe("ENOTFOUND");
      expect(await code(rig.mgr.loginComplete({ connectionId: "b", loginRef: a.loginRef, ...body }))).toBe("ENOTFOUND");
      rig.clock.advance(11 * 60 * 1000);
      expect(await code(rig.mgr.loginComplete({ connectionId: "a", loginRef: a.loginRef, ...body }))).toBe("ENOTFOUND");
    });

    it("a sign-in the sweeper finds expired is wiped and its uid freed", async () => {
      await rig.mgr.loginStart({ connectionId: "a", provider: "fake" });
      expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(1);
      rig.clock.advance(11 * 60 * 1000);
      await rig.mgr.sweep();
      expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(0);
      expect(rig.store.get().connections.a).toBeUndefined();
    });

    it.each([
      ["managed settings", { kind: "managed_settings_present" as const }, "EHAZARD:managed_settings_present"],
      ["api key source", { kind: "api_key_source" as const, source: "apiKeyHelper" }, "EHAZARD:api_key_source"],
      ["policy blocks AgentWeb", { kind: "policy_blocks_agentweb" as const, detail: "x" }, "EHAZARD:policy_blocks_agentweb"],
    ])("refuses the connection at sign-in on %s and leaves nothing behind", async (_n, hazard, expected) => {
      rig.script.hazards = [hazard];
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      expect(await code(rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" }))).toBe(expected);
      expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(0);
    });

    it("allows managed settings only when the host config allows them (the sandbox gate)", async () => {
      rig.cleanup();
      rig = makeRig({ config: { allowManagedSettings: true }, script: { hazards: [{ kind: "managed_settings_present" }] } });
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      await expect(rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" })).resolves.toMatchObject({ status: "ready" });
    });

    it("refuses when the CLI is not logged in after the code was accepted", async () => {
      rig.script.loggedIn = false;
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      expect(await code(rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" }))).toBe("EINVALID:not_logged_in");
    });

    it("cancel is idempotent and wipes", async () => {
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      await expect(rig.mgr.loginCancel({ connectionId: "c1", loginRef: start.loginRef })).resolves.toEqual({ cancelled: true });
      await expect(rig.mgr.loginCancel({ connectionId: "c1", loginRef: start.loginRef })).resolves.toEqual({ cancelled: true });
      expect(rig.script.loginsCancelled).toBe(1);
      expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(0);
    });

    it("exhausting the uid range answers EBUSY and leaks nothing", async () => {
      rig.cleanup();
      rig = makeRig({ config: { uidMin: 400_000, uidMax: 400_001 } });
      await rig.mgr.loginStart({ connectionId: "a", provider: "fake" });
      await rig.mgr.loginStart({ connectionId: "b", provider: "fake" });
      expect(await code(rig.mgr.loginStart({ connectionId: "c", provider: "fake" }))).toBe("EBUSY:uid_range_exhausted");
    });

    it("an unsupported provider is EUNSUPPORTED", async () => {
      expect(await code(rig.mgr.loginStart({ connectionId: "c1", provider: "grok" }))).toBe("EUNSUPPORTED");
    });
  });

  describe("sign-in (device_code)", () => {
    beforeEach(() => (rig = makeRig({ adapter: { ceremony: "device_code" } })));

    it("returns a user code, polls pending then done, and promotes", async () => {
      rig.script.devicePoll = "pending";
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      expect(start).toMatchObject({ ceremony: "device_code", userCode: "ABCD-1234" });
      expect(await rig.mgr.loginStatus({ connectionId: "c1", loginRef: start.loginRef })).toEqual({ status: "pending" });
      expect(await code(rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" }))).toBe("ESTATE:ceremony_not_paste_code");
      rig.script.devicePoll = "done";
      expect(await rig.mgr.loginStatus({ connectionId: "c1", loginRef: start.loginRef })).toMatchObject({ status: "ready" });
      await expect(rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 })).resolves.toMatchObject({ state: "active" });
    });

    it("a failed device login discards the attempt", async () => {
      rig.script.devicePoll = "failed";
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      expect(await rig.mgr.loginStatus({ connectionId: "c1", loginRef: start.loginRef })).toEqual({ status: "failed" });
      expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(0);
    });
  });

  describe("promote, reconnect and epochs", () => {
    beforeEach(() => (rig = makeRig()));

    it("promote is idempotent for the same attempt and epoch", async () => {
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      await rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
      await rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 });
      await expect(rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 })).resolves.toEqual({ state: "active", epoch: 1 });
      expect(rig.script.prepared).toBe(1);
    });

    it("promote needs a ready attempt", async () => {
      const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 }))).toBe("ENOTFOUND");
    });

    it("reconnect swaps the home: old processes die, the old home is wiped, the old uid is freed, the epoch moves", async () => {
      await signIn(rig, "c1", 1);
      const oldUid = rig.store.get().connections.c1.uid;
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const long = await rig.mgr.runTurn(turnReq("c1", 1, { turnId: "t-long" }));
      const pending = drain(long.events!);
      await flushTurns();
      await signIn2(rig, "c1", 2);
      const out = await pending;
      expect(out[out.length - 1]).toMatchObject({ type: "result", ok: false, aborted: "reconnect" });
      const c = rig.store.get().connections.c1;
      expect(c.epoch).toBe(2);
      expect(c.uid).not.toBe(oldUid);
      expect(rig.fs.killed).toContain(oldUid);
      await rig.mgr.sweep();
      expect(rig.store.get().uidOwners[String(oldUid)]).toBeUndefined();
      expect([...rig.fs.dirs].filter((d) => d.startsWith("home:"))).toHaveLength(1);
    });

    it("an older epoch on promote is ESTALE", async () => {
      await signIn(rig, "c1", 5);
      const re = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake", reconnect: true });
      await rig.mgr.loginComplete({ connectionId: "c1", loginRef: re.loginRef, code: "abcdefgh#12345678" });
      expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef: re.loginRef, epoch: 4 }))).toBe("ESTALE");
    });
  });

  describe("turns", () => {
    beforeEach(async () => {
      rig = makeRig();
      await signIn(rig);
    });

    it("streams the adapter's events and records the outcome", async () => {
      const started = await rig.mgr.runTurn(turnReq("conn1", 1));
      const events = await drain(started.events!);
      expect(events.map((e) => e.type)).toEqual(["text", "result"]);
      expect(rig.mgr.status({ connectionId: "conn1" }).runningTurns).toBe(0);
    });

    it("requires the host's epoch exactly and an active connection and an allowed model", async () => {
      expect(await code(rig.mgr.runTurn(turnReq("conn1", 2)))).toBe("ESTALE");
      expect(await code(rig.mgr.runTurn(turnReq("conn1", 1, { model: "other" })))).toBe("EINVALID:model_not_allowed");
      expect(await code(rig.mgr.runTurn(turnReq("nope", 1)))).toBe("ENOTFOUND");
      await rig.mgr.disable({ connectionId: "conn1", epoch: 1 });
      expect(await code(rig.mgr.runTurn(turnReq("conn1", 1)))).toBe("ESTATE:disabled");
    });

    it("a retried request does not run a second turn; a different request with the same key conflicts", async () => {
      const req = turnReq("conn1", 1);
      const first = await rig.mgr.runTurn(req);
      await drain(first.events!);
      const opened = rig.script.opened;
      const again = await rig.mgr.runTurn({ ...req, bridgeToken: "another-token-0123456789" });
      expect(again).toMatchObject({ duplicate: true, status: "finished" });
      expect(again.events).toBeUndefined();
      expect(rig.script.opened).toBe(opened);
      expect(await code(rig.mgr.runTurn({ ...req, prompt: "different" }))).toBe("EEXISTS");
    });

    it("ends a turn whose lease lapsed, and a renewal keeps it alive", async () => {
      let release!: () => void;
      rig.script.turnEvents = [{ wait: new Promise<void>((r) => (release = r)) }, { type: "result", ok: true, text: "done" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "tL" }));
      const pending = drain(started.events!);
      await flushTurns(); // the turn is now running inside the provider
      rig.clock.advance(20_000);
      rig.mgr.renewLease({ connectionId: "conn1", turnId: "tL", epoch: 1 });
      rig.clock.advance(20_000);
      rig.mgr.tick();
      expect(rig.script.interrupts).toBe(0); // renewed 20 s ago, lease is 30 s
      rig.clock.advance(11_000);
      rig.mgr.tick();
      const out = await pending;
      expect(out[out.length - 1]).toMatchObject({ aborted: "lease_lapsed" });
      expect(rig.script.interrupts).toBe(1);
      release();
    });

    it("an abort that arrives before the provider session is ready still ends the turn, without ever starting it at the provider", async () => {
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "tE" }));
      const pending = drain(started.events!);
      // no flush: the generator has not got past `await session.ready` yet
      await rig.mgr.disable({ connectionId: "conn1", epoch: 2 });
      const out = await pending;
      expect(out[out.length - 1]).toMatchObject({ ok: false, aborted: "disabled" });
      expect(rig.script.maxActiveTurns).toBe(0);
    });

    it("delivers nothing after an abort, even from a provider that ignores interrupt()", async () => {
      let release!: () => void;
      rig.script.ignoreInterrupt = true;
      rig.script.turnEvents = [{ wait: new Promise<void>((r) => (release = r)) }, { type: "text", delta: "LATE-SECRET" }, { type: "result", ok: true, text: "LATE-SECRET" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "tI" }));
      const pending = drain(started.events!);
      await flushTurns();
      await rig.mgr.revoke({ connectionId: "conn1", epoch: 2 });
      release();
      const out = await pending;
      expect(JSON.stringify(out)).not.toContain("LATE-SECRET");
      expect(out[out.length - 1]).toMatchObject({ ok: false, aborted: "revoked" });
    });

    it("ends a turn at its deadline", async () => {
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "tD", deadlineMs: 5_000 }));
      const pending = drain(started.events!);
      await flushTurns();
      rig.clock.advance(4_000);
      rig.mgr.renewLease({ connectionId: "conn1", turnId: "tD", epoch: 1 });
      rig.clock.advance(2_000);
      rig.mgr.tick();
      const out = await pending;
      expect(out[out.length - 1]).toMatchObject({ aborted: "deadline" });
    });

    it("renew / interrupt need the right epoch and a live turn", async () => {
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "tR" }));
      const pending = drain(started.events!);
      await flushTurns(); // the turn is running inside the provider
      expect(() => rig.mgr.renewLease({ connectionId: "conn1", turnId: "tR", epoch: 2 })).toThrow(HostError);
      expect(() => rig.mgr.renewLease({ connectionId: "other", turnId: "tR", epoch: 1 })).toThrow(HostError);
      expect(() => rig.mgr.renewLease({ connectionId: "conn1", turnId: "missing", epoch: 1 })).toThrow(HostError);
      await rig.mgr.interruptTurn({ connectionId: "conn1", turnId: "tR", epoch: 1 });
      const out = await pending;
      expect(out[out.length - 1]).toMatchObject({ aborted: "interrupted" });
      expect(rig.script.interruptedTurns).toEqual(["tR"]); // this turn only
    });

    it("an alarm event ends the turn, stops the sessions and parks the connection", async () => {
      rig.script.turnEvents = [{ type: "alarm", hazard: { kind: "hook_event" } }, { type: "result", ok: true, text: "x" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1));
      const out = await drain(started.events!);
      expect(out.map((e) => e.type)).toEqual(["alarm", "result"]);
      expect(out[1]).toMatchObject({ ok: false, aborted: "alarm" });
      expect(rig.mgr.status({ connectionId: "conn1" })).toMatchObject({ state: "needs_attention", reason: "hook_event" });
      expect(rig.script.closed).toBeGreaterThan(0);
      expect(await code(rig.mgr.runTurn(turnReq("conn1", 1)))).toBe("ESTATE:needs_attention");
    });

    it("a dead login found by preflight parks the connection as needs_reconnect", async () => {
      rig.script.preflight = { ok: false, kind: "auth_dead" };
      const started = await rig.mgr.runTurn(turnReq("conn1", 1));
      const out = await drain(started.events!);
      expect(out[out.length - 1]).toMatchObject({ ok: false, errorKind: "auth_dead" });
      expect(rig.mgr.status({ connectionId: "conn1" })).toMatchObject({ state: "needs_reconnect", reason: "auth_dead" });
    });

    it("a session that fails to open becomes a normal failed result and does not wedge the slot", async () => {
      rig.script.openFails = true;
      const started = await rig.mgr.runTurn(turnReq("conn1", 1));
      const out = await drain(started.events!);
      expect(out[out.length - 1]).toMatchObject({ ok: false, errorKind: "transient" });
      rig.script.openFails = false;
      const next = await rig.mgr.runTurn(turnReq("conn1", 1));
      expect((await drain(next.events!)).pop()).toMatchObject({ ok: true });
    });
  });

  describe("caps and admission", () => {
    it("never exceeds maxProcessesPerHome even when requests race (reserved synchronously)", async () => {
      rig = makeRig({ adapter: { maxProcessesPerHome: 2, maxTurnsPerProcess: 1 } });
      await signIn(rig);
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => code(rig.mgr.runTurn(turnReq("conn1", 1, { turnId: `race-${i}` })))));
      expect(results.filter((r) => r === "OK")).toHaveLength(2);
      expect(results.filter((r) => r === "EBUSY:connection_busy")).toHaveLength(3);
      expect(rig.script.opened).toBe(2);
    });

    it("a provider that serves many turns per process (Codex-like) uses one process", async () => {
      rig = makeRig({ adapter: { maxProcessesPerHome: 1, maxTurnsPerProcess: 4 } });
      await signIn(rig);
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => code(rig.mgr.runTurn(turnReq("conn1", 1, { turnId: `many-${i}` })))));
      expect(results.filter((r) => r === "OK")).toHaveLength(4);
      expect(rig.script.opened).toBe(1);
    });

    it("enforces the host-wide cap and keeps room for interactive turns", async () => {
      rig = makeRig({ adapter: { maxProcessesPerHome: 20 }, config: { maxTurnsPerHost: 4, scheduledReserve: 1 } });
      await signIn(rig);
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const scheduled = await Promise.all(Array.from({ length: 5 }, (_, i) => code(rig.mgr.runTurn(turnReq("conn1", 1, { turnId: `s-${i}`, priority: "scheduled" })))));
      expect(scheduled.filter((r) => r === "OK")).toHaveLength(3); // 4 - reserve 1
      expect(await code(rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "i-1" })))).toBe("OK"); // interactive may use the reserved slot
      expect(await code(rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "i-2" })))).toBe("EBUSY:host_busy");
    });
  });

  describe("disable, enable, revoke", () => {
    beforeEach(async () => {
      rig = makeRig();
      await signIn(rig);
    });

    it("disable adopts a newer epoch, stops turns, keeps the home; enable resumes without a new sign-in", async () => {
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "td" }));
      const pending = drain(started.events!);
      await expect(rig.mgr.disable({ connectionId: "conn1", epoch: 2 })).resolves.toEqual({ state: "disabled", epoch: 2 });
      expect((await pending).pop()).toMatchObject({ aborted: "disabled" });
      expect([...rig.fs.dirs].some((d) => d.startsWith("home:"))).toBe(true); // home kept
      expect(await code(rig.mgr.disable({ connectionId: "conn1", epoch: 1 }))).toBe("ESTALE");
      await expect(rig.mgr.enable({ connectionId: "conn1", epoch: 2 })).resolves.toEqual({ state: "active", epoch: 2 });
      rig.script.turnEvents = [{ type: "result", ok: true, text: "ok" }];
      expect((await drain((await rig.mgr.runTurn(turnReq("conn1", 2))).events!)).pop()).toMatchObject({ ok: true });
    });

    it("revoke fences first, kills, logs out, wipes, frees the uid only when residue is zero, and is idempotent", async () => {
      const uid = rig.store.get().connections.conn1.uid;
      rig.fs.residue.set(uid, 2); // files left in /tmp
      const r1 = await rig.mgr.revoke({ connectionId: "conn1", epoch: 2 });
      expect(r1).toEqual({ state: "revoking", epoch: 2, cleanupConfirmed: false });
      expect(rig.store.get().uidOwners[String(uid)]).toBeDefined(); // not freed: residue
      expect(rig.script.logouts).toBe(1);
      expect(await code(rig.mgr.runTurn(turnReq("conn1", 2)))).toBe("ESTATE:revoking");
      expect(await code(rig.mgr.loginStart({ connectionId: "conn1", provider: "fake", reconnect: true }))).toBe("ESTATE:revoked");
      rig.fs.residue.set(uid, 0);
      await rig.mgr.sweep();
      expect(rig.mgr.status({ connectionId: "conn1" }).state).toBe("revoked");
      expect(rig.store.get().uidOwners[String(uid)]).toBeUndefined();
      expect(rig.store.get().connections.conn1.cleanupConfirmedAtMs).toBeDefined();
      await expect(rig.mgr.revoke({ connectionId: "conn1", epoch: 2 })).resolves.toMatchObject({ state: "revoked", cleanupConfirmed: true });
    });

    it("revoke aborts a running turn and a failing wipe leaves it revoking until a later sweep succeeds", async () => {
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      const started = await rig.mgr.runTurn(turnReq("conn1", 1, { turnId: "tv" }));
      const pending = drain(started.events!);
      rig.fs.failWipes = true;
      expect(await rig.mgr.revoke({ connectionId: "conn1", epoch: 2 })).toMatchObject({ state: "revoking", cleanupConfirmed: false });
      expect((await pending).pop()).toMatchObject({ aborted: "revoked" });
      rig.fs.failWipes = false;
      await rig.mgr.sweep();
      expect(rig.mgr.status({ connectionId: "conn1" }).state).toBe("revoked");
    });

    it("kills every process of the uid before wiping its home, and wipes before the uid can be freed", async () => {
      const uid = rig.store.get().connections.conn1.uid;
      rig.fs.log.length = 0;
      await rig.mgr.revoke({ connectionId: "conn1", epoch: 2 });
      const mine = rig.fs.log.filter((l) => l.endsWith(`:${uid}`));
      expect(mine.indexOf(`kill:${uid}`)).toBeGreaterThanOrEqual(0);
      expect(mine.indexOf(`wipe:home:${uid}`)).toBeGreaterThan(mine.lastIndexOf(`kill:${uid}`) - 1);
      // the last operation before the uid is freed is a kill immediately followed by the wipe
      const wipeAt = mine.indexOf(`wipe:home:${uid}`);
      expect(mine[wipeAt - 1]).toBe(`kill:${uid}`);
      expect(rig.store.get().uidOwners[String(uid)]).toBeUndefined();
    });

    it("a stale epoch cannot revoke", async () => {
      await rig.mgr.disable({ connectionId: "conn1", epoch: 3 });
      expect(await code(rig.mgr.revoke({ connectionId: "conn1", epoch: 2 }))).toBe("ESTALE");
    });
  });

  describe("durability across a host restart", () => {
    it("remembers epochs, refuses a stale epoch, does not re-run a retried turn, and marks running turns aborted", async () => {
      rig = makeRig();
      await signIn(rig, "conn1", 3);
      const req = turnReq("conn1", 3, { turnId: "keep" });
      rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
      await rig.mgr.runTurn(req); // left running when the host "dies"
      const mgr2 = rig.restart();
      await mgr2.recover();
      expect(await code(mgr2.runTurn(turnReq("conn1", 2)))).toBe("ESTALE");
      const opened = rig.script.opened;
      await expect(mgr2.runTurn(req)).resolves.toMatchObject({ duplicate: true, status: "aborted" });
      expect(rig.script.opened).toBe(opened);
      expect(mgr2.status({ connectionId: "conn1" })).toMatchObject({ state: "active", epoch: 3 });
    });

    it("a sign-in attempt that was in flight at restart is expired and its uid freed", async () => {
      rig = makeRig();
      await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
      const mgr2 = rig.restart();
      await mgr2.recover();
      await mgr2.sweep();
      expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(0);
    });

    it("a second host cannot open the same state directory while the first lives", () => {
      rig = makeRig();
      const second = new StateStore(rig.dir, () => true);
      expect(() => second.open()).toThrow(/locked/);
    });
  });

  describe("no credential access in the host core", () => {
    it("no non-test source under src/loginHost opens a credential file or names one in code", () => {
      const root = join(__dirname, "..");
      const files = [root, join(root, "adapters")].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => join(d, f)));
      expect(files.length).toBeGreaterThan(5);
      const offenders: string[] = [];
      for (const f of files) {
        const code = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        if (/credentials\.json|auth\.json|\.credentials|readFileSync\([^)]*cred/i.test(code)) offenders.push(f);
      }
      expect(offenders).toEqual([]);
    });
  });
});

/** Lets async generators advance to their first provider await. */
async function flushTurns(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function signIn2(rig: Rig, connectionId: string, epoch: number): Promise<void> {
  const re = await rig.mgr.loginStart({ connectionId, provider: "fake", reconnect: true });
  await rig.mgr.loginComplete({ connectionId, loginRef: re.loginRef, code: "abcdefgh#12345678" });
  await rig.mgr.loginPromote({ connectionId, loginRef: re.loginRef, epoch });
}
