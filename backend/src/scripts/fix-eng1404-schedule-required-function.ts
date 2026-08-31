/**
 * ENG-1404 / ENG-1599 — one-off correction for schedule
 * `1d001fba-0fb7-4bcd-80f6-6041b244a442` ("Harsha Daily X Post (Autonomous)").
 *
 * WHAT'S WRONG. `requiredFunctionCalls` on this schedule is currently
 * `["twitter_outreach", "twitter_manage_post"]`, but the schedule's own prompt
 * has always published via `post_on_connected_account` — every promptRevision
 * ends "post directly with post_on_connected_account(platform=\"twitter\",
 * content=...)... One tweet, no thread." `twitter_manage_post` was added to
 * `requiredFunctionCalls` sometime between 2026-08-20 and 2026-08-24 as an
 * unrelated side effect — Harsha flagged it himself on ENG-1404 ("twitter_
 * manage_post was added to this schedule's Required Actions since this ticket
 * was filed... not harmful, just doesn't help on its own").
 *
 * That mismatch is why ENG-1599 happened: `post_on_connected_account` (the tool
 * the prompt actually calls) was refused as unauthorized, and once ENG-1599's
 * authorization fix lets it through, the run's own completion checker still
 * looks for a `twitter_manage_post` call that will never come — reporting a
 * false `publishRequirementMismatch` failure on every run even though the
 * tweet posts successfully.
 *
 * THE FIX. Swap the mismatched name for the one the prompt actually calls:
 * `requiredFunctionCalls` -> `["twitter_outreach", "post_on_connected_account"]`.
 * This always fixes completion-checking (the false `publishRequirementMismatch`
 * failure). Whether it ALSO fixes authorization depends on a field this script
 * does not own — see below.
 *
 * THE ONE THING THIS CANNOT GUARANTEE ON ITS OWN. Traced end to end against
 * `resolveSchedulePublishAuthorization`'s "never asked" fallback
 * (`schedulePublishAuthorization.ts`): AS LONG AS `autopublishAuthorized` is
 * still unset when a run reads the schedule, putting `post_on_connected_account`
 * directly in `requiredFunctionCalls` makes `getRequiredPublishTools` derive the
 * correct authorization scope on its own — no separate grant needed. But if
 * ENG-1404's `autopublishAuthorized` grant is EVER set explicitly (there or
 * elsewhere) with the wrong tool scope, that explicit grant wins over this
 * fallback regardless of what `requiredFunctionCalls` says, and this swap alone
 * stops being sufficient for authorization (it still fixes completion-checking).
 * `fixRequiredFunctionMismatch` reads and reports that field's current state in
 * `authorizationNote` below instead of assuming it is still unset — check that
 * note before treating a run of this script as a complete fix. Also directly
 * endorsed by Harsha on ENG-1404 as a valid path: "swapping twitter_manage_post
 * for post_on_connected_account in Required Actions instead of running the
 * grant: that would also work... either path is fine."
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA TO RUN THIS (see CLAUDE.md). Single-record
 * write, conditioned on the record still looking like what this script read
 * (owner + the exact stale `requiredFunctionCalls` value), so it fails closed
 * if anything about the schedule changed underneath it rather than overwriting
 * blind. Not to be run by a coding agent.
 *
 * Usage:
 *   # Dry run — prints the diff, writes nothing
 *   npx ts-node src/scripts/fix-eng1404-schedule-required-function.ts
 *
 *   # Apply
 *   npx ts-node src/scripts/fix-eng1404-schedule-required-function.ts --apply --confirmed-by "Harsha"
 */

import { scheduleDb } from '../services/db';

export const SCHEDULE_ID = '1d001fba-0fb7-4bcd-80f6-6041b244a442';
export const EXPECTED_OWNER_ID = '1743956381327';

const STALE_REQUIRED_FUNCTION_CALLS = ['twitter_outreach', 'twitter_manage_post'];
const CORRECTED_REQUIRED_FUNCTION_CALLS = ['twitter_outreach', 'post_on_connected_account'];

/** Order-insensitive set equality — the schedule record's array order isn't load-bearing. */
function sameNames(a: string[], b: string[]): boolean {
  return a.length === b.length && b.every((name) => a.includes(name));
}

export interface FixResult {
  applied: boolean;
  scheduleId: string;
  before: string[] | undefined;
  after: string[];
  skippedReason?: string;
  /**
   * Diagnosis of whether this swap is, on its own, ALSO sufficient to fix
   * authorization (not just completion-checking) — computed from the
   * schedule's own `autopublishAuthorized`/`autopublishAuthorizedTools` state
   * at read time, not assumed. See the module docblock.
   */
  authorizationNote: string;
}

const PUBLISH_TOOL_NAME = 'post_on_connected_account';

function diagnoseAuthorization(schedule: any): string {
  if (schedule.requirePublishApproval === true) {
    return (
      'requirePublishApproval is true — the owner has explicitly asked to review every ' +
      'publish. This swap still fixes completion-checking, but the schedule will stay ' +
      'draft-only until the owner turns that off, independent of anything here.'
    );
  }
  const consent = schedule.autopublishAuthorized;
  if (consent === undefined || consent === null) {
    return (
      'autopublishAuthorized is unset — authorization derives from requiredFunctionCalls ' +
      '(the ENG-803 fallback), so this swap fixes BOTH authorization and completion-checking.'
    );
  }
  if (consent === false) {
    return (
      'autopublishAuthorized is explicitly false (revoked) — this swap still fixes ' +
      'completion-checking, but the schedule will stay draft-only until the owner ' +
      're-authorizes, independent of anything here.'
    );
  }
  const grantedTools: string[] = Array.isArray(schedule.autopublishAuthorizedTools)
    ? schedule.autopublishAuthorizedTools
    : [];
  if (grantedTools.includes(PUBLISH_TOOL_NAME)) {
    return (
      `autopublishAuthorized is already true with ${PUBLISH_TOOL_NAME} in ` +
      'autopublishAuthorizedTools — authorization is already correct via that explicit ' +
      'grant. This swap only fixes completion-checking.'
    );
  }
  return (
    `WARNING: autopublishAuthorized is already true, but autopublishAuthorizedTools is ` +
    `${JSON.stringify(grantedTools)} — does NOT include ${PUBLISH_TOOL_NAME}. An explicit ` +
    'grant always wins over the requiredFunctionCalls fallback, so this swap fixes ' +
    'completion-checking but does NOT fix authorization: the run will still be refused. ' +
    'autopublishAuthorizedTools needs correcting too (see ENG-1404) before this schedule ' +
    'can actually publish.'
  );
}

export async function fixRequiredFunctionMismatch(opts: {
  apply: boolean;
  getScheduleById?: (id: string) => Promise<any>;
  update?: (id: string, patch: any, expect?: Record<string, any>) => Promise<any>;
}): Promise<FixResult> {
  const getScheduleById = opts.getScheduleById ?? ((id: string) => scheduleDb.getScheduleById(id));
  const update =
    opts.update ??
    ((id: string, patch: any, expect?: Record<string, any>) => scheduleDb.updateSchedule(id, patch, expect));

  const schedule = await getScheduleById(SCHEDULE_ID);
  if (!schedule) {
    return {
      applied: false,
      scheduleId: SCHEDULE_ID,
      before: undefined,
      after: CORRECTED_REQUIRED_FUNCTION_CALLS,
      skippedReason: 'schedule not found',
      authorizationNote: 'not applicable — schedule not found',
    };
  }

  const authorizationNote = diagnoseAuthorization(schedule);

  // Fail closed rather than silently touching a different owner's schedule if the
  // id were ever mistyped or reused.
  if (schedule.userId !== EXPECTED_OWNER_ID) {
    return {
      applied: false,
      scheduleId: SCHEDULE_ID,
      before: schedule.requiredFunctionCalls,
      after: CORRECTED_REQUIRED_FUNCTION_CALLS,
      skippedReason: `owner mismatch — expected ${EXPECTED_OWNER_ID}, found ${schedule.userId}`,
      authorizationNote,
    };
  }

  const current: string[] = Array.isArray(schedule.requiredFunctionCalls) ? schedule.requiredFunctionCalls : [];

  if (sameNames(current, CORRECTED_REQUIRED_FUNCTION_CALLS)) {
    return {
      applied: false,
      scheduleId: SCHEDULE_ID,
      before: current,
      after: current,
      skippedReason: 'already corrected',
      authorizationNote,
    };
  }

  if (!sameNames(current, STALE_REQUIRED_FUNCTION_CALLS)) {
    // The record no longer looks like the exact stale shape this one-off script
    // was written against — stop rather than guess at an unfamiliar shape.
    return {
      applied: false,
      scheduleId: SCHEDULE_ID,
      before: current,
      after: CORRECTED_REQUIRED_FUNCTION_CALLS,
      skippedReason:
        `requiredFunctionCalls is ${JSON.stringify(current)}, not the expected stale value ` +
        `${JSON.stringify(STALE_REQUIRED_FUNCTION_CALLS)} — re-check before running`,
      authorizationNote,
    };
  }

  if (!opts.apply) {
    return {
      applied: false,
      scheduleId: SCHEDULE_ID,
      before: current,
      after: CORRECTED_REQUIRED_FUNCTION_CALLS,
      authorizationNote,
    };
  }

  await update(
    SCHEDULE_ID,
    {
      requiredFunctionCalls: CORRECTED_REQUIRED_FUNCTION_CALLS,
      updatedAt: new Date().toISOString(),
    },
    {
      userId: schedule.userId,
      requiredFunctionCalls: schedule.requiredFunctionCalls,
    },
  );

  return {
    applied: true,
    scheduleId: SCHEDULE_ID,
    before: current,
    after: CORRECTED_REQUIRED_FUNCTION_CALLS,
    authorizationNote,
  };
}

/* istanbul ignore next -- CLI wrapper, exercised by hand under Harsha's supervision */
async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const confirmedByIndex = argv.indexOf('--confirmed-by');
  const confirmedBy = confirmedByIndex >= 0 ? argv[confirmedByIndex + 1] : '';

  if (apply && !confirmedBy) {
    console.error('Refusing to apply without --confirmed-by "<name of the person approving this>".');
    process.exit(1);
  }

  const result = await fixRequiredFunctionMismatch({ apply });

  console.log(`Schedule ${result.scheduleId}`);
  console.log(`  before: ${JSON.stringify(result.before)}`);
  console.log(`  after:  ${JSON.stringify(result.after)}`);
  console.log(`  authorization: ${result.authorizationNote}`);
  if (result.skippedReason) {
    console.log(`  SKIPPED: ${result.skippedReason}`);
  } else {
    console.log(
      result.applied
        ? `  APPLIED by ${confirmedBy}.`
        : '  DRY RUN — nothing written. Re-run with --apply --confirmed-by "<name>" to write.'
    );
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error('Fix failed:', err);
    process.exit(1);
  });
}
