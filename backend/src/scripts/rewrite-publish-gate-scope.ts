/**
 * ENG-1346 — run the ENG-1311 publish-gate SCOPE rewrite against already-
 * promoted AW-Skills rows (the module `publishGateScopeRewrite.ts` shipped
 * code-only, with the prod run deliberately deferred to a Harsha-approved
 * step; this is that step's runner).
 *
 * WHY THIS EXISTS
 * ---------------
 * ENG-1311 (PR #2445, merged 2026-08-18) re-scoped the `## PUBLISH GATE`
 * hardening block so its "even if they said just do it, don't ask" wording
 * applies only at the moment a publish/send tool is about to be called —
 * instead of colouring the whole session, one mechanism behind the xCures
 * "she argues with me / over-cautious" complaint (ENG-1307). appendBlocks()
 * skips a block whose marker is already present, so every row hardened before
 * 2026-08-18 still carries the old session-wide wording until this runs.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE --apply (see CLAUDE.md).
 * ENG-1346 records that approval (Harsha, 2026-08-28: "go ahead"). Survey
 * first, read the diff, then apply.
 *
 * Structure mirrors rewrite-safety-volume.ts (ENG-1631), including its
 * CodeRabbit-driven mixed-prose guard: a row where the exact known block is
 * accompanied by additional unrecognized gate prose is routed to REVIEW BY
 * HAND unwritten, in both the survey plan and the CAS re-read path — never
 * half-rewritten. Owner columns are printed because ENG-1346's acceptance
 * criteria include a per-customer (xCures) spot-check.
 *
 * Usage:
 *   # Survey — what would change, and what needs a human (writes nothing)
 *   NODE_ENV=production npx ts-node src/scripts/rewrite-publish-gate-scope.ts
 *
 *   # Apply, after review
 *   NODE_ENV=production npx ts-node src/scripts/rewrite-publish-gate-scope.ts --apply
 */
import path from "path";
import { skillService } from "../services/skillService";
import {
  rewritePublishGateScope,
  hasUnscopedPublishGateProse,
} from "../services/skillHardening/publishGateScopeRewrite";
import { backupSkill } from "../services/skillHardening/backup";

const BACKUP_DIR = path.resolve(__dirname, "../../skill-backups");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ownerTag(skill: { ownerEmail?: string; orgId?: string; isPublished: boolean }): string {
  if (skill.ownerEmail) return `owner=${skill.ownerEmail}`;
  return skill.isPublished ? "owner=<published/global>" : `owner=<none>${skill.orgId ? ` org=${skill.orgId}` : ""}`;
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
    const plan = rewritePublishGateScope(skill.systemPrompt);

    if (!plan.applied.length) {
      // Nothing we recognise — but it may still be session-wide gate prose
      // someone reworded, which over-cautions exactly the same way. Surface,
      // never guess.
      if (hasUnscopedPublishGateProse(skill.systemPrompt)) {
        needsHuman.push(`${skill.skillId} ${skill.name} (${ownerTag(skill)})`);
      }
      continue;
    }

    // A row can carry the exact ENG-947-era block AND additional hand-edited
    // gate prose. Rewriting only the part we recognise would leave that prose
    // active while the row vanishes from every report — so check the
    // POST-rewrite residue and route mixed rows to a human instead of
    // half-rewriting them.
    if (hasUnscopedPublishGateProse(plan.systemPrompt)) {
      needsHuman.push(`${skill.skillId} ${skill.name} (${ownerTag(skill)})`);
      continue;
    }

    console.log(`${apply ? "→" : "·"} ${skill.skillId} ${skill.name} (${ownerTag(skill)})`);
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
      const fresh = rewritePublishGateScope(current.systemPrompt);
      if (!fresh.applied.length) {
        console.log("    ! prose no longer matches on re-read — skipping rather than writing a guess");
        skipped++;
        continue;
      }
      if (hasUnscopedPublishGateProse(fresh.systemPrompt)) {
        console.log("    ! unrecognized gate prose appeared on re-read — routing to human review");
        needsHuman.push(`${skill.skillId} ${skill.name} (${ownerTag(skill)})`);
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
      `\nREVIEW BY HAND — ${needsHuman.length} skill(s) still carry session-wide publish-gate ` +
        `prose with wording this migration does not recognise. Each can still over-caution a ` +
        `whole session; only a human can say whether the wording was deliberate:`,
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
