/**
 * ENG-2110 PR 3: static guards on the production deploy tooling (install.sh, build script, pinned versions, config template). These scripts run as
 * root on the machine that holds customers' Claude logins and can format a disk, so the properties that matter are checked on every change:
 * they parse, they never pipe a download into a shell, they never print a secret, they never format a disk that holds data, every pinned value
 * is well-formed, and the config they generate is accepted by the host's OWN schema.
 */
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { parseHostConfig } from "../../host/hostConfig";

const BACKEND = join(__dirname, "../../../..");
const DEPLOY = join(BACKEND, "src/loginHost/deploy");
const PROD = join(DEPLOY, "prod");
const SCRIPTS = {
  "prod/install.sh": join(PROD, "install.sh"),
  "build-login-host.sh": join(BACKEND, "scripts/build-login-host.sh"),
  "aw-net.sh": join(DEPLOY, "aw-net.sh"),
  "claude-turn.sh": join(DEPLOY, "claude-turn.sh"),
  "aw-write-file.sh": join(DEPLOY, "aw-write-file.sh"),
  "install-test-host.sh": join(DEPLOY, "install-test-host.sh"),
};
const text = (p: string) => readFileSync(p, "utf8");
const install = text(SCRIPTS["prod/install.sh"]);
const build = text(SCRIPTS["build-login-host.sh"]);
const versions = Object.fromEntries(
  text(join(PROD, "versions.env"))
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

describe("deploy scripts", () => {
  it.each(Object.entries(SCRIPTS))("%s parses (bash -n)", (_name, path) => {
    const r = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  const shellcheck = spawnSync("shellcheck", ["--version"]).status === 0;
  (shellcheck ? it : it.skip)("the production scripts are shellcheck-clean (errors and warnings)", () => {
    const r = spawnSync("shellcheck", ["-S", "warning", "-x", "-e", "SC1091", SCRIPTS["prod/install.sh"], SCRIPTS["build-login-host.sh"]], { encoding: "utf8" });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(0);
  });

  it("install.sh and the build script run with set -euo pipefail", () => {
    expect(install).toMatch(/^set -euo pipefail$/m);
    expect(build).toMatch(/^set -euo pipefail$/m);
  });

  it("no script pipes a download into a shell (no `curl | sh`, no `wget -O- | bash`)", () => {
    for (const [name, p] of Object.entries(SCRIPTS)) {
      expect({ name, bad: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(text(p)) }).toEqual({ name, bad: false });
    }
  });

  it("downloads are https-only with a verified hash before use", () => {
    expect(install).toContain("--proto '=https'");
    expect(install).toMatch(/sha256sum "\$tmpd\/node\.tar\.xz"[\s\S]*NODE_TARBALL_SHA256/);
    expect(install).toMatch(/CLAUDE_TARBALL_INTEGRITY/);
    expect(install).toMatch(/CLAUDE_BIN_SHA256/);
    expect(install).not.toMatch(/http:\/\/(?!127\.|localhost)/); // no plain-http URL anywhere
  });

  it("never prints a secret: no echo/printf/log of key material, and the TLS files are only ever written to mode-0600 work files or root-owned targets", () => {
    expect(install).not.toMatch(/(echo|printf|log|ok|fail|skip|doing)[^\n]*\$\{?(SECRET|KEY_PEM|PRIVATE|TLS_KEY|SERVER_KEY)/i);
    expect(install).not.toMatch(/cat [^\n]*server\.key/);
    expect(install).not.toMatch(/set -x/);
    expect(install).toMatch(/server\.key:0600/);
    expect(install).toMatch(/umask 077/);
  });

  it("the data-disk guard: only a blank disk is ever formatted; anything else (or anything mounted) is refused", () => {
    expect(install).toContain("refusing to touch it");
    expect(install).toContain("wipefs --no-act");
    expect(install).toMatch(/blank\)[\s\S]{0,200}mkfs\.ext4/); // mkfs appears only in the blank branch
    expect(install.match(/^\s*mut mkfs\.ext4/gm)?.length).toBe(1); // exactly one place can format
    expect(install.match(/\bmkfs\.[a-z0-9]+ /g)?.every((m) => m.startsWith("mkfs.ext4"))).toBe(true);
    expect(install).toMatch(/\*\)[\s\S]{0,300}NOT blank and is not ours/);
  });

  it("quota work happens BEFORE the final remount that sets nosuid,nodev,usrquota (quotacheck drops the flags on AL2023)", () => {
    const q = install.indexOf("quotacheck -cu");
    const r = install.indexOf("mount -o remount,nosuid,nodev,usrquota");
    const verify = install.indexOf('for need in nosuid nodev usrquota');
    expect(q).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(q);
    expect(verify).toBeGreaterThan(r);
  });

  it("a half-configured host is stopped, never left crash-looping, with distinct exit codes", () => {
    expect(install).toMatch(/systemctl disable --now/);
    expect(install).toContain("exit 3");
    expect(build).not.toMatch(/PRIVATE KEY-----'\s*\|\|/); // the key-material scan aborts the build
    expect(build).toContain("private-key material found in the build");
  });

  it("the manifest lists the sha256/integrity pins (the grep must allow digits in names)", () => {
    expect(build).toContain("grep -E '^[A-Z0-9_]+='");
  });
});

describe("pinned versions", () => {
  it("every pin is well-formed", () => {
    expect(versions.NODE_VERSION).toMatch(/^22\.\d+\.\d+$/);
    expect(versions.NODE_TARBALL_URL).toBe(`https://nodejs.org/dist/v${versions.NODE_VERSION}/node-v${versions.NODE_VERSION}-linux-x64.tar.xz`);
    for (const k of ["NODE_TARBALL_SHA256", "NODE_BIN_SHA256", "CLAUDE_BIN_SHA256"]) expect(versions[k]).toMatch(/^[a-f0-9]{64}$/);
    expect(versions.CLAUDE_TARBALL_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(versions.CLAUDE_TARBALL_URL).toBe(`https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${versions.CLAUDE_VERSION}.tgz`);
    expect(versions.WORKER_PRIVATE_IP).toMatch(/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/);
    for (const k of ["TLS_SECRET_SERVER", "TLS_SECRET_CA"]) expect(versions[k]).toMatch(/^prod\/AgentWeb\/LoginHost\/(server|ca)$/);
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
      .replace("@@BRIDGE_URL@@", over.bridge ?? "https://backend.example.test/internal/tool-bridge/run/mcp");

  it("is accepted by the host's own schema once the two placeholders are filled", () => {
    const cfg = parseHostConfig(JSON.parse(fill()));
    expect(cfg.env).toBe("prod");
    expect(cfg.tls?.host).toBe(versions.WORKER_PRIVATE_IP);
    expect(cfg.tls?.clientCommonNames).toEqual(["agentweb-backend-prod"]);
    expect(cfg.manager.maxTurnsPerHost).toBe(8);
    expect(cfg.claude.version).toBe(versions.CLAUDE_VERSION);
    expect(cfg.claude.binaryPath).toBe(`/opt/aw-claude/${versions.CLAUDE_VERSION}/claude`);
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
