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
import { userDb, crmDb } from '../services/db';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';
import {
  fetchMetaAccountContext,
  snapshotMetaMetricsForDate,
  type ResolvedMetaCredentials,
  type MetaAccountContext,
} from '../cron/metaMetricsSnapshotCron';

/** The cron's own target. Haven only, deliberately — see ENG-916's note about Every.io/ENG-993. */
const DEFAULT_USER_ID = 'a3917669-1c7d-45ed-8ef9-f454de109b6f';

/** UTM tagging went live on this date. Earlier days cannot be attributed, by construction. */
const UTM_EPOCH = '2026-07-02';

/** Courtesy gap between days. Meta rate-limits per ad account, and 90 days is 90 insights calls. */
const PER_DAY_PAUSE_MS = 750;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

function assertDateStr(v: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${v}"`);
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
 * Every lead for a user bucketed by createdAt date.
 *
 * Mirrors the cron's own prefetch, and for the same reason: the per-date path cannot early-stop
 * (leads are ordered by leadId, not createdAt), so asking per day would re-walk every list once
 * per day — 90 full walks for a 90-day backfill, all returning identical pages.
 */
async function getLeadsByDateForUser(userId: string): Promise<Map<string, any[]>> {
  const byDate = new Map<string, any[]>();
  const lists = await crmDb.getLeadListsByUserId(userId);
  for (const list of lists) {
    let lastKey: any;
    do {
      const { items, lastEvaluatedKey } = await crmDb.getLeadsByListId(list.listId, 100, lastKey);
      for (const lead of items) {
        const created = (lead as any)?.createdAt;
        if (!created) continue;
        const day = String(created).split('T')[0];
        if (!byDate.has(day)) byDate.set(day, []);
        byDate.get(day)!.push(lead);
      }
      lastKey = lastEvaluatedKey;
    } while (lastKey);
  }
  return byDate;
}

async function main(): Promise<void> {
  const apply = has('apply');
  const userId = arg('user') || DEFAULT_USER_ID;

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const from = assertDateStr(arg('from') || UTM_EPOCH, '--from');
  const to = assertDateStr(arg('to') || toDateStr(yesterday), '--to');

  if (from > to) throw new Error(`--from (${from}) is after --to (${to})`);

  if (from < UTM_EPOCH && !has('allow-pre-utm')) {
    throw new Error(
      `--from ${from} predates the ${UTM_EPOCH} UTM epoch. Days before that carry no UTM tagging, ` +
      `so every row written would show 0 attributed leads — indistinguishable from a regression ` +
      `on any chart reading this store. Pass --allow-pre-utm if that is genuinely what you want.`
    );
  }

  let dates = datesBetween(from, to);
  const limit = Number(arg('limit') || 0);
  // Newest first when limited: the recent tail is the part anyone is looking at.
  if (limit > 0) dates = dates.slice(-limit);

  console.log(
    `[ENG-1601 backfill] ${apply ? 'APPLY' : 'DRY RUN (no metrics rows written, no Meta insights calls)'}`
  );
  console.log(`[ENG-1601 backfill] user=${userId} NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);
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
    leadsByDate = await getLeadsByDateForUser(userId);
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
  let rows = 0;
  let attributed = 0;
  let unattributed = 0;
  const failures: string[] = [];

  for (const dateStr of dates) {
    try {
      const r = await snapshotMetaMetricsForDate(userId, dateStr, credentials, leadsByDate, accountContext);
      ok++;
      rows += r.rowsWritten;
      attributed += r.leadCount;
      unattributed += r.unattributedLeadCount;
      console.log(
        `  ${dateStr}: ${r.rowsWritten} row(s), ${r.leadCount} attributed, ${r.unattributedLeadCount} unattributed`
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
    `\n[ENG-1601 backfill] done. ${ok} day(s) written, ${failed} failed, ${rows} row(s) total, ` +
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
