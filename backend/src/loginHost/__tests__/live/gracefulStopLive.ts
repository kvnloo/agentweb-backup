/**
 * ENG-2113 PR H: MANUAL live proof, on the test instance and with NO login, that the REAL port (SystemdUserFs, real systemd-run units
 * with the real hardened unit properties, as a real customer uid) stops customer processes GRACEFULLY and that a HARD kill is really hard.
 * The "customer process" is a shell script that behaves like the CLI around a login write: on SIGTERM it needs a second to finish
 * writing a marker file (the refreshed login), then exits.
 *
 *   G1  child.kill()  (what Stop / a deadline / the end of a turn does): the marker IS written, the unit is gone within ~3 s
 *   G2  child.kill() on a process that IGNORES SIGTERM: the unit is gone after the grace period (SIGKILL), no marker
 *   G3  port.killAll(uid) (default, graceful: disable, reconnect, host stop): marker written
 *   G3b port.killAll(uid) on a process that ignores SIGTERM: gone after the grace period
 *   G4  port.killAll(uid, {hard:true}) (revoke, hazard alarm): marker NOT written, gone within ~3 s
 *   G5  no unit of the uid is left after each case
 *
 *   sudo node gracefulStopLive.js        (the host aw-login-host@test1 may keep running: this script runs its own proxy and uses a spare uid)
 */
import { execFileSync } from "child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { parseHostConfig } from "../../host/hostConfig";
import { startEgressProxy, type EgressProxyHandle } from "../../egress/egressProxy";
import { bridgeTarget, layoutFor, portConfigFor } from "../../host/main";
import { nodeCommandPort, nodeRootFs } from "../../ports/system";
import { SystemdUserFs } from "../../ports/systemdUserFs";

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const cfg = parseHostConfig(JSON.parse(readFileSync(process.env.AW_HOST_CONFIG ?? "/etc/aw-login-host/test1.json", "utf8")));
const layout = layoutFor(cfg);
const UID = cfg.uidMax - 6; // a spare uid at the top of the range
const PROBE_DIR = "/run/aw-egress-gstop";
const GRACE_MS = cfg.limits.stopGraceSec * 1000;
let proxy: EgressProxyHandle | undefined;
let port: SystemdUserFs;
let n = 0;

interface Started {
  exited: Promise<number>; // ms from the stop request until the exit callback (resolved only after kickoff())
  kickoff: (how: (child: { kill(): void }) => void | Promise<void>) => void;
  marker: () => boolean;
  /** Resolves when the stop call itself has returned (the uid is gated until then: nothing new may start). */
  settled: () => Promise<void>;
}

/** Starts a customer unit running `body`, waits until it is really running, and returns hooks to stop it and time the exit. */
async function start(body: string): Promise<Started> {
  const ref = `att-${++n}`;
  await port.createAttemptDir(UID, ref);
  const ctx = port.contextFor("gstop", UID, ref, "attempt");
  const started = `${ctx.workDir}/started`;
  const marker = `${ctx.workDir}/marker`;
  const script = `${ctx.workDir}/run.sh`;
  writeFileSync(script, `#!/bin/sh\n${body.split("STARTED").join(started).split("MARKER").join(marker)}\n`);
  chmodSync(script, 0o700);
  chownSync(script, UID, UID);
  const child = ctx.spawnAs({ file: "/bin/sh", args: [script], env: { PATH: "/usr/bin:/bin" }, cwd: ctx.workDir });
  let t0 = 0;
  let done: Promise<void> = Promise.resolve();
  let resolveExit!: (ms: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  child.onExit(() => resolveExit(Date.now() - t0));
  const deadline = Date.now() + 15_000;
  while (!existsSync(started)) {
    if (Date.now() > deadline) throw new Error("the customer process did not start");
    await sleep(100);
  }
  return {
    exited,
    kickoff: (how) => {
      t0 = Date.now();
      done = Promise.resolve(how(child)).then(
        () => undefined,
        () => undefined,
      );
    },
    marker: () => existsSync(marker),
    settled: () => done,
  };
}

const unitsLeft = (): number => {
  const out = execFileSync("/usr/bin/systemctl", ["list-units", "--all", "--no-legend", "--plain", layout.unitPattern(UID)], { encoding: "utf8" });
  return out.split("\n").filter((l) => /\b(active|activating|deactivating)\b/.test(l)).length;
};

const FLUSH = `trap 'sleep 1; echo flushed > MARKER; exit 0' TERM
echo up > STARTED
while :; do sleep 0.2; done`;
const IGNORE = `trap '' TERM
echo up > STARTED
while :; do sleep 0.2; done`;

async function main() {
  if (existsSync(layout.uidDir(UID))) throw new Error(`refusing: uid ${UID} already has a directory (in use by the host?)`);
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true, mode: 0o755 });
  proxy = await startEgressProxy({
    perUid: { dir: PROBE_DIR, max: 8, ownByUid: true },
    allow: cfg.egress.allow,
    bridge: bridgeTarget(cfg.claude.bridgeUrl),
    logger: { warn: () => undefined },
  });
  port = new SystemdUserFs({ layout, cmd: nodeCommandPort, root: nodeRootFs, config: portConfigFor(cfg, { current: proxy }) });
  console.log(`grace period configured: ${GRACE_MS} ms`);

  // G1: the runner's own stop path (child.kill -> killUnit): a process that needs a moment to finish its write
  let s = await start(FLUSH);
  s.kickoff((child) => child.kill());
  let ms = await s.exited;
  await s.settled();
  check("G1 child.kill(): the process finished writing its marker before it was killed (graceful)", s.marker(), `${ms} ms`);
  check("G1 ...and the unit was gone within ~3 s (a clean exit does not wait out the grace period)", ms < 3_500, `${ms} ms`);
  check("G5 no unit left", unitsLeft() === 0);

  // G2: a process that ignores SIGTERM is killed at the grace period
  s = await start(IGNORE);
  s.kickoff((child) => child.kill());
  ms = await s.exited;
  await s.settled();
  check("G2 child.kill() on a process that ignores SIGTERM: SIGKILL after the grace period", ms >= GRACE_MS - 1_500 && ms <= GRACE_MS + 6_000, `${ms} ms vs grace ${GRACE_MS} ms`);
  check("G2 no marker (it never got to flush)", !s.marker());
  check("G5 no unit left", unitsLeft() === 0);

  // G3: killAll default is graceful too (disable, reconnect, host shutdown)
  s = await start(FLUSH);
  s.kickoff(() => port.killAll(UID));
  ms = await s.exited;
  await s.settled();
  check("G3 killAll(uid) default: the marker was written (graceful)", s.marker(), `${ms} ms`);
  check("G5 no unit left", unitsLeft() === 0);
  s = await start(IGNORE);
  s.kickoff(() => port.killAll(UID));
  ms = await s.exited;
  await s.settled();
  check("G3b killAll(uid) on a process that ignores SIGTERM: gone after the grace period", ms >= GRACE_MS - 1_500 && ms <= GRACE_MS + 8_000, `${ms} ms vs grace ${GRACE_MS} ms`);
  check("G5 no unit left", unitsLeft() === 0);

  // G4: a hard kill does not wait and does not let the process flush
  s = await start(FLUSH);
  s.kickoff(() => port.killAll(UID, { hard: true }));
  ms = await s.exited;
  await s.settled();
  check("G4 hard kill (revoke / alarm): the process is gone at once", ms < 3_500, `${ms} ms`);
  check("G4 ...and was NOT given the time to flush (no marker): a hard kill is really hard", !s.marker());
  check("G5 no unit left", unitsLeft() === 0);
}

main()
  .catch((e) => check("runner", false, String((e as Error).message).slice(0, 200)))
  .finally(async () => {
    try {
      await port?.killAll(UID, { hard: true });
    } catch {
      /* nothing to stop */
    }
    await proxy?.close().catch(() => undefined);
    rmSync(PROBE_DIR, { recursive: true, force: true });
    try {
      execFileSync("/usr/bin/systemctl", ["stop", layout.sliceName(UID)], { stdio: "ignore" });
    } catch {
      /* nothing to stop */
    }
    rmSync(layout.uidDir(UID), { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
