/**
 * ENG-2743 — flag scheduled agent runs whose daily cost jumps.
 *
 * Scheduled runs have no per-run token or cost cap (the per-session breaker is ENG-2812, still a decision),
 * and a schedule's cost can double over a week without anyone noticing: Nuerraa's daily newsletter send went
 * from ~$2-4/day to $13-17/day (Oct 26-29), an hourly lead follow-up from ~$5.6/day to ~$13/day (Nov 4-6).
 *
 * Once a day this reads the usage ledger (`AW-UsageRecords`, daily aggregates; each scheduled run's agent
 * loop is metered as feature `agent_task:scheduled:<scheduleId>`), sums each schedule's cost per UTC day, and
 * compares the last complete day with the median of the schedule's previous billed days. A schedule is
 * flagged when that day cost at least MIN_ALERT_USD and at least JUMP_RATIO times its baseline median (with
 * at least MIN_BASELINE_DAYS billed days of history). Flagged schedules go out as ONE email a day to the oncall
 * list (`oncall_emails`), by email only: no Linear issue is filed (owner's choice, 2026-11-12).
 *
 * Read-only: no database writes, no change to any schedule. Registered in server.ts (behind
 * isCronEnabled()) as a 15-minute tick that only acts during one UTC hour (scheduleCostJumpTick), so a deploy
 * outside that hour never repeats a day's email.
 */

import { usageRecordDb, type UsageRecordRow } from '../services/usageRecordDb';
import { emailService } from '../services/emailService';

/** Evaluated days this process has finished (emailed, or nothing to report). */
const finishedDays = new Set<string>();
/** Test hook. */
export function resetScheduleCostJumpDedupe(): void {
  finishedDays.clear();
}

const TAG = '[scheduleCostJumpCron]';
const FEATURE_PREFIX = 'agent_task:scheduled:';

/**
 * The check ticks every 15 minutes (and once at boot) but only acts during this UTC hour (07:00 UTC =
 * 12:30 IST). Every deploy starts a new process; without a fixed hour each boot would email the same flagged
 * day again. With it, a day is emailed once per process within that hour. A deploy that overlaps that hour
 * (immutable deploys run the old and new instance side by side; prod deploys ~12 times a day) can still send a
 * flagged day twice; the owner accepted that duplicate over a stored per-day marker (2026-11-12).
 */
export const SCHEDULE_COST_JUMP_TICK_MS = 15 * 60 * 1000;
export const SCHEDULE_COST_JUMP_SEND_HOUR_UTC = 7;
/** Days before the evaluated day that form the baseline. */
export const BASELINE_DAYS = 7;
/** Billed days needed in the baseline before a schedule can be judged (new schedules are skipped). */
export const MIN_BASELINE_DAYS = 3;
/** The evaluated day must cost at least this many times the baseline median... */
export const JUMP_RATIO = 2;
/** ...and at least this much, so cheap schedules never page. */
export const MIN_ALERT_USD = 3;

export interface ScheduleDayTotals {
  costUsd: number;
  calls: number;
  /** A trace breadcrumb for oncall (the last session that contributed on that day), not an owner. */
  lastSessionId?: string;
  billingUserId?: string;
}

export interface ScheduleCostJump {
  scheduleId: string;
  day: string;
  costUsd: number;
  calls: number;
  baselineMedianUsd: number;
  baselineDays: number;
  ratio: number;
  billingUserId?: string;
  lastSessionId?: string;
}

/** YYYY-MM-DD of a UTC day offset from `now`. */
export function utcDay(now: number, offsetDays: number): string {
  return new Date(now + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Sum ledger rows into per-schedule, per-day totals (all models of a schedule's agent loop together). */
export function totalsBySchedule(rows: UsageRecordRow[]): Map<string, Map<string, ScheduleDayTotals>> {
  const out = new Map<string, Map<string, ScheduleDayTotals>>();
  for (const r of rows) {
    if (typeof r.feature !== 'string' || !r.feature.startsWith(FEATURE_PREFIX)) continue;
    const scheduleId = r.feature.slice(FEATURE_PREFIX.length).trim();
    if (!scheduleId || typeof r.date !== 'string') continue;
    const cost = Number(r.costMicroUsd);
    const calls = Number(r.callCount);
    let days = out.get(scheduleId);
    if (!days) out.set(scheduleId, (days = new Map()));
    const t = days.get(r.date) ?? { costUsd: 0, calls: 0 };
    t.costUsd += Number.isFinite(cost) ? cost / 1e6 : 0;
    t.calls += Number.isFinite(calls) ? calls : 0;
    if (r.lastSessionId) t.lastSessionId = r.lastSessionId;
    if (r.billingUserId) t.billingUserId = r.billingUserId;
    days.set(r.date, t);
  }
  return out;
}

/** Pure: the schedules whose `day` cost jumped against their own previous BASELINE_DAYS days. */
export function findScheduleCostJumps(rows: UsageRecordRow[], day: string): ScheduleCostJump[] {
  const baselineDates = new Set<string>();
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  for (let i = 1; i <= BASELINE_DAYS; i++) baselineDates.add(utcDay(dayMs, -i));

  const jumps: ScheduleCostJump[] = [];
  for (const [scheduleId, days] of totalsBySchedule(rows)) {
    const target = days.get(day);
    if (!target || target.costUsd < MIN_ALERT_USD) continue;
    const baseline = [...days.entries()]
      .filter(([d, t]) => baselineDates.has(d) && t.costUsd > 0)
      .map(([, t]) => t.costUsd);
    if (baseline.length < MIN_BASELINE_DAYS) continue;
    const base = median(baseline);
    if (base <= 0 || target.costUsd < JUMP_RATIO * base) continue;
    jumps.push({
      scheduleId,
      day,
      costUsd: target.costUsd,
      calls: target.calls,
      baselineMedianUsd: base,
      baselineDays: baseline.length,
      ratio: target.costUsd / base,
      billingUserId: target.billingUserId,
      lastSessionId: target.lastSessionId,
    });
  }
  return jumps.sort((a, b) => b.costUsd - a.costUsd);
}

export interface ScheduleCostJumpSummary {
  day: string;
  rowsRead: number;
  jumps: number;
  alertSent: boolean;
}

/**
 * The 15-minute tick registered in server.ts. Outside SCHEDULE_COST_JUMP_SEND_HOUR_UTC it does nothing (no
 * ledger read). Inside it, it runs the check unless this process already finished the day; a day is finished
 * when it had no jump or its email went out, so a failed send is tried again on the next tick of the hour.
 */
export async function scheduleCostJumpTick(
  now: number = Date.now(),
  readRows?: (start: string, end: string) => Promise<UsageRecordRow[]>,
): Promise<ScheduleCostJumpSummary | null> {
  if (new Date(now).getUTCHours() !== SCHEDULE_COST_JUMP_SEND_HOUR_UTC) return null;
  if (finishedDays.has(utcDay(now, -1))) return null;
  const summary = await runScheduleCostJumpCheck(now, readRows);
  if (summary.jumps === 0 && summary.rowsRead > 0) finishedDays.add(summary.day);
  return summary;
}

/** `now` and the ledger reader are injectable for tests; production uses Date.now() and the real ledger. */
export async function runScheduleCostJumpCheck(
  now: number = Date.now(),
  readRows: (start: string, end: string) => Promise<UsageRecordRow[]> = (s, e) => usageRecordDb.scanByDateRange(s, e),
): Promise<ScheduleCostJumpSummary> {
  // The last complete UTC day; today's row is still being written.
  const day = utcDay(now, -1);
  const summary: ScheduleCostJumpSummary = { day, rowsRead: 0, jumps: 0, alertSent: false };

  let rows: UsageRecordRow[];
  try {
    rows = await readRows(utcDay(now, -1 - BASELINE_DAYS), day);
  } catch (error) {
    console.error(`${TAG} Failed to read the usage ledger:`, (error as Error)?.message);
    return summary;
  }
  summary.rowsRead = rows.length;

  const jumps = findScheduleCostJumps(rows, day);
  summary.jumps = jumps.length;
  if (jumps.length === 0) {
    console.log(`${TAG} ${day}: no schedule cost jumps (${rows.length} ledger rows)`);
    return summary;
  }

  const lines = jumps
    .map((j) =>
      `- schedule ${j.scheduleId}: $${j.costUsd.toFixed(2)} on ${j.day} (${j.calls} calls), ` +
      `${j.ratio.toFixed(1)}x its median of $${j.baselineMedianUsd.toFixed(2)}/day over ${j.baselineDays} prior day(s); ` +
      `billing user ${j.billingUserId ?? 'unknown'}, last session ${j.lastSessionId ?? 'unknown'}`)
    .join('\n');

  if (finishedDays.has(day)) {
    console.log(`${TAG} ${day}: ${jumps.length} schedule cost jump(s), already emailed by this process`);
    return summary;
  }
  try {
    summary.alertSent = await emailService.sendOncallEmailOnly(
      `${jumps.length} scheduled run${jumps.length === 1 ? '' : 's'} cost ${JUMP_RATIO}x+ more than usual on ${day}`,
      `These schedules cost at least ${JUMP_RATIO}x their usual daily cost (median of the previous ` +
      `${BASELINE_DAYS} days) and at least $${MIN_ALERT_USD} on ${day} (ENG-2743). Scheduled runs have no ` +
      `per-run cost cap yet (ENG-2812), so check whether each is real work or a loop / model change:\n\n${lines}`,
    );
    if (summary.alertSent) finishedDays.add(day);
  } catch (error) {
    console.error(`${TAG} Failed to send the alert:`, (error as Error)?.message);
  }

  console.log(`${TAG} ${day}: ${jumps.length} schedule cost jump(s), alertSent=${summary.alertSent}`);
  return summary;
}
