/**
 * Randomized sequence test of the real port against the in-memory system: random operations on three uids with
 * injected failures (rm fails, listing fails, an unkillable unit, the client dying while the unit lives, start
 * errors), checking the safety invariants after EVERY step. Deterministic per seed; a failure prints the seed
 * and the operation trace. INVARIANT_SEEDS / INVARIANT_STEPS scale it.
 *
 *  S1 a wipe that resolved left no directory, and a wipe never resolves while a unit of the uid is alive
 *  S2 a killAll that resolved left no unit and no stray process of the uid
 *  S3 promote never creates the source-and-target-both-present state, and when both already exist it refuses and changes nothing
 *  S4 every unit's name encodes this env and ITS OWN uid
 *  S5 an exit callback is only ever delivered for a unit that is inactive ("gone" is never a guess)
 *  S6 under a uid's directory only root and that uid own anything (never another uid)
 *  S7 no command argument contains a shell/service metacharacter (the dynamic parts were validated)
 *  S8 a spawn is refused while a kill of its uid is in flight, and allowed again right after (also after a failed kill)
 *  S9 after a killAll that resolved, NOTHING spawned before it ever comes alive later (the asynchronous systemd-run start: a unit created after the listing)
 */
import { Layout } from "../../ports/layout";
import { SystemdUserFs, type SystemdPortConfig } from "../../ports/systemdUserFs";
import type { ChildLike } from "../../adapter";
import { FakeSystem } from "./fakeSystem";

const SEEDS = Number(process.env.INVARIANT_SEEDS ?? 80);
const STEPS = Number(process.env.INVARIANT_STEPS ?? 45);
const UIDS = [400_100, 400_101, 400_102];
const REFS = ["att-1", "att-2", "att-3"];
const HOMES = ["home-1", "home-2"];

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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runSeed(seed: number): Promise<void> {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const sys = new FakeSystem();
  const layout = new Layout({ env: "test1", stateRoot: "/var/lib/aw-login-host/test1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 460_000 });
  let counter = 0;
  const config: SystemdPortConfig = {
    limits: { memoryMax: "1G", tasksMax: 256, tmpSize: "128M", shmSize: "64M", runtimeMaxSec: 7200 },
    paths: { systemRun: "/usr/bin/systemd-run", setpriv: "/usr/bin/setpriv", env: "/usr/bin/env", inaccessible: ["/run/aw-login-host-test1"], systemctl: "/usr/bin/systemctl", rm: "/usr/bin/rm", find: "/usr/bin/find", setquota: "/usr/sbin/setquota", writeFileHelper: "/opt/aw-login-host/aw-write-file.sh" },
    killTimeoutMs: 80,
    killPollMs: 2,
    commandTimeoutMs: 1000,
  };
  const port = new SystemdUserFs({ layout, cmd: sys, root: sys, config, randomHex: () => (++counter).toString(16).padStart(16, "0") });
  const trace: string[] = [];
  const fail = (m: string) => {
    throw new Error(`seed ${seed}: ${m}\n  trace: ${trace.join(" | ")}`);
  };
  const children: Array<{ uid: number; child: ChildLike; unit: string }> = [];
  const spawnedNames: Array<{ uid: number; name: string }> = [];

  const checkAll = (when: string) => {
    for (const u of sys.units.values()) {
      if (!new RegExp(`^aw-test1-${u.uid}-[a-f0-9]{16}\\.service$`).test(u.name)) fail(`S4 after ${when}: unit ${u.name} does not encode its uid ${u.uid}`);
    }
    for (const [p, n] of sys.tree) {
      const m = p.match(/^\/var\/lib\/aw-login-host\/test1\/u\/(\d+)\//);
      if (m && n.uid !== 0 && n.uid !== Number(m[1])) fail(`S6 after ${when}: ${p} owned by uid ${n.uid} under uid ${m[1]}'s directory`);
    }
    for (const c of sys.calls) for (const a of c.args) if (/[;|&`'"<>\n\\]/.test(a) || (/\$/.test(a))) fail(`S7 after ${when}: argument with a metacharacter: ${JSON.stringify(a)}`);
  };

  for (let i = 0; i < STEPS; i++) {
    const uid = pick(UIDS);
    const ref = pick(REFS);
    const op = pick(["create", "create", "promote", "wipeAtt", "wipeHome", "spawn", "spawn", "spawnShort", "killAll", "clientDeath", "endUnit", "killChild", "stray", "toggleFail", "killDuringSpawn", "toggleLatency"] as const);
    trace.push(`${op}(${uid % 100},${ref})`);
    try {
      switch (op) {
        case "create":
          await port.createAttemptDir(uid, ref).catch(() => undefined);
          break;
        case "promote": {
          const home = pick(HOMES);
          const src = layout.refDir(uid, "attempt", ref);
          const dst = layout.refDir(uid, "home", home);
          const before = { s: !!(await sys.lstat(src)), d: !!(await sys.lstat(dst)) };
          const r = await port.promoteAttempt(uid, ref, home).then(() => "ok", (e: Error) => e.message);
          const after = { s: !!(await sys.lstat(src)), d: !!(await sys.lstat(dst)) };
          if (after.s && after.d && !(before.s && before.d)) fail(`S3 promote CREATED the both-present state ${src} / ${dst}`);
          if (before.s && before.d && (r === "ok" || !after.s || !after.d)) fail("S3 promote replaced an existing target (or changed anything when it had to refuse)");
          if (r === "ok" && !(after.d && !after.s)) fail("S3 promote resolved but the target is missing or the source remains");
          break;
        }
        case "wipeAtt":
        case "wipeHome": {
          const kind = op === "wipeAtt" ? "attempt" : "home";
          const r = ref.replace("att", kind === "home" ? "home" : "att");
          const dir = layout.refDir(uid, kind, kind === "home" ? pick(HOMES) : ref);
          void r;
          const liveBefore = sys.activeUnits(uid).length;
          const res = await (kind === "attempt" ? port.wipeAttempt(uid, ref) : port.wipeHome(uid, dir.split("/").pop()!)).then(() => "ok", (e: Error) => e.message);
          if (res === "ok") {
            if (await sys.lstat(dir)) fail(`S1 wipe resolved but ${dir} exists`);
            if (liveBefore > 0 && sys.activeUnits(uid).length > 0 && liveBefore === sys.activeUnits(uid).length) fail("S1 wipe resolved while units of the uid were alive");
          }
          if (liveBefore > 0 && res === "ok") fail("S1 a wipe resolved although a unit of the uid was alive when it started");
          break;
        }
        case "spawn":
        case "spawnShort": {
          if (!(await sys.lstat(layout.refDir(uid, "attempt", ref)))) break;
          const ctx = port.contextFor("c", uid, ref, "attempt");
          try {
            const child = ctx.spawnAs({ file: "/bin/sleep", args: ["60"], env: { PATH: "/usr/bin:/bin" }, cwd: ctx.workDir });
            const name = (sys.calls[sys.calls.length - 1].args.find((a) => a.startsWith("--unit=")) ?? "").slice("--unit=".length);
            spawnedNames.push({ uid, name });
            child.onExit(() => {
              const u = sys.units.get(name);
              if (u && u.state !== "inactive") fail(`S5 exit delivered for ${name} while it is still ${u.state}`);
            });
            children.push({ uid, child, unit: name });
            const unit = sys.units.get(name);
            if (op === "spawnShort" && unit) sys.endUnit(unit, 0);
          } catch (e) {
            if (!/uid_gated|ENOENT/.test((e as Error).message)) fail(`unexpected spawn error ${(e as Error).message}`);
          }
          break;
        }
        case "killAll": {
          sys.failList = false;
          const before = spawnedNames.filter((s) => s.uid === uid).map((s) => s.name);
          const res = await port.killAll(uid).then(() => "ok", (e: Error) => e.message);
          if (res === "ok") {
            if (sys.activeUnits(uid).length) fail(`S2 killAll resolved with live units of ${uid}`);
            if ([...sys.strays.values()].includes(uid)) fail(`S2 killAll resolved with a stray of ${uid}`);
            await sleep(30); // anything still being created would have appeared by now
            for (const n of before) if (sys.units.get(n)?.state === "active") fail(`S9 ${n} came alive AFTER killAll resolved`);
          }
          // S8: a spawn right after is allowed (the gate reopened), whatever the outcome
          if (await sys.lstat(layout.refDir(uid, "attempt", ref))) {
            const ctx = port.contextFor("c", uid, ref, "attempt");
            try {
              ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir });
            } catch (e) {
              fail(`S8 gate stayed closed after killAll: ${(e as Error).message}`);
            }
          }
          break;
        }
        case "killDuringSpawn": {
          // S8: during a slow kill of this uid a spawn must be refused
          let release!: () => void;
          sys.stopGate = new Promise<void>((r) => (release = r));
          const killing = port.killAll(uid).catch(() => undefined);
          await sleep(3);
          if (await sys.lstat(layout.refDir(uid, "attempt", ref))) {
            const ctx = port.contextFor("c", uid, ref, "attempt");
            let threw = false;
            try {
              ctx.spawnAs({ file: "/bin/sleep", args: ["1"], env: {}, cwd: ctx.workDir });
            } catch {
              threw = true;
            }
            if (!threw) fail("S8 a spawn was accepted while a kill of its uid was in flight");
          }
          release();
          sys.stopGate = undefined;
          await killing;
          break;
        }
        case "clientDeath": {
          const u = pick(sys.activeUnits());
          if (u) u.clientExit(255, null);
          break;
        }
        case "endUnit": {
          const u = pick(sys.activeUnits());
          if (u) sys.endUnit(u, 0);
          break;
        }
        case "killChild": {
          const c = children.length ? pick(children) : undefined;
          c?.child.kill();
          break;
        }
        case "stray":
          sys.strays.set(5000 + i, uid);
          break;
        case "toggleLatency":
          sys.startLatencyMs = pick([0, 0, 12]);
          break;
        case "toggleFail": {
          const f = pick(["failRm", "failList", "startError", "immortal"] as const);
          if (f === "immortal") {
            const u = pick(sys.activeUnits());
            if (u) sys.immortal.add(u.name);
          } else sys[f] = !sys[f];
          break;
        }
      }
    } catch (e) {
      if ((e as Error).message.startsWith("seed ")) throw e;
      fail(`operation threw unexpectedly: ${(e as Error).message}`);
    }
    await sleep(1);
    checkAll(`step ${i} ${op}`);
  }

  // settle: remove every injected fault, then everything must be killable and wipeable
  sys.failRm = sys.failList = sys.startError = sys.rmNoop = false;
  sys.startLatencyMs = 0;
  sys.immortal.clear();
  sys.stopGate = undefined;
  await sleep(10);
  for (const uid of UIDS) {
    await port.killAll(uid).catch((e) => fail(`settle: killAll(${uid}) failed: ${(e as Error).message}`));
    if (sys.activeUnits(uid).length) fail(`settle: units left for ${uid}`);
    for (const ref of REFS) await port.wipeAttempt(uid, ref).catch((e) => fail(`settle: wipe failed: ${(e as Error).message}`));
    for (const h of HOMES) await port.wipeHome(uid, h).catch((e) => fail(`settle: wipeHome failed: ${(e as Error).message}`));
    const left = [...sys.tree.keys()].filter((p) => p.startsWith(layout.uidDir(uid) + "/") && /\/(attempts|homes)\/[^/]+/.test(p));
    if (left.length) fail(`settle: ${left.length} entries left under ${layout.uidDir(uid)}: ${left.slice(0, 3).join(",")}`);
  }
  checkAll("settle");
}

describe("SystemdUserFs: random operation sequences keep the safety invariants", () => {
  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))("seed %d", async (seed) => {
    await runSeed(seed);
  }, 30_000);
});
