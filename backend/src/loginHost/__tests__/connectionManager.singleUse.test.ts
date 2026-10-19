/**
 * PR 1b-i core amendments: single-use sessions (one process per turn), fail-closed hazards,
 * parking on a turn that ends `auth_dead`, and hung-turn cleanup that spares sibling turns.
 */
import { HostError } from "../protocol";
import { drain, makeRig, signIn, turnReq, type Rig } from "./helpers";

async function code<T>(p: Promise<T> | T): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof HostError ? e.code + (e.detail ? `:${e.detail}` : "") : `OTHER:${(e as Error).message}`;
  }
}
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
const resultEvent = { type: "result", ok: true, text: "x" } as const;
let n = 0;
const nextTurn = (c: string, ep: number) => turnReq(c, ep, { turnId: `su-${++n}`, idempotencyKey: `su-key-${n}` });

describe("single-use sessions", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("every turn gets its own session, and each is closed when its turn ends", async () => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [resultEvent];
    for (let i = 0; i < 3; i++) await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    await flush();
    expect(rig.script.opened).toBe(3);
    expect(rig.script.closed).toBe(3);
  });

  it("a turn admitted between the previous turn's result and its process being gone gets a FRESH session, never the finishing one", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 3 } });
    await signIn(rig, "c1", 1);
    let release!: () => void;
    rig.script.closeGate = new Promise<void>((r) => (release = r));
    rig.script.turnEvents = [resultEvent];
    await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!); // result delivered; its process is still "alive" (close gated)
    const second = await rig.mgr.runTurn(nextTurn("c1", 1));
    await drain(second.events!);
    await flush();
    expect(rig.script.opened).toBe(2); // not 1: the finishing session was not reused
    release();
    await flush();
    expect(rig.script.closed).toBe(2);
  });

  it("a session whose process is not gone yet still counts against the per-home cap; the slot frees when it is gone", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 1 } });
    await signIn(rig, "c1", 1);
    let release!: () => void;
    rig.script.closeGate = new Promise<void>((r) => (release = r));
    rig.script.turnEvents = [resultEvent];
    await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("EBUSY:connection_busy"); // the old process may still be running: no second one
    release();
    await flush();
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("OK");
  });

  it("a turn aborted before its provider turn starts closes its session at once (no idle wait)", async () => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    const turn = nextTurn("c1", 1);
    const started = await rig.mgr.runTurn(turn);
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: turn.turnId });
    const out = await drain(started.events!);
    await flush();
    expect(out.pop()).toMatchObject({ ok: false, aborted: "interrupted" });
    expect(rig.script.closed).toBe(rig.script.opened);
  });

  it("a stuck close() still frees the slot after the bounded call times out", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 1 }, config: { adapterCallTimeoutMs: 30 } });
    await signIn(rig, "c1", 1);
    rig.script.closeGate = new Promise<void>(() => undefined); // never
    rig.script.turnEvents = [resultEvent];
    await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    await new Promise((r) => setTimeout(r, 120));
    rig.script.closeGate = undefined;
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("OK");
  });

  it("a non-single-use adapter still reuses its session (unchanged behaviour)", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [resultEvent];
    for (let i = 0; i < 3; i++) await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    expect(rig.script.opened).toBe(1);
  });
});

describe("hazards fail closed", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  async function attempt(rig: Rig): Promise<string> {
    const s = await rig.mgr.loginStart({ connectionId: "h1", provider: "fake" });
    return code(rig.mgr.loginComplete({ connectionId: "h1", loginRef: s.loginRef, code: "abcdefgh#12345678" }));
  }
  it.each([["other"], ["hook_event"]] as const)("a reported hazard of kind %s blocks the connect", async (kind) => {
    rig = makeRig({ script: { hazards: [{ kind, ...(kind === "other" ? { detail: "unrecognised doctor output" } : {}) } as never] } });
    expect(await attempt(rig)).toBe(`EHAZARD:${kind}`);
  });
  it("managed settings block unless the config explicitly allows them; nothing else can be allowed", async () => {
    rig = makeRig({ script: { hazards: [{ kind: "managed_settings_present" }] } });
    expect(await attempt(rig)).toBe("EHAZARD:managed_settings_present");
    rig.cleanup();
    rig = makeRig({ script: { hazards: [{ kind: "managed_settings_present" }] }, config: { allowManagedSettings: true } });
    expect(await attempt(rig)).toBe("OK");
    rig.cleanup();
    rig = makeRig({ script: { hazards: [{ kind: "other", detail: "x" }] }, config: { allowManagedSettings: true } });
    expect(await attempt(rig)).toBe("EHAZARD:other");
  });
});

describe("a turn that ends auth_dead", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("parks the connection (the adapter has already confirmed the login is dead)", async () => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "result", ok: false, text: "", errorKind: "auth_dead" }];
    await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "needs_reconnect", reason: "auth_dead" });
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("ESTATE:needs_reconnect");
  });
  it.each([["usage_limit"], ["transient"], ["unknown"]] as const)("does NOT park on %s", async (kind) => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    rig.script.turnEvents = [{ type: "result", ok: false, text: "", errorKind: kind }];
    await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    expect(rig.mgr.status({ connectionId: "c1" }).state).toBe("active");
  });
  it("does not park a connection whose turn was already ended by the host (aborted)", async () => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    const turn = nextTurn("c1", 1);
    rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: false, text: "", errorKind: "auth_dead" }];
    ignoreInterruptAfterAbort(rig);
    const started = await rig.mgr.runTurn(turn);
    const out = drain(started.events!);
    await flush();
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: turn.turnId });
    await out;
    expect(rig.mgr.status({ connectionId: "c1" }).state).toBe("active");
  });
});
function ignoreInterruptAfterAbort(rig: Rig) {
  rig.script.ignoreInterrupt = true;
}

describe("a hung turn that shares its uid with a live sibling", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("keeps counting against the caps until its close settles; a failed close then gets the uid killed once no session is left", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 2 }, config: { abortGraceMs: 20, adapterCallTimeoutMs: 120 } });
    await signIn(rig, "c1", 1);
    const uid = rig.store.get().connections.c1.uid;
    let releaseSibling!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (releaseSibling = r)) }, resultEvent];
    const sOut = drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    await flush();
    rig.script.hangTurn = true;
    rig.script.closeGate = new Promise<void>(() => undefined); // a close that never returns: the hung process may still be alive
    const hung = nextTurn("c1", 1);
    const hOut = drain((await rig.mgr.runTurn(hung)).events!);
    await flush();
    rig.fs.killed.length = 0;
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: hung.turnId });
    expect((await hOut).pop()).toMatchObject({ ok: false, aborted: "interrupted" });
    // the hung session's close has not settled: its slot is NOT free, and nothing was killed (the sibling is running)
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("EBUSY:connection_busy");
    expect(rig.fs.killed).not.toContain(uid);
    await new Promise((r) => setTimeout(r, 250)); // the bounded close times out: the slot is released, the kill is deferred
    expect(rig.fs.killed).not.toContain(uid); // the sibling is still alive
    rig.script.hangTurn = false;
    releaseSibling();
    await sOut;
    await new Promise((r) => setTimeout(r, 250)); // the sibling's own (stuck) close times out too: no live session left
    expect(rig.fs.killed).toContain(uid); // now the possibly-live hung process is killed
  });

  it("a stale deferred kill never touches a uid the connection no longer owns (it may belong to someone else by now)", async () => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    const foreignUid = 400_009;
    (rig.mgr as unknown as { deferredKills: Map<string, number> }).deferredKills.set("c1", foreignUid);
    rig.script.turnEvents = [resultEvent];
    await drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!); // the session ends: no live session left, the deferred entry is consulted
    await flush();
    expect(rig.fs.killed).not.toContain(foreignUid);
    expect((rig.mgr as unknown as { deferredKills: Map<string, number> }).deferredKills.has("c1")).toBe(false); // consumed either way
  });

  it("no turn is admitted while a kill of its connection's uid is running (its fresh process would be the one killed)", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 3 }, config: { abortGraceMs: 20, adapterCallTimeoutMs: 100 } });
    await signIn(rig, "c1", 1);
    rig.script.hangTurn = true;
    rig.script.closeGate = new Promise<void>(() => undefined);
    let releaseKill!: () => void;
    rig.fs.killGate = new Promise<void>((r) => (releaseKill = r)); // a slow killAll
    const hung = nextTurn("c1", 1);
    const hOut = drain((await rig.mgr.runTurn(hung)).events!);
    await flush();
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: hung.turnId });
    await new Promise((r) => setTimeout(r, 80)); // grace passed: the host is now inside killAll (held)
    rig.script.hangTurn = false;
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("EBUSY:connection_busy"); // refused while the kill runs
    releaseKill();
    await hOut;
    await flush();
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("OK"); // and allowed again once it settled
  });

  it("admission is also refused while a DEFERRED kill runs, and two overlapping kills keep it refused until the LAST one settles", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 3 }, config: { abortGraceMs: 20, adapterCallTimeoutMs: 80 } });
    await signIn(rig, "c1", 1);
    const uid = rig.store.get().connections.c1.uid;
    // deferred kill path: a hung turn beside a sibling, close stuck; when the sibling ends the kill fires (held by the gate)
    let releaseSibling!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (releaseSibling = r)) }, resultEvent];
    const sOut = drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    await flush();
    rig.script.hangTurn = true;
    rig.script.closeGate = new Promise<void>(() => undefined);
    const hung = nextTurn("c1", 1);
    const hOut = drain((await rig.mgr.runTurn(hung)).events!);
    await flush();
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: hung.turnId });
    await hOut;
    await new Promise((r) => setTimeout(r, 150)); // the hung session's bounded close timed out: kill deferred
    rig.script.hangTurn = false;
    let releaseKill!: () => void;
    rig.fs.killGate = new Promise<void>((r) => (releaseKill = r));
    releaseSibling();
    await sOut;
    await new Promise((r) => setTimeout(r, 150)); // the sibling's stuck close times out; no live session left: the deferred kill starts and waits on the gate
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("EBUSY:connection_busy");
    releaseKill();
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.fs.killed).toContain(uid);
    rig.script.closeGate = undefined;
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("OK");

    // overlapping guarded kills: the guard holds until the last one settles
    const priv = rig.mgr as unknown as { killGuarded(id: string, uid: number): Promise<void> };
    let r1!: () => void;
    let r2!: () => void;
    rig.fs.killGate = new Promise<void>((r) => (r1 = r));
    const k1 = priv.killGuarded("c1", uid);
    rig.fs.killGate = new Promise<void>((r) => (r2 = r));
    const k2 = priv.killGuarded("c1", uid);
    r1();
    await k1;
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("EBUSY:connection_busy"); // the second kill is still running
    r2();
    await k2;
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("OK");
  });

  it("the kill guard outlives the bounded wait: while the port's own kill is still running turns stay refused; a port that never answers cannot make the connection busy forever", async () => {
    rig = makeRig({ adapter: { singleUse: true }, config: { portCallTimeoutMs: 40 } });
    await signIn(rig, "c1", 1);
    const uid = rig.store.get().connections.c1.uid;
    const priv = rig.mgr as unknown as { killGuarded(id: string, uid: number): Promise<void> };
    let releaseKill!: () => void;
    rig.fs.killGate = new Promise<void>((r) => (releaseKill = r));
    await priv.killGuarded("c1", uid).catch(() => undefined); // returns (rejecting) when the bounded wait (40 ms) gives up, while killAll is still pending
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("EBUSY:connection_busy"); // the kill is STILL running: no new process may start
    releaseKill();
    await flush();
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("OK"); // released the moment the real kill settled
    // a kill that never settles: released by the hard backstop (10 x the port timeout)
    rig.fs.killGate = new Promise<void>(() => undefined);
    await priv.killGuarded("c1", uid).catch(() => undefined);
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("EBUSY:connection_busy");
    await new Promise((r) => setTimeout(r, 500));
    expect(await code(rig.mgr.runTurn(nextTurn("c1", 1)))).toBe("OK");
  });

  it("a hung turn never kills a uid its connection no longer owns (after a reconnect the old uid belongs to the wipe queue, and may be someone else's)", async () => {
    rig = makeRig({ adapter: { singleUse: true }, config: { abortGraceMs: 500, adapterCallTimeoutMs: 60, portCallTimeoutMs: 60 } }); // the grace is long: the hung path runs AFTER the swap and the sweep freed the old uid
    await signIn(rig, "c1", 1);
    const oldUid = rig.store.get().connections.c1.uid;
    rig.script.hangTurn = true;
    rig.script.closeGate = new Promise<void>(() => undefined);
    const hung = nextTurn("c1", 1);
    const hOut = drain((await rig.mgr.runTurn(hung)).events!);
    await flush();
    // reconnect: the hung turn is aborted, the old uid goes to the wipe queue and is wiped (killed) by the swap itself
    const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake", reconnect: true });
    await rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
    await rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 2 });
    await rig.mgr.sweep();
    const killsOfOldUid = () => rig.fs.killed.filter((u) => u === oldUid).length;
    const before = killsOfOldUid();
    expect(rig.store.get().uidOwners[String(oldUid)]).toBeUndefined(); // freed: it could belong to anyone now
    await hOut; // the grace period passes, the hung path runs
    expect(killsOfOldUid()).toBe(before); // the hung-turn path did not signal it
  });

  it("disabling the connection clears a pending deferred kill (it must not fire at some unrelated later retire)", async () => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    const deferred = (rig.mgr as unknown as { deferredKills: Map<string, number> }).deferredKills;
    deferred.set("c1", rig.store.get().connections.c1.uid);
    await rig.mgr.disable({ connectionId: "c1", epoch: 2 });
    expect(deferred.has("c1")).toBe(false);
  });

  it("a close that succeeds needs no kill at all", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 2 }, config: { abortGraceMs: 20 } });
    await signIn(rig, "c1", 1);
    const uid = rig.store.get().connections.c1.uid;
    let releaseSibling!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (releaseSibling = r)) }, resultEvent];
    const sOut = drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    await flush();
    rig.script.hangTurn = true; // the turn hangs but the provider honours close()
    const hung = nextTurn("c1", 1);
    const hOut = drain((await rig.mgr.runTurn(hung)).events!);
    await flush();
    rig.fs.killed.length = 0;
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: hung.turnId });
    await hOut;
    rig.script.hangTurn = false;
    releaseSibling();
    await sOut;
    await flush();
    expect(rig.fs.killed).not.toContain(uid);
  });
});

describe("the auth_dead result is fenced by the epoch", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a result that lands while a reconnect holds the connection lock does not park the NEW login", async () => {
    rig = makeRig({ adapter: { singleUse: true } });
    await signIn(rig, "c1", 1);
    let releaseTurn!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (releaseTurn = r)) }, { type: "result", ok: false, text: "", errorKind: "auth_dead" }];
    rig.script.ignoreInterrupt = true; // the old provider keeps going after the reconnect aborts it
    const out = drain((await rig.mgr.runTurn(nextTurn("c1", 1))).events!);
    await flush();
    const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake", reconnect: true });
    await rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
    let releasePromote!: () => void;
    rig.fs.promoteGate = new Promise<void>((r) => (releasePromote = r));
    const promoting = rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 2 }); // holds the lock
    await flush();
    releaseTurn(); // the old turn now reports auth_dead and queues behind the lock
    await flush();
    releasePromote();
    await promoting;
    await out;
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "active", epoch: 2 });
  });
});

describe("a hung turn does not kill its siblings", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("with another live session on the same uid the hung turn is only closed; alone it falls back to killing the uid", async () => {
    rig = makeRig({ adapter: { singleUse: true, maxProcessesPerHome: 3 }, config: { abortGraceMs: 20 } });
    await signIn(rig, "c1", 1);
    const uid = rig.store.get().connections.c1.uid;
    // sibling turn: runs normally until released
    let releaseSibling!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (releaseSibling = r)) }, resultEvent];
    const sibling = nextTurn("c1", 1);
    const sOut = drain((await rig.mgr.runTurn(sibling)).events!);
    await flush();
    // hung turn on the same uid
    rig.script.hangTurn = true;
    const hung = nextTurn("c1", 1);
    const hOut = drain((await rig.mgr.runTurn(hung)).events!);
    await flush();
    rig.fs.killed.length = 0;
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: hung.turnId });
    expect((await hOut).pop()).toMatchObject({ ok: false, aborted: "interrupted" });
    expect(rig.fs.killed).not.toContain(uid); // the sibling's process was not killed
    rig.script.hangTurn = false;
    releaseSibling();
    expect((await sOut).pop()).toMatchObject({ ok: true });
    // now a lone hung turn: the uid is killed as before
    rig.script.hangTurn = true;
    const lone = nextTurn("c1", 1);
    const lOut = drain((await rig.mgr.runTurn(lone)).events!);
    await flush();
    rig.fs.killed.length = 0;
    await rig.mgr.interruptTurn({ connectionId: "c1", epoch: 1, turnId: lone.turnId });
    await lOut;
    expect(rig.fs.killed).toContain(uid);
  });
});
