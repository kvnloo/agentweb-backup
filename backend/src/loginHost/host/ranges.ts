/**
 * ENG-2110 PR 1b-ii part 2: environments sharing a worker must never share a uid (the same uid in two
 * environments would be two customers on one uid, and each host's stray-process sweep would act on the other's
 * processes). Every host registers its range in a root-owned registry under the shared parent at start-up and
 * refuses to start if it overlaps another registered range.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { HostConfigError } from "./hostConfig";

export interface RangeRecord {
  env: string;
  uidMin: number;
  uidMax: number;
}

/** Environments start in parallel at boot: the check-and-write below is serialized by an O_EXCL lock file (stale locks of dead pids are taken over). */
function withRegistryLock<T>(registryDir: string, fn: () => T, waitMs: number): T {
  const giveUp = Date.now() + waitMs;
  const lock = `${registryDir}/.lock`;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = 0;
      try {
        holder = Number(readFileSync(lock, "utf8"));
      } catch {
        /* just released */
      }
      // A lock file with no pid in it is a creator that died between create and write: stale once it is a few seconds old.
      if (!(holder > 0)) {
        try {
          if (Date.now() - statSync(lock).mtimeMs > 3000) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue; // released meanwhile
        }
      }
      let alive = holder > 0;
      if (alive) {
        try {
          process.kill(holder, 0);
        } catch {
          alive = false;
        }
      }
      if (!alive && holder > 0) {
        try {
          unlinkSync(lock);
        } catch {
          /* someone else took it over */
        }
      } else if (Date.now() > giveUp) throw new HostConfigError("range registry is locked");
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

export function registerRange(registryDir: string, rec: RangeRecord, lockWaitMs = 5000): void {
  if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true, mode: 0o755 });
  withRegistryLock(registryDir, () => registerRangeLocked(registryDir, rec), lockWaitMs);
}

function registerRangeLocked(registryDir: string, rec: RangeRecord): void {
  for (const name of readdirSync(registryDir)) {
    if (!name.endsWith(".json") || name === `${rec.env}.json`) continue;
    let other: RangeRecord;
    try {
      other = JSON.parse(readFileSync(`${registryDir}/${name}`, "utf8")) as RangeRecord;
    } catch {
      throw new HostConfigError(`range registry entry ${name} is unreadable: refusing to guess`);
    }
    if (typeof other.uidMin !== "number" || typeof other.uidMax !== "number") throw new HostConfigError(`range registry entry ${name} is malformed`);
    if (rec.uidMin <= other.uidMax && rec.uidMax >= other.uidMin) throw new HostConfigError(`uid range ${rec.uidMin}-${rec.uidMax} of "${rec.env}" overlaps "${other.env}" (${other.uidMin}-${other.uidMax})`);
  }
  const tmp = `${registryDir}/.${rec.env}.json.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, `${registryDir}/${rec.env}.json`);
}
