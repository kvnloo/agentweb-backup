/**
 * ENG-1601: rewrite the Meta metrics history through the FIXED lead join.
 *
 * `metaMetricsSnapshotCron` joined leads on `lead.firstTouch?.utm?.campaign` alone and dropped
 * 36% of attributable leads. On the measured 28 days, of 36 inbound leads carrying a usable
 * campaign id, 23 had it in `firstTouch` and 13 had it ONLY in `customFields`.
 * `promoteAttributionFromCustomFields` — which already existed for exactly this (ENG-926 §A) and
 * was already used at ingest — is now imported by the cron, and the 2026-08-27 09:00 UTC run
 * confirmed it live: attribution moved from 0 to 33 of 160 leads on the same store.
 *
 * But the cron only ever walks the last SETTLING_WINDOW_DAYS (28) days. Everything older was
 * either never written or was written through the broken join. This rewrites that history.
 *
 * WHY THIS IS SAFE TO RE-RUN
 * Rows key on buildEntityKey(platform, accountId, campaignId) + date — deterministic. A repeat
 * of the same date OVERWRITES its own row rather than appending, so an interrupted run is simply
 * resumed by running it again. There is no "partially applied" state to unwind.
 *
 * ⚠ THE 2026-07-02 UTM BOUNDARY
 * UTM tagging was not in place before 2026-07-02. Days earlier than that are not merely empty —
 * they are STRUCTURALLY unattributable, and writing them produces a long flat run of
 * "0 attributed" that reads as a regression on any chart built from this store. The floor is
 * therefore enforced, and `--allow-pre-utm` exists only so that choice is explicit and loud
 * rather than accidental.
 *
 * DRY RUN (default): resolves credentials, walks the CRM leads once, and prints the exact date
 * plan with per-date lead counts. Writes no METRICS rows and issues no Meta insights calls.
 *   NODE_ENV=development npx ts-node src/scripts/backfill-eng1601-meta-metrics-history.ts
 *
 * ⚠ Not literally side-effect free, and worth stating rather than implying: resolving credentials
 * goes through `getMetaAccountCredentials`, which can refresh the Meta token and PERSIST it back
 * to the user record inline (fb_exchange_token). That is the same write the cron performs every
 * day, so it is benign — but "dry run" should not be read as "touches nothing".
 *
 * APPLY:
 *   NODE_ENV=development npx ts-node src/scripts/backfill-eng1601-meta-metrics-history.ts --apply
 *
 * Recommended ladder — dry run, then a two-day apply to eyeball real output, then the rest:
 *   ... --apply --limit 2
 *
 * OPTIONS
 *   --from YYYY-MM-DD   first date to write   (default 2026-07-02, the UTM epoch)
 *   --to   YYYY-MM-DD   last date to write    (default: yesterday UTC)
 *   --user <userId>     override the target user (default: the cron's Haven user)
 *   --limit N           process at most N dates, newest first
 *   --apply             actually write (default is dry run)
 *   --allow-pre-utm     permit --from earlier than 2026-07-02
 *
 * Table prefix follows NODE_ENV like the rest of the app — set NODE_ENV=production to target the
 * real prod tables. Run against Dev first.
 *
 * ⚠ RUNNING THIS LOCALLY — `backend/.env` will send you to the wrong AWS account.
 * `services/db.ts` calls `dotenv.config()` on import, and that file currently carries
 * `AWS_REGION=ap-south-1` plus an `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair belonging to a
 * DIFFERENT AWS account from the one holding these tables. The symptom is a bare
 * `ResourceNotFoundException: Requested resource not found` from `getUserById`, which reads like a
 * missing table and is actually a wrong-account lookup.
 *
 * dotenv does not override variables already present in the environment, so blanking the two
 * credential vars restores the normal provider chain (profile / instance role):
 *
 *   AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY= AWS_SESSION_TOKEN= \
 *   NODE_ENV=production AWS_REGION=us-west-2 \
 *   npx ts-node src/scripts/backfill-eng1601-meta-metrics-history.ts
 *
 * On a deployed host none of this applies — the instance role and real env are already correct.
 */
import { userDb } from '../services/db';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';
import {
  fetchMetaAccountContext,
  snapshotMetaMetricsForDate,
  // Imported, NOT reimplemented. An earlier draft of this script kept its own copy of the lead
  // bucketing, which matched for real data and diverged on malformed `createdAt` — the cron threw,
  // the copy silently bucketed under a junk key and dropped the lead. A duplicate that can drift
  // from the thing it is supposed to mirror is how you end up verifying your own reimplementation
  // instead of the code that actually runs.
  getLeadsByDateForUser,
  type ResolvedMetaCredentials,
  type MetaAccountContext,
} from '../cron/metaMetricsSnapshotCron';

/** The cron's own target. Haven only, deliberately — see ENG-916's note about Every.io/ENG-993. */
const DEFAULT_USER_ID = 'a3917669-1c7d-45ed-8ef9-f454de109b6f';

/** UTM tagging went live on this date. Earlier days cannot be attributed, by construction. */
const UTM_EPOCH = '2026-07-02';

/** Courtesy gap between days. Meta rate-limits per ad account, and 90 days is 90 insights calls. */
const PER_DAY_PAUSE_MS = 750;

/**
 * Hard ceiling on how many days one run may touch.
 *
 * `--limit` is applied AFTER the range is generated, so it never protected against a range like
 * `2026-07-02 .. 9999-12-31` — roughly 3 million dates materialised before the limit was even
 * consulted. The range itself has to be bounded, not just the slice taken from it.
 */
const MAX_RANGE_DAYS = 400;

/**
 * Read a value option, refusing one that was supplied without a value.
 *
 * ⚠ A bare `--from` at the end of argv previously returned `undefined`, which fell through to the
 * UTM-epoch default — so `--apply --from` (a typo) silently selected the FULL range and started a
 * bulk write. A flag that is present but empty is a mistake, not a default: treat it as one. The
 * next token being another flag is the same mistake with a different shape.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`--${name} was supplied without a value.`);
  }
  return v;
}
/** True when a boolean flag is present. Boolean flags carry no value, so they need no validation. */
const has = (name: string) => process.argv.includes(`--${name}`);

/** A Date as `YYYY-MM-DD` in UTC — the same key format the snapshot rows are stored under. */
function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * ⚠ `Date.parse` NORMALISES an overflow date rather than rejecting it — `2026-09-31` silently
 * becomes `2026-10-01`. Accepting that would make the script write a date nobody asked for, and
 * for a value that is also compared as a STRING against the UTM epoch, a normalised date can land
 * on the far side of a bound it appeared to satisfy. So the parsed date must round-trip back to
 * exactly the input.
 */
function assertDateStr(v: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${v}"`);
  }
  const parsed = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
    throw new Error(`${label} is not a real calendar date: "${v}"`);
  }
  return v;
}

/** Inclusive date range, oldest first. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    out.push(toDateStr(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Refuse to write unless the target was named deliberately.
 *
 * ⚠ `adsMetricsDb` selects its table with `NODE_ENV === "development" ? "Dev-" : ""`, so ANY other
 * value — including UNSET — resolves to the production table. That is fail-OPEN: forgetting an
 * environment variable is enough to write production. For a read-only script that is harmless; for
 * one that overwrites rows it is not.
 *
 * So `--apply` additionally requires the environment to be stated explicitly, and writing to
 * production requires naming it. Nothing here can be satisfied by omission.
 */
function assertWriteTargetIsDeliberate(): 'production' | 'development' {
  const env = process.env.NODE_ENV;
  if (env !== 'production' && env !== 'development') {
    throw new Error(
      `--apply requires NODE_ENV to be exactly "production" or "development"; got ${env === undefined ? 'UNSET' : `"${env}"`}. ` +
      `adsMetricsDb treats every value except "development" as PRODUCTION, so an unset or typo'd ` +
      `value would write live data by accident.`
    );
  }
  if (env === 'production' && !has('yes-write-production')) {
    throw new Error(
      `Refusing to write to the PRODUCTION metrics table without --yes-write-production. ` +
      `Per AGENTS.md, a backfill also requires Harsha's explicit pre-merge approval; pass ` +
      `--approved-by "<name>" to record who authorised this run.`
    );
  }
  if (env === 'production' && !arg('approved-by')) {
    throw new Error(`--approved-by "<name>" is required when writing to production (AGENTS.md data-plane rule).`);
  }
  return env;
}

/**
 * Resolve the run, then either print the plan (dry run) or write it (`--apply`).
 *
 * Ordering is deliberate: every cheap refusal — scope, calendar validity, the UTM floor, the
 * latest complete day, the range ceiling, and the write-target guard — runs BEFORE any credential
 * resolution or CRM walk. A run that is going to be rejected should be rejected before it touches
 * a customer's record or spends a Graph call.
 */
async function main(): Promise<void> {
  const apply = has('apply');

  /*
   * The Haven-only scope is the cron's, and it is deliberate (ENG-916: Every.io's CAPI gap means
   * its Meta-reported conversions read as artificially low). An unrestricted --user would let this
   * script write metrics rows for an account the scope was never reasoned about.
   */
  const requestedUser = arg('user');
  if (requestedUser && requestedUser !== DEFAULT_USER_ID) {
    throw new Error(
      `--user ${requestedUser} is outside this script's scope. It targets the same single account ` +
      `as the cron (ENG-916, Haven only). Widening it is a scope decision, not a flag.`
    );
  }
  const userId = requestedUser || DEFAULT_USER_ID;

  const targetEnv = apply ? assertWriteTargetIsDeliberate() : (process.env.NODE_ENV || '(unset)');

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const from = assertDateStr(arg('from') || UTM_EPOCH, '--from');
  const to = assertDateStr(arg('to') || toDateStr(yesterday), '--to');

  if (from > to) throw new Error(`--from (${from}) is after --to (${to})`);

  /*
   * ⚠ Never write today or later.
   *
   * Today is INCOMPLETE — Meta is still accumulating it — and these rows are stamped
   * `dataQuality: "exact"`. Persisting a partial day under that label is not a smaller
   * measurement, it is a false one, and it is exactly why the cron walks `daysAgo` 1..28 and
   * never 0. Future dates are simply Meta calls that cannot return anything.
   *
   * The default `--to` is already yesterday; this stops an explicit one from reaching past it.
   */
  const latestComplete = toDateStr(yesterday);
  if (to > latestComplete) {
    throw new Error(
      `--to ${to} is later than the last COMPLETE UTC day (${latestComplete}). Today is still ` +
      `accumulating and these rows are written as dataQuality "exact", so storing a partial day ` +
      `would record it as settled. The cron never snapshots today for the same reason.`
    );
  }

  if (from < UTM_EPOCH && !has('allow-pre-utm')) {
    throw new Error(
      `--from ${from} predates the ${UTM_EPOCH} UTM epoch. Days before that carry no UTM tagging, ` +
      `so every row written would show 0 attributed leads — indistinguishable from a regression ` +
      `on any chart reading this store. Pass --allow-pre-utm if that is genuinely what you want.`
    );
  }

  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new Error(
      `${from}..${to} spans ${spanDays} days, over the ${MAX_RANGE_DAYS}-day ceiling. ` +
      `Narrow --from/--to. (--limit does not help: it is applied after the range is built.)`
    );
  }

  let dates = datesBetween(from, to);

  // A non-numeric, negative or fractional --limit previously collapsed to 0, which means "no
  // limit" — so a typo in the one flag intended to REDUCE blast radius silently removed it.
  const rawLimit = arg('limit');
  if (rawLimit !== undefined) {
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`--limit must be a positive whole number, got "${rawLimit}"`);
    }
    // Newest first: the recent tail is the part anyone is looking at.
    dates = dates.slice(-limit);
  }

  console.log(
    `[ENG-1601 backfill] ${apply ? 'APPLY' : 'DRY RUN (no metrics rows written, no Meta insights calls)'}`
  );
  console.log(`[ENG-1601 backfill] user=${userId} target=${targetEnv}` +
    (apply && targetEnv === 'production' ? ` approved-by="${arg('approved-by')}"` : ''));
  console.log(`[ENG-1601 backfill] range ${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} days)\n`);

  // Resolve ONCE for the whole run. getMetaAccountCredentials can refresh AND PERSIST the token
  // inline (fb_exchange_token), so per-day resolution would mean one write per day against a live
  // client's record — and, once a token expires, one identical CRITICAL error per day instead of
  // one. Same reasoning as the cron.
  let credentials: ResolvedMetaCredentials;
  let accountContext: MetaAccountContext;
  try {
    const user = await userDb.getUserById(userId);
    if (!user) throw new Error(`user ${userId} not found`);
    credentials = await getMetaAccountCredentials(user, userId);
    accountContext = await fetchMetaAccountContext(credentials.accountId, credentials.accessToken);
  } catch (error) {
    // No day can succeed without these, so fail once and loudly rather than N times.
    console.error('[ENG-1601 backfill] FATAL resolving credentials/account context:', error);
    process.exit(1);
  }
  console.log(
    `[ENG-1601 backfill] account=${credentials.accountId} currency=${accountContext.currency} ` +
    `tz=${accountContext.reportingTimezone ?? '(none)'}\n`
  );

  let leadsByDate: Map<string, any[]>;
  try {
    // Bounded to the requested window: the same pages are read either way, but only the leads
    // that can actually be joined are retained.
    leadsByDate = await getLeadsByDateForUser(userId, { from: dates[0], to: dates[dates.length - 1] });
  } catch (error) {
    console.error('[ENG-1601 backfill] FATAL reading CRM leads:', error);
    process.exit(1);
  }
  const totalLeads = [...leadsByDate.values()].reduce((n, l) => n + l.length, 0);
  console.log(`[ENG-1601 backfill] ${totalLeads} lead(s) across ${leadsByDate.size} day(s)\n`);

  if (!apply) {
    // Dry run validates the expensive preconditions (credentials, the full lead walk) and the
    // exact plan. It deliberately does NOT call snapshotMetaMetricsForDate, because that function
    // writes as it goes — there is no read-only mode to borrow, and adding one to shared cron code
    // for a script's benefit is a worse trade than being explicit here about the gap.
    //
    // Note the credential resolution above may already have persisted a refreshed token; see the
    // header. Calling this "writes nothing" would be the same kind of overclaim this whole ticket
    // exists to remove.
    let withLeads = 0;
    for (const d of dates) {
      const n = leadsByDate.get(d)?.length ?? 0;
      if (n > 0) withLeads++;
      console.log(`  ${d}  ${n} lead(s)${n ? '' : '  (no CRM leads; Meta rows may still be written)'}`);
    }
    console.log(
      `\n[ENG-1601 backfill] would process ${dates.length} day(s), ${withLeads} with CRM leads.\n` +
      `NOT verified by this dry run: the Meta insights fetch per day, and the resulting row values.\n` +
      `Next step: re-run with --apply --limit 2 and check those two days before the full range.`
    );
    return;
  }

  let ok = 0;
  let failed = 0;
  let campaignRows = 0;
  let accountDayRows = 0;
  let attributed = 0;
  let unattributed = 0;
  const failures: string[] = [];

  for (const dateStr of dates) {
    try {
      const r = await snapshotMetaMetricsForDate(
        userId, dateStr, credentials, leadsByDate, accountContext,
        // Stamped so a replayed row is distinguishable from one the cron observed live.
        'backfill',
      );
      ok++;
      // `rowsWritten` counts CAMPAIGN rows only — snapshotMetaMetricsForDate also always writes
      // one account_day row, which its return value does not include. Reporting the raw number
      // would say "0 row(s)" for a day that did write a row, which is exactly the kind of quiet
      // undercount this whole line of work exists to remove.
      campaignRows += r.rowsWritten;
      accountDayRows += 1;
      attributed += r.leadCount;
      unattributed += r.unattributedLeadCount;
      console.log(
        `  ${dateStr}: ${r.rowsWritten} campaign row(s) + 1 account-day row, ` +
        `${r.leadCount} attributed, ${r.unattributedLeadCount} unattributed`
      );
    } catch (error: any) {
      // One bad day must not abort the run — the write is idempotent, so a later re-run fixes
      // only what is still missing. A silent miss is the unacceptable outcome, not a noisy one.
      failed++;
      failures.push(dateStr);
      console.error(`  ${dateStr}: FAILED — ${error?.message ?? error}`);
    }
    if (PER_DAY_PAUSE_MS) await new Promise(res => setTimeout(res, PER_DAY_PAUSE_MS));
  }

  console.log(
    `\n[ENG-1601 backfill] done. ${ok} day(s) written, ${failed} failed, ` +
    `${campaignRows + accountDayRows} row(s) total (${campaignRows} campaign + ${accountDayRows} account-day), ` +
    `${attributed} attributed / ${unattributed} unattributed lead(s).`
  );
  if (failed) {
    // Named, not just counted — a count is not actionable and a re-run is cheap.
    console.log(`[ENG-1601 backfill] failed dates (re-run is safe and will retry only these):`);
    console.log(`  ${failures.join(' ')}`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('[ENG-1601 backfill] UNCAUGHT:', e);
  process.exit(1);
});
