/**
 * ENG-827 — record affirmative publish consent for schedules whose owners have said yes.
 *
 * WHAT THIS IS FOR — AND WHY IT IS NO LONGER A PREREQUISITE
 * ---------------------------------------------------------
 * ENG-827 adds affirmative, tool-scoped consent (`autopublishAuthorized` +
 * `autopublishAuthorizedTools`). It deliberately did NOT flip the default: a schedule
 * that has never been asked still resolves to authorized under the opt-out ENG-803
 * shipped, because reading that silence as a refusal would stop the ~25 schedules
 * publishing today — the exact failure ENG-827 was filed about, at larger scale.
 *
 * So nothing depends on this script having run. It exists to CLOSE that gap properly:
 * record a real consent decision for each legacy schedule, so the default can later be
 * flipped to opt-in without stopping anyone. Running it is inert with respect to
 * behaviour — it only turns an implicit yes into an explicit, scoped one.
 *
 * The eventual sequence is therefore:
 *
 *      1. survey   →   2. ask the owners   →   3. apply   →   4. flip the default
 *                                                               (a separate ticket)
 *
 * DATA-PLANE CHANGE — REQUIRES HARSHA'S APPROVAL BEFORE IT IS RUN (see CLAUDE.md).
 * This is a bulk mutation of production schedule records. Do not run it unattended.
 *
 * TWO PHASES, BECAUSE CONSENT CANNOT BE INFERRED
 * ----------------------------------------------
 * An earlier draft granted to every schedule that looked like it was already
 * publishing. That reasoning is circular: the whole point of ENG-827 is that a
 * schedule's configuration never expressed a consent decision, which is why we are
 * adding a field to hold one. Reading consent back out of that same configuration
 * would record a decision nobody made, in the owner's name, on the one question this
 * ticket says a human has to answer.
 *
 * So the script does not decide. It surveys, and then it writes down answers:
 *
 *   PHASE 1 — SURVEY (no allowlist, writes nothing)
 *       Prints every schedule that WOULD need a consent decision. This is the list to
 *       take to the owners. Nothing here is a grant.
 *
 *   PHASE 2 — APPLY (allowlist file required)
 *       Grants to exactly the schedules named in the file, each line carrying the
 *       owner's user id and a note recording how their confirmation was obtained.
 *       An id that is not in the file gets nothing, however much it looks eligible.
 *
 * The owner id on each line is not decoration: it is checked against the schedule's
 * real owner, so a mistyped schedule id fails closed instead of quietly granting
 * unreviewed publishing on a stranger's account.
 *
 * WHAT IT WILL NEVER DO, ALLOWLISTED OR NOT
 * -----------------------------------------
 *   - override an owner who set `requirePublishApproval` — that is a decision they DID
 *     make, and reversing it is the one thing this migration must never do
 *   - revisit a schedule that already has a consent decision recorded, grant OR refusal
 *   - touch an inactive schedule
 *   - INFER a tool scope from the schedule's own configuration. The survey (no
 *     allowlist) still requires a publish tool already named in requiredFunctionCalls,
 *     because with nothing else on the line that field is the only candidate signal —
 *     and inferring consent from it circularly is exactly what this ticket exists to
 *     stop.
 *
 * ENG-1245 — an ALLOWLISTED line may instead SPELL OUT the tools with `tools=`, because
 * that is not inference: it is the operator recording an answer a human actually gave.
 * Session 0e5af215's schedule (1d001fba-0fb7-4bcd-80f6-6041b244a442, "Harsha Daily X
 * Post (Autonomous)") is exactly the case the survey-only design missed — its
 * requiredFunctionCalls (["twitter_outreach"]) names no publish tool (it names the
 * research tool the completion checker happens to require), so it was never a
 * candidate and even a confirmed allowlist line for it granted nothing. `tools=` is
 * scoped no differently than the derived path: still gated on every existing safety
 * check (active, no `requirePublishApproval`, no consent already recorded, owner
 * match), and still validated against the real publish-tool registry
 * (`isPublishCapableTool`) so a typo cannot grant an unrelated tool.
 *
 * Usage:
 *   # Phase 1 — who needs to be asked
 *   npx ts-node src/scripts/grant-schedule-autopublish.ts
 *
 *   # Phase 2 — dry run against the collected confirmations, then write
 *   npx ts-node src/scripts/grant-schedule-autopublish.ts --allowlist ./consent.txt
 *   npx ts-node src/scripts/grant-schedule-autopublish.ts --allowlist ./consent.txt \
 *       --apply --confirmed-by "Harsha"
 *
 * Allowlist format — one schedule per line, `#` comments and blank lines ignored:
 *   <scheduleId>  <ownerUserId>  <how the owner confirmed>
 *   sched-abc123  e86420f2-4374-…  ruiw@agentweb.pro confirmed in #ops on 2026-08-11
 *
 * An optional `tools=` token — no spaces, comma-separated — between the owner id and
 * the note records the EXACT tools the owner confirmed, independent of
 * requiredFunctionCalls. Only needed when the schedule doesn't already name a publish
 * tool there:
 *   <scheduleId>  <ownerUserId>  tools=<tool1>[,<tool2>...]  <how the owner confirmed>
 *   1d001fba-0fb7-4bcd-80f6-6041b244a442  1743956381327  tools=post_on_connected_account  Harsha confirmed via Linear ENG-1404 on 2026-08-20
 */

import { scheduleDb } from '../services/db';
import { getRequiredPublishTools, isPublishCapableTool } from '../utils/schedulePublishAuthorization';

interface Candidate {
  scheduleId: string;
  scheduleName: string;
  userId: string;
  tools: string[];
}

/** One line of the allowlist: a schedule, its owner, and how they said yes. */
export interface ConsentConfirmation {
  scheduleId: string;
  ownerUserId: string;
  /**
   * ENG-1245: the exact tools the owner confirmed, from a `tools=` token — present
   * only when the line carried one. Absent (not an empty array) means "derive the
   * scope from requiredFunctionCalls", the original ENG-827 behavior.
   */
  tools?: string[];
  note: string;
}

export interface BackfillResult {
  scanned: number;
  /** Eligible for a grant IF its owner confirms. The survey output — never a grant. */
  candidates: Candidate[];
  /** Confirmed by an allowlist line AND eligible. Written when `apply` is set. */
  granted: Candidate[];
  /** Eligible, but nobody has confirmed it yet. */
  unconfirmed: Candidate[];
  /** Allowlist lines that could not be honoured, each with the reason. */
  rejected: Array<{ scheduleId: string; ownerUserId: string; reason: string }>;
  /** Schedules that are not eligible at all, allowlisted or not. */
  skipped: Array<{ scheduleId: string; scheduleName: string; reason: string }>;
  applied: boolean;
}

/**
 * Parse the confirmations file. Strict on purpose: a line we cannot read is an
 * operator error on a file that grants permission to publish in someone's name, so it
 * stops the run rather than being skipped with a warning nobody reads.
 */
export function parseConsentAllowlist(text: string): ConsentConfirmation[] {
  const out: ConsentConfirmation[] = [];

  (text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;

    const [scheduleId, ownerUserId, ...rest] = line.split(/\s+/);

    // ENG-1245: an optional tools=a,b token, always the first word after the owner id
    // and never spaced internally (the line is whitespace-delimited). Everything after
    // it is still the free-text note.
    let tools: string[] | undefined;
    let noteTokens = rest;
    if (rest[0]?.startsWith('tools=')) {
      tools = rest[0]
        .slice('tools='.length)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (tools.length === 0) {
        throw new Error(`Allowlist line ${i + 1} has an empty tools= list: ${line}`);
      }
      noteTokens = rest.slice(1);
    }

    const note = noteTokens.join(' ').trim();
    if (!scheduleId || !ownerUserId || !note) {
      throw new Error(
        `Allowlist line ${i + 1} is not "<scheduleId> <ownerUserId> [tools=t1,t2] <how the owner confirmed>": ${line}`,
      );
    }

    out.push(tools ? { scheduleId, ownerUserId, tools, note } : { scheduleId, ownerUserId, note });
  });

  return out;
}

export async function backfillPublishConsent(opts: {
  apply: boolean;
  confirmedBy: string;
  allowlist?: ConsentConfirmation[];
  listSchedules?: () => Promise<any[]>;
  update?: (scheduleId: string, patch: any, expect?: Record<string, any>) => Promise<any>;
}): Promise<BackfillResult> {
  // Not `(scheduleDb as any)` — the cast is what let this default point at a method
  // that did not exist. Every test injects `listSchedules`, so the only caller of the
  // default is the operator running the CLI, and they would have got a TypeError
  // before a single schedule was read. Keep it typed so the compiler holds the wiring.
  const listSchedules = opts.listSchedules ?? (() => scheduleDb.getAllSchedules());
  const update =
    opts.update ??
    ((id: string, patch: any, expect?: Record<string, any>) => scheduleDb.updateSchedule(id, patch, expect));
  const allowlist = opts.allowlist ?? [];

  if (opts.apply && allowlist.length === 0) {
    // Without this an --apply typo becomes a silent grant to everything eligible.
    throw new Error('Refusing to apply with an empty allowlist — consent has to be confirmed per schedule.');
  }

  // Safety gates that apply no matter how the tool scope is determined — the derived
  // survey path below, and the ENG-1245 explicit `tools=` allowlist path further down.
  // None of these are about scope; all of them are about whether a grant may happen
  // at all.
  const ineligibilityReason = (schedule: any): string | null => {
    if (schedule.status !== 'active') return 'not active';
    if (schedule.requirePublishApproval === true) return 'owner requires approval';
    if (schedule.autopublishAuthorized !== undefined && schedule.autopublishAuthorized !== null) {
      return 'consent already recorded';
    }
    return null;
  };

  const all = (await listSchedules()) || [];
  const candidates: Candidate[] = [];
  const skipped: BackfillResult['skipped'] = [];
  const byId = new Map<string, any>();

  for (const schedule of all) {
    const scheduleId = schedule?.scheduleId;
    const scheduleName = schedule?.scheduleName || schedule?.name || '(unnamed)';
    if (!scheduleId) continue;
    byId.set(scheduleId, schedule);

    const reason = ineligibilityReason(schedule);
    if (reason) {
      skipped.push({ scheduleId, scheduleName, reason });
      continue;
    }

    const tools = getRequiredPublishTools(schedule.requiredFunctionCalls);
    if (tools.length === 0) {
      skipped.push({ scheduleId, scheduleName, reason: 'no publishing tool designated' });
      continue;
    }

    candidates.push({ scheduleId, scheduleName, userId: schedule.userId, tools });
  }

  const eligible = new Map(candidates.map((c) => [c.scheduleId, c]));
  const confirmed: Candidate[] = [];
  const rejected: BackfillResult['rejected'] = [];
  const seen = new Set<string>();

  for (const entry of allowlist) {
    const reject = (reason: string) =>
      rejected.push({ scheduleId: entry.scheduleId, ownerUserId: entry.ownerUserId, reason });

    if (seen.has(entry.scheduleId)) {
      reject('duplicate allowlist entry');
      continue;
    }
    seen.add(entry.scheduleId);

    const schedule = byId.get(entry.scheduleId);
    if (!schedule) {
      reject('no such schedule');
      continue;
    }
    if (schedule.userId !== entry.ownerUserId) {
      // A mistyped id must not grant on whoever's schedule it landed on.
      reject(`owner mismatch — allowlist says ${entry.ownerUserId}, schedule belongs to ${schedule.userId}`);
      continue;
    }

    if (entry.tools) {
      // ENG-1245: an explicit, operator-recorded answer — not inferred from
      // requiredFunctionCalls, so it can grant a schedule that never became a
      // `candidates` entry (e.g. one whose requiredFunctionCalls names a checker
      // tool, not a publish tool). Still bound by every other safety gate, and still
      // validated against the real publish-tool registry so a typo can't grant an
      // unrelated tool.
      const reason = ineligibilityReason(schedule);
      if (reason) {
        reject(reason);
        continue;
      }
      const invalid = entry.tools.filter((t) => !isPublishCapableTool(t));
      if (invalid.length > 0) {
        reject(`tools= names a tool that is not publish-capable: ${invalid.join(', ')}`);
        continue;
      }
      confirmed.push({
        scheduleId: entry.scheduleId,
        scheduleName: schedule.scheduleName || schedule.name || '(unnamed)',
        userId: schedule.userId,
        tools: Array.from(new Set(entry.tools)),
      });
      continue;
    }

    const candidate = eligible.get(entry.scheduleId);
    if (!candidate) {
      // Confirmed, but something about the schedule itself forbids the grant. Say which,
      // rather than dropping the line: the operator collected an answer for this one.
      const why = skipped.find((s) => s.scheduleId === entry.scheduleId)?.reason ?? 'not eligible';
      reject(why);
      continue;
    }

    confirmed.push(candidate);
  }

  // Not granted until the write actually lands: a schedule edited between the scan and
  // the write is reported, not authorized.
  let granted: Candidate[] = confirmed;

  if (opts.apply) {
    granted = [];
    for (const c of confirmed) {
      const source = byId.get(c.scheduleId);
      const now = new Date().toISOString();
      try {
        await update(
          c.scheduleId,
          {
            autopublishAuthorized: true,
            autopublishAuthorizedTools: c.tools,
            autopublishAuthorizedAt: now,
            // The owner, exactly as the consent endpoint records it — a migrated row must
            // be indistinguishable from one where they ticked the box themselves. The
            // operator who ran the migration is named in the run log, not here: this field
            // answers "who authorized this", and the answer is never the operator.
            autopublishAuthorizedBy: c.userId,
            updatedAt: now,
          },
          // Everything this grant was DERIVED from, as it read a moment ago. The apply
          // pass can run long — one write per schedule, sequentially — and the owner can
          // be revoking, renaming or re-scoping throughout it. Writing unconditionally
          // would record a decision against a schedule that no longer looks like the one
          // the owner answered about: a re-scoped `requiredFunctionCalls` would leave the
          // grant pointing at tools they never saw, and an approval hold set in the
          // window would be silently overridden — the one thing this migration must
          // never do. The interactive endpoint conditions its grant the same way.
          // `undefined` compiles to attribute_not_exists, which is exactly the state
          // eligibility required of `autopublishAuthorized`.
          {
            userId: source.userId,
            status: source.status,
            requiredFunctionCalls: source.requiredFunctionCalls,
            requirePublishApproval: source.requirePublishApproval,
            autopublishAuthorized: source.autopublishAuthorized,
          },
        );
        granted.push(c);
      } catch (writeError: any) {
        if (
          writeError?.code !== 'ConditionalCheckFailedException' &&
          writeError?.name !== 'ConditionalCheckFailedException'
        ) {
          throw writeError;
        }
        // One moved schedule must not abort the run and leave the rest unmigrated.
        // Report it and carry on; the operator re-surveys and re-asks that owner.
        rejected.push({
          scheduleId: c.scheduleId,
          ownerUserId: c.userId,
          reason: 'schedule changed after it was read — not granted; re-run the survey for this one',
        });
      }
    }
  }

  const confirmedIds = new Set(granted.map((g) => g.scheduleId));
  return {
    scanned: all.length,
    candidates,
    granted,
    unconfirmed: candidates.filter((c) => !confirmedIds.has(c.scheduleId)),
    rejected,
    skipped,
    applied: opts.apply,
  };
}

/* istanbul ignore next -- CLI wrapper, exercised by hand under Harsha's supervision */
async function main() {
  const argv = process.argv.slice(2);
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : '';
  };
  const apply = argv.includes('--apply');
  const confirmedBy = arg('--confirmed-by');
  const allowlistPath = arg('--allowlist');

  if (apply && !confirmedBy) {
    console.error('Refusing to apply without --confirmed-by "<name of the person approving this>".');
    process.exit(1);
  }
  if (apply && !allowlistPath) {
    console.error('Refusing to apply without --allowlist <file of per-schedule owner confirmations>.');
    process.exit(1);
  }

  const allowlist = allowlistPath
    ? parseConsentAllowlist(require('fs').readFileSync(allowlistPath, 'utf8'))
    : [];

  const result = await backfillPublishConsent({ apply, confirmedBy, allowlist });

  console.log(`\nScanned ${result.scanned} schedules.`);

  if (allowlist.length === 0) {
    console.log(`\nSURVEY — these need a consent decision from their owner (${result.candidates.length}):`);
    for (const c of result.candidates) {
      console.log(`  ${c.scheduleId}  ${c.userId}  ${c.scheduleName}  ->  ${c.tools.join(', ')}`);
    }
    console.log('\nNothing was written. Take this list to the owners, record their answers in an');
    console.log('allowlist file (one "<scheduleId> <ownerUserId> <how they confirmed>" per line),');
    console.log('and re-run with --allowlist <file>.');
  } else {
    console.log(`\n${result.applied ? 'GRANTED' : 'WOULD GRANT'} (${result.granted.length}):`);
    for (const g of result.granted) {
      console.log(`  ${g.scheduleId}  ${g.scheduleName}  ->  ${g.tools.join(', ')}`);
    }
    if (result.unconfirmed.length) {
      console.log(`\nELIGIBLE BUT UNCONFIRMED — left alone (${result.unconfirmed.length}):`);
      for (const u of result.unconfirmed) console.log(`  ${u.scheduleId}  ${u.scheduleName}`);
    }
    if (result.rejected.length) {
      console.log(`\nALLOWLIST LINES NOT HONOURED (${result.rejected.length}):`);
      for (const r of result.rejected) console.log(`  ${r.scheduleId}  ${r.reason}`);
    }
  }

  const reasons = result.skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] || 0) + 1;
    return acc;
  }, {});
  console.log(`\nNOT ELIGIBLE (${result.skipped.length}):`, reasons);
  console.log(
    result.applied
      ? `\nAPPLIED by ${confirmedBy}. Merge the PR only after confirming these records look right.`
      : '\nDRY RUN — nothing written.'
  );
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
