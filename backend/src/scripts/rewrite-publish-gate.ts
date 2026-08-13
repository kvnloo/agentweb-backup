/**
 * ENG-947 — bring already-promoted skill rows onto the current publish-gate prose.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ENG-204 hardening promotion (2026-07-30T10:30:56Z) wrote a publish gate that
 * told every scheduled run to withhold publishing unconditionally, inside a block
 * declaring itself to override "every other instruction in this prompt". That
 * outranks the runtime PUBLISH AUTHORIZATION block, so schedules whose owners HAD
 * authorized publishing still refused, and the scheduler re-pressed them to
 * exhaustion — the $6-8/run nudge loop this ticket is about.
 *
 * applyHardening's constants are now fixed, but that alone changes nothing here:
 * appendBlocks() skips a block whose marker is already present, and setPrompt only
 * fills an EMPTY prompt. Both guards are correct; the consequence is that reworded
 * prose needs this explicit, reviewed rewrite to reach production.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE --apply (see CLAUDE.md).
 * It is a bulk mutation of production skill rows. Survey first, read the diff,
 * then apply.
 *
 * ORDER: this is INERT until it runs — the code change ships harmless prose that
 * no promoted row carries. Running it is what actually unblocks publishing, and it
 * only unblocks runs whose PUBLISH AUTHORIZATION block says they are authorized.
 * A run whose owner requires approval still withholds, via that block.
 *
 * WHAT IT WILL NEVER DO
 * ---------------------
 *   - rewrite prose it does not recognise byte-for-byte. Hand-edited rows are
 *     reported under REVIEW BY HAND and left exactly as they are: silently
 *     rewording someone's deliberate policy is worse than skipping them.
 *   - touch approval gates that are not about publishing (calendar, meeting and
 *     CRM write gates resolve against no PUBLISH AUTHORIZATION block, so
 *     deferring them there would strand them).
 *   - clobber a concurrent edit: every row is re-read immediately before the
 *     write and skipped if its updatedAt moved.
 *   - write without a backup: each mutated row is snapshotted to skill-backups/
 *     first, so a rollback is a single updateSkill of the snapshot.
 *
 * Usage:
 *   # Survey — what would change, and what needs a human (writes nothing)
 *   NODE_ENV=development npx ts-node src/scripts/rewrite-publish-gate.ts
 *
 *   # Apply, after review
 *   NODE_ENV=development npx ts-node src/scripts/rewrite-publish-gate.ts --apply
 */
import path from "path";
import { skillService } from "../services/skillService";
import {
  rewritePublishGate,
  hasUnrecognizedPublishGateProse,
} from "../services/skillHardening/publishGateRewrite";
import { backupSkill } from "../services/skillHardening/backup";

const BACKUP_DIR = path.resolve(__dirname, "../../skill-backups");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const s = stamp();

  const skills = await skillService.getAllSkills();
  console.log(`Scanned ${skills.length} skill(s) in ${process.env.NODE_ENV || "development"}\n`);

  let changed = 0;
  let skipped = 0;
  const needsHuman: string[] = [];

  for (const skill of skills) {
    const plan = rewritePublishGate(skill.systemPrompt);

    if (!plan.applied.length) {
      // Nothing we recognise — but it may still be a withholding gate someone
      // reworded, which deadlocks exactly the same way. Surface, never guess.
      if (hasUnrecognizedPublishGateProse(skill.systemPrompt)) {
        needsHuman.push(`${skill.skillId} ${skill.name}`);
      }
      continue;
    }

    console.log(`${apply ? "→" : "·"} ${skill.skillId} ${skill.name}`);
    console.log(`    rewrites: ${plan.applied.join(", ")}`);

    if (apply) {
      const current = await skillService.getSkill(skill.skillId);
      if (!current || current.updatedAt !== skill.updatedAt) {
        console.log("    ! changed since read (updatedAt) — skipping to avoid clobbering a concurrent edit");
        skipped++;
        continue;
      }
      // Everything below is derived from `current`, the row we just re-read, and
      // never from `skill`, the row the scan saw. The updatedAt guard above is
      // necessary but not sufficient: a writer that mutates a field without
      // bumping the timestamp would be silently reverted by spreading the stale
      // scan row, and — worse — the backup would hold that same stale copy, so it
      // could not restore what the write destroyed. Re-deriving costs one pure
      // function call and removes the whole class of problem.
      const fresh = rewritePublishGate(current.systemPrompt);
      if (!fresh.applied.length) {
        console.log("    ! prose no longer matches on re-read — skipping rather than writing a guess");
        skipped++;
        continue;
      }
      const backup = backupSkill(current, BACKUP_DIR, s);
      console.log(`    backup: ${path.relative(process.cwd(), backup)}`);
      await skillService.updateSkill({ ...current, systemPrompt: fresh.systemPrompt });
      console.log("    applied ✅");
    }
    changed++;
  }

  if (needsHuman.length) {
    console.log(
      `\nREVIEW BY HAND — ${needsHuman.length} skill(s) still withhold publishing in unattended ` +
        `runs with wording this migration does not recognise. Each can still deadlock a ` +
        `scheduled run; only a human can say whether the wording was deliberate:`,
    );
    for (const line of needsHuman) console.log(`  ? ${line}`);
  }

  console.log(
    `\n${apply ? "Applied" : "Would change"} ${changed} skill(s); ${skipped} skipped; ` +
      `${needsHuman.length} for human review. ${apply ? "" : "(survey — pass --apply to write)"}`,
  );
  process.exit(0);
}

// Only run when invoked directly, not when imported by tests.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
