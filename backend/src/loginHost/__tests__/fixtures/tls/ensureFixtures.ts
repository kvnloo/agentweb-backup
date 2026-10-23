/**
 * ENG-2110: TEST-ONLY keys and certificates for the TLS tests, generated on demand with `openssl` (P-256, 100-year validity). They protect nothing and are
 * never deployed. They are NOT committed on purpose (`*.pem` is git-ignored, and key material in a repository trips secret scanners even when it is a test key):
 * every suite that needs them imports this module first, and the files are created the first time, by whichever test worker gets there first.
 *
 * Names and properties (the tests depend on them):
 *   ca / rogue-ca        self-signed CAs (aw-test-ca, rogue-ca)
 *   server               CN aw-login-worker-test, SAN 127.0.0.1 + localhost, serverAuth, signed by ca
 *   client               CN agentweb-backend-test, clientAuth, signed by ca              (the identity the host pins)
 *   other                CN somebody-else, clientAuth, signed by ca                      (valid chain, wrong identity)
 *   rogue-client         CN agentweb-backend-test, clientAuth, signed by rogue-ca        (right name, wrong CA)
 *   wrong-server         CN wrong, SAN 10.9.9.9, serverAuth, signed by ca, key = server.key.pem (a worker that names another address)
 *   deploy/fixtures/worker-server.pem   CN aw-login-worker-prod-test, SAN 172.31.30.50 (the production worker's address, which install.sh insists on)
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const TLS_DIR = __dirname;
const DEPLOY_FIXTURES = join(__dirname, "../../deploy/fixtures");
const MARKER = join(TLS_DIR, ".generated");

const openssl = (args: string[], cwd: string) => execFileSync("openssl", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

function generate(tmp: string): void {
  const key = (name: string) => openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", `${name}.key.pem`], tmp);
  const selfSigned = (name: string, cn: string) => openssl(["req", "-x509", "-new", "-key", `${name}.key.pem`, "-subj", `/CN=${cn}`, "-days", "36500", "-sha256", "-addext", "basicConstraints=critical,CA:TRUE", "-out", `${name}.pem`], tmp);
  const leaf = (out: string, keyName: string, cn: string, caName: string, ext: string) => {
    writeFileSync(join(tmp, `${out}.cnf`), ext + "\n");
    openssl(["req", "-new", "-key", `${keyName}.key.pem`, "-subj", `/CN=${cn}`, "-out", `${out}.csr`], tmp);
    openssl(["x509", "-req", "-in", `${out}.csr`, "-CA", `${caName}.pem`, "-CAkey", `${caName}.key.pem`, "-CAcreateserial", "-days", "36500", "-sha256", "-extfile", `${out}.cnf`, "-out", `${out}.pem`], tmp);
  };
  for (const k of ["ca", "rogue-ca", "server", "client", "other", "rogue-client"]) key(k);
  selfSigned("ca", "aw-test-ca");
  selfSigned("rogue-ca", "rogue-ca");
  leaf("server", "server", "aw-login-worker-test", "ca", "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth");
  leaf("client", "client", "agentweb-backend-test", "ca", "extendedKeyUsage=clientAuth");
  leaf("other", "other", "somebody-else", "ca", "extendedKeyUsage=clientAuth");
  leaf("rogue-client", "rogue-client", "agentweb-backend-test", "rogue-ca", "extendedKeyUsage=clientAuth");
  leaf("wrong-server", "server", "wrong", "ca", "subjectAltName=IP:10.9.9.9\nextendedKeyUsage=serverAuth");
  leaf("worker-server", "server", "aw-login-worker-prod-test", "ca", "subjectAltName=IP:172.31.30.50\nextendedKeyUsage=serverAuth");
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function ensureTlsFixtures(): void {
  if (existsSync(MARKER)) return;
  const lock = join(TLS_DIR, ".generating");
  let mine = false;
  try {
    mkdirSync(lock); // atomic: exactly one worker generates
    mine = true;
  } catch {
    /* another worker is generating: wait for it */
  }
  if (!mine) {
    for (let i = 0; i < 600 && !existsSync(MARKER); i++) sleepSync(100);
    if (!existsSync(MARKER)) throw new Error("the TLS test fixtures were not generated in time (is `openssl` installed?)");
    return;
  }
  const tmp = mkdtempSync(join(TLS_DIR, ".tmp-"));
  try {
    generate(tmp);
    mkdirSync(DEPLOY_FIXTURES, { recursive: true });
    for (const f of ["ca", "rogue-ca", "server", "client", "other", "rogue-client"]) {
      renameSync(join(tmp, `${f}.key.pem`), join(TLS_DIR, `${f}.key.pem`));
    }
    for (const f of ["ca", "rogue-ca", "server", "client", "other", "rogue-client", "wrong-server"]) renameSync(join(tmp, `${f}.pem`), join(TLS_DIR, `${f}.pem`));
    renameSync(join(tmp, "worker-server.pem"), join(DEPLOY_FIXTURES, "worker-server.pem"));
    writeFileSync(MARKER, new Date().toISOString());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

ensureTlsFixtures();
