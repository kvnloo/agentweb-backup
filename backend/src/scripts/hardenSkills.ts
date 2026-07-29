/**
 * ENG-204 skill-hardening runner (dev-first).
 *
 * Reads a JSON list of targets and, for each skill, appends hardening blocks
 * and/or adds toolNames — idempotently, backing up the current row before any
 * write. DRY-RUN by default; `--apply` performs the writes against the
 * AW-Skills table for the current NODE_ENV (Dev-* in development).
 *
 * Prod-only skills must first be staged into dev with
 * `syncSkill(prodId,'prod-to-dev')` (see hardenSkills:stage), then edited here,
 * then promoted with `dev-to-prod` by a human.
 *
 *   NODE_ENV=development npx ts-node src/scripts/hardenSkills.ts targets.json
 *   NODE_ENV=development npx ts-node src/scripts/hardenSkills.ts targets.json --apply
 *
 * targets.json: [{ "skillId": "...", "blocks": ["safety"], "addTools": ["x"] }]
 */
import fs from "fs";
import path from "path";
import { skillService } from "../services/skillService";
import {
  planSkillChange,
  SkillHardeningTarget,
} from "../services/skillHardening/applyHardening";
import { backupSkill } from "../services/skillHardening/backup";

const BACKUP_DIR = path.resolve(__dirname, "../../skill-backups");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Merge duplicate skillIds so each skill is processed (and backed up) exactly
 * once — otherwise a second occurrence would back up the already-modified row
 * over the original snapshot, breaking rollback.
 */
export function dedupeTargets(targets: SkillHardeningTarget[]): SkillHardeningTarget[] {
  const byId = new Map<string, SkillHardeningTarget>();
  for (const t of targets) {
    const cur = byId.get(t.skillId);
    if (!cur) {
      byId.set(t.skillId, {
        skillId: t.skillId,
        blocks: [...(t.blocks || [])],
        addTools: [...(t.addTools || [])],
      });
    } else {
      cur.blocks = [...new Set([...(cur.blocks || []), ...(t.blocks || [])])];
      cur.addTools = [...new Set([...(cur.addTools || []), ...(t.addTools || [])])];
    }
  }
  return [...byId.values()];
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!file) {
    console.error("Usage: hardenSkills.ts <targets.json> [--apply]");
    process.exit(2);
  }
  const rawTargets: SkillHardeningTarget[] = JSON.parse(fs.readFileSync(file, "utf8"));
  const targets = dedupeTargets(rawTargets);
  if (targets.length !== rawTargets.length) {
    console.log(`(merged ${rawTargets.length} target rows into ${targets.length} unique skills)`);
  }
  const s = stamp();

  let changed = 0;
  let skipped = 0;
  for (const target of targets) {
    const skill = await skillService.getSkill(target.skillId);
    if (!skill) {
      console.log(`? ${target.skillId} — NOT FOUND in this table, skipping`);
      skipped++;
      continue;
    }
    const plan = planSkillChange(skill, target);
    if (!plan.changed) {
      console.log(`= ${target.skillId} ${skill.name} — already hardened, no change`);
      continue;
    }
    console.log(`${apply ? "→" : "·"} ${target.skillId} ${skill.name}`);
    if (plan.appended.length) console.log(`    + blocks: ${plan.appended.join(", ")}`);
    if (plan.addedTools.length) console.log(`    + tools:  ${plan.addedTools.join(", ")}`);

    if (apply) {
      // Guard against a stale read-modify-write: re-read immediately before the
      // full-row put and bail if the row changed since we planned against it,
      // so we never silently revert a concurrent edit.
      const current = await skillService.getSkill(target.skillId);
      if (!current || current.updatedAt !== skill.updatedAt) {
        console.log(`    ! changed since read (updatedAt) — skipping to avoid clobbering a concurrent edit`);
        skipped++;
        continue;
      }
      const backup = backupSkill(skill, BACKUP_DIR, s);
      console.log(`    backup: ${path.relative(process.cwd(), backup)}`);
      await skillService.updateSkill(plan.skill);
      console.log(`    applied ✅`);
    }
    changed++;
  }

  console.log(
    `\n${apply ? "Applied" : "Would change"} ${changed} skill(s); ${skipped} not found. ` +
      `${apply ? "" : "(dry-run — pass --apply to write)"}`,
  );
  process.exit(0);
}

// Only run when invoked directly (`ts-node hardenSkills.ts ...`), not when
// imported (e.g. by unit tests for dedupeTargets).
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
