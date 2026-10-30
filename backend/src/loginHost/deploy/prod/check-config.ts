/**
 * ENG-2110: the host's OWN config parser as a tiny stand-alone checker. build-login-host.sh bundles this file to check-config.js; install.sh runs it on the
 * generated config before the host ever reads it, so a config the host would refuse never replaces a working one.
 *
 *   node check-config.js <config.json>
 *       exit 0 and "config ok", or exit 1 and the schema message (never a secret: the config holds none)
 *   node check-config.js <config.json> --owner <uid> [--boundary <dir>] [--map <from>=<to>]...
 *       ALSO runs the host's start-up trusted-path check (host/trustedPaths.ts, the very list runMain uses) on every configured path that lies under a
 *       `from` prefix, looking at it under `to` instead (install.sh: the release being staged is not at its final path yet). So a rendered config whose node
 *       path has a symlink on it, or whose shim is not root-owned, fails HERE, before the switch, instead of as a host that will not start afterwards.
 *       System tools (/usr/bin/...) are not under any `from`: the host checks those itself at start-up.
 */
import { readFileSync } from "fs";
import { assertTrustedPath } from "../../host/binary";
import { parseHostConfig } from "../../host/hostConfig";
import { assertCustomerCanUse, hostTrustedPaths } from "../../host/trustedPaths";

/** Exported for tests. Returns the message of the first failure, or undefined. */
export function checkConfig(configPath: string, args: string[]): string | undefined {
  try {
    const cfg = parseHostConfig(JSON.parse(readFileSync(configPath, "utf8")));
    const flag = (name: string): string[] => args.flatMap((a, i) => (a === name ? [args[i + 1] ?? ""] : []));
    const maps = flag("--map").map((m) => {
      const at = m.indexOf("=");
      if (at < 1 || at === m.length - 1) throw new Error(`bad --map ${m}`);
      return [m.slice(0, at), m.slice(at + 1)] as const;
    });
    const owner = flag("--owner")[0];
    if (owner !== undefined) {
      const expectedOwnerUid = Number(owner);
      if (!Number.isInteger(expectedOwnerUid) || expectedOwnerUid < 0) throw new Error("bad --owner");
      const boundary = flag("--boundary")[0];
      for (const p of hostTrustedPaths(cfg)) {
        const map = maps.find(([from]) => p === from || p.startsWith(from + "/"));
        if (!map) continue;
        const real = map[1] + p.slice(map[0].length);
        try {
          assertTrustedPath(real, { expectedOwnerUid, ...(boundary ? { boundary } : {}) });
        } catch (e) {
          throw new Error(`${p} is not trusted: ${(e as Error).message.replace(real, p)}`);
        }
      }
      // a customer uid must be able to run the node and read the shim it is given (what install-test-host.sh also checks for the test box)
      for (const [p, need] of [[cfg.claude.nodePath, "execute"], [cfg.claude.relayShimPath, "read"]] as const) {
        const map = maps.find(([from]) => p === from || p.startsWith(from + "/"));
        if (!map) continue;
        const real = map[1] + p.slice(map[0].length);
        try {
          assertCustomerCanUse(real, need, boundary || undefined);
        } catch (e) {
          throw new Error(`${p}: ${(e as Error).message.replace(real, p)}`);
        }
      }
    }
    return undefined;
  } catch (e) {
    return String((e as Error).message);
  }
}

if (require.main === module) {
  const problem = checkConfig(process.argv[2], process.argv.slice(3));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log("config ok");
}
