/**
 * ENG-2110 PR 1b-ii part 2: environments sharing a worker must never share a uid (the same uid in two
 * environments would be two customers on one uid, and each host's stray-process sweep would act on the other's
 * processes). Every host registers its range in a root-owned registry under the shared parent at start-up and
 * refuses to start if it overlaps another registered range.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { HostConfigError } from "./hostConfig";

export interface RangeRecord {
  env: string;
  uidMin: number;
  uidMax: number;
}

export function registerRange(registryDir: string, rec: RangeRecord): void {
  if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true, mode: 0o755 });
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
