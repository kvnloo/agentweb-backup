/**
 * ENG-827 — record affirmative publish consent for the schedules that publish TODAY.
 *
 * WHY THIS EXISTS, AND WHY IT MUST RUN BEFORE THE PR MERGES
 * --------------------------------------------------------
 * Publishing consent became affirmative and tool-scoped: a schedule publishes
 * unattended only where `autopublishAuthorized === true` and the tool is in
 * `autopublishAuthorizedTools`. Every schedule created before that field resolves to
 * NOT authorized.
 *
 * Roughly 25 active schedules publish today. If the code ships first, all of them stop
 * publishing within minutes of deploy — the exact failure ENG-827 was filed about, at
 * larger scale. Running this first is INERT: nothing reads these fields until the new
 * code deploys, so the safe order is
 *
 *      1. run this against production   →   2. merge the PR   →   3. deploy
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE IT IS RUN (see CLAUDE.md).
 * This is a bulk mutation of production schedule records. Do not run it unattended.
 *
 * WHAT IT WILL AND WILL NOT TOUCH
 * -------------------------------
 * It grants ONLY to schedules that are already publishing in practice:
 *   - status active, and
 *   - `requiredFunctionCalls` names at least one publishing tool, and
 *   - `requirePublishApproval` is not true (the owner has not asked to be held), and
 *   - no consent decision is recorded yet.
 *
 * It deliberately does NOT infer consent from prompt wording. A schedule whose prompt
 * says "post this" but which names no publishing tool gets nothing: consent is recorded
 * against a specific tool, and there is no tool to name. Those owners tick the box
 * themselves, which is the honest outcome — we would otherwise be manufacturing a
 * decision nobody made, on the exact question this ticket says must be a human one.
 *
 * Usage:
 *   npx ts-node src/scripts/grant-schedule-autopublish.ts            # DRY RUN (default)
 *   npx ts-node src/scripts/grant-schedule-autopublish.ts --apply --confirmed-by "Harsha"
 */

import { scheduleDb } from '../services/db';
import { getRequiredPublishTools } from '../utils/schedulePublishAuthorization';

interface Candidate {
  scheduleId: string;
  scheduleName: string;
  userId: string;
  tools: string[];
}

export interface BackfillResult {
  scanned: number;
  granted: Candidate[];
  skipped: Array<{ scheduleId: string; scheduleName: string; reason: string }>;
  applied: boolean;
}

export async function backfillPublishConsent(opts: {
  apply: boolean;
  confirmedBy: string;
  listSchedules?: () => Promise<any[]>;
  update?: (scheduleId: string, patch: any) => Promise<any>;
}): Promise<BackfillResult> {
  const listSchedules = opts.listSchedules ?? (() => (scheduleDb as any).getAllSchedules());
  const update = opts.update ?? ((id: string, patch: any) => scheduleDb.updateSchedule(id, patch));

  const all = (await listSchedules()) || [];
  const granted: Candidate[] = [];
  const skipped: BackfillResult['skipped'] = [];

  for (const schedule of all) {
    const scheduleId = schedule?.scheduleId;
    const scheduleName = schedule?.scheduleName || schedule?.name || '(unnamed)';
    if (!scheduleId) continue;

    if (schedule.status !== 'active') {
      skipped.push({ scheduleId, scheduleName, reason: 'not active' });
      continue;
    }
    if (schedule.requirePublishApproval === true) {
      // The owner asked to be held. Granting here would override a decision they DID
      // make — the one thing this migration must never do.
      skipped.push({ scheduleId, scheduleName, reason: 'owner requires approval' });
      continue;
    }
    if (schedule.autopublishAuthorized !== undefined && schedule.autopublishAuthorized !== null) {
      skipped.push({ scheduleId, scheduleName, reason: 'consent already recorded' });
      continue;
    }

    const tools = getRequiredPublishTools(schedule.requiredFunctionCalls);
    if (tools.length === 0) {
      // Prompt-only publisher. We will not invent a tool scope for it.
      skipped.push({ scheduleId, scheduleName, reason: 'no publishing tool designated' });
      continue;
    }

    granted.push({ scheduleId, scheduleName, userId: schedule.userId, tools });
  }

  if (opts.apply) {
    for (const c of granted) {
      await update(c.scheduleId, {
        autopublishAuthorized: true,
        autopublishAuthorizedTools: c.tools,
        autopublishAuthorizedAt: new Date().toISOString(),
        // Attributed to the human who approved the migration, never to a service
        // identity — the audit trail has to name someone accountable.
        autopublishAuthorizedBy: opts.confirmedBy,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return { scanned: all.length, granted, skipped, applied: opts.apply };
}

/* istanbul ignore next -- CLI wrapper, exercised by hand under Harsha's supervision */
async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const byIdx = argv.indexOf('--confirmed-by');
  const confirmedBy = byIdx >= 0 ? argv[byIdx + 1] : '';

  if (apply && !confirmedBy) {
    console.error('Refusing to apply without --confirmed-by "<name of the person approving this>".');
    process.exit(1);
  }

  const result = await backfillPublishConsent({ apply, confirmedBy });

  console.log(`\nScanned ${result.scanned} schedules.`);
  console.log(`\nWOULD GRANT (${result.granted.length}):`);
  for (const g of result.granted) {
    console.log(`  ${g.scheduleId}  ${g.scheduleName}  ->  ${g.tools.join(', ')}`);
  }
  const reasons = result.skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nSKIPPED (${result.skipped.length}):`, reasons);
  console.log(
    result.applied
      ? '\nAPPLIED. Merge the PR only after confirming these records look right.'
      : '\nDRY RUN — nothing written. Re-run with --apply --confirmed-by "<name>" to write.'
  );
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
