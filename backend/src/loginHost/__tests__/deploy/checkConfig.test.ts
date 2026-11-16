/**
 * ENG-2113 review fix: check-config.js (run by install.sh before it switches to a release) also runs the host's start-up trusted-path check on the rendered
 * config, over the staged files. Real temp tree; the owner is the test's uid.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { checkConfig } from "../../deploy/prod/check-config";

const PROD = join(__dirname, "..", "..", "deploy", "prod");
const versions = Object.fromEntries(
  readFileSync(join(PROD, "versions.env"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const uid = process.getuid?.() ?? 0;
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const REL = "/opt/aw-login-host/releases/login-host-abc-20261021000000";
const TLS = "/etc/aw-login-host/tls/login-host-abc-20261021000000";
const render = () =>
  readFileSync(join(PROD, "host-config.template.json"), "utf8")
    .replace(/@@CLAUDE_BIN_SHA256@@/g, versions.CLAUDE_BIN_SHA256)
    .replace(/@@BRIDGE_URL@@/g, "https://backend.example.test/internal/tool-bridge/run/mcp")
    .replace(/@@WORKER_IP@@/g, "172.31.30.50")
    .replace(/@@RELEASE_DIR@@/g, REL)
    .replace(/@@TLS_DIR@@/g, TLS)
    .replace(/@@CLAUDE_VERSION@@/g, versions.CLAUDE_VERSION)
    .replace(/@@NODE_VERSION@@/g, versions.NODE_VERSION);

/** A tree holding the staged release, the staged TLS set and the pinned node, all as the installer would leave them. */
function tree(over: { node?: "file" | "symlink"; cfgText?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chkcfg-"));
  roots.push(root);
  chmodSync(root, 0o755);
  const stageRel = join(root, "stage-rel");
  const stageTls = join(root, "stage-tls");
  const nodeRoot = join(root, "aw-node");
  const nodeFile = join(nodeRoot, `v${versions.NODE_VERSION}`, "bin", "node");
  const put = (p: string, mode = 0o755) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x", { mode });
    chmodSync(p, mode);
  };
  for (const f of ["claude-turn.sh", "aw-relay-shim.js", "aw-net.sh", "aw-write-file.sh", "system-prompt.txt"]) put(join(stageRel, f));
  for (const f of ["server.crt", "ca.crt"]) put(join(stageTls, f), 0o644);
  put(join(stageTls, "server.key"), 0o600);
  if (over.node === "symlink") {
    put(join(root, "real-node"));
    mkdirSync(dirname(nodeFile), { recursive: true });
    symlinkSync(join(root, "real-node"), nodeFile);
  } else put(nodeFile);
  for (const d of [root, stageRel, stageTls, nodeRoot, join(nodeRoot, `v${versions.NODE_VERSION}`), dirname(nodeFile)]) chmodSync(d, 0o755);
  const cfg = join(root, "prod.json");
  writeFileSync(cfg, over.cfgText ?? render());
  const args = ["--owner", String(uid), "--boundary", root, "--map", `${REL}=${stageRel}`, "--map", `${TLS}=${stageTls}`, "--map", `/opt/aw-node=${nodeRoot}`];
  return { root, cfg, args, stageRel, nodeFile };
}

describe("check-config: schema only (no --owner)", () => {
  it("accepts the rendered prod config and does not look at any path", () => {
    const t = tree();
    expect(checkConfig(t.cfg, [])).toBeUndefined();
    rmSync(t.nodeFile);
    expect(checkConfig(t.cfg, [])).toBeUndefined(); // a missing node is not a schema problem
  });
  it("MUTATION TARGET: a config without claude.nodePath is a schema problem (no default: /usr/bin/node is a symlink and would crash-loop the worker)", () => {
    const cfg = JSON.parse(readFileSync(tree().cfg, "utf8"));
    delete cfg.claude.nodePath;
    const t = tree({ cfgText: JSON.stringify(cfg) });
    expect(checkConfig(t.cfg, [])).toMatch(/claude\.nodePath/);
  });
  it("still reports a schema problem", () => {
    const t = tree({ cfgText: JSON.stringify({ env: "prod" }) });
    expect(checkConfig(t.cfg, [])).toMatch(/host config/);
  });
});

describe("check-config: the pre-switch trusted-path check", () => {
  it("the staged release, TLS set and real node pass", () => {
    const t = tree();
    expect(checkConfig(t.cfg, t.args)).toBeUndefined();
  });

  it("MUTATION TARGET: a node path that is a SYMLINK is refused, naming the configured path and the reason", () => {
    const t = tree({ node: "symlink" });
    const out = checkConfig(t.cfg, t.args);
    expect(out).toContain(`/opt/aw-node/v${versions.NODE_VERSION}/bin/node is not trusted`);
    expect(out).toContain("is a symlink");
    expect(out).not.toContain(t.root); // the message names the path the host will use, not the staging location
  });

  it("MUTATION TARGET: a missing node is refused", () => {
    const t = tree();
    rmSync(t.nodeFile);
    expect(checkConfig(t.cfg, t.args)).toContain("is not trusted");
  });

  it("MUTATION TARGET: the shim (a staged release file) with another owner, or writable by group/others, is refused", () => {
    const t = tree();
    expect(checkConfig(t.cfg, ["--owner", String(uid + 1), ...t.args.slice(2)])).toContain(`is not owned by uid ${uid + 1}`);
    chmodSync(join(t.stageRel, "aw-relay-shim.js"), 0o775);
    expect(checkConfig(t.cfg, t.args)).toContain(`${REL}/aw-relay-shim.js is not trusted`);
  });

  it("MUTATION TARGET: a symlinked shim is refused", () => {
    const t = tree();
    rmSync(join(t.stageRel, "aw-relay-shim.js"));
    symlinkSync(join(t.stageRel, "claude-turn.sh"), join(t.stageRel, "aw-relay-shim.js"));
    expect(checkConfig(t.cfg, t.args)).toContain("aw-relay-shim.js is not trusted");
  });

  it("MUTATION TARGET: the pinned node must be executable by a customer uid, and the shim readable (a root-only node would pass the owner check and still fail every customer unit)", () => {
    const t = tree();
    chmodSync(t.nodeFile, 0o750);
    expect(checkConfig(t.cfg, t.args)).toMatch(/aw-node\/v[0-9.]+\/bin\/node: .* not executable by other users/);
    chmodSync(t.nodeFile, 0o755);
    chmodSync(join(dirname(t.nodeFile)), 0o750);
    expect(checkConfig(t.cfg, t.args)).toMatch(/not traversable by other users/);
    chmodSync(dirname(t.nodeFile), 0o755);
    chmodSync(join(t.stageRel, "aw-relay-shim.js"), 0o700);
    expect(checkConfig(t.cfg, t.args)).toMatch(/aw-relay-shim\.js: .* not readable by other users/);
  });

  it("only paths under a --map are checked (system tools such as /usr/bin/systemd-run are the host's own start-up business)", () => {
    const t = tree();
    expect(checkConfig(t.cfg, ["--owner", String(uid), "--boundary", t.root])).toBeUndefined(); // no map: nothing to look at
  });

  it("bad arguments are refused, not ignored", () => {
    const t = tree();
    expect(checkConfig(t.cfg, ["--owner", "x"])).toMatch(/bad --owner/);
    expect(checkConfig(t.cfg, ["--owner", String(uid), "--map", "nonsense"])).toMatch(/bad --map/);
  });
});
