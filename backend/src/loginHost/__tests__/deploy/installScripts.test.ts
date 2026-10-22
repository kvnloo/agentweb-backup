/**
 * ENG-2110 PR 3: guards on the production deploy tooling (install.sh + lib.sh, the build script, pinned versions, the config template).
 * These scripts run as root on the machine that holds customers' Claude logins and can format a disk, so what matters is EXECUTED, not grepped:
 *   - lib.sh (disk classification, fstab edit, quota check, TLS validation, address rules) is driven with fake tools first on PATH and the REAL openssl;
 *   - install.sh's whole release machinery (stage -> validate -> switch -> prune, rollback, "a failure never touches a healthy host") runs in a scratch
 *     directory in TEST MODE against a REAL build tarball (a `.aw-test-mode` marker file redirects the paths and fakes the tools; it is never in a tarball).
 * Anything that needs root (the loop-device disk self-test) is run by hand on the test instance and reported in the PR.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseHostConfig } from "../../host/hostConfig";

const BACKEND = join(__dirname, "../../../..");
const DEPLOY = join(BACKEND, "src/loginHost/deploy");
const PROD = join(DEPLOY, "prod");
const TLS = join(__dirname, "../fixtures/tls");
const WORKER_CERT = join(__dirname, "fixtures/worker-server.pem");
const SCRIPTS = {
  "prod/install.sh": join(PROD, "install.sh"),
  "prod/deploy.sh": join(PROD, "deploy.sh"),
  "prod/lib.sh": join(PROD, "lib.sh"),
  "build-login-host.sh": join(BACKEND, "scripts/build-login-host.sh"),
  "aw-net.sh": join(DEPLOY, "aw-net.sh"),
  "claude-turn.sh": join(DEPLOY, "claude-turn.sh"),
  "aw-write-file.sh": join(DEPLOY, "aw-write-file.sh"),
  "install-test-host.sh": join(DEPLOY, "install-test-host.sh"),
};
const text = (p: string) => readFileSync(p, "utf8");
const install = text(SCRIPTS["prod/install.sh"]);
const lib = text(SCRIPTS["prod/lib.sh"]);
const build = text(SCRIPTS["build-login-host.sh"]);
const unit = text(join(DEPLOY, "aw-login-host@.service"));
const versions = Object.fromEntries(
  text(join(PROD, "versions.env"))
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const sh = (cmd: string, env: Record<string, string> = {}, opts: { cwd?: string; input?: string } = {}): SpawnSyncReturns<string> =>
  spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: { ...process.env, ...env }, cwd: opts.cwd, input: opts.input, timeout: 120_000 });

// ───────────────────────────── static guards ─────────────────────────────

describe("deploy scripts: static guards", () => {
  it.each(Object.entries(SCRIPTS))("%s parses (bash -n)", (_name, path) => {
    const r = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  const shellcheckAvailable = spawnSync("shellcheck", ["--version"]).status === 0;
  if (shellcheckAvailable) {
    it("the production scripts are shellcheck-clean (errors and warnings)", () => {
      const r = spawnSync("shellcheck", ["-S", "warning", "-x", "-e", "SC1091", "-e", "SC2154", SCRIPTS["prod/install.sh"], SCRIPTS["prod/deploy.sh"], SCRIPTS["prod/lib.sh"], SCRIPTS["build-login-host.sh"]], { encoding: "utf8" });
      expect(r.stdout).toBe("");
      expect(r.status).toBe(0);
    });
  } else if (process.env.CI) {
    it("shellcheck must be installed when CI is set (a skipped lint is not a pass in CI)", () => {
      throw new Error("shellcheck is not installed but CI=1: install it so the deploy scripts are linted");
    });
  } else {
    console.warn("SKIPPED shellcheck: the `shellcheck` binary is not installed here (it is REQUIRED when CI=1). The scripts are still syntax-checked and executed by the tests below.");
    it.skip("the production scripts are shellcheck-clean (SKIPPED: shellcheck not installed; required when CI=1)", () => undefined);
  }

  it("install.sh, lib.sh and the build script are strict (set -euo pipefail where they are entry points)", () => {
    expect(install).toMatch(/^set -euo pipefail$/m);
    expect(build).toMatch(/^set -euo pipefail$/m);
    expect(install).toMatch(/^umask 022$/m);
  });

  it("no script pipes a download into a shell (no `curl | sh`, no `wget -O- | bash`)", () => {
    for (const [name, p] of Object.entries(SCRIPTS)) {
      expect({ name, bad: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(text(p)) }).toEqual({ name, bad: false });
    }
  });

  it("downloads are https-only with a verified hash before use (the only plain-http URL is the instance metadata service)", () => {
    expect(install).toContain("--proto '=https'");
    expect(install).toMatch(/sha256sum "\$tmpd\/node\.tar\.xz"[\s\S]*NODE_TARBALL_SHA256/);
    expect(install).toMatch(/CLAUDE_TARBALL_INTEGRITY/);
    expect(install).toMatch(/CLAUDE_BIN_SHA256/);
    expect(install).not.toMatch(/http:\/\/(?!127\.|localhost|169\.254\.169\.254)/);
  });

  it("never prints a secret: no log of key material, the TLS set only ever lives in 0700/0600 staging, the key ends up 0600", () => {
    for (const t of [install, lib]) {
      expect(t).not.toMatch(/(echo|printf|log|ok|fail|skip|doing)[^\n]*\$\{?(SECRET|KEY_PEM|PRIVATE|TLS_KEY|SERVER_KEY)/i);
      expect(t).not.toMatch(/cat [^\n]*server\.key/);
      expect(t).not.toMatch(/set -x/);
    }
    expect(install).toMatch(/chmod 0600 "\$STAGE_TLS_DIR\/server\.key"/);
    expect(install).toMatch(/chmod 0600 "\$act_tls\/server\.key"/); // re-asserted even when nothing changed
    expect(install).toMatch(/mkdir -m 0700 "\$STAGE_TLS_DIR"/);
  });

  it("the only place that can format a disk is the 'blank' branch of ensure_data_disk", () => {
    expect(lib.match(/^\s*mut mkfs\.ext4/gm)?.length).toBe(1);
    expect(lib).toMatch(/blank\)[\s\S]{0,200}mkfs\.ext4/);
    expect(lib).toMatch(/\*\)[\s\S]{0,400}NOT blank and is not ours/);
    expect(lib).toContain("refusing to touch it");
    expect(install).not.toMatch(/mkfs\./);
    for (const t of [install, lib]) expect(t.match(/\bmkfs\.[a-z0-9]+ /g)?.every((m) => m.startsWith("mkfs.ext4")) ?? true).toBe(true);
  });

  it("quota work happens BEFORE the final remount that sets nosuid,nodev,usrquota, and a quota that is not on fails the step", () => {
    const q = lib.indexOf("ensure_quota \"$mp\"\n    mount -o remount");
    expect(q).toBeGreaterThan(0);
    expect(lib).toContain("quota_is_on");
    expect(lib).not.toMatch(/quotaon -pu[^\n]*\|\s*grep/); // its exit status is 1 when quotas are on: never pipe it under pipefail
    expect(lib).not.toMatch(/quotaon -u[^\n]*\|\| true/); // turning quotas on may not be swallowed
    expect(lib).not.toMatch(/quotacheck[^\n]*>\/dev\/null 2>&1 \|\| true/);
  });

  it("a failed redeploy never stops a healthy host: `disable --now` exists only in the trap and only when NO valid install exists", () => {
    expect(install.match(/disable --now/g)?.length).toBe(1);
    expect(install).toMatch(/have_valid_install; then[\s\S]{0,300}else[\s\S]{0,300}disable --now/);
    expect(install).toContain("exit 3");
    expect(install).toContain("flock -n 9");
  });

  it("the systemd unit asserts the mount flags before every start, waits for the network, and says so once when it gives up", () => {
    expect(unit).toMatch(/ExecStartPre=\/usr\/bin\/mount -o remount,nosuid,nodev,usrquota \/var\/lib\/aw-login-host\/%i\/u/);
    expect(unit).toMatch(/After=[^\n]*network-online\.target/);
    expect(unit).toMatch(/Wants=network-online\.target/);
    expect(unit).toMatch(/StartLimitIntervalSec=\d+/);
    expect(unit).toMatch(/StartLimitBurst=\d+/);
    expect(unit).toMatch(/OnFailure=aw-login-host-failed@%i\.service/);
    expect(unit).toMatch(/Restart=on-failure/);
    expect(unit).toMatch(/KillMode=control-group/);
    expect(unit).toMatch(/TimeoutStopSec=60/);
    expect(unit).not.toContain("install-host.sh");
    expect(text(join(DEPLOY, "aw-login-host-failed@.service"))).toContain("host_start_failed");
  });

  it("the slice template is a template whose ceiling comes from versions.env, and its name matches the host's own slice naming", () => {
    const slice = text(join(DEPLOY, "aw-env.slice.example"));
    for (const p of ["@@MEMORY_MAX@@", "@@MEMORY_HIGH@@", "@@TASKS_MAX@@", "@@CPU_QUOTA@@"]) expect(slice).toContain(p);
    expect(versions.SLICE_MEMORY_MAX).toMatch(/^[1-9][0-9]*[MG]$/);
    expect(versions.SLICE_MEMORY_HIGH).toMatch(/^[1-9][0-9]*[MG]$/);
    expect(install).toContain("aw-$ENV_NAME.slice");
    const layout = text(join(DEPLOY, "../ports/layout.ts"));
    expect(layout).toContain("`aw-${this.cfg.env}.slice`");
  });

  it("the build script is the gate: tests, a clean tree over ALL of backend/, the lockfile check, and loud overrides recorded in the MANIFEST", () => {
    expect(build).toMatch(/jest src\/loginHost\/__tests__\/deploy src\/loginHost\/__tests__\/host src\/services\/funding\/__tests__\/loginHostMutualTls\.test\.ts/);
    expect(build).toContain("status --porcelain -- backend)");
    expect(build).toContain("--skip-tests");
    expect(build).toContain("--allow-dirty");
    expect(build).toMatch(/echo "tests=\$TESTS"/);
    expect(build).toMatch(/echo "allow_dirty=\$ALLOW_DIRTY"/);
    expect(build).toMatch(/echo "lockfile_check=\$LOCK_CHECK"/);
    expect(build).toMatch(/echo "package_lock_sha256=\$LOCK_SHA"/);
    expect(build).toMatch(/echo "esbuild=\$ESBUILD_VERSION"/);
    expect(build).toContain("private-key material found in the build");
    expect(build).toContain("grep -E '^[A-Z0-9_]+='");
  });
});

describe("pinned versions", () => {
  it("every pin is well-formed, and nothing machine-specific is pinned", () => {
    expect(versions.NODE_VERSION).toMatch(/^22\.\d+\.\d+$/);
    expect(versions.NODE_TARBALL_URL).toBe(`https://nodejs.org/dist/v${versions.NODE_VERSION}/node-v${versions.NODE_VERSION}-linux-x64.tar.xz`);
    for (const k of ["NODE_TARBALL_SHA256", "NODE_BIN_SHA256", "CLAUDE_BIN_SHA256"]) expect(versions[k]).toMatch(/^[a-f0-9]{64}$/);
    expect(versions.CLAUDE_TARBALL_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(versions.CLAUDE_TARBALL_URL).toBe(`https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${versions.CLAUDE_VERSION}.tgz`);
    expect(versions.WORKER_PRIVATE_IP).toBeUndefined(); // the address is read at install time, so one build serves any worker
    for (const k of ["TLS_SECRET_SERVER", "TLS_SECRET_CA"]) expect(versions[k]).toMatch(/^prod\/AgentWeb\/LoginHost\/(server|ca)$/);
    expect(Number(versions.RELEASES_KEEP)).toBeGreaterThanOrEqual(2);
  });

  it("the claude pin equals the version the backend itself pins in package-lock.json (one source of truth)", () => {
    const lock = JSON.parse(readFileSync(join(BACKEND, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; integrity?: string }> };
    const pkg = lock.packages["node_modules/@anthropic-ai/claude-code-linux-x64"];
    expect(pkg?.version).toBe(versions.CLAUDE_VERSION);
    expect(pkg?.integrity).toBe(versions.CLAUDE_TARBALL_INTEGRITY);
  });
});

describe("config template", () => {
  const fill = (over: Record<string, string> = {}) =>
    text(join(PROD, "host-config.template.json"))
      .replace("@@CLAUDE_BIN_SHA256@@", over.sha ?? versions.CLAUDE_BIN_SHA256)
      .replace("@@BRIDGE_URL@@", over.bridge ?? "https://backend.example.test/internal/tool-bridge/run/mcp")
      .replace(/@@WORKER_IP@@/g, over.ip ?? "172.31.30.50")
      .replace(/@@RELEASE_DIR@@/g, over.rel ?? "/opt/aw-login-host/releases/login-host-abc-20261021000000")
      .replace(/@@TLS_DIR@@/g, over.tls ?? "/etc/aw-login-host/tls/login-host-abc-20261021000000")
      .replace(/@@CLAUDE_VERSION@@/g, over.ver ?? versions.CLAUDE_VERSION);

  it("is accepted by the host's own schema once the placeholders are filled, and every path points into the release / its TLS set", () => {
    const cfg = parseHostConfig(JSON.parse(fill()));
    expect(cfg.env).toBe("prod");
    expect(cfg.tls?.host).toBe("172.31.30.50");
    expect(cfg.tls?.certPath).toBe("/etc/aw-login-host/tls/login-host-abc-20261021000000/server.crt");
    expect(cfg.tls?.clientCommonNames).toEqual(["agentweb-backend-prod"]);
    expect(cfg.manager.maxTurnsPerHost).toBe(8);
    expect(cfg.claude.version).toBe(versions.CLAUDE_VERSION);
    expect(cfg.claude.binaryPath).toBe(`/opt/aw-claude/${versions.CLAUDE_VERSION}/claude`);
    expect(cfg.claude.turnWrapperPath).toBe("/opt/aw-login-host/releases/login-host-abc-20261021000000/claude-turn.sh");
    expect(cfg.claude.systemPromptFile).toBe("/opt/aw-login-host/releases/login-host-abc-20261021000000/system-prompt.txt");
    expect(cfg.egress.launcherPath).toBe("/opt/aw-login-host/releases/login-host-abc-20261021000000/aw-net.sh");
    expect(cfg.tools.writeFileHelper).toBe("/opt/aw-login-host/releases/login-host-abc-20261021000000/aw-write-file.sh");
    expect(cfg.egress.allow).toEqual(expect.arrayContaining(["api.anthropic.com:443", "platform.claude.com:443"]));
    expect(cfg.egressDir).toBe("/run/aw-egress-prod");
  });

  it("has no unfilled placeholder left after filling, and no secret", () => {
    const filled = fill();
    expect(filled).not.toContain("@@");
    expect(filled).not.toMatch(/PRIVATE KEY|password|secret/i);
  });

  it("the unix socket directory and state root are the production environment's, and the uid range is outside typical subuid ranges", () => {
    const cfg = parseHostConfig(JSON.parse(fill()));
    expect(cfg.socket.dir).toBe("/run/aw-login-host-prod");
    expect(cfg.stateRoot).toBe("/var/lib/aw-login-host/prod");
    expect(cfg.uidMin).toBeGreaterThanOrEqual(500_000);
  });
});

// ───────────────────────────── lib.sh, executed with fake tools ─────────────────────────────

describe("lib.sh: disk classification (fake lsblk/wipefs/blkid, nothing real is touched)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aw-fakebin-"));
    const fake = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    // lsblk -rno MOUNTPOINT DEV  -> the mount points (and blank lines for unmounted children); lsblk -no TYPE DEV -> disk + N parts
    fake("lsblk", `case "$*" in
  *MOUNTPOINT*) printf '%b' "\${FAKE_MOUNTS:-}"; echo ;;
  *TYPE*) echo disk; for _ in $(seq 1 "\${FAKE_PARTS:-0}"); do echo part; done ;;
esac`);
    fake("wipefs", `echo "# offset,uuid,label,type"; for _ in $(seq 1 "\${FAKE_SIGS:-0}"); do echo "0x438,,x,ext4"; done`);
    fake("blkid", `case "$*" in *TYPE*) echo "\${FAKE_FSTYPE:-}" ;; *LABEL*) echo "\${FAKE_LABEL:-}" ;; esac`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const classify = (env: Record<string, string>) => sh(`source "${SCRIPTS["prod/lib.sh"]}"; classify_disk /dev/fake awdata /var/lib/aw-login-host/prod/u`, { PATH: `${dir}:${process.env.PATH}`, ...env }).stdout.trim();
  const MP = "/var/lib/aw-login-host/prod/u";

  it.each([
    ["a blank disk", {}, "blank"],
    ["our disk, not mounted (after a reboot, before the mount)", { FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }, "ours"],
    ["our disk, mounted at exactly the mount point (a redeploy / rollback / certificate rotation)", { FAKE_MOUNTS: MP, FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }, "ours"],
    ["our label but mounted somewhere ELSE", { FAKE_MOUNTS: "/mnt/elsewhere", FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }, "other"],
    ["mounted at the mount point AND somewhere else", { FAKE_MOUNTS: `${MP}\\n/mnt/other`, FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }, "other"],
    ["mounted at the mount point but another label", { FAKE_MOUNTS: MP, FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "somethingelse" }, "other"],
    ["mounted at the mount point but not ext4", { FAKE_MOUNTS: MP, FAKE_SIGS: "1", FAKE_FSTYPE: "xfs", FAKE_LABEL: "awdata" }, "other"],
    ["an ext4 filesystem with another label", { FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "data" }, "other"],
    ["an ext4 filesystem with no label", { FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "" }, "other"],
    ["our label but xfs", { FAKE_SIGS: "1", FAKE_FSTYPE: "xfs", FAKE_LABEL: "awdata" }, "other"],
    ["a partition table, no filesystem", { FAKE_PARTS: "1" }, "other"],
    ["a partition table with our label on the disk signature", { FAKE_PARTS: "2", FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }, "other"],
    ["a partition mounted at the mount point (the disk is partitioned)", { FAKE_MOUNTS: MP, FAKE_PARTS: "1", FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }, "other"],
    ["a signature but no filesystem we know (LVM/RAID/LUKS/zeroed header)", { FAKE_SIGS: "1" }, "other"],
    ["swap", { FAKE_MOUNTS: "[SWAP]", FAKE_SIGS: "1", FAKE_FSTYPE: "swap" }, "other"],
  ])("%s -> %s", (_name, env, expected) => {
    expect(classify(env as Record<string, string>)).toBe(expected);
  });
});

describe("lib.sh: ensure_data_disk drives the right commands (fake tools log every call)", () => {
  let dir: string;
  let calls: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aw-fakedisk-"));
    calls = join(dir, "calls.log");
    const fake = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    fake("lsblk", `case "$*" in *MOUNTPOINT*) printf '%b' "\${FAKE_MOUNTS:-}"; echo ;; *TYPE*) echo disk ;; esac`);
    fake("wipefs", `echo "# h"; for _ in $(seq 1 "\${FAKE_SIGS:-0}"); do echo "0x438,,x,ext4"; done`);
    fake("blkid", `case "$*" in *TYPE*) echo "\${FAKE_FSTYPE:-}" ;; *LABEL*) echo "\${FAKE_LABEL:-}" ;; esac`);
    fake("mkfs.ext4", `echo "mkfs $*" >>"$CALLS"`);
    fake("mount", `echo "mount $*" >>"$CALLS"`);
    fake("quotacheck", `echo "quotacheck $*" >>"$CALLS"; touch "\${@: -1}/aquota.user"`);
    fake("quotaon", `echo "quotaon $*" >>"$CALLS"; if [ "$1" = -pu ]; then if [ -e "$FAKE_QSTATE" ]; then echo "user quota on $2 (/dev/fake) is on"; exit 1; else echo "user quota on $2 (/dev/fake) is off"; fi; else touch "$FAKE_QSTATE"; fi`);
    fake("findmnt", `case "$*" in
  *"-o SOURCE"*) echo "\${FAKE_SRC:-/dev/fake}" ;;
  *"-o OPTIONS"*) echo "\${FAKE_OPTS:-rw,nosuid,nodev,usrquota}" ;;
  *) [ -n "\${FAKE_MOUNTED:-}" ] ;;
esac`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (envOrFn: Record<string, string> | ((mp: string) => Record<string, string>)) => {
    const mp = mkdtempSync(join(dir, "mp-"));
    const env = typeof envOrFn === "function" ? envOrFn(mp) : envOrFn;
    const fstab = join(dir, "fstab");
    writeFileSync(fstab, "# keep me\nUUID=1-1 / xfs defaults 0 1\n");
    writeFileSync(calls, "");
    const q = join(dir, `q-${Math.random().toString(36).slice(2)}`);
    const r = sh(`set -euo pipefail; source "${SCRIPTS["prod/lib.sh"]}"; ensure_data_disk /dev/fake "${mp}" awdata "${fstab}"`, { PATH: `${dir}:${process.env.PATH}`, CALLS: calls, FAKE_QSTATE: q, ...env });
    return { r, log: readFileSync(calls, "utf8"), mp, fstab: readFileSync(fstab, "utf8") };
  };

  it("a BLANK disk is formatted once, mounted with the flags, quotas switched on, and the flags re-asserted last", () => {
    const { r, log, mp } = run({});
    expect(r.status).toBe(0);
    expect(log.match(/^mkfs /gm)?.length).toBe(1);
    expect(log).toContain("mkfs -q -L awdata /dev/fake");
    expect(log).toContain("mount -o defaults,nosuid,nodev,usrquota /dev/fake");
    expect(log.indexOf("quotacheck")).toBeLessThan(log.indexOf("quotaon -u"));
    expect(log.lastIndexOf("mount -o remount,nosuid,nodev,usrquota")).toBeGreaterThan(log.indexOf("quotaon -u"));
    expect(existsSync(join(mp, "aquota.user"))).toBe(true);
  });

  it("OUR disk, already mounted at the mount point (the second run on the worker): no mkfs, no second mount, quotas verified, the flags re-asserted", () => {
    const { r, log } = run((mp) => ({ FAKE_MOUNTED: "1", FAKE_MOUNTS: mp, FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already mounted from /dev/fake");
    expect(log).not.toContain("mkfs");
    expect(log).not.toMatch(/^mount -o defaults/m);
    expect(log).toMatch(/^mount -o remount,nosuid,nodev,usrquota/m);
    expect(log).toContain("quotaon -pu");
  });

  it("OUR disk, not mounted (after a reboot): no mkfs, one mount", () => {
    const { r, log } = run({ FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" });
    expect(r.status).toBe(0);
    expect(log).not.toContain("mkfs");
    expect(log.match(/^mount -o defaults/gm)?.length).toBe(1);
  });

  it.each([
    ["another filesystem", { FAKE_SIGS: "1", FAKE_FSTYPE: "xfs", FAKE_LABEL: "data" }],
    ["a partition table", { FAKE_SIGS: "1" }],
    ["a disk mounted somewhere else", { FAKE_MOUNTS: "/data", FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" }],
  ])("%s is REFUSED: exit 1, no mkfs, no mount, fstab untouched", (_n, env) => {
    const { r, log, fstab } = run(env as Record<string, string>);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to touch it");
    expect(log).toBe("");
    expect(fstab).toBe("# keep me\nUUID=1-1 / xfs defaults 0 1\n");
  });

  it("the mount point already mounted from a DIFFERENT device is refused", () => {
    const { r } = run({ FAKE_MOUNTED: "1", FAKE_SRC: "/dev/other", FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mounted from \/dev\/other/);
  });

  it("mount options that lack nosuid/nodev/usrquota after the remount are a hard failure", () => {
    const { r } = run({ FAKE_MOUNTED: "1", FAKE_OPTS: "rw,relatime", FAKE_SIGS: "1", FAKE_FSTYPE: "ext4", FAKE_LABEL: "awdata" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lack nosuid/);
  });
});

describe("lib.sh: fstab_set and ensure_quota", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aw-fstab-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const LINE = "LABEL=awdata /var/lib/aw-login-host/prod/u ext4 defaults,nofail,nosuid,nodev,usrquota 0 2";
  const set = (fstab: string) => sh(`source "${SCRIPTS["prod/lib.sh"]}"; fstab_set "${fstab}" awdata /var/lib/aw-login-host/prod/u "${LINE}"`);

  it("replaces ANY line mounting the mount point (even by UUID) and any other awdata line, keeps every other line byte for byte, saves a backup, never duplicates", () => {
    const f = join(dir, "fstab");
    const original = "# comment stays\nUUID=aaaa / xfs defaults 0 1\nUUID=bbbb /var/lib/aw-login-host/prod/u ext4 defaults 0 2\nLABEL=awdata /somewhere/else ext4 defaults 0 2\n\n#LABEL=awdata /var/lib/aw-login-host/prod/u ext4 commented 0 2\n";
    writeFileSync(f, original);
    expect(set(f).stdout.trim()).toBe("changed");
    const after = readFileSync(f, "utf8");
    expect(after).toContain("# comment stays\nUUID=aaaa / xfs defaults 0 1\n");
    expect(after).toContain("#LABEL=awdata /var/lib/aw-login-host/prod/u ext4 commented 0 2"); // a comment is not a mount
    expect(after).not.toContain("UUID=bbbb");
    expect(after).not.toContain("/somewhere/else");
    expect(after.split("\n").filter((l) => l === LINE)).toHaveLength(1);
    expect(readFileSync(`${f}.aw-backup`, "utf8")).toBe(original);
    expect(set(f).stdout.trim()).toBe("unchanged"); // idempotent
    expect(readFileSync(f, "utf8")).toBe(after);
  });

  it("creates the file if it does not exist, and writes it with mode 0644", () => {
    const f = join(dir, "fstab-new");
    expect(set(f).stdout.trim()).toBe("changed");
    expect(readFileSync(f, "utf8")).toBe(`${LINE}\n`);
    expect(statSync(f).mode & 0o777).toBe(0o644);
  });

  describe("ensure_quota", () => {
    const fakeQuota = (opts: { quotaonFails?: boolean; neverOn?: boolean; noAquota?: boolean }) => {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const fake = (n: string, body: string) => {
        writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
        chmodSync(join(bin, n), 0o755);
      };
      fake("quotacheck", opts.noAquota ? `echo "quotacheck: cannot do it" >&2; exit 1` : `touch "\${@: -1}/aquota.user"`);
      fake("quotaon", opts.quotaonFails
        ? `if [ "$1" = -pu ]; then echo "user quota on $2 (/dev/x) is off"; else echo boom >&2; exit 1; fi`
        : opts.neverOn
          ? `if [ "$1" = -pu ]; then echo "user quota on $2 (/dev/x) is off"; fi; exit 0`
          : `if [ "$1" = -pu ]; then if [ -e "${dir}/on" ]; then echo "user quota on $2 (/dev/x) is on"; exit 1; else echo "user quota on $2 (/dev/x) is off"; fi; else touch "${dir}/on"; fi`);
      return bin;
    };
    const run = (o: Parameters<typeof fakeQuota>[0]) => {
      const mp = join(dir, "mp");
      mkdirSync(mp, { recursive: true });
      return sh(`set -euo pipefail; source "${SCRIPTS["prod/lib.sh"]}"; ensure_quota "${mp}"`, { PATH: `${fakeQuota(o)}:${process.env.PATH}` });
    };

    it("creates the quota file, switches quotas on, and verifies they are on", () => {
      const r = run({});
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("user quotas are on");
    });
    it("a quotacheck that creates no quota file is FATAL (and its message is shown)", () => {
      const r = run({ noAquota: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("quotacheck did not create");
      expect(r.stderr).toContain("cannot do it");
    });
    it("a quotaon that fails is FATAL, not swallowed", () => {
      const r = run({ quotaonFails: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("quotaon failed");
    });
    it("quotas that are still off after a successful-looking quotaon are FATAL", () => {
      const r = run({ neverOn: true });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("NOT on");
    });
  });
});

describe("lib.sh: is_private_ipv4", () => {
  const is = (ip: string) => sh(`source "${SCRIPTS["prod/lib.sh"]}"; is_private_ipv4 "${ip}"`).status === 0;
  it.each(["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.30.50", "172.31.255.255", "192.168.1.1"])("%s is private", (ip) => expect(is(ip)).toBe(true));
  it.each(["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "010.0.0.1", "10.0.0.256", "10.0.0", "10.0.0.1.1", "172.031.30.50", "::1", "", "10.0.0.1; rm -rf /", "0x7f.0.0.1"])("%j is NOT accepted", (ip) => expect(is(ip)).toBe(false));
});

describe("lib.sh: validate_tls_dir (the REAL openssl on the test certificates)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aw-tls-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const set = (over: { cert?: string; key?: string; ca?: string } = {}) => {
    copyFileSync(over.cert ?? WORKER_CERT, join(dir, "server.crt"));
    copyFileSync(over.key ?? join(TLS, "server.key.pem"), join(dir, "server.key"));
    copyFileSync(over.ca ?? join(TLS, "ca.pem"), join(dir, "ca.crt"));
  };
  const check = (ip = "172.31.30.50") => sh(`source "${SCRIPTS["prod/lib.sh"]}"; validate_tls_dir "${dir}" "${ip}"`);

  it("accepts a certificate that names the address, matches its key, chains to the CA and has not expired", () => {
    set();
    expect(check().status).toBe(0);
  });
  it("rejects a certificate that does not name the worker's address", () => {
    set();
    const r = check("172.31.30.5"); // a prefix of the real address must not match
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not name IP 172.31.30.5");
    set({ cert: join(TLS, "wrong-server.pem") });
    expect(check().stderr).toContain("does not name IP 172.31.30.50");
  });
  it("rejects a key that does not match the certificate", () => {
    set({ key: join(TLS, "client.key.pem") });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("key does not match");
  });
  it("rejects a certificate that does not chain to the CA", () => {
    set({ ca: join(TLS, "rogue-ca.pem") });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not chain to the CA");
  });
  it("rejects a missing file, an empty file and garbage", () => {
    set();
    rmSync(join(dir, "ca.crt"));
    expect(check().stderr).toContain("missing ca.crt");
    set();
    writeFileSync(join(dir, "server.crt"), "");
    expect(check().stderr).toContain("missing server.crt");
    writeFileSync(join(dir, "server.crt"), "not a certificate\n");
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a certificate");
  });
  it("rejects an EXPIRED certificate", () => {
    set();
    // A certificate that expired a second after it started, signed by the test CA (openssl 3 supports -not_before/-not_after only from 3.4: use faketime-free `x509 -days 0` is racy, so
    // build a CA-signed certificate with an explicit short window through a tiny `openssl ca` database).
    const db = join(dir, "ca-db");
    mkdirSync(join(db, "newcerts"), { recursive: true });
    writeFileSync(join(db, "index.txt"), "");
    writeFileSync(join(db, "serial"), "01\n");
    writeFileSync(join(db, "ext.cnf"), "subjectAltName=IP:172.31.30.50\n");
    writeFileSync(join(db, "ca.cnf"), `[ca]\ndefault_ca=c\n[c]\ndatabase=${db}/index.txt\nnew_certs_dir=${db}/newcerts\nserial=${db}/serial\ndefault_md=sha256\npolicy=p\nunique_subject=no\n[p]\ncommonName=supplied\n`);
    const r1 = sh(`openssl req -new -key "${join(TLS, "server.key.pem")}" -subj /CN=expired -out "${db}/e.csr" 2>/dev/null && openssl ca -batch -config "${db}/ca.cnf" -cert "${join(TLS, "ca.pem")}" -keyfile "${join(TLS, "ca.key.pem")}" -in "${db}/e.csr" -out "${dir}/server.crt" -startdate 20200101000000Z -enddate 20200102000000Z -extfile "${db}/ext.cnf" 2>&1`);
    expect(r1.status).toBe(0);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("expired");
  });
});

// ───────────────────────────── install.sh end to end (test mode, a REAL build tarball) ─────────────────────────────

describe("install.sh: stage -> validate -> switch, rollback, and 'a failure never touches a healthy host' (test mode, real build)", () => {
  jest.setTimeout(240_000);
  let root: string;
  let tarDir: string;
  let pkg: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "aw-inst-"));
    tarDir = join(root, "out");
    const b = spawnSync("bash", [SCRIPTS["build-login-host.sh"], "--out", tarDir, "--skip-tests", "--allow-dirty"], { cwd: BACKEND, encoding: "utf8", timeout: 200_000 });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stdout}\n${b.stderr}`);
    const tgz = readdirSync(tarDir).find((f) => f.endsWith(".tar.gz"))!;
    const x = spawnSync("tar", ["-xzf", join(tarDir, tgz), "-C", root], { encoding: "utf8" });
    expect(x.status).toBe(0);
    pkg = join(root, tgz.replace(/\.tar\.gz$/, ""));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  interface Box {
    dir: string;
    opt: string;
    conf: string;
    units: string;
    bin: string;
    calls: string;
    env: Record<string, string>;
    pkg: string;
  }

  /** A fresh fake machine: scratch OPT/CONF/UNIT_DIR, a fake `aws` serving the test certificates, a fake `systemctl` that logs, a bridge-url file. */
  function box(opts: { bridge?: string | null; cert?: string; copyPkg?: string } = {}): Box {
    const dir = mkdtempSync(join(root, "box-"));
    const p = join(dir, "pkg");
    spawnSync("cp", ["-a", opts.copyPkg ?? pkg, p]);
    writeFileSync(join(p, ".aw-test-mode"), "");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls.log");
    writeFileSync(calls, "");
    const fake = (n: string, body: string) => {
      writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, n), 0o755);
    };
    const pem = (f: string) => readFileSync(f, "utf8");
    const serverJson = JSON.stringify({ cert: pem(opts.cert ?? WORKER_CERT), key: pem(join(TLS, "server.key.pem")), ca: pem(join(TLS, "ca.pem")) });
    const caJson = JSON.stringify({ cert: pem(join(TLS, "ca.pem")) });
    writeFileSync(join(dir, "server.json"), serverJson);
    writeFileSync(join(dir, "ca.json"), caJson);
    fake("aws", `[ -e "${dir}/aws-fails" ] && { echo "AccessDenied" >&2; exit 254; }
case "$*" in *"${versions.TLS_SECRET_SERVER}"*) cat "${dir}/server.json" ;; *"${versions.TLS_SECRET_CA}"*) cat "${dir}/ca.json" ;; *) exit 2 ;; esac`);
    fake("systemctl", `echo "systemctl $*" >>"${calls}"`);
    const opt = join(dir, "opt");
    const conf = join(dir, "etc");
    const units = join(dir, "units");
    for (const d of [opt, conf, units]) mkdirSync(d);
    if (opts.bridge !== null) writeFileSync(join(conf, "bridge-url"), `${opts.bridge ?? "https://backend.example.test/internal/tool-bridge/run/mcp"}\n`);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      AW_OPT: opt, AW_CONF: conf, AW_UNIT_DIR: units, AW_LOCK: join(dir, "lock"), AW_SYSTEMCTL: join(bin, "systemctl"),
      AW_SKIP_PREREQS: "1", AW_WORKER_IP: "172.31.30.50", AW_TMP: dir,
    };
    return { dir, opt, conf, units, bin, calls, env, pkg: p };
  }
  const run = (b: Box, ...args: string[]) => spawnSync("bash", [join(b.pkg, "install.sh"), ...args], { encoding: "utf8", env: { ...process.env, ...b.env }, timeout: 120_000 });
  const releases = (b: Box) => (existsSync(join(b.opt, "releases")) ? readdirSync(join(b.opt, "releases")).filter((n) => !n.startsWith(".")).sort() : []);
  const tlsDirs = (b: Box) => (existsSync(join(b.conf, "tls")) ? readdirSync(join(b.conf, "tls")).filter((n) => !n.startsWith(".")).sort() : []);
  const stagingLeft = (b: Box) => [...(existsSync(join(b.opt, "releases")) ? readdirSync(join(b.opt, "releases")) : []), ...(existsSync(join(b.conf, "tls")) ? readdirSync(join(b.conf, "tls")) : [])].filter((n) => n.startsWith(".stage"));
  const current = (b: Box) => readlinkSync(join(b.opt, "current"));
  const tree = (dir: string): string => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) out.push(`L ${p} -> ${readlinkSync(p)}`);
        else if (st.isDirectory()) { out.push(`D ${p} ${(st.mode & 0o777).toString(8)}`); walk(p); }
        else out.push(`F ${p} ${(st.mode & 0o777).toString(8)} ${readFileSync(p).toString("base64").slice(0, 64)} ${st.size}`);
      }
    };
    walk(dir);
    return out.join("\n");
  };
  const systemctlCalls = (b: Box) => readFileSync(b.calls, "utf8").split("\n").filter(Boolean);

  it("the build is a real tarball with everything install.sh needs, nothing machine-specific, and an honest MANIFEST", () => {
    const manifest = text(join(pkg, "MANIFEST"));
    expect(manifest).toMatch(/^name=login-host-[A-Za-z0-9-]+$/m);
    expect(manifest).toMatch(/^tests=SKIPPED \(--skip-tests\)$/m);
    expect(manifest).toMatch(/^allow_dirty=1$/m);
    expect(manifest).toMatch(/^esbuild=\d+\.\d+\.\d+$/m);
    expect(manifest).toMatch(/^package_lock_sha256=[a-f0-9]{64}$/m);
    expect(manifest).toMatch(/^lockfile_check=/m);
    expect(manifest).not.toContain("WORKER_PRIVATE_IP");
    for (const f of ["install.sh", "deploy.sh", "deployctl.js", "lib.sh", "versions.env", "check-config.js", "dist/loginHost/host/start.js", "files/aw-login-host@.service", "files/aw-login-host-failed@.service", "files/aw-env.slice.template", "files/host-config.template.json", "files/claude-turn.sh", "files/aw-net.sh", "files/aw-write-file.sh", "files/system-prompt.txt"]) {
      expect(existsSync(join(pkg, f))).toBe(true);
    }
    expect(text(join(pkg, "files/host-config.template.json"))).toContain("@@WORKER_IP@@"); // filled at install time
    expect(text(join(pkg, "versions.env"))).not.toMatch(/172\.31\.30\.50/);
  });

  it("the real tarball passes the SSM document's own layout rule: one top directory named after the build, no absolute or parent paths, a deploy.sh that is a regular file", () => {
    const tgz = readdirSync(tarDir).find((f) => f.endsWith(".tar.gz"))!;
    const name = tgz.replace(/\.tar\.gz$/, "");
    const entries = spawnSync("tar", ["-tzf", join(tarDir, tgz)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    expect(entries.length).toBeGreaterThan(10);
    for (const e of entries) {
      expect({ e, unsafe: e.startsWith("/") || e.includes("..") }).toEqual({ e, unsafe: false });
      expect({ e, inside: e === name || e.startsWith(`${name}/`) }).toEqual({ e, inside: true });
    }
    expect(lstatSync(join(pkg, "deploy.sh")).isFile()).toBe(true);
    expect(text(join(pkg, "MANIFEST"))).toMatch(/^commit_time=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m); // deploy.sh's no-downgrade rule reads this
  });

  it("FIRST install: a complete, validated release is switched in atomically; the unit, slice and config are in place; nothing was disabled", () => {
    const b = box();
    const r = run(b);
    expect(r.status).toBe(0);
    const rels = releases(b);
    expect(rels).toHaveLength(1);
    expect(current(b)).toBe(`releases/${rels[0]}`);
    expect(lstatSync(join(b.opt, "current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(b.opt, "dist"))).toBe("current/dist");
    expect(existsSync(join(b.opt, "previous"))).toBe(false);
    // the config is a REGULAR file (the host refuses symlinks on trusted paths), mode 0600, and its paths point into THIS release and ITS TLS set
    const cfgPath = join(b.conf, "prod.json");
    expect(lstatSync(cfgPath).isSymbolicLink()).toBe(false);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const cfg = parseHostConfig(JSON.parse(text(cfgPath)));
    expect(cfg.tls?.host).toBe("172.31.30.50");
    expect(cfg.claude.turnWrapperPath).toBe(join(b.opt, "releases", rels[0], "claude-turn.sh"));
    expect(cfg.egress.launcherPath).toBe(join(b.opt, "releases", rels[0], "aw-net.sh"));
    expect(cfg.tls?.keyPath).toBe(join(b.conf, "tls", rels[0], "server.key"));
    for (const p of [cfg.claude.turnWrapperPath, cfg.egress.launcherPath, cfg.tools.writeFileHelper, cfg.claude.systemPromptFile, cfg.tls!.certPath, cfg.tls!.keyPath, cfg.tls!.caPath]) {
      expect(existsSync(p)).toBe(true);
      for (let q = p; q.startsWith(b.dir) && q !== b.dir; q = join(q, "..")) expect(lstatSync(q).isSymbolicLink()).toBe(false); // no symlink anywhere on a trusted path
    }
    // TLS set modes: the key is 0600, the directory is not writable by others, certs readable
    const tls = join(b.conf, "tls", rels[0]);
    expect(statSync(join(tls, "server.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(tls, "server.crt")).mode & 0o777).toBe(0o644);
    expect(statSync(tls).mode & 0o022).toBe(0);
    expect(text(join(b.opt, "releases", rels[0], "TLS_DIR")).trim()).toBe(tls);
    // units + slice
    expect(text(join(b.units, "aw-login-host@.service"))).toContain("ExecStartPre=/usr/bin/mount -o remount,nosuid,nodev,usrquota");
    expect(existsSync(join(b.units, "aw-login-host-failed@.service"))).toBe(true);
    const slice = text(join(b.units, "aw-prod.slice"));
    expect(slice).toContain(`MemoryMax=${versions.SLICE_MEMORY_MAX}`);
    expect(slice).toContain(`MemoryHigh=${versions.SLICE_MEMORY_HIGH}`);
    expect(slice).toContain(`TasksMax=${versions.SLICE_TASKS_MAX}`);
    expect(slice).toMatch(/CPUQuota=\d+%/);
    expect(slice).not.toContain("@@");
    // systemd: reload + enable, and never a disable
    const calls = systemctlCalls(b);
    expect(calls).toContain("systemctl daemon-reload");
    expect(calls.some((c) => c.startsWith("systemctl enable"))).toBe(true);
    expect(calls.some((c) => c.includes("disable"))).toBe(false);
    expect(stagingLeft(b)).toEqual([]);
  });

  it("re-running the SAME build changes nothing, and re-asserts the key mode even though the content is unchanged", () => {
    const b = box();
    expect(run(b).status).toBe(0);
    const rel = releases(b)[0];
    const key = join(b.conf, "tls", rel, "server.key");
    chmodSync(key, 0o644); // drifted
    chmodSync(join(b.conf, "tls", rel), 0o755);
    const before = tree(b.opt);
    const r = run(b);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to do");
    expect(releases(b)).toEqual([rel]);
    expect(tree(b.opt)).toBe(before);
    expect(statSync(key).mode & 0o777).toBe(0o600);
  });

  it("a CHANGED input (a new bridge URL) makes a NEW release; the old one becomes `previous`; the config follows", () => {
    const b = box();
    expect(run(b).status).toBe(0);
    const first = releases(b)[0];
    writeFileSync(join(b.conf, "bridge-url"), "https://other.example.test/mcp\n");
    // the release id carries a one-second timestamp: make sure the two differ
    spawnSync("sleep", ["1.1"]);
    expect(run(b).status).toBe(0);
    const rels = releases(b);
    expect(rels).toHaveLength(2);
    expect(current(b)).toBe(`releases/${rels.find((n) => n !== first)}`);
    expect(readlinkSync(join(b.opt, "previous"))).toBe(`releases/${first}`);
    expect(parseHostConfig(JSON.parse(text(join(b.conf, "prod.json")))).claude.bridgeUrl).toBe("https://other.example.test/mcp");
    expect(parseHostConfig(JSON.parse(text(join(b.opt, "releases", first, "prod.json")))).claude.bridgeUrl).toBe("https://backend.example.test/internal/tool-bridge/run/mcp");
  });

  it("a rotated server certificate (same address, same build, same bridge) is NOT 'nothing to do': it becomes a new release with its own TLS set", () => {
    const b = box();
    expect(run(b).status).toBe(0);
    const first = releases(b)[0];
    // a fresh certificate for the same key and address, signed by the same test CA, with another serial
    const cnf = join(b.dir, "w.cnf");
    writeFileSync(cnf, "subjectAltName=IP:172.31.30.50\nextendedKeyUsage=serverAuth\n");
    const mk = sh(`openssl req -new -key "${join(TLS, "server.key.pem")}" -subj /CN=rotated -out "${b.dir}/w.csr" 2>/dev/null && openssl x509 -req -in "${b.dir}/w.csr" -CA "${join(TLS, "ca.pem")}" -CAkey "${join(TLS, "ca.key.pem")}" -set_serial 4242 -days 3650 -sha256 -extfile "${cnf}" -out "${b.dir}/rotated.pem" 2>/dev/null`);
    expect(mk.status).toBe(0);
    writeFileSync(join(b.dir, "server.json"), JSON.stringify({ cert: text(join(b.dir, "rotated.pem")), key: text(join(TLS, "server.key.pem")), ca: text(join(TLS, "ca.pem")) }));
    spawnSync("sleep", ["1.1"]);
    const r = run(b);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("nothing to do");
    const rels = releases(b);
    expect(rels).toHaveLength(2);
    const second = rels.find((n) => n !== first)!;
    expect(current(b)).toBe(`releases/${second}`);
    expect(text(join(b.conf, "tls", second, "server.crt"))).toBe(text(join(b.dir, "rotated.pem")));
    expect(text(join(b.conf, "tls", first, "server.crt"))).toBe(text(WORKER_CERT)); // the previous set is untouched, so --rollback still works
  });

  describe("a FAILED redeploy leaves the healthy running host exactly as it was", () => {
    const failing: Array<[string, (b: Box) => void, RegExp]> = [
      ["the TLS secrets cannot be read", (b) => writeFileSync(join(b.dir, "aws-fails"), ""), /could not read secret/],
      ["the server certificate names another address", (b) => writeFileSync(join(b.dir, "server.json"), JSON.stringify({ cert: text(join(TLS, "wrong-server.pem")), key: text(join(TLS, "server.key.pem")), ca: text(join(TLS, "ca.pem")) })), /does not name IP/],
      ["the key does not match the certificate", (b) => writeFileSync(join(b.dir, "server.json"), JSON.stringify({ cert: text(WORKER_CERT), key: text(join(TLS, "client.key.pem")), ca: text(join(TLS, "ca.pem")) })), /key does not match/],
      ["the CA secret is another CA", (b) => writeFileSync(join(b.dir, "ca.json"), JSON.stringify({ cert: text(join(TLS, "rogue-ca.pem")) })), /does not chain/],
      ["the secret has the wrong shape", (b) => writeFileSync(join(b.dir, "server.json"), JSON.stringify({ nope: 1 })), /expected JSON shape/],
    ];
    it.each(failing)("%s", (_n, breakIt, msg) => {
      const b = box();
      expect(run(b).status).toBe(0);
      const rel = releases(b)[0];
      spawnSync("sleep", ["1.1"]);
      writeFileSync(join(b.conf, "bridge-url"), "https://changed.example.test/mcp\n"); // force a real redeploy (not the 'nothing to do' path)
      const beforeOpt = tree(b.opt);
      const beforeConf = tree(b.conf).replace(/F [^\n]*bridge-url[^\n]*/g, "");
      writeFileSync(b.calls, "");
      breakIt(b);
      const r = run(b);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(msg);
      expect(tree(b.opt)).toBe(beforeOpt); // nothing in /opt changed: same release, same links
      expect(tree(b.conf).replace(/F [^\n]*bridge-url[^\n]*/g, "")).toBe(beforeConf);
      expect(current(b)).toBe(`releases/${rel}`);
      expect(systemctlCalls(b).some((c) => c.includes("disable") || c.includes("stop"))).toBe(false); // the running unit was never touched
      expect(stagingLeft(b)).toEqual([]);
      expect(r.stderr).toContain("keeps running");
    });

    it("the generated config is rejected by the host's own parser", () => {
      const b = box();
      expect(run(b).status).toBe(0);
      spawnSync("sleep", ["1.1"]);
      writeFileSync(join(b.conf, "bridge-url"), "https://changed.example.test/mcp\n");
      const tpl = join(b.pkg, "files/host-config.template.json");
      writeFileSync(tpl, text(tpl).replace('"env": "prod",', '"env": "prod", "surprise": 1,'));
      const before = tree(b.opt);
      const r = run(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/rejected by the host's own schema/);
      expect(tree(b.opt)).toBe(before);
      expect(systemctlCalls(b).some((c) => c.includes("disable"))).toBe(false);
    });
  });

  it("a failure on a FIRST install (nothing valid exists) stops/disables the unit so nothing crash-loops, and leaves no staging", () => {
    const b = box();
    writeFileSync(join(b.dir, "aws-fails"), "");
    const r = run(b);
    expect(r.status).not.toBe(0);
    expect(systemctlCalls(b).some((c) => c.startsWith("systemctl disable --now aw-login-host@prod"))).toBe(true);
    expect(existsSync(join(b.opt, "current"))).toBe(false);
    expect(existsSync(join(b.conf, "prod.json"))).toBe(false);
    expect(stagingLeft(b)).toEqual([]);
  });

  it("no bridge URL: exit 3, nothing installed on a first install; on a redeploy the running host keeps running", () => {
    const first = box({ bridge: null });
    const r1 = run(first);
    expect(r1.status).toBe(3);
    expect(r1.stderr).toContain("NOT INSTALLED");
    expect(existsSync(join(first.opt, "current"))).toBe(false);

    const b = box();
    expect(run(b).status).toBe(0);
    const before = tree(b.opt);
    rmSync(join(b.conf, "bridge-url"));
    writeFileSync(b.calls, "");
    const r2 = run(b);
    expect(r2.status).toBe(3);
    expect(r2.stderr).toContain("keeps running");
    expect(tree(b.opt)).toBe(before);
    expect(systemctlCalls(b).some((c) => c.includes("disable"))).toBe(false);
    for (const bad of ["http://insecure.example.test/mcp", "https://x.example.test/mcp$HOME", "https://x y.example.test", "ftp://x"]) {
      writeFileSync(join(b.conf, "bridge-url"), `${bad}\n`);
      expect(run(b).status).toBe(3);
    }
  });

  it("--rollback re-points current, the config and previous (and again, back); with no previous it refuses", () => {
    const b = box();
    expect(run(b).status).toBe(0);
    expect(run(b, "--rollback").status).toBe(1); // nothing to roll back to
    const first = releases(b)[0];
    spawnSync("sleep", ["1.1"]);
    writeFileSync(join(b.conf, "bridge-url"), "https://second.example.test/mcp\n");
    expect(run(b).status).toBe(0);
    const second = releases(b).find((n) => n !== first)!;
    const r = run(b, "--rollback");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Restart the service");
    expect(current(b)).toBe(`releases/${first}`);
    expect(readlinkSync(join(b.opt, "previous"))).toBe(`releases/${second}`);
    expect(parseHostConfig(JSON.parse(text(join(b.conf, "prod.json")))).claude.bridgeUrl).toBe("https://backend.example.test/internal/tool-bridge/run/mcp");
    expect(lstatSync(join(b.conf, "prod.json")).isSymbolicLink()).toBe(false);
    expect(run(b, "--rollback").status).toBe(0); // and forward again
    expect(current(b)).toBe(`releases/${second}`);
    expect(parseHostConfig(JSON.parse(text(join(b.conf, "prod.json")))).claude.bridgeUrl).toBe("https://second.example.test/mcp");
    expect(systemctlCalls(b).some((c) => c.includes("disable") || c.includes("stop"))).toBe(false); // the caller restarts; the script never does
  });

  it("--rollback refuses when the previous release's TLS set is no longer valid, and changes nothing", () => {
    const b = box();
    expect(run(b).status).toBe(0);
    const first = releases(b)[0];
    spawnSync("sleep", ["1.1"]);
    writeFileSync(join(b.conf, "bridge-url"), "https://second.example.test/mcp\n");
    expect(run(b).status).toBe(0);
    writeFileSync(join(b.conf, "tls", first, "server.crt"), "garbage\n");
    const before = tree(b.opt) + tree(b.conf);
    const r = run(b, "--rollback");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TLS set is no longer valid");
    expect(tree(b.opt) + tree(b.conf)).toBe(before);
  });

  it("old releases are pruned down to RELEASES_KEEP, but the active and the previous release (and their TLS sets) always stay", () => {
    const b = box();
    const keep = Number(versions.RELEASES_KEEP);
    for (let i = 0; i < keep + 2; i++) {
      writeFileSync(join(b.conf, "bridge-url"), `https://backend${i}.example.test/mcp\n`);
      expect(run(b).status).toBe(0);
      spawnSync("sleep", ["1.1"]);
    }
    const rels = releases(b);
    expect(rels).toHaveLength(keep);
    expect(tlsDirs(b)).toEqual(rels); // each release has exactly its own TLS set
    expect(rels).toContain(current(b).replace("releases/", ""));
    expect(rels).toContain(readlinkSync(join(b.opt, "previous")).replace("releases/", ""));
  });

  it("--dry-run changes nothing at all", () => {
    const b = box();
    const snap = () => [b.opt, b.conf, b.units].map(tree).join("\n--\n"); // (the lock file is not state)
    const before = snap();
    const r = run(b, "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry run finished");
    expect(snap()).toBe(before);
    expect(readdirSync(b.dir).filter((n) => n.startsWith("aw-dry"))).toEqual([]);
    expect(systemctlCalls(b)).toEqual([]);
    expect(stagingLeft(b)).toEqual([]);
  });

  it("two installs at once cannot collide: while another process holds the install lock, the second refuses and changes nothing", async () => {
    const b = box();
    const holder = spawn("flock", ["-n", b.env.AW_LOCK, "sleep", "30"], { stdio: "ignore", detached: true });
    try {
      await new Promise((r) => setTimeout(r, 400));
      const before = [b.opt, b.conf, b.units].map(tree).join("|");
      const r = run(b);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("another install is running");
      expect([b.opt, b.conf, b.units].map(tree).join("|")).toBe(before);
    } finally {
      process.kill(-holder.pid!, "SIGKILL"); // flock AND the sleep it runs (which is what holds the lock)
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(run(b).status).toBe(0); // and it works again once the lock is free
  });

  it("without the test-mode marker the AW_* variables are IGNORED (a root installer must not take paths from the environment)", () => {
    const b = box();
    rmSync(join(b.pkg, ".aw-test-mode"));
    const r = spawnSync("bash", [join(b.pkg, "install.sh")], { encoding: "utf8", env: { ...process.env, ...b.env } });
    if (process.getuid && process.getuid() === 0) return; // as root it would run for real; the static guard below covers that case
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must run as root");
    expect(existsSync(join(b.opt, "releases"))).toBe(false);
  });

  it("the marker is not part of any tarball and the AW_* seams are read only behind it", () => {
    expect(existsSync(join(pkg, ".aw-test-mode"))).toBe(false);
    const seamLines = install.split("\n").filter((l) => /AW_(OPT|CONF|UNIT_DIR|LOCK|SYSTEMCTL|SKIP_PREREQS|WORKER_IP|BRIDGE_FILE)/.test(l));
    expect(seamLines.length).toBeGreaterThan(0);
    const testBlock = install.slice(install.indexOf('if [ -e "$HERE/.aw-test-mode" ]'), install.indexOf("if [ \"$TEST\" != 1 ] && [ \"$(id -u)\" != 0 ]"));
    for (const l of seamLines) expect(testBlock.includes(l) || /\[ "\$TEST" (!=|=) 1 \]|TEST" = 1/.test(l) || l.trim().startsWith("#")).toBe(true);
  });
});
