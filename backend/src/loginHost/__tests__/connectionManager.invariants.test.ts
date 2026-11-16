/**
 * Randomized invariant test: random sequences of operations on several connections, with injected
 * faults and host restarts, checking the safety properties after EVERY step instead of only the cases
 * a reviewer thought of. Deterministic (seeded); a failure prints the seed and the operation trace.
 *
 * Invariants:
 *  I1 a directory that holds anything under a uid exists only while that uid is allocated (a uid is never free while credentials exist under it)
 *  I2 an allocated uid has a directory or a pending wipe (nothing leaks forever)
 *  I3 a connection that was disabled by the user is never `active` until a successful enable (or revoke)
 *  I4 a `revoked` connection has nothing pending and nothing on disk
 *  I6 provider sessions alive never exceed the per-home caps (single-use sessions included)
 *  I5 after faults stop and the sweeper runs, every connection that was revoked is `revoked` and the host holds nothing for it
 */
import { HostError } from "../protocol";
import { assertConsistent, drain, makeRig, turnReq, type Rig } from "./helpers";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONNS = ["c1", "c2", "c3"];
const SEEDS = Number(process.env.INVARIANT_SEEDS ?? 120);
const STEPS = Number(process.env.INVARIANT_STEPS ?? 45);

async function run(seed: number): Promise<void> {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const rig: Rig = makeRig({ adapter: { singleUse: seed % 2 === 0 }, config: { uidMin: 400_000, uidMax: 400_000 + 40, portCallTimeoutMs: 15, adapterCallTimeoutMs: 15, abortGraceMs: 10 } }); // even seeds: one process per turn
  let mgr = rig.mgr;
  const trace: string[] = [];
  const attempts = new Map<string, string>(); // connection -> loginRef of a ready attempt
  const userDisabled = new Set<string>();
  const revokeRequested = new Set<string>();
  const fail = (msg: string) => {
    throw new Error(`seed ${seed}: ${msg}\n  trace: ${trace.join(" | ")}`);
  };
  const epochOf = (c: string): number => {
    try {
      return mgr.status({ connectionId: c }).epoch ?? 0;
    } catch {
      return 0;
    }
  };
  const stateOf = (c: string): string => {
    try {
      return mgr.status({ connectionId: c }).state;
    } catch {
      return "unknown";
    }
  };
  const tolerate = async (label: string, p: () => Promise<unknown>): Promise<boolean> => {
    try {
      await p();
      trace.push(label);
      return true;
    } catch (e) {
      trace.push(`${label}!${e instanceof HostError ? e.code : (e as Error).message.slice(0, 20)}`);
      return false;
    }
  };
  const check = (when: string) => {
    try {
      const st = rig.store.get();
      const dirUids = new Set([...rig.fs.dirs].map((d) => Number(d.split(":")[1])));
      for (const uid of dirUids) if (st.uidOwners[String(uid)] === undefined) fail(`I1 after ${when}: directory under free uid ${uid}`);
      const pending = new Set<number>();
      for (const c of Object.values(st.connections)) for (const w of c.wipePending ?? []) pending.add(w.uid);
      for (const u of Object.keys(st.uidOwners)) if (!dirUids.has(Number(u)) && !pending.has(Number(u))) fail(`I2 after ${when}: uid ${u} owned with no directory and no pending wipe`);
      if (rig.script.opened - rig.script.closed > CONNS.length * rig.adapter.maxProcessesPerHome) fail(`I6 after ${when}: ${rig.script.opened - rig.script.closed} provider sessions alive, over the per-home caps`);
      for (const c of CONNS) {
        if (!st.connections[c]) userDisabled.delete(c); // the host forgot an abandoned first sign-in: a later sign-in is a brand-new connection
        if (userDisabled.has(c) && stateOf(c) === "active") fail(`I3 after ${when}: ${c} is active although the user disabled it`);
        const rec = st.connections[c];
        if (rec?.state === "revoked") {
          if (rec.wipePending?.length) fail(`I4 after ${when}: ${c} revoked with pending wipes`);
          if (rec.uid >= 0 || rec.homeRef) fail(`I4 after ${when}: ${c} revoked but still points at a home`);
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("seed ")) throw e;
      fail(`invariant check threw: ${(e as Error).message}`);
    }
  };

  for (let i = 0; i < STEPS; i++) {
    const c = pick(CONNS);
    const ep = epochOf(c);
    // random fault injection for this step
    rig.fs.failPromote = rand() < 0.07;
    rig.fs.failKillOnce = rand() < 0.07;
    rig.fs.crashAfterPromote = rand() < 0.04;
    rig.fs.hangWipe = rand() < 0.04;
    const op = pick(["start", "start", "reconnect", "complete", "promote", "promote", "cancel", "disable", "enable", "revoke", "turn", "sweep", "sweep", "restart", "tick"] as const);
    switch (op) {
      case "start":
      case "reconnect": {
        const ok = await tolerate(`${c}.${op}`, async () => {
          const r = await mgr.loginStart({ connectionId: c, provider: "fake", ...(op === "reconnect" ? { reconnect: true } : {}) });
          attempts.set(c, r.loginRef);
          await mgr.loginComplete({ connectionId: c, loginRef: r.loginRef, code: "abcdefgh#12345678" });
        });
        if (!ok) attempts.delete(c);
        break;
      }
      case "complete":
        break;
      case "promote": {
        const ref = attempts.get(c);
        if (ref) await tolerate(`${c}.promote@${rand() < 0.2 ? ep : ep + 1}`, () => mgr.loginPromote({ connectionId: c, loginRef: ref, epoch: rand() < 0.2 ? ep : ep + 1 }));
        break;
      }
      case "cancel": {
        const ref = attempts.get(c);
        if (ref && (await tolerate(`${c}.cancel`, () => mgr.loginCancel({ connectionId: c, loginRef: ref })))) attempts.delete(c);
        break;
      }
      case "disable":
        if (await tolerate(`${c}.disable`, () => mgr.disable({ connectionId: c, epoch: ep + 1 }))) userDisabled.add(c);
        break;
      case "enable":
        if (await tolerate(`${c}.enable`, () => mgr.enable({ connectionId: c, epoch: ep + 1 })) && stateOf(c) === "active") userDisabled.delete(c);
        break;
      case "revoke":
        revokeRequested.add(c);
        userDisabled.delete(c);
        await tolerate(`${c}.revoke`, () => mgr.revoke({ connectionId: c, epoch: ep + 1 }));
        break;
      case "turn":
        await tolerate(`${c}.turn`, async () => {
          const r = await mgr.runTurn(turnReq(c, ep));
          if (r.events) await drain(r.events);
        });
        break;
      case "sweep":
        await tolerate("sweep", () => mgr.sweep());
        break;
      case "restart":
        mgr = rig.restart();
        trace.push("restart");
        await tolerate("recover", () => mgr.recover());
        break;
      case "tick":
        rig.clock.advance(rand() < 0.3 ? 11 * 60 * 1000 : 1000);
        trace.push("tick");
        break;
    }
    check(`step ${i} (${op} ${c})`);
  }

  // settle: faults off, run the sweeper until quiet
  rig.fs.failPromote = rig.fs.failKillOnce = rig.fs.crashAfterPromote = rig.fs.hangWipe = false;
  mgr = rig.restart();
  await mgr.recover();
  rig.clock.advance(30 * 60 * 1000);
  for (let i = 0; i < 4; i++) await mgr.sweep();
  check("settle");
  for (const c of revokeRequested) {
    const s = rig.store.get().connections[c];
    if (s && s.state !== "revoked" && s.state !== "revoking") continue; // revoke was refused (e.g. unknown connection): nothing to prove
    if (s && s.state !== "revoked") fail(`I5: ${c} still ${s.state} after settling`);
  }
  assertConsistent(rig);
  rig.cleanup();
}

describe("host invariants under random operations, faults and restarts", () => {
  const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
  it.each(seeds)("seed %d", async (seed) => {
    await run(seed);
  }, 60_000);
});
