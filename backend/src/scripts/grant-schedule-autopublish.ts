/**
 * grant-schedule-autopublish.ts
 *
 * ENG-827 operator tool: record an owner's consent for a schedule to PUBLISH to
 * their live connected accounts during unattended runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * Publishing in an unattended run is gated on one explicit flag,
 * `autopublishAuthorized` (see utils/schedulePublishAuthorization.ts). Owners
 * normally set it themselves via the "Publish without my review" checkbox in the
 * customer portal, and that is the path everyone should use.
 *
 * Schedules created BEFORE that checkbox existed do not carry the flag, so they
 * keep drafting even when their owner has since said they want unattended posting.
 * This script is the audited way to record that consent for those schedules,
 * without inventing it.
 *
 * WHAT THIS SCRIPT DELIBERATELY IS NOT
 * ------------------------------------
 * It is NOT a blanket migration and it will never scan-and-flip. Consent cannot be
 * derived from any other field: not from a publishing tool sitting in
 * `requiredFunctionCalls` (that picker is a verification control), not from
 * "post automatically / do not ask for approval" wording in the schedule prompt
 * (unscoped — a waiver written about a different step is not a publish waiver),
 * and not from `fullAutonomy` (that governs how a blocking question is ANSWERED).
 * Each of those was tried and rejected on review. So this script requires the
 * operator to name the exact schedules AND to attest, in `--confirmed-by`, who
 * obtained the owner's confirmation. That attestation is written onto the schedule
 * so the grant is auditable after the fact.
 *
 * Refuses to act when the outcome would be meaningless or unsafe:
 *   • a schedule that designates no publishing tool — consent with no scope
 *     authorizes nothing (the resolver would still return unauthorized), so the
 *     grant would be a silent no-op. Fix `requiredFunctionCalls` first.
 *   • a schedule that already has the flag — reported, never rewritten.
 *
 * ⚠️ DATA-PLANE: this writes a consent record that causes irreversible public
 * posts. Get data-plane sign-off, ALWAYS --dry-run first, and only run it for an
 * owner who has actually confirmed.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/grant-schedule-autopublish.ts \
 *     --confirmed-by "<who confirmed, and how>" <scheduleId> [<scheduleId> ...] [--dry-run]
 *
 * Example — the ENG-827 reporter's three social schedules:
 *   ... grant-schedule-autopublish.ts --confirmed-by "kevin@ via ENG-827 ticket" \
 *       1c20ada1-f1b8-4bd6-a47f-ca79c5c985ff e7ed196d-7871-42ec-9e2d-86a9c856bfb4 \
 *       34154af9-489a-454c-b96d-cfea22ea27f7 --dry-run
 */

import { scheduleDb } from '../services/db';
import { resolveSchedulePublishAuthorization } from '../utils/schedulePublishAuthorization';

interface Outcome {
  scheduleId: string;
  name: string;
  action: 'granted' | 'would-grant' | 'skipped-already-authorized' | 'skipped-no-publish-tool' | 'not-found';
  detail?: string;
}

export async function grantSchedulePublishConsent(
  scheduleIds: string[],
  confirmedBy: string,
  dryRun: boolean
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];

  for (const scheduleId of scheduleIds) {
    const schedule = await scheduleDb.getScheduleById(scheduleId);
    if (!schedule) {
      outcomes.push({ scheduleId, name: '(unknown)', action: 'not-found' });
      continue;
    }

    const name = (schedule as any).scheduleName || '(unnamed)';

    if ((schedule as any).autopublishAuthorized === true) {
      outcomes.push({ scheduleId, name, action: 'skipped-already-authorized' });
      continue;
    }

    // Consent with no designated publish tool authorizes nothing, so granting it
    // here would look like it worked and change no behaviour at all.
    const { tools } = resolveSchedulePublishAuthorization({
      autopublishAuthorized: true,
      requiredFunctionCalls: (schedule as any).requiredFunctionCalls,
    });
    if (tools.length === 0) {
      outcomes.push({
        scheduleId,
        name,
        action: 'skipped-no-publish-tool',
        detail: 'no publishing tool in requiredFunctionCalls — the grant would authorize nothing',
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({ scheduleId, name, action: 'would-grant', detail: `scope: ${tools.join(', ')}` });
      continue;
    }

    await scheduleDb.updateSchedule(scheduleId, {
      autopublishAuthorized: true,
      // Audit trail: who attested to the owner's confirmation, and when.
      autopublishAuthorizedAt: new Date().toISOString(),
      autopublishAuthorizedBy: confirmedBy,
    } as any);
    outcomes.push({ scheduleId, name, action: 'granted', detail: `scope: ${tools.join(', ')}` });
  }

  return outcomes;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  const confirmedByIdx = argv.indexOf('--confirmed-by');
  const confirmedBy = confirmedByIdx >= 0 ? argv[confirmedByIdx + 1] : undefined;
  if (!confirmedBy || confirmedBy.startsWith('--')) {
    console.error(
      'Refusing to run: --confirmed-by "<who obtained the owner\'s confirmation>" is required.\n' +
        'This flag is the audit record for a consent grant that causes irreversible public posts.'
    );
    process.exit(1);
  }

  const scheduleIds = argv.filter(
    (a, i) => !a.startsWith('--') && i !== confirmedByIdx + 1
  );
  if (scheduleIds.length === 0) {
    console.error('Refusing to run: name at least one scheduleId explicitly. This script never scans.');
    process.exit(1);
  }

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}granting unattended-publish consent for ${scheduleIds.length} schedule(s); confirmed by: ${confirmedBy}`
  );

  const outcomes = await grantSchedulePublishConsent(scheduleIds, confirmedBy, dryRun);
  for (const o of outcomes) {
    console.log(`  ${o.action.padEnd(28)} ${o.scheduleId}  ${o.name}${o.detail ? `  — ${o.detail}` : ''}`);
  }

  const granted = outcomes.filter(o => o.action === 'granted' || o.action === 'would-grant').length;
  console.log(`\n${dryRun ? 'would grant' : 'granted'}: ${granted}; skipped: ${outcomes.length - granted}`);
  if (dryRun) console.log('Re-run without --dry-run to commit.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('grant-schedule-autopublish failed:', err);
    process.exit(1);
  });
}
