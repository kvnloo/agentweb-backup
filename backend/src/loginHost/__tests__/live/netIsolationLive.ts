/**
 * ENG-2110 PR 2: MANUAL live proof of the network isolation on the test instance, with NO login needed. It builds the exact
 * `systemd-run` command the host builds for a customer process (same Layout/unitProperties/systemRunArgs code, the installed host
 * config) and runs probe commands INSIDE that real hardened unit as a customer uid: the unit must have no network of its own, see only
 * the egress proxy socket, reach only allowlisted hosts through the proxy, and share nothing with the host's network namespace.
 *
 *   sudo node netIsolationLive.js        (the host aw-login-host@test1 must be running: it owns the proxy)
 */
import { execFileSync, spawn, spawnSync } from "child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createServer, type Server } from "net";
import { parseHostConfig } from "../../host/hostConfig";
import { startEgressProxy, type EgressProxyHandle } from "../../egress/egressProxy";
import { bridgeTarget, layoutFor, portConfigFor } from "../../host/main";
import { systemRunArgs } from "../../ports/unitArgs";

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};

const cfg = parseHostConfig(JSON.parse(readFileSync(process.env.AW_HOST_CONFIG ?? "/etc/aw-login-host/test1.json", "utf8")));
const layout = layoutFor(cfg);
const port = portConfigFor(cfg);
const UID = cfg.uidMax - 3; // two uids at the top of the range, unlikely to be in use
const UID_B = cfg.uidMax - 4;
const REF = "home-ffffffffffff";
const PROBE_DIR = "/run/aw-egress-probe"; // this script runs its OWN proxy (the same code the host runs), so the host's is left alone
const PER_UID_MAX = 8;
let proxy: EgressProxyHandle | undefined;

function unitArgsFor(script: string, suffix: string, uid: number): string[] {
  const refDir = layout.refDir(uid, "home", REF);
  // A unit's argv may not contain $ or % (the service manager expands them): the probe travels as a file the customer owns.
  const scriptPath = `${refDir}/work/probe-${suffix}.sh`;
  writeFileSync(scriptPath, script + "\n");
  chmodSync(scriptPath, 0o700);
  chownSync(scriptPath, uid, uid);
  return systemRunArgs(
    layout,
    {
      uid, unitName: layout.unitName(uid, suffix), refDir, file: "/bin/sh", args: [scriptPath],
      env: { PATH: "/usr/bin:/bin", HOME: `${refDir}/home`, TMPDIR: "/tmp" }, cwd: `${refDir}/work`,
    },
    { memoryMax: cfg.limits.memoryMax, tasksMax: cfg.limits.tasksMax, tmpSize: cfg.limits.tmpSize, shmSize: cfg.limits.shmSize, runtimeMaxSec: 120 },
    // ITS OWN proxy socket directory, exactly as the host binds it for this uid.
    { ...port.paths, net: { ...port.paths.net!, dir: proxy!.listenFor(uid) } },
  );
}

// Async on purpose: the proxy runs in THIS process, and a blocking spawn would starve it while the sandbox waits for it.
function inSandbox(script: string, suffix: string, uid = UID): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(port.paths.systemRun, unitArgsFor(script, suffix, uid), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("close", (code) => {
      clearTimeout(t);
      resolve({ out, code });
    });
  });
}

function makeRefDir(uid: number): void {
  // The customer's reference directory, as the host would have created it (root-owned parents, uid-owned leaf dirs).
  const refDir = layout.refDir(uid, "home", REF);
  mkdirSync(refDir, { recursive: true });
  for (const d of ["home", "work", "tmp"]) {
    mkdirSync(`${refDir}/${d}`, { recursive: true });
    chownSync(`${refDir}/${d}`, uid, uid);
  }
}

const ownedUids = new Set<number>(); // only what THIS run created is ever stopped or deleted

async function main() {
  // The probe uses two uids at the top of the host's range. If either already has a directory (the host may have allocated it to a
  // real connection), do nothing: stopping its slice or deleting its directory would destroy a customer's data.
  for (const u of [UID, UID_B]) {
    if (existsSync(layout.uidDir(u))) throw new Error(`refusing: uid ${u} already has a directory (in use by the host?)`);
  }
  makeRefDir(UID);
  makeRefDir(UID_B);
  ownedUids.add(UID);
  ownedUids.add(UID_B);
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true, mode: 0o755 });
  proxy = await startEgressProxy({
    perUid: { dir: PROBE_DIR, max: PER_UID_MAX, ownByUid: true },
    allow: cfg.egress.allow,
    bridge: bridgeTarget(cfg.claude.bridgeUrl),
    logger: { warn: (event, f) => console.log(`  [proxy] ${event} ${JSON.stringify(f)}`) },
  });

  // Things in the HOST's network namespace that the sandbox must not reach.
  const hostTcp: Server = createServer((c) => c.end("host-secret\n"));
  await new Promise<void>((r) => hostTcp.listen(39999, "127.0.0.1", r));
  const abstractName = "aw-net-iso-probe";
  const hostAbstract: Server = createServer((c) => c.end("abstract-secret\n"));
  await new Promise<void>((r) => hostAbstract.listen("\0" + abstractName, r));

  const probe = [
    'echo "IFACES=$(cut -d: -f1 /proc/net/dev | tail -n +3 | tr -d \' \' | tr \'\\n\' \',\')"',
    'echo "RUN=$(ls /run | tr \'\\n\' \',\')"',
    'echo "DIRECT_INTERNET=$(curl -s -m 4 --noproxy \'*\' -o /dev/null -w \'%{http_code}\' https://api.anthropic.com/ 2>/dev/null || true)"',
    'echo "HOST_LOOPBACK=$(curl -s -m 3 --noproxy \'*\' http://127.0.0.1:39999/ 2>/dev/null || true)"',
    `echo "ABSTRACT=$(socat -T2 - ABSTRACT-CONNECT:${abstractName} </dev/null 2>/dev/null || true)"`,
    'echo "PROXY_ALLOWED=$(curl -s -m 10 -o /dev/null -w \'%{http_code}\' https://api.anthropic.com/ 2>/dev/null || true)"',
    'echo "PROXY_DENIED=$(curl -s -m 10 -o /dev/null -w \'%{http_code}\' https://example.com/ 2>/dev/null || true)"',
    'echo "PROXY_IMDS=$(curl -s -m 6 -o /dev/null -w \'%{http_code}\' http://169.254.169.254/latest/meta-data/ 2>/dev/null || true)"',
    'echo "PROXY_LOOPBACK=$(curl -s -m 6 -o /dev/null -w \'%{http_code}\' http://127.0.0.1:39999/ 2>/dev/null || true)"',
    'echo "WHOAMI=$(id -u)"',
  ].join("\n");
  const r = await inSandbox(probe, "00000000000000a1");
  const v: Record<string, string> = {};
  for (const line of r.out.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) v[m[1]] = m[2];
  }
  console.log(`(sandbox exit ${r.code}; ${Object.keys(v).length} probe values)`);
  check("runs-as-customer-uid", v.WHOAMI === String(UID));
  check("only-loopback-interface", v.IFACES === "lo,", `ifaces=${v.IFACES}`);
  // /run is an empty tmpfs: only the egress proxy directory (ours) and systemd's own per-unit notify directory (it creates it) exist.
  check("run-shows-only-egress-dir", v.RUN === "aw-egress," || v.RUN === "aw-egress,systemd,", `run=${v.RUN}`);
  check("direct-internet-impossible", v.DIRECT_INTERNET === "000" || v.DIRECT_INTERNET === "", `code=${v.DIRECT_INTERNET}`);
  check("host-loopback-service-unreachable", !(v.HOST_LOOPBACK ?? "").includes("host-secret"));
  check("host-abstract-socket-unreachable", !(v.ABSTRACT ?? "").includes("abstract-secret"));
  check("proxy-reaches-allowlisted-host", /^(200|301|302|401|403|404)$/.test(v.PROXY_ALLOWED ?? ""), `code=${v.PROXY_ALLOWED}`);
  check("proxy-refuses-other-hosts", v.PROXY_DENIED === "000" || v.PROXY_DENIED === "", `code=${v.PROXY_DENIED}`);
  check("proxy-refuses-metadata-service", v.PROXY_IMDS === "000" || v.PROXY_IMDS === "" || v.PROXY_IMDS === "403" || v.PROXY_IMDS === "400", `code=${v.PROXY_IMDS}`);
  check("proxy-refuses-host-loopback", v.PROXY_LOOPBACK !== "200", `code=${v.PROXY_LOOPBACK}`);

  // Two units of two customers share no abstract socket namespace: one creates one, the other cannot connect.
  const aProm = inSandbox('socat ABSTRACT-LISTEN:aw-cust-a,fork SYSTEM:"echo cust-a-secret" & sleep 5; true', "00000000000000b1", UID);
  await new Promise((r) => setTimeout(r, 1_500)); // A is up and listening while B probes
  const second = await inSandbox('socat -T2 - ABSTRACT-CONNECT:aw-cust-a </dev/null 2>/dev/null || echo none', "00000000000000b2", UID_B);
  await aProm;
  check("customers-do-not-share-abstract-sockets", second.out.includes("none") && !second.out.includes("cust-a-secret"), second.out.trim().slice(-30));

  // ── per-customer sockets: ownership, no cross-access, and one customer cannot starve another ──
  const sockA = `${proxy.listenFor(UID)}/proxy.sock`;
  const stA = statSync(sockA);
  check("own-socket-owned-by-the-customer-mode-0600", stA.uid === UID && (stA.mode & 0o777) === 0o600, `uid=${stA.uid} mode=${(stA.mode & 0o777).toString(8)}`);
  const stDir = statSync(`${proxy.listenFor(UID)}`);
  check("own-directory-owned-by-the-customer-mode-0700", stDir.uid === UID && (stDir.mode & 0o777) === 0o700, `uid=${stDir.uid} mode=${(stDir.mode & 0o777).toString(8)}`);
  const cross = spawnSync("/usr/bin/setpriv", [`--reuid=${UID_B}`, `--regid=${UID_B}`, "--clear-groups", "/usr/bin/socat", "-T2", "-", `UNIX-CONNECT:${sockA}`], { input: "", encoding: "utf8", timeout: 10_000 });
  check("another-customer-cannot-connect-to-it", cross.status !== 0 && /ermission denied/i.test(`${cross.stderr}`), `exit=${cross.status} ${String(cross.stderr).trim().slice(-60)}`);

  // Customer A opens far more connections than its share and keeps them; customer B must still get through meanwhile.
  // 3x its share of connections to its own proxy socket, each held open (sleep keeps the pipe's stdin alive) for ~8 s.
  const holdScript = `for i in $(seq 1 ${PER_UID_MAX * 3}); do (sleep 8 | socat - TCP:127.0.0.1:3128 >/dev/null 2>&1 &); done\nsleep 8`;
  const hog = spawn(port.paths.systemRun, unitArgsFor(holdScript, "00000000000000c1", UID), { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2_500));
  const hogging = proxy.stats().perUid[UID] ?? 0;
  check("customer-A-is-held-at-its-own-cap", hogging > 0 && hogging <= PER_UID_MAX, `A tunnels=${hogging} cap=${PER_UID_MAX}`);
  const bProbe = await inSandbox('echo "B=$(curl -s -m 10 -o /dev/null -w \'%{http_code}\' https://api.anthropic.com/ 2>/dev/null || true)"', "00000000000000c2", UID_B);
  check("customer-B-is-still-served-while-A-hogs", /B=(200|301|302|401|403|404)/.test(bProbe.out), bProbe.out.trim().slice(-40));
  await new Promise<void>((r) => {
    hog.once("close", () => r());
    setTimeout(() => (hog.kill("SIGKILL"), r()), 15_000);
  });

  hostTcp.close();
  hostAbstract.close();
}

main()
  .catch((e) => check("runner", false, String((e as Error).message).slice(0, 160)))
  .finally(async () => {
    await proxy?.close().catch(() => undefined);
    rmSync(PROBE_DIR, { recursive: true, force: true });
    try {
      execFileSync(port.paths.systemRun.replace("systemd-run", "systemctl"), ["stop", layout.sliceName(UID)], { stdio: "ignore" });
    } catch {
      /* nothing to stop */
    }
    for (const u of ownedUids) {
      try {
        execFileSync(port.paths.systemRun.replace("systemd-run", "systemctl"), ["stop", layout.sliceName(u)], { stdio: "ignore" });
      } catch {
        /* nothing to stop */
      }
      rmSync(layout.uidDir(u), { recursive: true, force: true });
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
