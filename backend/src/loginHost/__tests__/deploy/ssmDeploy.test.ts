/**
 * ENG-2110: the SSM document body (ssm-run.sh) is the root of trust of every worker deploy, so it is EXECUTED here with real keys, real signatures
 * (real openssl, ECDSA P-256 as KMS produces), real tarballs and a fake `aws` that serves a local directory as the bucket. The protected ACTION is
 * what is asserted: a build that must be refused never gets unpacked and its deploy.sh never runs.
 */
import { generateKeyPairSync, createHash, sign as cryptoSign } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS script (run by hand by whoever installs the document)
const { render } = require("../../deploy/aws/render-ssm-doc.js") as { render: (o: Record<string, unknown>) => { parameters: Record<string, { allowedPattern: string; default?: string }>; mainSteps: Array<{ inputs: { runCommand: string[]; timeoutSeconds: string } }> } };

const NAME = "login-host-0123456789ab";
const KEY = `prod/builds/${NAME}.tar.gz`;
const OPENSSL = spawnSync("which", ["openssl"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/openssl";

const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubPem = (k: ReturnType<typeof pair>) => k.publicKey.export({ type: "spki", format: "pem" }).toString();

describe("ssm-run.sh (the deploy document's body)", () => {
  let dir: string;
  let bucket: string;
  let work: string;
  let marker: string;
  let signer: ReturnType<typeof pair>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ssm-run-"));
    bucket = join(dir, "bucket");
    work = join(dir, "work");
    marker = join(dir, "deploy-ran");
    mkdirSync(join(bucket, "prod/builds"), { recursive: true });
    mkdirSync(work);
    signer = pair();
    // the fake `aws`: s3 cp s3://<bucket>/<key> <dest>  ->  copy from the local bucket directory
    writeFileSync(join(dir, "aws"), `#!/bin/bash\n[ "$1 $2" = "s3 cp" ] || exit 9\nshift 2\nif [ "$1" = "--only-show-errors" ]; then shift; fi\nsrc=\${1#s3://fakebucket/}\ncp "${bucket}/$src" "$2"\n`);
    chmodSync(join(dir, "aws"), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A build directory laid out like the real one, with a deploy.sh that records how it was called. */
  function makePackage(opts: { name?: string; manifestName?: string; deploySh?: "regular" | "symlink" | "missing"; extra?: (pkgDir: string) => void; rc?: number } = {}) {
    const name = opts.name ?? NAME;
    const root = join(dir, "pkgroot");
    rmSync(root, { recursive: true, force: true });
    const pkg = join(root, name);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "MANIFEST"), `name=${opts.manifestName ?? name}\ncommit_time=2026-10-22T10:00:00Z\n`);
    if (opts.deploySh !== "missing") {
      if (opts.deploySh === "symlink") {
        writeFileSync(join(dir, "elsewhere.sh"), "echo hijacked\n");
        symlinkSync(join(dir, "elsewhere.sh"), join(pkg, "deploy.sh"));
      } else {
        writeFileSync(join(pkg, "deploy.sh"), `#!/bin/bash\necho "$@" > "${marker}"\nexit ${opts.rc ?? 0}\n`);
        chmodSync(join(pkg, "deploy.sh"), 0o755);
      }
    }
    opts.extra?.(pkg);
    return { root, name };
  }
  const tarUp = (root: string, name: string, tarName = `${name}.tar.gz`, extraArgs: string[] = []) => {
    const out = join(bucket, "prod/builds", tarName);
    const r = spawnSync("tar", ["-czf", out, ...extraArgs, "-C", root, name]);
    expect(r.status).toBe(0);
    return out;
  };
  /** What the pipeline does: sha256 of the tarball, signed with the key (DER ECDSA, like KMS). */
  const signFile = (tarball: string, key = signer, sigPath = `${tarball}.sig`) => writeFileSync(sigPath, cryptoSign("sha256", readFileSync(tarball), key.privateKey));

  /** Renders the document with scratch paths, substitutes the two parameters the way SSM does, and runs the script. */
  function runDoc(params: { BuildKey?: string; MaxWait?: string } = {}, publicKey = signer) {
    const doc = render({ publicKeyPem: pubPem(publicKey), bucket: "fakebucket", workBase: work, aws: join(dir, "aws"), openssl: OPENSSL });
    const script = doc.mainSteps[0].inputs.runCommand.join("\n").replace("{{ BuildKey }}", params.BuildKey ?? KEY).replace("{{ MaxWait }}", params.MaxWait ?? "1800");
    writeFileSync(join(dir, "doc.sh"), "#!/bin/bash\n" + script);
    const r = spawnSync("bash", [join(dir, "doc.sh")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 60_000 });
    return { rc: r.status, out: r.stdout + r.stderr };
  }
  const deployRan = () => existsSync(marker);
  const workLeft = () => readdirSync(work);

  it("a build signed by the pipeline is verified, unpacked and its deploy.sh runs with the wait limit; the scratch directory is removed", () => {
    const { root, name } = makePackage();
    signFile(tarUp(root, name));
    const r = runDoc({ MaxWait: "600" });
    expect(r.out).toContain("signature verified");
    expect(r.rc).toBe(0);
    expect(readFileSync(marker, "utf8").trim()).toBe("--max-wait 600");
    expect(workLeft()).toEqual([]);
  });

  it("a machine without aws or openssl is 'could not prepare' (21), never reported as a bad signature (20)", () => {
    const { root, name } = makePackage();
    signFile(tarUp(root, name));
    rmSync(join(dir, "aws"));
    const r = runDoc();
    expect(r.rc).toBe(21);
    expect(deployRan()).toBe(false);
  });

  it("a tool failing BEFORE deploy.sh starts (download, unpack) is 21 'could not prepare', never a code deploy.sh uses (tar and aws also exit 2 = 'host DOWN')", () => {
    const { root, name } = makePackage();
    signFile(tarUp(root, name));
    writeFileSync(join(dir, "aws"), "#!/bin/bash\nexit 2\n");
    const r = runDoc();
    expect(r.rc).toBe(21);
    expect(deployRan()).toBe(false);
    expect(workLeft()).toEqual([]);
  });

  it("deploy.sh's exit code is the document's result (75 'not idle' must reach the pipeline as 75)", () => {
    const { root, name } = makePackage({ rc: 75 });
    signFile(tarUp(root, name));
    expect(runDoc().rc).toBe(75);
  });

  it("a signature made the way KMS makes it (over the DIGEST, DER ECDSA) verifies", () => {
    const { root, name } = makePackage();
    const tar = tarUp(root, name);
    const digest = createHash("sha256").update(readFileSync(tar)).digest();
    writeFileSync(join(dir, "digest.bin"), digest);
    writeFileSync(join(dir, "priv.pem"), signer.privateKey.export({ type: "pkcs8", format: "pem" }));
    const s = spawnSync(OPENSSL, ["pkeyutl", "-sign", "-inkey", join(dir, "priv.pem"), "-in", join(dir, "digest.bin")]);
    expect(s.status).toBe(0);
    writeFileSync(`${tar}.sig`, s.stdout);
    expect(runDoc().rc).toBe(0);
    expect(deployRan()).toBe(true);
  });

  describe("refused: the build is never unpacked and deploy.sh never runs", () => {
    const refused = (r: { rc: number | null; out: string }, why: string) => {
      expect(r.rc).toBe(20); // distinct from every deploy.sh code: the pipeline reports it as a security event
      expect(r.out).toContain("REFUSED");
      expect(r.out).toContain(why);
      expect(deployRan()).toBe(false);
      expect(workLeft()).toEqual([]);
    };

    it("signed by a DIFFERENT key (anyone who can write to the bucket, but is not the pipeline)", () => {
      const { root, name } = makePackage();
      signFile(tarUp(root, name), pair());
      refused(runDoc(), "signature does not verify");
    });

    it("no signature file at all", () => {
      const { root, name } = makePackage();
      tarUp(root, name);
      expect(runDoc().rc).not.toBe(0);
      expect(deployRan()).toBe(false);
    });

    it("an empty or garbage signature", () => {
      const { root, name } = makePackage();
      const tar = tarUp(root, name);
      writeFileSync(`${tar}.sig`, "not a signature");
      refused(runDoc(), "signature does not verify");
      writeFileSync(`${tar}.sig`, "");
      refused(runDoc(), "implausible size");
    });

    it("a tarball altered after signing (one byte)", () => {
      const { root, name } = makePackage();
      const tar = tarUp(root, name);
      signFile(tar);
      const bytes = readFileSync(tar);
      bytes[bytes.length - 20] ^= 0xff;
      writeFileSync(tar, bytes);
      refused(runDoc(), "signature does not verify");
    });

    it("a signature copied from another, genuine build", () => {
      const a = makePackage();
      const tarA = tarUp(a.root, a.name);
      signFile(tarA);
      const sigA = readFileSync(`${tarA}.sig`);
      const b = makePackage({ extra: (p) => writeFileSync(join(p, "extra.txt"), "different content") });
      const tarB = tarUp(b.root, b.name);
      writeFileSync(`${tarB}.sig`, sigA);
      refused(runDoc(), "signature does not verify");
    });

    it("a document installed with a different public key refuses the pipeline's builds (key rotation must be deliberate)", () => {
      const { root, name } = makePackage();
      signFile(tarUp(root, name));
      refused(runDoc({}, pair()), "signature does not verify");
    });

    it("a correctly signed archive with a path that escapes, before anything is extracted", () => {
      const { root, name } = makePackage();
      writeFileSync(join(root, "evil.txt"), "x");
      const tar = tarUp(root, name, `${name}.tar.gz`, ["-C", root, "--transform", `s,^evil.txt,../evil.txt,`, "evil.txt"]);
      signFile(tar);
      refused(runDoc(), "unsafe path");
      expect(existsSync(join(dir, "evil.txt"))).toBe(false);
    });

    it("a correctly signed archive with an absolute path", () => {
      const { root, name } = makePackage();
      writeFileSync(join(root, "abs.txt"), "x");
      const tar = tarUp(root, name, `${name}.tar.gz`, ["-P", "-C", root, "--transform", `s,^abs.txt,${dir}/abs-out.txt,`, "abs.txt"]);
      signFile(tar);
      refused(runDoc(), "unsafe path");
      expect(existsSync(join(dir, "abs-out.txt"))).toBe(false);
    });

    it("a correctly signed archive whose top directory is not the one named", () => {
      const { root, name } = makePackage({ name: "login-host-aaaaaaaaaaaa" });
      const tar = tarUp(root, name, `${NAME}.tar.gz`);
      signFile(tar);
      refused(runDoc(), "outside");
    });

    it("a correctly signed archive whose MANIFEST names a different build", () => {
      const { root, name } = makePackage({ manifestName: "login-host-bbbbbbbbbbbb" });
      signFile(tarUp(root, name));
      refused(runDoc(), "MANIFEST names a different build");
    });

    it("a correctly signed archive whose deploy.sh is missing", () => {
      const { root, name } = makePackage({ deploySh: "missing" });
      signFile(tarUp(root, name));
      refused(runDoc(), "no deploy.sh");
    });

    it("a correctly signed archive containing a symlink or a hard link is refused before anything is extracted (only plain files and directories)", () => {
      const { root, name } = makePackage({ deploySh: "symlink" });
      signFile(tarUp(root, name));
      refused(runDoc(), "not a plain file");
      const p2 = makePackage({ extra: (pkg) => { writeFileSync(join(pkg, "a.txt"), "x"); spawnSync("ln", [join(pkg, "a.txt"), join(pkg, "b.txt")]); } });
      signFile(tarUp(p2.root, p2.name));
      refused(runDoc(), "not a plain file");
    });

    it.each([
      ["a path walk", "prod/builds/../../etc/passwd"],
      ["another prefix", "staging/builds/login-host-0123456789ab.tar.gz"],
      ["a dirty build", "prod/builds/login-host-0123456789ab-dirty.tar.gz"],
      ["an upper-case hash", "prod/builds/login-host-0123456789AB.tar.gz"],
      ["a short hash", "prod/builds/login-host-0123.tar.gz"],
      ["a signature file as the build", "prod/builds/login-host-0123456789ab.tar.gz.sig"],
    ])("BuildKey with %s", (_why, key) => {
      const { root, name } = makePackage();
      signFile(tarUp(root, name));
      const r = runDoc({ BuildKey: key });
      expect(r.rc).toBe(20);
      expect(r.out).toContain("BuildKey is not");
      expect(deployRan()).toBe(false);
    });

    // SSM substitutes `{{ }}` as TEXT before bash parses the script, so a value that breaks out of its quotes would run before any check in the script. The
    // defence is the document's allowedPattern, which SSM enforces BEFORE substituting: these must all fail it (and they are exactly what a person could try).
    it.each([
      "prod/builds/login-host-0123456789ab.tar.gz'; touch /tmp/pwned; '",
      "prod/builds/login-host-0123456789ab.tar.gz\nreboot",
      "prod/builds/login-host-0123456789ab.tar.gz$(reboot)",
      "prod/builds/login-host-0123456789ab.tar.gz`reboot`",
      "prod/builds/login-host-0123456789ab.tar.gz ",
      " prod/builds/login-host-0123456789ab.tar.gz",
      "prod/builds/login-host-0123456789ab.tar.gz\n",
    ])("the document's BuildKey pattern rejects %j before anything is substituted", (v) => {
      const re = new RegExp(render(ok).parameters.BuildKey.allowedPattern);
      expect(re.test(v)).toBe(false);
    });
    it.each(["1800'; reboot; '", "1800\nreboot", "1800 ", "$(reboot)", "-1", "", "0800", "00"])("the document's MaxWait pattern rejects %j", (v) => {
      expect(new RegExp(render(ok).parameters.MaxWait.allowedPattern).test(v)).toBe(false);
    });
    it("and accepts the real values", () => {
      const doc = render(ok);
      expect(new RegExp(doc.parameters.BuildKey.allowedPattern).test(KEY)).toBe(true);
      expect(new RegExp(doc.parameters.MaxWait.allowedPattern).test("1800")).toBe(true);
    });

    it.each(["", "abc", "1800; reboot", "-1", "12345", "3001", "0800", "0900", "00"])("MaxWait %j", (v) => {
      const { root, name } = makePackage();
      signFile(tarUp(root, name));
      const r = runDoc({ MaxWait: v });
      expect(r.rc).toBe(20);
      expect(r.out).toContain("MaxWait is not");
      expect(deployRan()).toBe(false);
    });
  });
});

const ok = { publicKeyPem: pubPem(pair()), bucket: "agentweb-login-host-992382574572" };

describe("render-ssm-doc.js", () => {

  it("renders a document that constrains both parameters and carries the public key, never a private one", () => {
    const doc = render(ok);
    expect(doc.parameters.BuildKey.allowedPattern).toBe("^prod/builds/login-host-[0-9a-f]{12}\\.tar\\.gz$");
    expect(doc.parameters.MaxWait.allowedPattern).toBe("^(0|[1-9][0-9]{0,3})$");
    const script = doc.mainSteps[0].inputs.runCommand.join("\n");
    expect(script).toContain("BEGIN PUBLIC KEY");
    expect(script).not.toContain("PRIVATE KEY");
    expect(script).toContain("s3://$BUCKET/$BUILD_KEY");
    expect(script).toContain("agentweb-login-host-992382574572");
    expect(script).not.toMatch(/@@[A-Z_]+@@/);
    expect(Number(doc.mainSteps[0].inputs.timeoutSeconds)).toBeGreaterThan(9999 + 3600); // longer than the longest allowed idle wait plus install and two health checks
    expect(script.startsWith("#!/bin/bash")).toBe(true); // SSM honours the shebang; the script needs bash
  });

  it("refuses a key that is not EC P-256 (RSA, P-384, garbage, a private key)", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    for (const publicKeyPem of [rsa, p384, "garbage"]) expect(() => render({ ...ok, publicKeyPem })).toThrow();
  });

  it("refuses a script that would let SSM substitute anything beyond the two parameters, or that has an unfilled placeholder", () => {
    expect(() => render({ ...ok, script: "x '{{ BuildKey }}' '{{ Other }}' @@BUCKET@@ @@WORK_BASE@@ @@AWS@@ @@OPENSSL@@ @@PUBLIC_KEY@@" })).toThrow("not one of the two parameters");
    expect(() => render({ ...ok, script: "'{{ BuildKey }}' @@BUCKET@@ @@MYSTERY@@" })).toThrow("unfilled placeholder");
  });

  it("refuses a bucket name that could inject into the script", () => {
    expect(() => render({ ...ok, bucket: "b'; rm -rf /; '" })).toThrow();
  });

  it("the document body is the repo file, so a review of the file is a review of what runs as root", () => {
    const body = readFileSync(join(__dirname, "../../deploy/prod/ssm-run.sh"), "utf8");
    expect(body).toMatch(/^set -euo pipefail$/m);
    expect(body).toContain('verdict=$("$OPENSSL" dgst -sha256 -verify');
  });
});
