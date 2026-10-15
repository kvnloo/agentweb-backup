/**
 * ENG-2110/ENG-2113: the pinned `claude` binary, resolved by absolute path. Shared by the
 * sign-in runner and the turn runner so neither depends on the process PATH.
 */
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

/**
 * The pinned `claude` binary (the @anthropic-ai/claude-code dependency), by absolute path.
 * Not looked up on PATH: the backend runs as `node dist/server.js`, whose PATH does not
 * include node_modules/.bin (seen on the test instance), so a bare "claude" is not found.
 * Falls back to the bare name when the package cannot be resolved.
 */
export function resolveClaudeBinary(): string {
  try {
    const pkgPath = require.resolve("@anthropic-ai/claude-code/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
    if (rel) {
      const abs = join(dirname(pkgPath), rel);
      if (existsSync(abs)) return abs;
    }
  } catch {
    /* fall through */
  }
  return "claude";
}
