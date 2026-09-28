/**
 * ENG-2181 — pause and transfer emongiovi@xcures.com's ("Ed", a departed
 * employee) scheduled chats to agentwebintegration@xcures.com ("Filipe"),
 * per Filipe's explicit request on the ticket: pause them so they stop
 * consuming credits unsupervised, then hand them to him to review whether
 * they still provide value.
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA TO RUN THIS (see CLAUDE.md). Bulk
 * mutation of production schedule records reassigning ownership between real
 * user accounts. Not to be run by a coding agent.
 *
 * WHAT THIS DOES, PER SCHEDULE
 * -----------------------------
 * 1. `status: 'paused'` — the exact write the manual pause endpoint makes
 *    (`toggleScheduledChatStatus`), so this is indistinguishable from Filipe
 *    pausing it by hand.
 * 2. `userId: <Filipe's userId>` — schedule ownership. `runScheduledChat`
 *    resolves every credential/entitlement/connected-account check off this
 *    field alone at run time (nothing is cached from the old owner), so once
 *    this lands the schedule is Filipe's in every sense, not just on paper.
 * 3. Clears any recorded publish consent (`autopublishAuthorized`,
 *    `autopublishAuthorizedTools`, `autopublishAuthorizedAt`,
 *    `autopublishAuthorizedBy`) back to "never asked". Ed's consent decision
 *    (or lack of one) does not transfer to Filipe — same reasoning as the
 *    ENG-827 migration: a consent decision must be made by the person it
 *    binds, never inferred or carried over.
 * 4. ONLY if Ed's email is explicitly listed in `emailNotifications`, swaps
 *    it for Filipe's. An empty/absent list is left untouched: every
 *    notification call site in agentModeController already falls back to
 *    whoever currently owns the schedule (or stays deliberately silent for
 *    report preflight), so a schedule that never named Ed explicitly must
 *    not come out of this naming Filipe explicitly either.
 *
 * WHAT THIS DELIBERATELY LEAVES ALONE
 * ------------------------------------
 * Because ownership is resolved live off `userId`, any schedule whose prompt
 * or config depends on a connected account (LinkedIn, email sender, etc.)
 * that only Ed had access to will silently stop finding it once transferred
 * — it will not error cleanly, it will just run without that access. That is
 * exactly the review Filipe asked to do ("review whether they still provide
 * value"), so this script pauses first and leaves resuming to him — it does
 * not attempt to detect or fix account mismatches itself.
 *
 * Usage:
 *   # Dry run — prints every schedule that would be paused and transferred,
 *   # writes nothing
 *   npx ts-node src/scripts/eng2181-transfer-eds-schedules-to-filipe.ts
 *
 *   # Apply — also writes a JSON manifest of exactly what moved into
 *   # Filipe's account, meant to be handed to whoever messages him (e.g. in
 *   # the XCures group) so they can name the schedules instead of speaking
 *   # about the change in the abstract. Defaults to
 *   # eng2181-transfer-manifest.json in the current directory; override with
 *   # --manifest <path>.
 *   npx ts-node src/scripts/eng2181-transfer-eds-schedules-to-filipe.ts \
 *       --apply --confirmed-by "Harsha" [--manifest ./eng2181-transfer-manifest.json]
 */

import { scheduleDb, userDb } from '../services/db';

export const ED_EMAIL = 'emongiovi@xcures.com';
export const FILIPE_EMAIL = 'agentwebintegration@xcures.com';
// Sanity guard against a typo'd email silently resolving to the wrong account —
// this is the userId Filipe's own bug report was filed under.
export const EXPECTED_FILIPE_USER_ID = 'f958eb3e-4e82-4227-8aa8-634476498a62';

export interface ScheduleTransfer {
  scheduleId: string;
  scheduleName: string;
  /** Owner-authored summary, if any — the most useful line for naming the schedule in a customer message. */
  description: string;
  frequency: string;
  statusBefore: string;
  emailNotificationsBefore: string[];
  emailNotificationsAfter: string[];
  emailNotificationsChanged: boolean;
}

/** Just enough to name a previously-transferred schedule in the manifest — never written to again. */
export interface AlreadyTransferredSchedule {
  scheduleId: string;
  scheduleName: string;
  description: string;
}

export interface TransferResult {
  edUserId?: string;
  filipeUserId?: string;
  scanned: number;
  /** Ed's active/paused schedules eligible for transfer. */
  candidates: ScheduleTransfer[];
  /** Already owned by Filipe — left alone, but still named here for a complete manifest. */
  alreadyTransferred: AlreadyTransferredSchedule[];
  /** Written when `apply` is set; equals `candidates` minus any that raced. */
  transferred: ScheduleTransfer[];
  /** A schedule changed underneath the read — not transferred. */
  raced: string[];
  skippedReason?: string;
}

const CONSENT_FIELDS_TO_CLEAR = [
  'autopublishAuthorized',
  'autopublishAuthorizedTools',
  'autopublishAuthorizedAt',
  'autopublishAuthorizedBy',
];

/**
 * Swap `fromEmail` for `toEmail` in an `emailNotifications` list — but ONLY if
 * `fromEmail` is actually in it. An empty/absent list is not "nobody
 * configured a recipient yet": every notification call site in
 * agentModeController falls back to the CURRENT owner's account email at send
 * time (`scheduleUser?.email`, resolved live off `schedule.userId`), and for
 * report-preflight it's deliberately silent by design. So a schedule that
 * never named Ed explicitly must not come out of this script naming Filipe
 * explicitly either — that would turn on notifications nobody asked for, or
 * pin a hardcoded address where the system was already correctly following
 * whoever owns the schedule.
 */
function swapEmail(emails: string[] | undefined, fromEmail: string, toEmail: string): { after: string[]; changed: boolean } {
  const list = emails || [];
  const fromLower = fromEmail.toLowerCase();
  if (!list.some((e) => e.toLowerCase() === fromLower)) {
    return { after: list, changed: false };
  }
  const without = list.filter((e) => e.toLowerCase() !== fromLower);
  const after = without.some((e) => e.toLowerCase() === toEmail.toLowerCase()) ? without : [...without, toEmail];
  return { after, changed: true };
}

export async function transferEdsSchedulesToFilipe(opts: {
  apply: boolean;
  getUserByEmail?: (email: string) => Promise<any>;
  getSchedulesByUserId?: (userId: string) => Promise<any[]>;
  update?: (scheduleId: string, patch: any, expect?: Record<string, any>, shedRunResults?: any, removeAttributes?: string[]) => Promise<any>;
}): Promise<TransferResult> {
  const getUserByEmail = opts.getUserByEmail ?? ((email: string) => userDb.getUserByEmailConsistent(email));
  const getSchedulesByUserId = opts.getSchedulesByUserId ?? ((userId: string) => scheduleDb.getSchedulesByUserId(userId));
  const update =
    opts.update ??
    ((scheduleId: string, patch: any, expect?: Record<string, any>, shedRunResults?: any, removeAttributes?: string[]) =>
      scheduleDb.updateSchedule(scheduleId, patch, expect, shedRunResults, removeAttributes));

  const [ed, filipe] = await Promise.all([getUserByEmail(ED_EMAIL), getUserByEmail(FILIPE_EMAIL)]);

  if (!ed) {
    return { scanned: 0, candidates: [], alreadyTransferred: [], transferred: [], raced: [], skippedReason: `no user found for ${ED_EMAIL}` };
  }
  if (!filipe) {
    return { scanned: 0, candidates: [], alreadyTransferred: [], transferred: [], raced: [], skippedReason: `no user found for ${FILIPE_EMAIL}` };
  }
  if (filipe.userId !== EXPECTED_FILIPE_USER_ID) {
    return {
      edUserId: ed.userId,
      filipeUserId: filipe.userId,
      scanned: 0,
      candidates: [],
      alreadyTransferred: [],
      transferred: [],
      raced: [],
      skippedReason: `refusing to run — ${FILIPE_EMAIL} resolved to ${filipe.userId}, expected ${EXPECTED_FILIPE_USER_ID}`,
    };
  }

  const schedules = (await getSchedulesByUserId(ed.userId)) || [];
  const candidates: ScheduleTransfer[] = [];
  const alreadyTransferred: AlreadyTransferredSchedule[] = [];

  for (const schedule of schedules) {
    if (!schedule?.scheduleId) continue;
    const scheduleName = schedule.scheduleName || schedule.name || '(unnamed)';
    if (schedule.userId === filipe.userId) {
      alreadyTransferred.push({ scheduleId: schedule.scheduleId, scheduleName, description: schedule.description || '' });
      continue;
    }
    const { after: emailNotificationsAfter, changed: emailNotificationsChanged } = swapEmail(
      schedule.emailNotifications,
      ED_EMAIL,
      FILIPE_EMAIL,
    );
    candidates.push({
      scheduleId: schedule.scheduleId,
      scheduleName,
      description: schedule.description || '',
      frequency: schedule.frequency || '',
      statusBefore: schedule.status,
      emailNotificationsBefore: schedule.emailNotifications || [],
      emailNotificationsAfter,
      emailNotificationsChanged,
    });
  }

  if (!opts.apply) {
    return { edUserId: ed.userId, filipeUserId: filipe.userId, scanned: schedules.length, candidates, alreadyTransferred, transferred: [], raced: [] };
  }

  const transferred: ScheduleTransfer[] = [];
  const raced: string[] = [];

  for (const c of candidates) {
    const now = new Date().toISOString();
    try {
      await update(
        c.scheduleId,
        {
          status: 'paused',
          userId: filipe.userId,
          // Only written when Ed's email was actually in the list — an
          // untouched empty/absent list keeps following whoever owns the
          // schedule (or stays deliberately silent), exactly as before.
          ...(c.emailNotificationsChanged ? { emailNotifications: c.emailNotificationsAfter } : {}),
          updatedAt: now,
        } as any,
        {
          userId: ed.userId,
          status: c.statusBefore,
        },
        undefined,
        CONSENT_FIELDS_TO_CLEAR,
      );
      transferred.push(c);
    } catch (writeError: any) {
      if (writeError?.code !== 'ConditionalCheckFailedException' && writeError?.name !== 'ConditionalCheckFailedException') {
        throw writeError;
      }
      // One schedule changing underneath the run must not abort the rest.
      raced.push(c.scheduleId);
    }
  }

  return { edUserId: ed.userId, filipeUserId: filipe.userId, scanned: schedules.length, candidates, alreadyTransferred, transferred, raced };
}

/* istanbul ignore next -- CLI wrapper, exercised by hand under Harsha's supervision */
async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const confirmedByIndex = argv.indexOf('--confirmed-by');
  const confirmedBy = confirmedByIndex >= 0 ? argv[confirmedByIndex + 1] : '';
  const manifestIndex = argv.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : 'eng2181-transfer-manifest.json';

  if (apply && !confirmedBy) {
    console.error('Refusing to apply without --confirmed-by "<name of the person approving this>".');
    process.exit(1);
  }

  const result = await transferEdsSchedulesToFilipe({ apply });

  if (result.skippedReason) {
    console.error(`ABORTED: ${result.skippedReason}`);
    process.exit(1);
  }

  console.log(`Ed (${ED_EMAIL}): ${result.edUserId}`);
  console.log(`Filipe (${FILIPE_EMAIL}): ${result.filipeUserId}`);
  console.log(`Scanned ${result.scanned} of Ed's schedules.`);

  if (result.alreadyTransferred.length) {
    console.log(`\nALREADY FILIPE'S — left alone (${result.alreadyTransferred.length}):`);
    for (const s of result.alreadyTransferred) console.log(`  ${s.scheduleId}  "${s.scheduleName}"`);
  }

  const list = apply ? result.transferred : result.candidates;
  console.log(`\n${apply ? 'TRANSFERRED' : 'WOULD TRANSFER'} (${list.length}):`);
  for (const c of list as ScheduleTransfer[]) {
    const emailNote = c.emailNotificationsChanged ? `  (emailNotifications: ${JSON.stringify(c.emailNotificationsBefore)} -> ${JSON.stringify(c.emailNotificationsAfter)})` : '';
    console.log(`  ${c.scheduleId}  "${c.scheduleName}"  status: ${c.statusBefore} -> paused${emailNote}`);
  }

  if (result.raced.length) {
    console.log(`\nRACED — schedule changed mid-run, not transferred (${result.raced.length}):`);
    for (const id of result.raced) console.log(`  ${id}`);
  }

  // ENG-2181: whoever messages Filipe (e.g. in the XCures group) needs to name
  // exactly what moved into his account, not describe the change in the
  // abstract. Written on apply only — a dry run hasn't moved anything yet, so
  // there is nothing real to hand off. Includes schedules transferred by an
  // earlier run of this script too, so the manifest is always the complete
  // "everything that came from Ed's account" list, not just this run's delta.
  if (apply) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      confirmedBy,
      ed: { email: ED_EMAIL, userId: result.edUserId },
      filipe: { email: FILIPE_EMAIL, userId: result.filipeUserId },
      transferredThisRun: result.transferred.map((c) => ({
        scheduleId: c.scheduleId,
        scheduleName: c.scheduleName,
        description: c.description,
        frequency: c.frequency,
        statusBeforeTransfer: c.statusBefore,
      })),
      transferredInAnEarlierRun: result.alreadyTransferred,
      notTransferred: result.raced.map((scheduleId) => ({
        scheduleId,
        reason: 'changed underneath this run — re-run the script to pick it up',
      })),
    };
    require('fs').writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nWrote manifest of everything now in Filipe's account to ${manifestPath}`);
  }

  console.log(
    apply
      ? `\nAPPLIED by ${confirmedBy}. Have Filipe review each schedule's connected accounts before resuming any of them.`
      : '\nDRY RUN — nothing written. Re-run with --apply --confirmed-by "<name>" to write.'
  );
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error('Transfer failed:', err);
    process.exit(1);
  });
}
