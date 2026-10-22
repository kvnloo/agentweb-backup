/**
 * ENG-2110: scripts/sign-login-host.sh, the pipeline's signing step, against a fake `aws kms` that signs with a real local EC P-256 key exactly as KMS
 * does (DER ECDSA over the DIGEST). The result must verify the way the worker's document verifies it.
 */
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync } from "crypto";

const SCRIPT = join(__dirname, "../../../../scripts/sign-login-host.sh");

describe("sign-login-host.sh", () => {
  let dir: string;
  const run = (tarName: string, awsBody: string) => {
    writeFileSync(join(dir, "aws"), `#!/bin/bash\n${awsBody}\n`);
    chmodSync(join(dir, "aws"), 0o755);
    return spawnSync("bash", [SCRIPT, join(dir, tarName), "alias/test-key"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", AW_AWS: join(dir, "aws") } });
  };
  /** A fake `aws`: kms sign signs the digest with the key; kms get-public-key returns its DER public half. */
  let awsGood: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sign-"));
    const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(join(dir, "priv.pem"), k.privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(join(dir, "pub.der.b64"), k.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    awsGood = `
if [ "$1 $2" = "kms sign" ]; then
  # the digest file is given as fileb://<path>
  for a in "$@"; do case "$a" in fileb://*) f=\${a#fileb://} ;; esac; done
  openssl pkeyutl -sign -inkey "${join(dir, "priv.pem")}" -in "$f" | base64 -w0; echo; exit 0
fi
if [ "$1 $2" = "kms get-public-key" ]; then cat "${join(dir, "pub.der.b64")}"; exit 0; fi
exit 9`;
    writeFileSync(join(dir, "login-host-0123456789ab.tar.gz"), "pretend tarball bytes");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a signature that verifies over the tarball with the key's public half", () => {
    const r = run("login-host-0123456789ab.tar.gz", awsGood);
    expect(r.status).toBe(0);
    const sig = join(dir, "login-host-0123456789ab.tar.gz.sig");
    expect(existsSync(sig)).toBe(true);
    writeFileSync(join(dir, "pub.der"), Buffer.from(readFileSync(join(dir, "pub.der.b64"), "utf8"), "base64"));
    expect(spawnSync("openssl", ["pkey", "-pubin", "-inform", "DER", "-in", join(dir, "pub.der"), "-out", join(dir, "pub.pem")]).status).toBe(0);
    const v = spawnSync("openssl", ["dgst", "-sha256", "-verify", join(dir, "pub.pem"), "-signature", sig, join(dir, "login-host-0123456789ab.tar.gz")], { encoding: "utf8" });
    expect(v.stdout.trim()).toBe("Verified OK");
  });

  it("fails (and writes NO signature) when KMS signed with a different key than the one it reports", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(join(dir, "pub.der.b64"), other.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    const r = run("login-host-0123456789ab.tar.gz", awsGood);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not verify");
    expect(existsSync(join(dir, "login-host-0123456789ab.tar.gz.sig"))).toBe(false);
  });

  it("fails when KMS itself fails (no permission, no key), writing nothing", () => {
    const r = run("login-host-0123456789ab.tar.gz", 'echo "AccessDenied" >&2; exit 254');
    expect(r.status).not.toBe(0);
    expect(existsSync(join(dir, "login-host-0123456789ab.tar.gz.sig"))).toBe(false);
  });

  it.each(["login-host-0123456789ab-dirty.tar.gz", "login-host-xyz.tar.gz", "something.tar.gz"])("never signs %s (only clean, committed builds are signed)", (name) => {
    writeFileSync(join(dir, name), "x");
    const r = run(name, awsGood);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to sign");
    expect(existsSync(join(dir, `${name}.sig`))).toBe(false);
  });

  it("is strict bash", () => {
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/^set -euo pipefail$/m);
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });
});
