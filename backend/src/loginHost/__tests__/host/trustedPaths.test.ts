/**
 * ENG-2113 review fix: the host refuses to start if ANY path it hands to a customer unit has a symlink on it (assertTrustedPath). On the prod worker
 * /usr/bin/node is a symlink to /opt/aw-node/v<ver>/bin/node (install.sh), so the RENDERED prod config must name the real path. These tests run the rendered
 * config through the very list runMain checks, over a real temp tree.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { assertTrustedPath } from "../../host/binary";
import { assertHostTrustedPaths, hostTrustedPaths } from "../../host/main";
import { assertCustomerCanUse } from "../../host/trustedPaths";
import { parseHostConfig } from "../../host/hostConfig";

const PROD = join(__dirname, "..", "..", "deploy", "prod");
const versions = Object.fromEntries(
  readFileSync(join(PROD, "versions.env"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
/** The substitutions install.sh's renderer makes (its python block), with install.sh's own values. */
const render = () =>
  readFileSync(join(PROD, "host-config.template.json"), "utf8")
    .replace(/@@CLAUDE_BIN_SHA256@@/g, versions.CLAUDE_BIN_SHA256)
    .replace(/@@BRIDGE_URL@@/g, "https://backend.example.test/internal/tool-bridge/run/mcp")
    .replace(/@@WORKER_IP@@/g, "172.31.30.50")
    .replace(/@@RELEASE_DIR@@/g, "/opt/aw-login-host/releases/login-host-abc-20261021000000")
    .replace(/@@TLS_DIR@@/g, "/etc/aw-login-host/tls/login-host-abc-20261021000000")
    .replace(/@@CLAUDE_VERSION@@/g, versions.CLAUDE_VERSION)
    .replace(/@@NODE_VERSION@@/g, versions.NODE_VERSION);

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe("the rendered prod config names a node path that cannot be a symlink", () => {
  const install = readFileSync(join(PROD, "install.sh"), "utf8");
  it("claude.nodePath is the versioned real path, and install.sh's renderer fills the placeholder", () => {
    const text = render();
    expect(text).not.toContain("@@");
    const cfg = parseHostConfig(JSON.parse(text));
    expect(cfg.claude.nodePath).toBe(`/opt/aw-node/v${versions.NODE_VERSION}/bin/node`);
    expect(install).toContain('("@@NODE_VERSION@@", nodever)');
    expect(install).toContain('"$CLAUDE_VERSION" "$NODE_VERSION" <<');
  });

  it("by construction: install.sh links ONLY /usr/bin/node (to the versioned path), and the config path is neither that link nor under any link install.sh makes", () => {
    const links = [...install.matchAll(/ln -sfn?\s+("?[^\s]+"?)\s+("?[^\s]+"?)/g)].map((m) => m[2].replace(/"/g, ""));
    expect(links).toContain("/usr/bin/node");
    const cfg = parseHostConfig(JSON.parse(render()));
    for (const link of links.filter((l) => l.startsWith("/"))) {
      expect(cfg.claude.nodePath === link || cfg.claude.nodePath.startsWith(link + "/")).toBe(false);
    }
    expect(cfg.claude.nodePath).toMatch(/^\/opt\/aw-node\/v[0-9.]+\/bin\/node$/);
    // the path install.sh installs the real binary at is exactly the one the config names
    expect(install).toContain("NODE_DIR=/opt/aw-node/v$NODE_VERSION");
  });
});

describe("assertCustomerCanUse: a customer uid (not root, not the owner) must be able to reach what its unit is given", () => {
  const make = () => {
    const root = mkdtempSync(join(tmpdir(), "cust-"));
    roots.push(root);
    const dir = join(root, "a", "b");
    mkdirSync(dir, { recursive: true });
    for (const d of [root, join(root, "a"), dir]) chmodSync(d, 0o755);
    const file = join(dir, "node");
    writeFileSync(file, "x", { mode: 0o755 });
    chmodSync(file, 0o755);
    return { root, dir, file };
  };
  it("MUTATION TARGET: an executable file under traversable directories passes; a file others cannot execute, or a directory others cannot traverse, is refused with a clear message", () => {
    const t = make();
    expect(() => assertCustomerCanUse(t.file, "execute", t.root)).not.toThrow();
    chmodSync(t.file, 0o750);
    expect(() => assertCustomerCanUse(t.file, "execute", t.root)).toThrow(/not executable by other users/);
    chmodSync(t.file, 0o755);
    chmodSync(t.dir, 0o750);
    expect(() => assertCustomerCanUse(t.file, "execute", t.root)).toThrow(/not traversable by other users/);
    chmodSync(t.dir, 0o755);
    chmodSync(join(t.root, "a"), 0o700);
    expect(() => assertCustomerCanUse(t.file, "execute", t.root)).toThrow(/not traversable/);
  });
  it("MUTATION TARGET: the shim only needs to be READABLE by others (node reads it), not executable", () => {
    const t = make();
    chmodSync(t.file, 0o644);
    expect(() => assertCustomerCanUse(t.file, "read", t.root)).not.toThrow();
    expect(() => assertCustomerCanUse(t.file, "execute", t.root)).toThrow();
    chmodSync(t.file, 0o640);
    expect(() => assertCustomerCanUse(t.file, "read", t.root)).toThrow(/not readable by other users/);
  });
});

describe("the rendered config through the host's trusted-path list (real temp tree)", () => {
  const uid = process.getuid?.() ?? 0;

  /** Builds `tree` under a temp root with a real file for every path the list names; `nodeIsLink` makes /usr/bin/node a symlink to the real node. */
  function tree(nodePath: string, nodeIsLink: boolean) {
    const root = mkdtempSync(join(tmpdir(), "trusted-"));
    roots.push(root);
    const cfg = parseHostConfig({ ...JSON.parse(render()), claude: { ...JSON.parse(render()).claude, nodePath } });
    const real = `/opt/aw-node/v${versions.NODE_VERSION}/bin/node`;
    for (const p of hostTrustedPaths(cfg)) {
      const target = join(root, p);
      mkdirSync(dirname(target), { recursive: true });
      if (p === nodePath && nodeIsLink) continue; // created below
      writeFileSync(target, "x", { mode: 0o755 });
    }
    mkdirSync(dirname(join(root, real)), { recursive: true });
    writeFileSync(join(root, real), "x", { mode: 0o755 });
    if (nodeIsLink) {
      mkdirSync(dirname(join(root, nodePath)), { recursive: true });
      symlinkSync(join(root, real), join(root, nodePath));
    }
    // every directory: owned by us, not writable by group/other (what root-owned 0755 is on the worker)
    const fix = (d: string) => {
      for (let p = d; p.startsWith(root); p = dirname(p)) {
        chmodSync(p, 0o755);
        if (p === root) break;
      }
    };
    for (const p of hostTrustedPaths(cfg)) fix(dirname(join(root, p)));
    fix(dirname(join(root, real)));
    const check = (p: string) => assertTrustedPath(join(root, p), { expectedOwnerUid: uid, boundary: root });
    return { cfg, check };
  }

  it("the rendered prod config passes every check when node is the real file", () => {
    const { cfg, check } = tree(parseHostConfig(JSON.parse(render())).claude.nodePath, false);
    expect(() => assertHostTrustedPaths(cfg, check)).not.toThrow();
  });

  it("MUTATION TARGET: the old default (/usr/bin/node, a symlink on the worker) makes the host refuse to start", () => {
    const { cfg, check } = tree("/usr/bin/node", true);
    expect(() => assertHostTrustedPaths(cfg, check)).toThrow(/is a symlink/);
  });

  it("MUTATION TARGET: the list is exactly every executed or policy file (a regression that drops one would let an untrusted file run)", () => {
    const cfg = parseHostConfig(JSON.parse(render()));
    const rel = "/opt/aw-login-host/releases/login-host-abc-20261021000000";
    const tls = "/etc/aw-login-host/tls/login-host-abc-20261021000000";
    // EXACTLY this list, in this order (runMainTrusted.test.ts relies on the order): every file a customer unit runs or reads as policy, and every tool the host runs as root.
    expect(hostTrustedPaths(cfg)).toEqual([
      `${tls}/server.crt`,
      `${tls}/server.key`,
      `${tls}/ca.crt`,
      `${rel}/claude-turn.sh`,
      `${rel}/aw-relay-shim.js`,
      `/opt/aw-node/v${versions.NODE_VERSION}/bin/node`,
      `${rel}/aw-net.sh`,
      "/usr/bin/socat",
      `${rel}/system-prompt.txt`,
      `${rel}/aw-write-file.sh`,
      "/usr/bin/systemd-run",
      "/usr/bin/systemctl",
      "/usr/bin/setpriv",
      "/usr/bin/env",
      "/usr/bin/rm",
      "/usr/bin/find",
      "/usr/sbin/setquota",
    ]);
    // without TLS and quota, exactly those entries drop out
    const plain = parseHostConfig({ ...JSON.parse(render()), tls: undefined, quota: undefined });
    expect(hostTrustedPaths(plain)).toEqual(hostTrustedPaths(cfg).filter((p) => !p.startsWith(tls) && p !== "/usr/sbin/setquota"));
  });
});
