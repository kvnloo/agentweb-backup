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
