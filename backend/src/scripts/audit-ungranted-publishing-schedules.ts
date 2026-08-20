/**
 * ENG-1245 follow-up — read-only audit for the bug class this ticket's own fix
 * quietly stopped surfacing: an active schedule whose own prompt says it means
 * to publish unattended, but which was never granted standing publish
 * authorization (see utils/ungrantedPublishScheduleAudit.ts for why this is a
 * deterministic check rather than relying on judge scores again).
 *
 * This is a SURVEY, not a migration — it writes nothing. A flagged schedule
 * still needs its owner's confirmation before anything is granted; take the
 * output to scripts/grant-schedule-autopublish.ts (with a `tools=` allowlist
 * line if requiredFunctionCalls doesn't already name the schedule's publish
 * tool — see that script's own header for why).
 *
 * Usage:
 *   npx ts-node src/scripts/audit-ungranted-publishing-schedules.ts
 */
import { scheduleDb } from '../services/db';
import { findUngrantedPublishingSchedules } from '../utils/ungrantedPublishScheduleAudit';

async function main() {
  const schedules = (await scheduleDb.getAllSchedules()) || [];
  const findings = findUngrantedPublishingSchedules(schedules);

  console.log(`\nScanned ${schedules.length} schedules.`);

  if (findings.length === 0) {
    console.log('\nNo active, publish-intent schedule is stuck without standing publish authorization.');
    return;
  }

  // Most stale first — a schedule that has never published, or hasn't in the
  // longest, is the most urgent to get an owner's answer on.
  const sorted = [...findings].sort((a, b) => (b.daysSinceLastPublish ?? Infinity) - (a.daysSinceLastPublish ?? Infinity));

  console.log(`\nUNGRANTED PUBLISHING SCHEDULES (${findings.length}) — never granted standing publish authorization:`);
  for (const f of sorted) {
    const staleness =
      f.daysSinceLastPublish === undefined
        ? 'never published in the available history'
        : `last published ${f.daysSinceLastPublish} day(s) ago`;
    console.log(`  ${f.scheduleId}  ${f.userId}  ${f.scheduleName}  —  ${staleness}`);
  }
  console.log('\nNothing was written. Confirm with each owner, then grant via:');
  console.log('  npx ts-node src/scripts/grant-schedule-autopublish.ts --allowlist <file> --apply --confirmed-by "<name>"');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('audit-ungranted-publishing-schedules failed:', err);
      process.exit(1);
    });
}
