/**
 * ENG-1631 — bring already-promoted skill rows onto the current SAFETY &
 * VOLUME LIMITS prose (post-#2635: LinkedIn sends capped PER DAY by the
 * backend, no per-run invite/message numbers).
 *
 * WHY THIS EXISTS
 * ---------------
 * #2635 moved LinkedIn volume enforcement into linkedInWritePacer.ts (configured
 * daily_invite_cap, absolute ceiling 30/day) and rewrote the canonical SAFETY
 * constant — but appendBlocks() skips a block whose marker is already present,
 * so every row hardened before #2635 still tells the model "max 5 LinkedIn
 * invites … per run", absolute in unattended runs. Live consequence: scheduled
 * outreach stops at 5 invites regardless of the account's real daily cap
 * (observed on iTrials, 2026-08-27, configured cap 15).
 *
 * applyHardening's constant is already correct; this explicit, reviewed rewrite
 * is what actually reaches production rows. Directed by Harsha on ENG-1631:
 * "remove the unattended run hardcoded 5 invites per run safety cap, the safety
 * cap should be 30 instead" — the 30 being the backend's absolute daily
 * ceiling, which this rewrite makes the operative limit.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE --apply (see CLAUDE.md).
 * It is a bulk mutation of production skill rows. Survey first, read the diff,
 * then apply. (ENG-1631 records the standing approval for this specific run.)
 *
 * WHAT IT WILL NEVER DO
 * ---------------------
 *   - rewrite prose it does not recognise byte-for-byte. Hand-edited rows are
 *     reported under REVIEW BY HAND and left exactly as they are.
 *   - clobber a concurrent edit: every row is re-read immediately before the
 *     write and skipped if its updatedAt moved.
 *   - write without a backup: each mutated row is snapshotted to skill-backups/
 *     first, so a rollback is a single updateSkill of the snapshot.
 *
 * Usage:
 *   # Survey — what would change, and what needs a human (writes nothing)
 *   NODE_ENV=development npx ts-node src/scripts/rewrite-safety-volume.ts
 *
 *   # Apply, after review
 *   NODE_ENV=development npx ts-node src/scripts/rewrite-safety-volume.ts --apply
 */
import path from "path";
import { skillService } from "../services/skillService";
import {
  rewriteSafetyVolume,
  hasUnrecognizedSafetyVolumeProse,
} from "../services/skillHardening/safetyVolumeRewrite";
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
    const plan = rewriteSafetyVolume(skill.systemPrompt);

    if (!plan.applied.length) {
      // Nothing we recognise — but it may still be a numeric per-run invite cap
      // someone reworded, which throttles exactly the same way. Surface, never guess.
      if (hasUnrecognizedSafetyVolumeProse(skill.systemPrompt)) {
        needsHuman.push(`${skill.skillId} ${skill.name}`);
      }
      continue;
    }

    // A row can carry the exact stale block AND an additional hand-edited numeric
    // cap. Rewriting only the part we recognise would leave that cap active while
    // the row vanishes from every report — so check the POST-rewrite residue and
    // route mixed rows to a human instead of half-rewriting them.
    if (hasUnrecognizedSafetyVolumeProse(plan.systemPrompt)) {
      needsHuman.push(`${skill.skillId} ${skill.name}`);
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
      // never from `skill`, the row the scan saw — a writer that mutates a field
      // without bumping the timestamp would otherwise be reverted by spreading the
      // stale scan row, with a backup holding that same stale copy.
      const fresh = rewriteSafetyVolume(current.systemPrompt);
      if (!fresh.applied.length) {
        console.log("    ! prose no longer matches on re-read — skipping rather than writing a guess");
        skipped++;
        continue;
      }
      if (hasUnrecognizedSafetyVolumeProse(fresh.systemPrompt)) {
        console.log("    ! unrecognized volume prose appeared on re-read — routing to human review");
        needsHuman.push(`${skill.skillId} ${skill.name}`);
        skipped++;
        continue;
      }
      const backup = backupSkill(current, BACKUP_DIR, s);
      console.log(`    backup: ${path.relative(process.cwd(), backup)}`);
      try {
        // Compare-and-swap on the timestamp we just read. The re-read above narrows
        // the window; only this makes the write atomic.
        await skillService.updateSkill({ ...current, systemPrompt: fresh.systemPrompt }, current.updatedAt);
      } catch (error: any) {
        if (error?.code === "ConditionalCheckFailedException" || error?.name === "ConditionalCheckFailedException") {
          console.log("    ! changed mid-write (conditional check failed) — skipped, nothing was overwritten");
          skipped++;
          continue;
        }
        throw error;
      }
      console.log("    applied ✅");
    }
    changed++;
  }

  if (needsHuman.length) {
    console.log(
      `\nREVIEW BY HAND — ${needsHuman.length} skill(s) still carry a numeric per-run LinkedIn ` +
        `invite cap with wording this migration does not recognise. Each still throttles ` +
        `unattended outreach below the backend daily cap; only a human can say whether the ` +
        `wording was deliberate:`,
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
