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

/** A deploy must never cut off a customer: drain refuses NEW work only, lets everything running finish, and expires on its own. */
describe("ConnectionManager deploy drain", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  /** A turn that keeps running until `release()`; returns a promise of its events. */
  async function longTurn(connectionId = "conn1", extra: Record<string, unknown> = {}) {
    let release!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (release = r)) }, { type: "result", ok: true, text: "done" }];
    const req = turnReq(connectionId, 1, extra);
    const started = await rig.mgr.runTurn(req);
    const events = drain(started.events!);
    return { release, events, turnId: req.turnId };
  }

  it("strict refuses while a turn runs, and the running turn is untouched", async () => {
    rig = makeRig();
    await signIn(rig);
    const t = await longTurn();
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: false, mode: "off", running: 1 });
    expect(await code(rig.mgr.runTurn(turnReq("conn1", 1)))).toBe("OK"); // nothing was gated: the host kept serving
    t.release();
    expect((await t.events).some((e) => e.type === "result" && e.ok)).toBe(true);
  });

  it("strict succeeds once idle, then refuses every new turn and sign-in with a retryable EBUSY, and off lifts it", async () => {
    rig = makeRig();
    await signIn(rig);
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: true, mode: "strict", running: 0, signIns: 0 });
    expect(await code(rig.mgr.runTurn(turnReq("conn1", 1)))).toBe("EBUSY:draining");
    expect(await code(rig.mgr.runTurn(turnReq("conn1", 1, { priority: "scheduled" })))).toBe("EBUSY:draining");
    expect(await code(rig.mgr.loginStart({ connectionId: "conn2", provider: rig.adapter.id }))).toBe("EBUSY:draining");
    expect(await code(rig.mgr.loginStart({ connectionId: "conn1", provider: rig.adapter.id, reconnect: true }))).toBe("EBUSY:draining");
    expect(rig.mgr.hostStatus()).toMatchObject({ drain: "strict", running: 0 });
    rig.mgr.setDrain({ mode: "off" });
    expect(await code(rig.mgr.runTurn(turnReq("conn1", 1)))).toBe("OK");
  });

  it("a refused request leaves no trace: no turn, no attempt, no uid", async () => {
    rig = makeRig();
    await signIn(rig);
    const uidsBefore = Object.keys(rig.store.get().uidOwners).length;
    rig.mgr.setDrain({ mode: "strict" });
    await code(rig.mgr.runTurn(turnReq("conn1", 1)));
    await code(rig.mgr.loginStart({ connectionId: "conn2", provider: rig.adapter.id }));
    expect(rig.mgr.hostStatus().running).toBe(0);
    expect(rig.store.get().connections["conn2"]).toBeUndefined();
    expect(Object.keys(rig.store.get().uidOwners)).toHaveLength(uidsBefore);
  });

  it("a person in the middle of signing in blocks strict until they finish", async () => {
    rig = makeRig();
    const start = await rig.mgr.loginStart({ connectionId: "conn1", provider: rig.adapter.id });
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: false, signIns: 1 });
    await rig.mgr.loginComplete({ connectionId: "conn1", loginRef: start.loginRef, code: "abcdefgh#12345678" });
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: false, signIns: 1 }); // ready, not yet promoted
    await rig.mgr.loginPromote({ connectionId: "conn1", loginRef: start.loginRef, epoch: 1 });
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: true, mode: "strict" });
  });

  it("an abandoned sign-in (past its time limit) does not hold a deploy up", async () => {
    rig = makeRig();
    await rig.mgr.loginStart({ connectionId: "conn1", provider: rig.adapter.id });
    expect(rig.mgr.setDrain({ mode: "strict" }).ok).toBe(false);
    rig.clock.advance(rig.adapter.loginTtlMs + 1_000);
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: true, mode: "strict" });
  });

  it("expires by itself, so a deploy that died half-way cannot leave the host refusing work", async () => {
    rig = makeRig();
    await signIn(rig);
    rig.mgr.setDrain({ mode: "strict", ttlSec: 30 });
    rig.clock.advance(29_000);
    expect(await code(rig.mgr.runTurn(turnReq("conn1", 1)))).toBe("EBUSY:draining");
    rig.clock.advance(2_000);
    expect(rig.mgr.hostStatus().drain).toBe("off");
    expect(await code(rig.mgr.runTurn(turnReq("conn1", 1)))).toBe("OK");
  });

  it("a restart clears it (the drain only prepares one)", async () => {
    rig = makeRig();
    await signIn(rig);
    rig.mgr.setDrain({ mode: "strict" });
    expect(rig.restart().hostStatus().drain).toBe("off");
  });

  it("everything that protects a customer keeps working while drained: running-turn control, status, disable, revoke", async () => {
    rig = makeRig();
    await signIn(rig);
    const t = await longTurn();
    expect(await code(rig.mgr.renewLease({ connectionId: "conn1", turnId: t.turnId, epoch: 1 }))).toBe("OK");
    expect(await code(rig.mgr.interruptTurn({ connectionId: "conn1", turnId: t.turnId, epoch: 1 }))).toBe("OK");
    expect(rig.mgr.status({ connectionId: "conn1" }).runningTurns).toBe(1);
    t.release();
    await t.events;
    rig.mgr.setDrain({ mode: "strict" });
    expect(await code(rig.mgr.disable({ connectionId: "conn1", epoch: 1 }))).toBe("OK");
    expect(await code(rig.mgr.revoke({ connectionId: "conn1", epoch: 2 }))).toBe("OK");
  });

  it("a duplicate of an already-accepted turn still gets its recorded outcome while drained (no second run, no spurious error)", async () => {
    rig = makeRig();
    await signIn(rig);
    const req = turnReq("conn1", 1);
    const first = await rig.mgr.runTurn(req);
    await drain(first.events!);
    rig.mgr.setDrain({ mode: "strict" });
    const again = await rig.mgr.runTurn(req);
    expect(again.duplicate).toBe(true);
  });

  it("a sign-in being PROMOTED (the swap in progress) counts as busy, and is not once it is done", async () => {
    rig = makeRig();
    await signIn(rig);
    const conn = rig.store.get().connections["conn1"];
    conn.state = "swapping"; // what loginPromote sets while it moves the new home into place
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: false, signIns: 1 });
    conn.state = "active";
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: true });
  });

  it("a sign-in already past its gate is counted until its attempt exists", async () => {
    rig = makeRig();
    let proceed!: () => void;
    const gate = new Promise<void>((r) => (proceed = r));
    const orig = rig.fs.createAttemptDir.bind(rig.fs);
    rig.fs.createAttemptDir = async (...a: Parameters<typeof orig>) => (await gate, orig(...a));
    const racing = code(rig.mgr.loginStart({ connectionId: "conn1", provider: rig.adapter.id }));
    await new Promise((r) => setImmediate(r));
    const d = rig.mgr.setDrain({ mode: "strict" });
    expect(d.ok).toBe(false);
    expect(d.signIns).toBeGreaterThanOrEqual(1); // may count it twice (admitting + recorded): erring toward waiting is the safe side
    proceed();
    expect(await racing).toBe("OK");
  });

  it("a RECONNECT sign-in that is still clearing the customer's expired attempt is counted (the window before its new attempt exists)", async () => {
    rig = makeRig();
    await signIn(rig);
    await rig.mgr.loginStart({ connectionId: "conn1", provider: rig.adapter.id, reconnect: true });
    rig.clock.advance(rig.adapter.loginTtlMs + 1_000); // that attempt is now expired, so on its own it no longer counts
    expect(rig.mgr.hostStatus().signIns).toBe(0);
    let proceed!: () => void;
    const gate = new Promise<void>((r) => (proceed = r));
    const orig = rig.fs.wipeAttempt.bind(rig.fs);
    rig.fs.wipeAttempt = async (...a: Parameters<typeof orig>) => (await gate, orig(...a));
    const racing = code(rig.mgr.loginStart({ connectionId: "conn1", provider: rig.adapter.id, reconnect: true }));
    await new Promise((r) => setImmediate(r));
    expect(rig.mgr.setDrain({ mode: "strict" })).toMatchObject({ ok: false, signIns: 1 });
    proceed();
    expect(await racing).toBe("OK");
  });
});
