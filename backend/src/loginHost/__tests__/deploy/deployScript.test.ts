/**
 * ENG-2110: deploy.sh, the automatic worker deploy. What matters is the ORDER and what is NOT done:
 *   a busy host is never restarted; a bad build is rolled back; a host that is down is reported; nothing runs twice at once.
 * The real script runs in a scratch directory in TEST MODE (`.aw-test-mode`, never in a tarball) with fake `systemctl`, `install.sh` and `node`
 * that write every call to a log, so each branch is observable. The real gate logic is tested in drainGate.test.ts, the real install.sh in
 * installScripts.test.ts.
 */
import { spawn, spawnSync } from "child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DEPLOY_SH = join(__dirname, "../../deploy/prod/deploy.sh");

interface Scenario {
  /** `systemctl is-active` result for the service before the deploy. */
  active?: boolean;
  installRc?: number;
  /** exit code of `deployctl acquire` */
  acquireRc?: number;
  /** results of successive `deployctl health` calls (exit codes); default all healthy */
  health?: number[];
  rollbackRc?: number;
  hasPrevious?: boolean;
  /** the active release symlink already exists, and the (fake) installer does not change it: an identical build */
  activeBefore?: boolean;
  /** the (fake) installer switches the active release and then fails */
  installMovesCurrent?: boolean;
  /** the build's build_seq in its MANIFEST (null = the line is absent, as in a hand-made build) */
  buildSeq?: number | null;
  /** the build_seq of the build the worker last finished deploying */
  lastDeployedSeq?: number;
}

describe("deploy.sh", () => {
  let dir: string;
  const log = () => readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-sh-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(sc: Scenario, args: string[] = [], extraEnv: Record<string, string> = {}) {
    const S = join(dir, "scen");
    mkdirSync(S, { recursive: true });
    mkdirSync(join(dir, "opt"), { recursive: true });
    rmSync(join(dir, "opt/previous"), { force: true });
    rmSync(join(dir, "opt/current"), { force: true });
    if (sc.activeBefore || sc.installMovesCurrent) symlinkSync("releases/old", join(dir, "opt/current"));
    if (sc.hasPrevious !== false) symlinkSync("releases/old", join(dir, "opt/previous"));
    writeFileSync(join(S, "active"), sc.active === false ? "1" : "0");
    writeFileSync(join(S, "install.rc"), String(sc.installRc ?? 0));
    writeFileSync(join(S, "acquire.rc"), String(sc.acquireRc ?? 0));
    writeFileSync(join(S, "health.rcs"), (sc.health ?? [0, 0, 0, 0]).join("\n") + "\n");
    writeFileSync(join(S, "rollback.rc"), String(sc.rollbackRc ?? 0));
    writeFileSync(join(dir, "calls.log"), "");

    const pkg = join(dir, "pkg");
    mkdirSync(pkg, { recursive: true });
    copyFileSync(DEPLOY_SH, join(pkg, "deploy.sh"));
    chmodSync(join(pkg, "deploy.sh"), 0o755);
    writeFileSync(join(pkg, ".aw-test-mode"), "");
    writeFileSync(join(pkg, "MANIFEST"), `name=x\ncommit_time=2026-10-22T10:00:00Z\n${sc.buildSeq === null ? "" : `build_seq=${sc.buildSeq ?? 100}\n`}`);
    mkdirSync(join(dir, "state"), { recursive: true });
    rmSync(join(dir, "state/deployed-build-seq"), { force: true });
    if (sc.lastDeployedSeq !== undefined) writeFileSync(join(dir, "state/deployed-build-seq"), `${sc.lastDeployedSeq}\n`);
    writeFileSync(join(pkg, "deployctl.js"), ""); // only the fake node reads its arguments
    // install.sh: logs, honours the scenario
    writeFileSync(
      join(pkg, "install.sh"),
      `#!/bin/bash
echo "install $*" >> "${dir}/calls.log"
if [ "\${1:-}" = "--rollback" ]; then exit "$(cat "${S}/rollback.rc")"; fi
${sc.installMovesCurrent ? `ln -sfn releases/new "${dir}/opt/current"` : ""}
exit "$(cat "${S}/install.rc")"
`,
    );
    chmodSync(join(pkg, "install.sh"), 0o755);
    // systemctl: logs, is-active from the scenario
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "systemctl"),
      `#!/bin/bash
echo "systemctl $*" >> "${dir}/calls.log"
if [ "$1" = "is-active" ]; then exit "$(cat "${S}/active")"; fi
exit 0
`,
    );
    // node (the deployctl bundle): $1 = deployctl.js, $2 = socket, $3 = command
    writeFileSync(
      join(bin, "node"),
      `#!/bin/bash
shift 2
cmd=$1; shift
echo "ctl $cmd $*" >> "${dir}/calls.log"
case "$cmd" in
  acquire) exit "$(cat "${S}/acquire.rc")" ;;
  health)
    rc=$(head -n1 "${S}/health.rcs"); tail -n +2 "${S}/health.rcs" > "${S}/health.rcs.tmp"; mv "${S}/health.rcs.tmp" "${S}/health.rcs"
    exit "\${rc:-0}" ;;
  info) echo '{"protocol":2}'; exit 0 ;;
esac
exit 0
`,
    );
    for (const f of ["systemctl", "node"]) chmodSync(join(bin, f), 0o755);

    const r = spawnSync("bash", [join(pkg, "deploy.sh"), ...args], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        AW_SYSTEMCTL: join(bin, "systemctl"),
        AW_SOCK: join(dir, "host.sock"),
        AW_DEPLOY_LOCK: join(dir, "lockdir/deploy.lock"),
        AW_NODE: join(bin, "node"),
        AW_OPT: join(dir, "opt"),
        AW_STATE_DIR: join(dir, "state"),
        AW_HEALTH_TIMEOUT: "5",
        ...extraEnv,
      },
      timeout: 30_000,
    });
    return { rc: r.status, out: r.stdout + r.stderr };
  }
  const order = (calls: string[], ...needles: string[]) => {
    // each needle must occur AFTER the previous one (the same text may legitimately occur more than once)
    let from = 0;
    for (const n of needles) {
      const i = calls.slice(from).findIndex((c) => c.includes(n));
      expect({ needle: n, found: i >= 0 }).toEqual({ needle: n, found: true });
      from += i + 1;
    }
  };
  const restarts = (calls: string[]) => calls.filter((c) => c.startsWith("systemctl restart")).length;

  it("an idle host: wait for idle FIRST, then install, restart, health, in that order; exit 0", () => {
    const r = run({});
    expect(r.rc).toBe(0);
    const calls = log();
    order(calls, "ctl acquire", "install ", "systemctl restart", "ctl health");
    expect(calls.filter((c) => c === "install ")).toHaveLength(1);
    expect(restarts(calls)).toBe(1);
    expect(r.out).toContain("OK   deployed");
  });

  it("passes the wait limit and a strict-drain lifetime that covers the install to the gate", () => {
    run({}, ["--max-wait", "600"]);
    expect(log()).toContain("ctl acquire --total 600 --strict-ttl 900");
  });

  it("NOT idle within the limit: NOTHING has changed (the installer never ran) and nothing is restarted; exit 75, not a failure", () => {
    const r = run({ acquireRc: 75 });
    expect(r.rc).toBe(75);
    const calls = log();
    expect(restarts(calls)).toBe(0); // the protected ACTION did not happen
    expect(calls.some((c) => c.startsWith("install"))).toBe(false); // so nothing on disk moved under the running host
    expect(calls.some((c) => c.startsWith("ctl health"))).toBe(false);
    expect(r.out).toContain("NOT DEPLOYED");
  });

  it("a running host that predates the drain protocol is not gated, not touched, and reported (76) for a one-time forced bootstrap", () => {
    const r = run({ acquireRc: 76 });
    expect(r.rc).toBe(76);
    expect(log().some((c) => c.startsWith("install") || c.startsWith("systemctl restart"))).toBe(false);
    expect(r.out).toContain("one-time bootstrap");
  });

  it("an idle gate that FAILS (not just 'busy') changes and restarts nothing; exit 22", () => {
    const r = run({ acquireRc: 1 });
    expect(r.rc).toBe(22);
    expect(log().some((c) => c.startsWith("install") || c.startsWith("systemctl restart"))).toBe(false);
  });

  it("--force skips the gate (and says so), installs, restarts and still checks health", () => {
    const r = run({}, ["--force"]);
    expect(r.rc).toBe(0);
    expect(log().some((c) => c.startsWith("ctl acquire"))).toBe(false);
    expect(restarts(log())).toBe(1);
    expect(r.out).toContain("FORCE");
  });

  it("an unhealthy new build is rolled back and the old one checked with ITS protocol version; exit 1", () => {
    const r = run({ health: [1, 0] });
    expect(r.rc).toBe(1);
    const calls = log();
    order(calls, "systemctl restart", "ctl health --timeout 5", "install --rollback", "systemctl restart", "ctl health --timeout 5 --any-protocol");
    expect(restarts(calls)).toBe(2);
    expect(r.out).toContain("ROLLED BACK");
  });

  it("a build that is bad AND whose rollback is bad is reported as DOWN (exit 2)", () => {
    const r = run({ health: [1, 1] });
    expect(r.rc).toBe(2);
    expect(r.out).toContain("DOWN");
  });

  it("a rollback that cannot even be installed is DOWN too", () => {
    expect(run({ health: [1], rollbackRc: 1 }).rc).toBe(2);
  });

  it("no previous release: a bad build reports DOWN instead of pretending to roll back", () => {
    const r = run({ health: [1], hasPrevious: false });
    expect(r.rc).toBe(2);
    expect(log()).not.toContain("install --rollback");
  });

  it("a host that is not running has nobody to protect: no gate, install, start it, check it", () => {
    const r = run({ active: false });
    expect(r.rc).toBe(0);
    expect(log().some((c) => c.startsWith("ctl acquire"))).toBe(false);
    expect(restarts(log())).toBe(1);
  });

  it("a failed install restarts nothing, lifts the drain it took, and exits 22", () => {
    const r = run({ installRc: 1 });
    expect(r.rc).toBe(22);
    const calls = log().filter((c) => !c.startsWith("systemctl is-active"));
    expect(calls).toEqual(["ctl acquire --total 1800 --strict-ttl 900", "install ", "ctl release "]);
  });

  it("an install that fails AFTER switching the active release puts the old one back (the old host is still running on it)", () => {
    const r = run({ installRc: 1, installMovesCurrent: true });
    expect(r.rc).toBe(22);
    order(log(), "install ", "install --rollback", "ctl release");
    expect(restarts(log())).toBe(0);
  });

  it("an install that is refused for want of a bridge URL (exit 3) is passed through, nothing is restarted, the drain is lifted", () => {
    const r = run({ installRc: 3 });
    expect(r.rc).toBe(3);
    expect(restarts(log())).toBe(0);
    expect(log()).toContain("ctl release ");
  });

  it("an identical build (the installer changes nothing) restarts nothing and lifts the drain at once", () => {
    const r = run({ activeBefore: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("nothing to restart");
    expect(restarts(log())).toBe(0);
    expect(log()).toContain("ctl release ");
  });

  it("a successful restart does not leave a stale release call behind (the restart cleared the drain)", () => {
    run({});
    expect(log()).not.toContain("ctl release ");
  });

  it("clears a start-limit failure before restarting (a crash loop must not block the deploy that fixes it)", () => {
    run({});
    order(log(), "systemctl reset-failed", "systemctl restart");
  });

  it("two deploys never run at once, and the lock lives in a root-only directory", async () => {
    mkdirSync(join(dir, "lockdir"), { recursive: true });
    const lock = join(dir, "lockdir/deploy.lock");
    const holder = spawn("bash", ["-c", `exec 8>"${lock}"; flock 8; sleep 5`]);
    await new Promise((r) => setTimeout(r, 300));
    const r = run({});
    holder.kill();
    expect(r.rc).toBe(22);
    expect(r.out).toContain("another deploy is running");
    expect(restarts(log())).toBe(0);
  });

  it("creates the lock directory root-only when it does not exist", () => {
    run({});
    expect(statSync(join(dir, "lockdir")).mode & 0o777).toBe(0o700);
  });

  describe("no downgrades (a validly signed OLD build is still a downgrade)", () => {
    const recorded = () => {
      try {
        return Number(readFileSync(join(dir, "state/deployed-build-seq"), "utf8"));
      } catch {
        return undefined;
      }
    };

    it("refuses a build with a LOWER number than the one deployed: exit 4, and NOTHING runs (not even the gate or installer)", () => {
      const r = run({ buildSeq: 99, lastDeployedSeq: 100 });
      expect(r.rc).toBe(4);
      expect(log().filter((c) => !c.startsWith("systemctl is-active"))).toEqual([]);
      expect(r.out).toContain("REFUSED");
      expect(recorded()).toBe(100);
    });
    it("accepts the same number again (a redeploy) and a higher one, and records it only AFTER the host is healthy", () => {
      expect(run({ buildSeq: 100, lastDeployedSeq: 100 }).rc).toBe(0);
      expect(run({ buildSeq: 100, lastDeployedSeq: 50 }).rc).toBe(0);
      expect(recorded()).toBe(100);
    });
    it("first ever deploy records its number", () => {
      expect(run({}).rc).toBe(0);
      expect(recorded()).toBe(100);
    });
    it("a failed, rolled-back or not-idle deploy does not move the mark forward", () => {
      expect(run({ lastDeployedSeq: 50, health: [1, 0] }).rc).toBe(1);
      expect(recorded()).toBe(50);
      expect(run({ lastDeployedSeq: 50, acquireRc: 75 }).rc).toBe(75);
      expect(recorded()).toBe(50);
    });
    it("the mark never moves backwards, even with --allow-older", () => {
      expect(run({ buildSeq: 100, lastDeployedSeq: 500 }, ["--allow-older"]).rc).toBe(0);
      expect(recorded()).toBe(500);
    });
    it("--allow-older lets a person step back on purpose", () => {
      expect(run({ buildSeq: 99, lastDeployedSeq: 100 }, ["--allow-older"]).rc).toBe(0);
    });
    it("a build with no pipeline number (hand-made) is refused, and a git committer date cannot stand in for it", () => {
      expect(run({ buildSeq: null }).rc).toBe(4);
      expect(log().filter((c) => !c.startsWith("systemctl is-active"))).toEqual([]);
      expect(run({ buildSeq: null }, ["--allow-older"]).rc).toBe(0);
    });
  });

  it("refuses a nonsense wait limit and unknown arguments before doing anything", () => {
    expect(run({}, ["--max-wait", "soon"]).rc).toBe(22);
    expect(log()).toEqual([]);
    expect(run({}, ["--yolo"]).rc).toBe(2);
  });

  it("parses and is strict", () => {
    expect(spawnSync("bash", ["-n", DEPLOY_SH]).status).toBe(0);
    expect(readFileSync(DEPLOY_SH, "utf8")).toMatch(/^set -euo pipefail$/m);
  });
});
