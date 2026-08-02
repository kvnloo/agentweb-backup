import fs from "fs";
import path from "path";
import type { Skill } from "../skillService";

/**
 * ENG-204 hardening — reversibility. Before any skill row is mutated or deleted,
 * its full current state is snapshotted to a JSON file so the change can be
 * rolled back with a single updateSkill/put. Pure serialization is separated
 * from the file I/O so the format is unit-testable.
 */

/**
 * Deterministic JSON snapshot of a skill row (stable key order at every level).
 * A recursive key-sorting REPLACER is used — not an array allowlist, which
 * JSON.stringify applies at every depth and would strip nested objects like
 * `schedule` down to `{}`, losing data the backup exists to protect.
 */
export function serializeSkillBackup(skill: Skill): string {
  return JSON.stringify(
    skill,
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value,
    2,
  );
}

/** Parse a snapshot produced by serializeSkillBackup back into a Skill. */
export function parseSkillBackup(json: string): Skill {
  return JSON.parse(json) as Skill;
}

/**
 * Write a snapshot to `<dir>/<skillId>.<stamp>.json` and return the path.
 * `stamp` is passed in (never generated here) so callers control naming and
 * tests stay deterministic.
 */
export function backupSkill(skill: Skill, dir: string, stamp: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${skill.skillId}.${stamp}.json`);
  fs.writeFileSync(file, serializeSkillBackup(skill));
  return file;
}
