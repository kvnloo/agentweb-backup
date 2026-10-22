/**
 * ENG-2110: the deploy's window into the running host, as a tiny stand-alone program (build-login-host.sh bundles it to deployctl.js, deploy.sh
 * runs it as root over the host's unix socket; the network listener refuses `host.drain`).
 *
 *   node deployctl.js <socket> acquire [--poll S] [--total S] [--strict-ttl S]   wait for idle, then refuse new work
 *                                                                              0 acquired, 75 not idle, 76 the host predates drain (cannot be gated)
 *   node deployctl.js <socket> release                                          let the host take work again           0
 *   node deployctl.js <socket> health [--timeout S] [--any-protocol]             this build is up, same protocol (any, after a rollback), undrained   0 healthy, 1 not
 *   node deployctl.js <socket> info                                              prints host.info as JSON               0
 *
 * Exit 1 is any other failure (including a host that cannot be reached). Prints no secret: the host has none to give.
 */
import { request } from "http";
import { PROTOCOL_VERSION } from "../../protocol";
import { acquireIdle, DEFAULT_GATE, waitHealthy, type DrainReply } from "./drainGate";

function call<T>(socketPath: string, route: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json" }, timeout: 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((res.statusCode ?? 0) >= 400) {
            const err = new Error(`host answered ${res.statusCode} ${String(json?.error ?? "")}${json?.detail ? "/" + String(json.detail) : ""}`);
            // A host built before host.drain existed answers an unknown route like this.
            if (res.statusCode === 404 && json?.error === "EINVALID" && json?.detail === "route") (err as Error & { unknownRoute?: boolean }).unknownRoute = true;
            reject(err);
          } else resolve(json as T);
        } catch {
          reject(new Error(`host answered ${res.statusCode} with something that is not JSON`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("host did not answer in 10s")));
    req.on("error", (e: NodeJS.ErrnoException) => {
      // Not listening yet / any more: a restart in progress or a host that has just started.
      if (e.code === "ECONNREFUSED" || e.code === "ENOENT") (e as Error & { notReady?: boolean }).notReady = true;
      reject(e);
    });
    req.end(JSON.stringify(body));
  });
}

/** Every option must be one the command knows: a misspelt or renamed flag must fail loudly, not silently fall back to a default. */
function expectOnly(args: string[], flags: string[], bare: string[] = []): void {
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i])) i++;
    else if (!bare.includes(args[i])) throw new Error(`unknown option ${args[i]}`);
  }
}

const num = (args: string[], flag: string, dflt: number): number => {
  const i = args.indexOf(flag);
  if (i < 0) return dflt;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${flag} needs a non-negative number`);
  return v;
};

async function main(argv: string[]): Promise<number> {
  const [socket, cmd, ...rest] = argv;
  if (!socket || !cmd) {
    console.error("usage: deployctl.js <socket> acquire|release|health|info [...] (run by deploy.sh; see deploy/prod/README.md)");
    return 2;
  }
  const log = (line: string) => console.log(`deploy: ${line}`);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  switch (cmd) {
    case "acquire": {
      expectOnly(rest, ["--poll", "--total", "--strict-ttl"]);
      try {
        const r = await acquireIdle(
          { pollSec: num(rest, "--poll", DEFAULT_GATE.pollSec), totalSec: num(rest, "--total", DEFAULT_GATE.totalSec), strictTtlSec: num(rest, "--strict-ttl", DEFAULT_GATE.strictTtlSec) },
          { drain: (mode, ttlSec) => call<DrainReply>(socket, "host.drain", { mode, ttlSec }), sleep, now: Date.now, log },
        );
        return r.result === "acquired" ? 0 : 75;
      } catch (e) {
        if ((e as { unknownRoute?: boolean }).unknownRoute) {
          console.error("deploy: the running host does not know host.drain (it predates it)");
          return 76;
        }
        throw e;
      }
    }
    case "release":
      expectOnly(rest, []);
      await call(socket, "host.drain", { mode: "off" });
      return 0;
    case "health":
      expectOnly(rest, ["--timeout"], ["--any-protocol"]);
      return (await waitHealthy(rest.includes("--any-protocol") ? "any" : PROTOCOL_VERSION, num(rest, "--timeout", 60), { info: () => call(socket, "host.info", {}), sleep, now: Date.now, log })) ? 0 : 1;
    case "info":
      expectOnly(rest, []);
      console.log(JSON.stringify(await call(socket, "host.info", {})));
      return 0;
    default:
      console.error(`unknown command ${cmd}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`deploy: ${e instanceof Error ? e.message : "failed"}`);
    process.exit(1);
  },
);
