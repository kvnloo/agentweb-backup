/**
 * ENG-2110 PR 2: MANUAL live proof of the network isolation on the test instance, with NO login needed. It builds the exact
 * `systemd-run` command the host builds for a customer process (same Layout/unitProperties/systemRunArgs code, the installed host
 * config) and runs probe commands INSIDE that real hardened unit as a customer uid: the unit must have no network of its own, see only
 * the egress proxy socket, reach only allowlisted hosts through the proxy, and share nothing with the host's network namespace.
 *
 *   sudo node netIsolationLive.js        (the host aw-login-host@test1 must be running: it owns the proxy)
 */
import { execFileSync, spawnSync } from "child_process";
import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "net";
import { parseHostConfig } from "../../host/hostConfig";
import { layoutFor, portConfigFor } from "../../host/main";
import { systemRunArgs } from "../../ports/unitArgs";

const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};

const cfg = parseHostConfig(JSON.parse(readFileSync(process.env.AW_HOST_CONFIG ?? "/etc/aw-login-host/test1.json", "utf8")));
const layout = layoutFor(cfg);
const port = portConfigFor(cfg);
const UID = cfg.uidMax - 3; // a uid at the top of the range, unlikely to be in use
const REF = "home-ffffffffffff";

function inSandbox(script: string, suffix: string): { out: string; code: number | null } {
  const refDir = layout.refDir(UID, "home", REF);
  // A unit's argv may not contain $ or % (the service manager expands them): the probe travels as a file the customer owns.
  const scriptPath = `${refDir}/work/probe-${suffix}.sh`;
  writeFileSync(scriptPath, script + "\n");
  chownSync(scriptPath, UID, UID);
  chmodSync(scriptPath, 0o700);
  const args = systemRunArgs(
    layout,
    {
      uid: UID, unitName: layout.unitName(UID, suffix), refDir, file: "/bin/sh", args: [scriptPath],
      env: { PATH: "/usr/bin:/bin", HOME: `${refDir}/home`, TMPDIR: "/tmp" }, cwd: `${refDir}/work`,
    },
    { memoryMax: cfg.limits.memoryMax, tasksMax: cfg.limits.tasksMax, tmpSize: cfg.limits.tmpSize, shmSize: cfg.limits.shmSize, runtimeMaxSec: 120 },
    port.paths,
  );
  const r = spawnSync(port.paths.systemRun, args, { encoding: "utf8", timeout: 60_000 });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status };
}

async function main() {
  // The customer's reference directory, as the host would have created it (root-owned parents, uid-owned leaf dirs).
  const refDir = layout.refDir(UID, "home", REF);
  mkdirSync(refDir, { recursive: true });
  for (const d of ["home", "work", "tmp"]) {
    mkdirSync(`${refDir}/${d}`, { recursive: true });
    chownSync(`${refDir}/${d}`, UID, UID);
  }

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
  const r = inSandbox(probe, "00000000000000a1");
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
  const a = inSandbox('socat ABSTRACT-LISTEN:aw-cust-a,fork SYSTEM:"echo cust-a-secret" & sleep 4; true', "00000000000000b1");
  void a; // (runs for 4 s in the foreground of its own unit)
  const second = inSandbox('socat -T2 - ABSTRACT-CONNECT:aw-cust-a </dev/null 2>/dev/null || echo none', "00000000000000b2");
  check("customers-do-not-share-abstract-sockets", !second.out.includes("cust-a-secret"));

  hostTcp.close();
  hostAbstract.close();
}

main()
  .catch((e) => check("runner", false, String((e as Error).message).slice(0, 160)))
  .finally(() => {
    try {
      execFileSync(port.paths.systemRun.replace("systemd-run", "systemctl"), ["stop", layout.sliceName(UID)], { stdio: "ignore" });
    } catch {
      /* nothing to stop */
    }
    rmSync(layout.uidDir(UID), { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? "; FAILED: " + failed.map((f) => f.name).join(", ") : ""}`);
    process.exit(failed.length ? 1 : 0);
  });
