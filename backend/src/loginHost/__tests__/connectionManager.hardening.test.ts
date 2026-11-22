/**
 * Round-2 review tests for PR 1a: cleanup that targets the right uid, side effects of a superseded
 * login, time-bounded adapter/port calls, failed and interrupted promotes, enable rules.
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
  const start = await rig.mgr.loginStart({ connectionId, provider: "fake", ...(reconnect ? { reconnect: true } : {}) });
  await rig.mgr.loginComplete({ connectionId, loginRef: start.loginRef, code: "abcdefgh#12345678" });
  return start.loginRef;
}

describe("cleanup targets the right uid", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a hung turn after a revoke never calls killAll with an out-of-range uid (-1 would mean every process)", async () => {
    rig = makeRig({ config: { abortGraceMs: 30 } });
    await signIn(rig, "c1", 1);
    const uid = rig.store.get().connections.c1.uid;
    rig.script.hangTurn = true;
    const out = drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    await flush();
    await rig.mgr.revoke({ connectionId: "c1", epoch: 2 });
    await out;
    expect(rig.fs.killed.length).toBeGreaterThan(0);
    for (const k of rig.fs.killed) expect(k).toBe(uid);
  });

  it("a hung turn of the OLD login never kills the processes of the NEW login after a reconnect", async () => {
    rig = makeRig({ config: { abortGraceMs: 30 } });
    await signIn(rig, "c1", 1);
    const oldUid = rig.store.get().connections.c1.uid;
    rig.script.hangTurn = true;
    const out = drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    await flush();
    const loginRef = await readyAttempt(rig, "c1", true);
    await rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 });
    const newUid = rig.store.get().connections.c1.uid;
    expect(newUid).not.toBe(oldUid);
    rig.fs.killed.length = 0;
    await out; // returns after the grace period; the hung-turn cleanup has run
    expect(rig.fs.killed).not.toContain(newUid);
    for (const k of rig.fs.killed) expect(k).toBe(oldUid);
  });
});

describe("uid safety", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("never signals a uid outside the reserved range, whatever the books say (kill(-1) means every process)", async () => {
    rig = makeRig();
    await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    const c = rig.store.get().connections.c1;
    c.wipePending = [
      { uid: -1, ref: "x", kind: "home", owner: "c1" },
      { uid: 0, ref: "x", kind: "home", owner: "c1" },
      { uid: 1, ref: "x", kind: "home", owner: "c1" },
      { uid: 999_999_999, ref: "x", kind: "home", owner: "c1" },
    ];
    await rig.mgr.sweep();
    for (const bad of [-1, 0, 1, 999_999_999]) expect(rig.fs.killed).not.toContain(bad);
  });
});

describe("uid release while more cleanup is queued", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a uid is not freed when another cleanup entry for it was queued while the drain was running; the next sweep releases it", async () => {
    rig = makeRig();
    const a = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    const c = rig.store.get().connections.c1;
    const uid = c.attempt!.uid;
    const owner = `attempt:${c.attempt!.attemptRef}`;
    let fired = false;
    rig.fs.onWipe = () => {
      if (fired) return;
      fired = true;
      (c.wipePending ??= []).push({ uid, ref: "late-home", kind: "home", owner }); // a concurrent operation queues more work for the same uid
    };
    await rig.mgr.loginCancel({ connectionId: "c1", loginRef: a.loginRef });
    expect(rig.store.get().uidOwners[String(uid)]).toBe(owner); // still allocated: work remains for it
    expect(rig.store.get().connections.c1.wipePending).toHaveLength(2); // both entries of the uid are kept together and retried (wipes are idempotent)
    rig.fs.onWipe = undefined;
    await rig.mgr.sweep();
    expect(rig.store.get().uidOwners[String(uid)]).toBeUndefined();
    assertConsistent(rig);
  });

  it("a cleanup entry for a uid that is now outside the configured range (range narrowed between restarts) is never signalled and is kept", async () => {
    rig = makeRig({ config: { uidMin: 400_000, uidMax: 400_009 } });
    await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    rig.store.get().uidOwners["5"] = "c1"; // an old allocation from a wider range
    rig.store.get().connections.c1.wipePending = [{ uid: 5, ref: "old", kind: "home", owner: "c1" }];
    rig.fs.killed.length = 0;
    await rig.mgr.sweep();
    expect(rig.fs.killed).not.toContain(5);
    expect(rig.store.get().connections.c1.wipePending).toHaveLength(1); // kept: credentials may still be on disk, so never "clean"
  });
});

describe("pending cleanup is durable while it runs", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a save by another operation during a revoke's wipe still records the pending wipe, so a restart finishes it instead of confirming a revoke with credentials on disk", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    await signIn(rig, "c2", 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rig.fs.wipeGate = gate;
    const revoking = rig.mgr.revoke({ connectionId: "c1", epoch: 2 });
    await flush();
    await rig.mgr.disable({ connectionId: "c2", epoch: 2 }); // saves the whole state while c1's wipe is in flight
    const onDisk = JSON.parse(JSON.stringify(rig.store.get())); // what a crash right now would leave
    expect(onDisk.connections.c1.wipePending?.length).toBeGreaterThan(0);
    release();
    await revoking;
  });

  it("a stuck wipe survives a restart and is retried", async () => {
    rig = makeRig({ config: { portCallTimeoutMs: 50 } });
    await signIn(rig, "c1", 1);
    rig.fs.hangWipe = true;
    await rig.mgr.revoke({ connectionId: "c1", epoch: 2 });
    rig.fs.hangWipe = false;
    const mgr2 = rig.restart();
    await mgr2.recover();
    await mgr2.sweep();
    expect(mgr2.status({ connectionId: "c1" }).state).toBe("revoked");
    expect([...rig.fs.dirs].filter((d) => d.startsWith("home:"))).toEqual([]);
    assertConsistent(rig);
  });

  it("an entry for a uid outside the configured range is kept, and the revoke is not confirmed", async () => {
    rig = makeRig({ config: { uidMin: 400_000, uidMax: 400_009 } });
    await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    rig.store.get().uidOwners["5"] = "c1";
    rig.store.get().connections.c1.wipePending = [{ uid: 5, ref: "old", kind: "home", owner: "c1" }];
    await rig.mgr.sweep();
    expect(rig.fs.killed).not.toContain(5);
    expect(rig.store.get().connections.c1.wipePending).toHaveLength(1);
  });
});

describe("a superseded login's late side effects", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("an auth_dead preflight that answers after a reconnect does not park the freshly reconnected connection", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    let release!: () => void;
    rig.script.preflightGate = new Promise<void>((r) => (release = r));
    rig.script.preflight = { ok: false, kind: "auth_dead" };
    const out = drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    await flush(); // the turn is waiting inside preflight
    const loginRef = await readyAttempt(rig, "c1", true);
    await rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 });
    release();
    await out;
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "active", epoch: 2 });
  });

  it("an alarm from a superseded login (whose turn was aborted by the reconnect) does not park the new one", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    let release!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (release = r)) }, { type: "alarm", hazard: { kind: "hook_event" } }, { type: "result", ok: true, text: "x" }];
    rig.script.ignoreInterrupt = true; // the old provider keeps going after the abort
    const out = drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    await flush();
    const loginRef = await readyAttempt(rig, "c1", true);
    await rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 });
    release();
    await out;
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "active", epoch: 2 });
  });
});

describe("a hung adapter or port cannot wedge a connection", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a session that never opens does not block disable or revoke", async () => {
    rig = makeRig({ config: { adapterCallTimeoutMs: 50, portCallTimeoutMs: 50, abortGraceMs: 30 } });
    await signIn(rig, "c1", 1);
    rig.script.openHang = true;
    const out = drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!);
    const t0 = Date.now();
    await rig.mgr.disable({ connectionId: "c1", epoch: 2 });
    await rig.mgr.revoke({ connectionId: "c1", epoch: 3 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await out).pop()).toMatchObject({ ok: false, aborted: "disabled" });
    expect(rig.mgr.status({ connectionId: "c1" }).state).toMatch(/revok/);
  });

  it("a wipe that hangs leaves the connection revoking (cleanup pending) in bounded time, and the sweep still cleans the other connections", async () => {
    rig = makeRig({ config: { portCallTimeoutMs: 50 } });
    await signIn(rig, "c1", 1);
    await rig.mgr.loginStart({ connectionId: "c2", provider: "fake" }); // an attempt that will expire
    rig.fs.hangWipe = true;
    const t0 = Date.now();
    expect(await rig.mgr.revoke({ connectionId: "c1", epoch: 2 })).toMatchObject({ state: "revoking", cleanupConfirmed: false });
    expect(Date.now() - t0).toBeLessThan(2000);
    rig.clock.advance(11 * 60 * 1000);
    await rig.mgr.sweep();
    expect(rig.store.get().connections.c2).toBeUndefined(); // c2 was cleaned although c1 is stuck
    rig.fs.hangWipe = false;
    await rig.mgr.sweep();
    expect(rig.mgr.status({ connectionId: "c1" }).state).toBe("revoked");
    assertConsistent(rig);
  });

  it("a revoke whose cleanup throws reports cleanup pending instead of failing, and the sweeper finishes it", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    rig.fs.failKillOnce = true;
    await expect(rig.mgr.revoke({ connectionId: "c1", epoch: 2 })).resolves.toMatchObject({ state: "revoking", cleanupConfirmed: false });
    await rig.mgr.sweep();
    expect(rig.mgr.status({ connectionId: "c1" }).state).toBe("revoked");
    assertConsistent(rig);
  });

  it("a connection whose sweep step throws does not stop the sweep of the others", async () => {
    rig = makeRig();
    await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    await rig.mgr.loginStart({ connectionId: "c2", provider: "fake" });
    rig.clock.advance(11 * 60 * 1000);
    const realSave = rig.store.save.bind(rig.store);
    let thrown = false;
    rig.store.save = () => {
      if (!thrown) {
        thrown = true;
        throw new Error("disk full");
      }
      realSave();
    };
    await expect(rig.mgr.sweep()).resolves.toBeUndefined();
    rig.store.save = realSave;
    await rig.mgr.sweep(); // the retry finishes whatever the failed step left
    expect(rig.store.get().connections.c1).toBeUndefined();
    expect(rig.store.get().connections.c2).toBeUndefined();
    assertConsistent(rig);
  });

  it("concurrent sweeps share one run (no pile-up of stuck sweeps)", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    const a = rig.mgr.sweep();
    const b = rig.mgr.sweep();
    expect(a).toBe(b);
    await a;
  });
});

describe("failed and interrupted promotes", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("a failure mid-reconnect parks the connection, and the same promote can be resumed at the same epoch", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    const loginRef = await readyAttempt(rig, "c1", true);
    rig.fs.failKillOnce = true; // fails inside the fenced section
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 }))).toBe("EINTERNAL:promote_failed");
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "needs_attention", reason: "promote_failed", epoch: 2 });
    expect(await code(rig.mgr.runTurn(turnReq("c1", 2)))).toBe("ESTATE:needs_attention");
    // a different epoch still needs to be newer; the same one resumes
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 }))).toBe("OK");
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "active", epoch: 2 });
    assertConsistent(rig);
  });

  it("a connection that was disabled BEFORE a reconnect whose promote failed stays disabled when that promote is resumed", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    await rig.mgr.disable({ connectionId: "c1", epoch: 2 });
    const loginRef = await readyAttempt(rig, "c1", true);
    rig.fs.failKillOnce = true;
    await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 3 }));
    expect(rig.mgr.status({ connectionId: "c1" })).toMatchObject({ state: "needs_attention", reason: "promote_failed" }); // the failure path forgot it was disabled...
    expect(await rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 3 })).toEqual({ state: "disabled", epoch: 3 }); // ...the record did not
  });

  it("a connection disabled before a failed reconnect stays disabled when the user cancels and starts a NEW reconnect", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    await rig.mgr.disable({ connectionId: "c1", epoch: 2 });
    const a = await readyAttempt(rig, "c1", true);
    rig.fs.failPromote = true;
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef: a, epoch: 3 }))).toBe("EINTERNAL:promote_failed");
    expect(rig.mgr.status({ connectionId: "c1" }).state).toBe("needs_attention");
    rig.fs.failPromote = false;
    await rig.mgr.loginCancel({ connectionId: "c1", loginRef: a });
    const b = await readyAttempt(rig, "c1", true);
    expect(await rig.mgr.loginPromote({ connectionId: "c1", loginRef: b, epoch: 4 })).toEqual({ state: "disabled", epoch: 4 });
  });

  it("a promote whose attempt uid is owned by someone else fails closed instead of carrying on", async () => {
    rig = makeRig();
    const loginRef = await readyAttempt(rig, "c1");
    const uid = rig.store.get().connections.c1.attempt!.uid;
    rig.store.get().uidOwners[String(uid)] = "someone-else"; // corrupted books
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 1 }))).toBe("EINTERNAL:promote_failed");
    expect(rig.mgr.status({ connectionId: "c1" }).state).toBe("needs_attention");
  });

  it("disabling a connection that is mid first sign-in (or parked needs_reconnect) is recorded, not silently dropped", async () => {
    rig = makeRig();
    const ref = await readyAttempt(rig, "c1");
    await rig.mgr.disable({ connectionId: "c1", epoch: 1 });
    expect(await rig.mgr.loginPromote({ connectionId: "c1", loginRef: ref, epoch: 2 })).toEqual({ state: "disabled", epoch: 2 });
    // parked by a dead login, then disabled, then reconnected
    await signIn(rig, "c2", 1);
    rig.script.preflight = { ok: false, kind: "auth_dead" };
    await drain((await rig.mgr.runTurn(turnReq("c2", 1))).events!);
    expect(rig.mgr.status({ connectionId: "c2" }).state).toBe("needs_reconnect");
    await rig.mgr.disable({ connectionId: "c2", epoch: 2 });
    const re = await readyAttempt(rig, "c2", true);
    expect(await rig.mgr.loginPromote({ connectionId: "c2", loginRef: re, epoch: 3 })).toEqual({ state: "disabled", epoch: 3 });
  });

  it("a parked or home-less connection cannot be brought back by disable then enable (only a reconnect clears it)", async () => {
    rig = makeRig();
    // first sign-in whose promote fails: no home at all
    const first = await readyAttempt(rig, "c1");
    rig.fs.failPromote = true;
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef: first, epoch: 1 }))).toBe("EINTERNAL:promote_failed");
    await rig.mgr.disable({ connectionId: "c1", epoch: 2 });
    expect(await code(rig.mgr.enable({ connectionId: "c1", epoch: 2 }))).toBe("ESTATE:promote_failed");
    rig.fs.failPromote = false;
    // an existing home whose reconnect failed: the old login must not come back under the new epoch
    rig.cleanup();
    rig = makeRig();
    await signIn(rig, "c2", 1);
    const re = await readyAttempt(rig, "c2", true);
    rig.fs.failPromote = true;
    await code(rig.mgr.loginPromote({ connectionId: "c2", loginRef: re, epoch: 2 }));
    await rig.mgr.disable({ connectionId: "c2", epoch: 3 });
    expect(await code(rig.mgr.enable({ connectionId: "c2", epoch: 3 }))).toBe("ESTATE:promote_failed");
  });

  it("promote reports the real state: a disabled connection stays disabled, and a retry says so too", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    await rig.mgr.disable({ connectionId: "c1", epoch: 2 });
    const re = await readyAttempt(rig, "c1", true);
    expect(await rig.mgr.loginPromote({ connectionId: "c1", loginRef: re, epoch: 3 })).toEqual({ state: "disabled", epoch: 3 });
    expect(await rig.mgr.loginPromote({ connectionId: "c1", loginRef: re, epoch: 3 })).toEqual({ state: "disabled", epoch: 3 });
  });

  it("resuming a failed promote of a connection that was disabled meanwhile keeps it disabled", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    const loginRef = await readyAttempt(rig, "c1", true);
    rig.fs.failKillOnce = true;
    await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 }));
    await rig.mgr.disable({ connectionId: "c1", epoch: 2 }); // allowed at the equal epoch
    expect(await rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 })).toEqual({ state: "disabled", epoch: 2 });
    expect(await code(rig.mgr.runTurn(turnReq("c1", 2)))).toBe("ESTATE:disabled");
  });

  it("a uid is not handed out again while the home that holds credentials under it still has to be wiped (cross-tenant)", async () => {
    rig = makeRig({ config: { uidMin: 400_000, uidMax: 400_001, portCallTimeoutMs: 50 } });
    const loginRef = await readyAttempt(rig, "c1");
    rig.fs.crashAfterPromote = true;
    await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 1 })); // the rename happened; the books say "attempt"
    rig.fs.crashAfterPromote = false;
    const credentialUid = Number([...rig.fs.dirs].find((d) => d.startsWith("home:"))!.split(":")[1]);
    rig.fs.hangWipe = true; // the home wipe cannot complete
    await rig.mgr.loginCancel({ connectionId: "c1", loginRef }); // wipes the attempt (done) and the intended home (stuck)
    expect(rig.store.get().uidOwners[String(credentialUid)]).toBeDefined(); // NOT freed
    // another tenant signing in must not be given that uid
    const other = await rig.mgr.loginStart({ connectionId: "c2", provider: "fake" });
    expect(other.loginRef).toBeTruthy();
    const c2Uid = rig.store.get().connections.c2.attempt!.uid;
    expect(c2Uid).not.toBe(credentialUid);
    // once the wipe can finish, the uid is released
    rig.fs.hangWipe = false;
    await rig.mgr.sweep();
    expect(rig.store.get().uidOwners[String(credentialUid)]).toBeUndefined();
    assertConsistent(rig);
  });

  it("the second pending entry of a uid cannot kill or wipe a different tenant who now owns that uid", async () => {
    rig = makeRig();
    await rig.mgr.loginStart({ connectionId: "c1", provider: "fake" });
    const uid = rig.store.get().connections.c1.attempt!.uid;
    // a stale entry (owner no longer owns the uid) pointing at a uid that belongs to c1's live attempt
    rig.store.get().connections.c9 = { connectionId: "c9", provider: "fake", uid: -1, homeRef: "", epoch: 0, state: "attempting", createdAtMs: 1, updatedAtMs: 1, wipePending: [{ uid, ref: "old", kind: "home", owner: "someone-else" }] };
    rig.fs.killed.length = 0;
    await rig.mgr.sweep();
    expect(rig.fs.killed).not.toContain(uid);
    expect(rig.store.get().uidOwners[String(uid)]).toBe(`attempt:${rig.store.get().connections.c1.attempt!.attemptRef}`);
  });

  it("a revoked connection cannot complete a sign-in that was in flight", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    const re = await rig.mgr.loginStart({ connectionId: "c1", provider: "fake", reconnect: true });
    rig.fs.failKillOnce = true; // the kill inside revoke's cleanup throws before it reaches the attempt
    await rig.mgr.revoke({ connectionId: "c1", epoch: 2 });
    expect(await code(rig.mgr.loginComplete({ connectionId: "c1", loginRef: re.loginRef, code: "abcdefgh#12345678" }))).toBe("ENOTFOUND");
  });

  it("a crash between the rename and the save does not leave credentials behind: the intended home is recorded first and recovery wipes it", async () => {
    rig = makeRig();
    const loginRef = await readyAttempt(rig, "c1");
    rig.fs.crashAfterPromote = true;
    expect(await code(rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 1 }))).toBe("EINTERNAL:promote_failed");
    expect([...rig.fs.dirs].some((d) => d.startsWith("home:"))).toBe(true); // the credentials were moved into the intended home
    rig.fs.crashAfterPromote = false;
    const mgr2 = rig.restart(); // the host died here
    await mgr2.recover();
    await mgr2.sweep();
    expect([...rig.fs.dirs]).toEqual([]);
    expect(Object.keys(rig.store.get().uidOwners)).toEqual([]);
    assertConsistent(rig);
  });
});
