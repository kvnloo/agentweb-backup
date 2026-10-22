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
  /** whether the service is running before the deploy (systemd ActiveState active / inactive) */
  active?: boolean;
  /** systemd's ActiveState when it is neither (e.g. "activating", "failed") */
  activeState?: string;
  /** what STATE_DIR/running-release holds (the release the host was last seen healthy on) */
  runningRelease?: string;
  /** the fake `acquire` blocks for this many seconds (for the signal test) */
  acquireSleep?: number;
  installRc?: number;
  /** exit code of `deployctl acquire` */
  acquireRc?: number;
  /** exit code of a SECOND `acquire` (the re-check right before the restart); default 0 */
  reacquireRc?: number;
  /** exit code of `install.sh --prepare` */
  prepareRc?: number;
  /** a hold file exists */
  hold?: boolean;
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
    writeFileSync(join(S, "state"), (sc.activeState ?? (sc.active === false ? "inactive" : "active")) + "\n");
    rmSync(join(dir, "state/running-release"), { force: true });
    writeFileSync(join(S, "acquire.sleep"), String(sc.acquireSleep ?? 0));
    writeFileSync(join(S, "install.rc"), String(sc.installRc ?? 0));
    writeFileSync(join(S, "prepare.rc"), String(sc.prepareRc ?? 0));
    writeFileSync(join(S, "reacquire.rc"), String(sc.reacquireRc ?? 0));
    writeFileSync(join(S, "info.drain"), "strict");
    rmSync(join(dir, "hold"), { force: true });
    rmSync(join(S, "acquired.flag"), { force: true });
    if (sc.hold) writeFileSync(join(dir, "hold"), "");
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
    if (sc.runningRelease !== undefined) writeFileSync(join(dir, "state/running-release"), `${sc.runningRelease}\n`);
    writeFileSync(join(pkg, "deployctl.js"), ""); // only the fake node reads its arguments
    // install.sh: logs, honours the scenario
    writeFileSync(
      join(pkg, "install.sh"),
      `#!/bin/bash
echo "install $*" >> "${dir}/calls.log"
if [ "\${1:-}" = "--rollback" ]; then exit "$(cat "${S}/rollback.rc")"; fi
if [ "\${1:-}" = "--prepare" ]; then exit "$(cat "${S}/prepare.rc")"; fi
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
if [ "$1" = "show" ]; then cat "${S}/state"; exit 0; fi
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
  acquire)
    sleep "$(cat "${S}/acquire.sleep")"
    if [ -f "${S}/acquired.flag" ]; then exit "$(cat "${S}/reacquire.rc")"; fi
    touch "${S}/acquired.flag"; exit "$(cat "${S}/acquire.rc")" ;;
  health)
    rc=$(head -n1 "${S}/health.rcs"); tail -n +2 "${S}/health.rcs" > "${S}/health.rcs.tmp"; mv "${S}/health.rcs.tmp" "${S}/health.rcs"
    exit "\${rc:-0}" ;;
  info) printf '{"protocol":2,"drain":"%s"}\\n' "$(cat "${S}/info.drain")"; exit 0 ;;
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
        AW_HOLD: join(dir, "hold"),
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

  it("an idle host: prepare (slow part) FIRST, then wait for idle, then install, restart, health, in that order; exit 0", () => {
    const r = run({});
    expect(r.rc).toBe(0);
    const calls = log();
    order(calls, "install --prepare", "ctl acquire", "install ", "systemctl restart", "ctl health");
    expect(calls.filter((c) => c === "install ")).toHaveLength(1);
    expect(restarts(calls)).toBe(1);
    expect(r.out).toContain("OK   deployed");
  });

  it("the slow prepare happens BEFORE the drain, so downloads never run while the host refuses customers' work", () => {
    run({});
    const calls = log();
    expect(calls.indexOf("install --prepare")).toBeLessThan(calls.findIndex((c) => c.startsWith("ctl acquire")));
  });

  it("passes the wait limit and a drain lifetime that covers only the switch, restart and health check", () => {
    run({}, ["--max-wait", "600"]);
    expect(log()).toContain("ctl acquire --total 600 --strict-ttl 300");
  });

  it("NOT idle within the limit: NOTHING has changed (the real install never ran) and nothing is restarted; exit 75, not a failure", () => {
    const r = run({ acquireRc: 75 });
    expect(r.rc).toBe(75);
    const calls = log();
    expect(restarts(calls)).toBe(0); // the protected ACTION did not happen
    expect(calls.filter((c) => c.startsWith("install"))).toEqual(["install --prepare"]); // only the harmless part ran
    expect(calls.some((c) => c.startsWith("ctl health"))).toBe(false);
    expect(r.out).toContain("NOT DEPLOYED");
  });

  it("the drain lapsed before the restart and the host is busy again: undo the switch, restart NOTHING, exit 75", () => {
    const r = run({ reacquireRc: 75 });
    expect(r.rc).toBe(75);
    expect(restarts(log())).toBe(0);
    order(log(), "install ", "ctl acquire --total 300", "install --rollback");
    expect(r.out).toContain("became busy again");
  });

  it("the drain lapsed but the host is idle again: it is taken again and the deploy goes on", () => {
    const r = run({ reacquireRc: 0 });
    expect(r.rc).toBe(0);
    expect(restarts(log())).toBe(1);
    expect(log().filter((c) => c.startsWith("ctl acquire"))).toHaveLength(2);
  });

  it("a running host that predates the drain protocol is not gated, not touched, and reported (76) for a one-time forced bootstrap", () => {
    const r = run({ acquireRc: 76 });
    expect(r.rc).toBe(76);
    expect(log().some((c) => c === "install " || c.startsWith("systemctl restart"))).toBe(false);
    expect(r.out).toContain("one-time bootstrap");
  });

  it("an idle gate that FAILS (not just 'busy') changes and restarts nothing, lifts any drain it may have taken, and exits 22", () => {
    const r = run({ acquireRc: 1 });
    expect(r.rc).toBe(22);
    expect(log().some((c) => c === "install " || c.startsWith("systemctl restart"))).toBe(false);
    expect(log()).toContain("ctl release ");
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

  it("a host that is not running has nobody to protect: prepare, install, start it, check it, no gate", () => {
    const r = run({ active: false });
    expect(r.rc).toBe(0);
    expect(log().some((c) => c.startsWith("ctl acquire"))).toBe(false);
    expect(restarts(log())).toBe(1);
  });

  it("a failed prepare changes nothing, restarts nothing and takes no drain; exit 22", () => {
    const r = run({ prepareRc: 1 });
    expect(r.rc).toBe(22);
    expect(log().filter((c) => !/^systemctl (is-active|show)/.test(c))).toEqual(["install --prepare"]);
  });

  it("a prepare refused for want of a bridge URL (exit 3) is passed through before anything else", () => {
    const r = run({ prepareRc: 3 });
    expect(r.rc).toBe(3);
    expect(log().filter((c) => !/^systemctl (is-active|show)/.test(c))).toEqual(["install --prepare"]);
  });

  it("a failed install restarts nothing, lifts the drain it took, and exits 22", () => {
    const r = run({ installRc: 1 });
    expect(r.rc).toBe(22);
    const calls = log().filter((c) => !/^systemctl (is-active|show)/.test(c));
    expect(calls).toEqual(["install --prepare", "ctl acquire --total 1800 --strict-ttl 300", "install ", "ctl release "]);
  });

  it("an install that fails AFTER switching the active release puts the old one back (the old host is still running on it)", () => {
    const r = run({ installRc: 1, installMovesCurrent: true });
    expect(r.rc).toBe(22);
    order(log(), "install ", "install --rollback", "ctl release");
    expect(restarts(log())).toBe(0);
  });

  it("an identical build (the installer changes nothing) restarts nothing and lifts the drain at once", () => {
    const r = run({ activeBefore: true, runningRelease: "releases/old" });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("nothing to restart");
    expect(restarts(log())).toBe(0);
    expect(log()).toContain("ctl release ");
  });

  it("an identical build is NOT skipped when the host was never seen healthy on that release (a deploy killed half-way left `current` ahead of what runs): it is restarted behind the gate", () => {
    for (const runningRelease of [undefined, "releases/some-older-one"]) {
      const r = run({ activeBefore: true, runningRelease });
      expect(r.rc).toBe(0);
      expect(r.out).not.toContain("nothing to restart");
      expect(restarts(log())).toBe(1);
      order(log(), "ctl acquire", "systemctl restart", "ctl health");
    }
  });

  it("after a healthy start the release the host runs is recorded (so the next identical deploy can be believed)", () => {
    run({ activeBefore: true });
    expect(readFileSync(join(dir, "state/running-release"), "utf8").trim()).toBe("releases/old");
  });

  it("systemd's own state decides whether anyone needs protecting: a unit that is `activating` (starting or auto-restarting) goes through the gate; only inactive/failed skips it", () => {
    expect(run({ activeState: "activating" }).rc).toBe(0);
    expect(log().some((c) => c.startsWith("ctl acquire"))).toBe(true);
    for (const st of ["inactive", "failed"]) {
      run({ activeState: st });
      expect({ st, gated: log().some((c) => c.startsWith("ctl acquire")) }).toEqual({ st, gated: false });
    }
  });

  it("the rollback restart is also asked to wait briefly for a quiet moment (a failing new build may have admitted turns in its minute)", () => {
    run({ health: [1, 0] });
    order(log(), "systemctl restart", "install --rollback", "ctl info", "ctl acquire --total 20", "systemctl restart");
  });

  it("a SIGTERM (an SSM cancel) is mapped to 22 'not restarted' and lifts the drain, instead of leaving the script with an unreadable status", async () => {
    const child = (() => {
      // run() is synchronous; build the same scenario by hand and send the signal while the (slow) fake gate is running
      run({ acquireSleep: 0 }); // lays out the scratch files; discarded below
      writeFileSync(join(dir, "scen/acquire.sleep"), "2");
      writeFileSync(join(dir, "calls.log"), "");
      rmSync(join(dir, "scen/acquired.flag"), { force: true });
      rmSync(join(dir, "state/deployed-build-seq"), { force: true });
      return spawn("bash", [join(dir, "pkg/deploy.sh")], {
        env: { PATH: process.env.PATH ?? "", AW_SYSTEMCTL: join(dir, "bin/systemctl"), AW_SOCK: join(dir, "host.sock"), AW_DEPLOY_LOCK: join(dir, "lockdir/deploy.lock"), AW_NODE: join(dir, "bin/node"), AW_OPT: join(dir, "opt"), AW_STATE_DIR: join(dir, "state"), AW_HOLD: join(dir, "hold"), AW_HEALTH_TIMEOUT: "5" },
      });
    })();
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 700));
    child.kill("SIGTERM");
    const rc = await new Promise<number | null>((r) => child.on("close", r));
    expect(rc).toBe(22);
    expect(out).toContain("UNEXPECTED FAILURE");
    expect(restarts(log())).toBe(0);
    expect(log()).toContain("ctl release ");
  }, 20_000);

  it("a successful restart does not leave a stale release call behind (the restart cleared the drain)", () => {
    run({});
    expect(log()).not.toContain("ctl release ");
  });

  it("clears a start-limit failure before restarting (a crash loop must not block the deploy that fixes it)", () => {
    run({});
    order(log(), "systemctl reset-failed", "systemctl restart");
  });

  it("a hold file stops every deploy before it does anything (the 'do not touch the worker' kill-switch)", () => {
    const r = run({ hold: true });
    expect(r.rc).toBe(22);
    expect(r.out).toContain("HELD");
    expect(log().filter((c) => !/^systemctl (is-active|show)/.test(c))).toEqual([]);
  });

  it("an UNEXPECTED failure before the restart (here: the lock directory cannot be created) is 22 'host not restarted', never a build outcome like 1 or 2", () => {
    writeFileSync(join(dir, "afile"), "x");
    const r = run({}, [], { AW_DEPLOY_LOCK: join(dir, "afile/sub/deploy.lock") });
    expect(r.rc).toBe(22);
    expect(r.out).toContain("UNEXPECTED FAILURE");
    expect(restarts(log())).toBe(0);
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

    it("refuses a build with a LOWER number than the one deployed: exit 4, and NOTHING runs (not even prepare or the gate)", () => {
      const r = run({ buildSeq: 99, lastDeployedSeq: 100 });
      expect(r.rc).toBe(4);
      expect(log().filter((c) => !/^systemctl (is-active|show)/.test(c))).toEqual([]);
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
    it("a build with no pipeline number is exit 5 (a different outcome from 'older'), and a committer date cannot stand in for it", () => {
      const r = run({ buildSeq: null });
      expect(r.rc).toBe(5);
      expect(log().filter((c) => !/^systemctl (is-active|show)/.test(c))).toEqual([]);
      expect(run({ buildSeq: null }, ["--allow-older"]).rc).toBe(0);
    });
    it("a number that is not plain digits, or too long to compare safely, is exit 5, not a silently skipped check", () => {
      expect(run({ buildSeq: "99999999999999999999" as unknown as number, lastDeployedSeq: 5 }).rc).toBe(5);
      expect(run({ buildSeq: "12abc" as unknown as number }).rc).toBe(5);
      expect(run({ buildSeq: "-5" as unknown as number }).rc).toBe(5);
    });
  });

  it("refuses a nonsense wait limit, one over 3000 s, and unknown arguments, before doing anything", () => {
    expect(run({}, ["--max-wait", "soon"]).rc).toBe(22);
    expect(log()).toEqual([]);
    expect(run({}, ["--max-wait", "3001"]).rc).toBe(22);
    expect(run({}, ["--max-wait", "3000"]).rc).toBe(0);
    expect(run({}, ["--yolo"]).rc).toBe(22); // (2 would read as 'the host is DOWN')
  });

  it("parses and is strict", () => {
    expect(spawnSync("bash", ["-n", DEPLOY_SH]).status).toBe(0);
    expect(readFileSync(DEPLOY_SH, "utf8")).toMatch(/^set -euo pipefail$/m);
  });
});
