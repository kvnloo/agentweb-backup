/**
 * Review-driven tests for PR 1a: operations that interleave on one connection, a provider that
 * hangs, restart recovery, relayed tool calls, session retirement and the uid/disk invariant.
 */
import { HostError } from "../protocol";
import { assertConsistent, drain, makeRig, signIn, turnReq, type Rig } from "./helpers";

async function code<T>(p: Promise<T> | T): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof HostError ? e.code + (e.detail ? `:${e.detail}` : "") : `OTHER:${(e as Error).message}`;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function readyAttempt(rig: Rig, connectionId: string, reconnect = false): Promise<string> {
  const start = await rig.mgr.loginStart({ connectionId, provider: rig.adapter.id, ...(reconnect ? { reconnect: true } : {}) });
  await rig.mgr.loginComplete({ connectionId, loginRef: start.loginRef, code: "abcdefgh#12345678" });
  return start.loginRef;
}

describe("ConnectionManager: interleaving operations", () => {
  let rig: Rig;
  beforeEach(() => (rig = makeRig()));
  afterEach(() => rig.cleanup());

  it("a cancel that arrives mid-promote is applied after it: the connection ends up active and the books match the disk", async () => {
    const loginRef = await readyAttempt(rig, "c1");
    let open!: () => void;
    rig.fs.promoteGate = new Promise<void>((r) => (open = r));
    const promote = rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 1 });
    const cancel = rig.mgr.loginCancel({ connectionId: "c1", loginRef });
    await flush();
    open();
    await expect(promote).resolves.toEqual({ state: "active", epoch: 1 });
    await expect(cancel).resolves.toEqual({ cancelled: true });
    const c = rig.store.get().connections.c1;
    expect(c.state).toBe("active");
    expect(c.uid).toBeGreaterThanOrEqual(400_000);
    expect(rig.store.get().uidOwners[String(c.uid)]).toBe("c1");
    expect([...rig.fs.dirs].some((d) => d.startsWith(`home:${c.uid}:`))).toBe(true);
    assertConsistent(rig);
  });

  it("a revoke that arrives mid-promote is applied after it: nothing is left on a freed uid", async () => {
    const loginRef = await readyAttempt(rig, "c1");
    let open!: () => void;
    rig.fs.promoteGate = new Promise<void>((r) => (open = r));
    const promote = rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 1 });
    const revoke = rig.mgr.revoke({ connectionId: "c1", epoch: 2 });
    await flush();
    open();
    await promote;
    await expect(revoke).resolves.toMatchObject({ state: "revoked", cleanupConfirmed: true });
    expect([...rig.fs.dirs]).toEqual([]);
    expect(Object.keys(rig.store.get().uidOwners)).toEqual([]);
    assertConsistent(rig);
  });

  it("a disable that arrives mid-reconnect is not overwritten by the promote, and a reconnect does not re-enable a disabled connection", async () => {
    await signIn(rig, "c1", 1);
    const loginRef = await readyAttempt(rig, "c1", true);
    let open!: () => void;
    rig.fs.promoteGate = new Promise<void>((r) => (open = r));
    const promote = rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 });
    const disable = rig.mgr.disable({ connectionId: "c1", epoch: 3 });
    await flush();
    open();
    await promote;
    await disable;
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "disabled", epoch: 3 });
    // now reconnect the DISABLED connection: it stays disabled
    rig.fs.promoteGate = undefined;
    const again = await readyAttempt(rig, "c1", true);
    await rig.mgr.loginPromote({ connectionId: "c1", loginRef: again, epoch: 4 });
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "disabled", epoch: 4 });
    expect(await code(rig.mgr.runTurn(turnReq("c1", 4)))).toBe("ESTATE:disabled");
    assertConsistent(rig);
  });

  it("no turn is admitted while a connection is swapping homes", async () => {
    await signIn(rig, "c1", 1);
    const loginRef = await readyAttempt(rig, "c1", true);
    let open!: () => void;
    rig.fs.promoteGate = new Promise<void>((r) => (open = r));
    const promote = rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 });
    await flush();
    expect(await code(rig.mgr.runTurn(turnReq("c1", 2)))).toBe("ESTATE:swapping");
    // another sign-in on the same connection waits its turn behind the promote instead of interleaving with it
    let startedEarly = false;
    const queued = rig.mgr.loginStart({ connectionId: "c1", provider: "fake", reconnect: true }).then(() => (startedEarly = true));
    await flush();
    expect(startedEarly).toBe(false);
    open();
    await promote;
    await queued;
    expect(await code(rig.mgr.runTurn(turnReq("c1", 2)))).toBe("OK");
  });

  it("the home is prepared before the sign-in runs, not after promotion", async () => {
    const start = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    expect(rig.script.prepared).toBe(1);
    expect(rig.fs.writes.every((w) => w.kind === "attempt")).toBe(true); // nothing is written into a promoted home by the host itself
    await rig.mgr.loginComplete({ connectionId: "c1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
    await rig.mgr.loginPromote({ connectionId: "c1", loginRef: start.loginRef, epoch: 1 });
    expect(rig.script.prepared).toBe(1); // not prepared a second time
  });

  it("two sweeps running at once clean an expired sign-in exactly once and never double-free its uid", async () => {
    await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    const uid = Number(Object.keys(rig.store.get().uidOwners)[0]);
    rig.clock.advance(11 * 60 * 1000);
    await Promise.all([rig.mgr.sweep(), rig.mgr.sweep()]);
    expect(rig.fs.wipes.filter((w) => w.startsWith(`attempt:${uid}:`))).toHaveLength(1);
    expect(rig.fs.killed.filter((k) => k === uid)).toHaveLength(1);
    expect(Object.keys(rig.store.get().uidOwners)).toEqual([]);
    assertConsistent(rig);
  });

  it("a late cleanup of an old owner cannot free a uid that was re-allocated to a new sign-in", async () => {
    const a = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    const oldUid = Number(Object.keys(rig.store.get().uidOwners)[0]);
    await rig.mgr.loginCancel({ connectionId: "c1", loginRef: a.loginRef });
    const b = await rig.mgr.loginStart({ connectionId: "c2", provider: "fake" });
    expect(Number(Object.keys(rig.store.get().uidOwners)[0])).toBe(oldUid); // lowest free uid is reused
    // replay the old cleanup entry by hand: it must not touch the new owner
    const c1 = rig.store.get().connections.c1;
    c1.wipePending = [{ uid: oldUid, ref: "stale", kind: "attempt", owner: "attempt:att-1" }];
    await rig.mgr.sweep();
    expect(rig.store.get().uidOwners[String(oldUid)]).toBe(`attempt:${rig.store.get().connections.c2.attempt!.attemptRef}`);
    expect(b.loginRef).toBeTruthy();
  });

  it("a reconnect needs a strictly newer epoch (an equal epoch would let in-flight old-epoch calls land on the new login)", async () => {
    await signIn(rig, "c1", 3);
    const loginRef = await readyAttempt(rig, "c1", true);
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 3 }))).toBe("ESTALE");
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 4 }))).toBe("OK");
  });

  it("disable on a revoking connection is refused and does not adopt the epoch", async () => {
    await signIn(rig, "c1", 1);
    rig.fs.failWipes = true;
    await rig.mgr.revoke({ connectionId: "c1", epoch: 2 });
    expect(await code(rig.mgr.disable({ connectionId: "c1", epoch: 9 }))).toBe("ESTATE:revoking");
    expect(rig.mgr.status({ connectionId: "c1" }).epoch).toBe(2);
  });

  it("the same turnId on two connections is fine; on one connection it conflicts, and one connection cannot probe another's ids", async () => {
    await signIn(rig, "a", 1);
    await signIn(rig, "b", 1);
    rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    expect(await code(rig.mgr.runTurn({ ...turnReq("a", 1), turnId: "same" }))).toBe("OK");
    expect(await code(rig.mgr.runTurn({ ...turnReq("b", 1), turnId: "same" }))).toBe("OK");
    expect(await code(rig.mgr.runTurn({ ...turnReq("a", 1), turnId: "same" }))).toBe("EEXISTS");
  });
});

describe("ConnectionManager: provider failures", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a provider that hangs after an abort is force-closed after the grace period: slot freed, uid processes killed, next turn works", async () => {
    rig = makeRig({ adapter: { maxProcessesPerHome: 1 }, config: { abortGraceMs: 30 } });
    await signIn(rig, "c1", 1);
    rig.script.hangTurn = true;
    const started = await rig.mgr.runTurn(turnReq("c1", 1, { turnId: "hang1" }));
    const pending = drain(started.events!);
    await flush();
    const uid = rig.store.get().connections.c1.uid;
    rig.fs.killed.length = 0;
    rig.clock.advance(31_000);
    rig.mgr.tick(); // lease lapsed
    const out = await pending;
    expect(out[out.length - 1]).toMatchObject({ ok: false, aborted: "lease_lapsed" });
    expect(rig.fs.killed).toContain(uid);
    expect(rig.mgr.status({ connectionId: "c1" }).runningTurns).toBe(0);
    // the single process slot is free again: a new session opens
    rig.script.hangTurn = false;
    const next = await rig.mgr.runTurn(turnReq("c1", 1));
    expect((await drain(next.events!)).pop()).toMatchObject({ ok: true });
    expect(rig.script.opened).toBe(2);
  });

  it("an idle session is closed and retired; a session the provider closed itself is not reused", async () => {
    rig = makeRig({ adapter: { maxProcessesPerHome: 1 }, config: { idleSessionMs: 60_000 } });
    await signIn(rig, "c1", 1);
    await drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    expect(rig.script.opened).toBe(1);
    rig.clock.advance(61_000);
    rig.mgr.tick();
    await flush();
    expect(rig.script.closed).toBe(1);
    await drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    expect(rig.script.opened).toBe(2);
    // the provider's process dies by itself
    rig.script.killSessions.forEach((k) => k());
    await flush();
    await drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    expect(rig.script.opened).toBe(3);
  });

  it("caps provider processes across the host (idle processes of many connections are bounded)", async () => {
    rig = makeRig({ config: { maxSessionsPerHost: 2 } });
    await signIn(rig, "a", 1);
    await signIn(rig, "b", 1);
    await signIn(rig, "c", 1);
    await drain((await rig.mgr.runTurn(turnReq("a", 1))).events!);
    await drain((await rig.mgr.runTurn(turnReq("b", 1))).events!);
    expect(await code(rig.mgr.runTurn(turnReq("c", 1)))).toBe("EBUSY:host_busy");
  });

  it("relayed tool calls: only an operation this turn issued can be answered, once; unanswered ones time out", async () => {
    rig = makeRig({ adapter: { toolTransport: "host_relay" }, config: { toolCallTimeoutMs: 1_000 } });
    await signIn(rig, "c1", 1);
    await signIn(rig, "c2", 1);
    rig.script.turnEvents = [{ type: "tool-use", operationId: "op1", name: "t", input: {} }, { type: "tool-use", operationId: "op2", name: "t", input: {} }, { wait: new Promise<void>(() => undefined) }, { type: "result", ok: true, text: "x" }];
    const started = await rig.mgr.runTurn(turnReq("c1", 1, { turnId: "tr1" }));
    const it = started.events![Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: "tool-use", operationId: "op1" });
    expect((await it.next()).value).toMatchObject({ type: "tool-use", operationId: "op2" });
    const answer = (conn: string, op: string) => rig.mgr.turnToolResult({ connectionId: conn, turnId: "tr1", epoch: 1, operationId: op, ok: true, content: "r" });
    expect(await code(answer("c1", "nope"))).toBe("ENOTFOUND");
    expect(await code(answer("c2", "op1"))).toBe("ENOTFOUND"); // another connection cannot answer it
    expect(await code(answer("c1", "op1"))).toBe("OK");
    expect(await code(answer("c1", "op1"))).toBe("ENOTFOUND"); // once
    rig.clock.advance(2_000);
    rig.mgr.tick();
    await flush();
    expect(rig.script.answers.map((a) => a.operationId)).toEqual(["op1", "op2"]);
    expect(rig.script.answers[1].answer).toMatchObject({ kind: "tool-result", ok: false, content: "tool_call_timeout" });
    await it.return?.();
  });
});

describe("ConnectionManager: host restart", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("recover() kills the processes of every allocated uid before serving, and parks a connection that died mid-swap", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    await rig.mgr.loginStart({ connectionId: "c2", provider: "fake" });
    const ownedBefore = Object.keys(rig.store.get().uidOwners).map(Number);
    expect(ownedBefore).toHaveLength(2); // the connection's uid and the pending attempt's uid
    rig.store.get().connections.c1.state = "swapping";
    rig.store.save();
    rig.fs.killed.length = 0;
    const mgr2 = rig.restart();
    await mgr2.recover();
    for (const u of ownedBefore) expect(rig.fs.killed).toContain(u);
    expect(mgr2.status({ connectionId: "c1" })).toMatchObject({ state: "needs_attention", reason: "swap_interrupted" });
    await mgr2.sweep();
    assertConsistent(rig);
  });
});
