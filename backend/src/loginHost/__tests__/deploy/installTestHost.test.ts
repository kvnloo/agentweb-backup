/**
 * ENG-2113 review fix: install-test-host.sh checks the node it will name in the config BEFORE installing anything, the way the host's trusted-path check
 * will (owner, no group/other write) plus what a customer unit needs (others may traverse every directory and execute the file). Run through its
 * --check-node-only mode on real temp trees (owner = the test's uid, the walk stops at the temp root).
 */
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(__dirname, "..", "..", "deploy", "install-test-host.sh");
const uid = process.getuid?.() ?? 0;
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function tree() {
  const root = mkdtempSync(join(tmpdir(), "ith-"));
  roots.push(root);
  chmodSync(root, 0o755);
  const bin = join(root, "opt", "node", "bin");
  mkdirSync(bin, { recursive: true });
  for (const d of [join(root, "opt"), join(root, "opt", "node"), bin]) chmodSync(d, 0o755);
  const node = join(bin, "node");
  writeFileSync(node, "x", { mode: 0o755 });
  chmodSync(node, 0o755);
  return { root, bin, node };
}
const check = (path: string, root: string, owner = uid) => spawnSync("bash", [SCRIPT, "--check-node-only", path, String(owner), root], { encoding: "utf8" });

describe("install-test-host.sh: node path check", () => {
  it("a root-shaped real file passes and the real path is printed; a symlink to it resolves to that real path", () => {
    const t = tree();
    expect(check(t.node, t.root)).toMatchObject({ status: 0, stdout: t.node });
    const link = join(t.root, "usr-bin-node");
    symlinkSync(t.node, link);
    expect(check(link, t.root)).toMatchObject({ status: 0, stdout: t.node });
  });

  it("a nonexistent path says so (not 'not owned by root')", () => {
    const t = tree();
    const r = check(join(t.root, "nope", "node"), t.root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not exist");
  });

  it("MUTATION TARGET: a component owned by someone else is refused", () => {
    const t = tree();
    const r = check(t.node, t.root, uid + 1);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is not owned by uid");
  });

  it("MUTATION TARGET: a group- or other-writable directory is refused", () => {
    const t = tree();
    chmodSync(t.bin, 0o775);
    const r = check(t.node, t.root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("writable by group or others");
  });

  it("MUTATION TARGET: a directory others cannot traverse, or a file others cannot execute, is refused (a customer unit could not run node)", () => {
    const t = tree();
    chmodSync(t.bin, 0o750);
    expect(check(t.node, t.root).stderr).toContain("not executable/traversable by others");
    chmodSync(t.bin, 0o755);
    chmodSync(t.node, 0o750);
    expect(check(t.node, t.root).stderr).toContain("not executable/traversable by others");
  });

  it("MUTATION TARGET: the check runs before anything is installed (a failure leaves the previous start.js and test1.json in place)", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const checkAt = text.indexOf('NODE_REAL=$(check_node_path "$NODE_TARGET" 0)');
    expect(checkAt).toBeGreaterThan(0);
    for (const later of ["install -m", "mkdir -p $D", "ln -sf", "cat > /etc/aw-login-host/test1.json", "systemctl"]) {
      const at = text.indexOf(later);
      expect({ later, before: at > checkAt }).toEqual({ later, before: true });
    }
    expect(text).toContain('"nodePath": "$NODE_REAL"');
  });
});
