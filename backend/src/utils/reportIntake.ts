/**
 * Shared helpers for the in-app report intake route (POST /api/support/report-ui-bug).
 *
 * WHY THIS EXISTS (ENG-529)
 * -------------------------
 * The route built its report title from the RAW first 80 characters of the user's description
 * and reused that string verbatim as the Resend email subject. A multiline description therefore
 * put a newline in the subject, Resend rejected the send with
 * `422 validation_error: "The \n is not allowed in the subject field."`, and because that `await`
 * sat inside the route's success-critical try/catch an already-filed report was reported to the
 * user as HTTP 500. The generic failure toast then invited retries, so one report became three
 * reporter tickets (#169, #170, #171) on 2026-07-26.
 *
 * Two pieces live here, both deliberately pure/bounded so they can be unit-tested on their own:
 *
 *  1. `buildReportTitle` — the ONE place the shared title is normalized, so the tracked issue
 *     title and the outbound notification subject are derived from the same single-line text and
 *     can never disagree or carry a line break again.
 *  2. `fileReportOnce` — a short-window replay guard keyed on the report's identity, so a retried
 *     or timed-out submission replays the first filing result instead of creating another
 *     reporter ticket for the same report.
 */

import { createHash } from 'crypto';

/**
 * Characters that must never survive into a title or an email subject: ASCII control codes
 * (which includes \n, \r and \t), DEL, and every Unicode whitespace/line separator — the last
 * group covers U+2028/U+2029, which some mail APIs also treat as line breaks.
 */
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]+/g;

/** Collapse every whitespace/control run into a single space and trim. Never returns a newline. */
export function toSingleLine(text: string): string {
  return text.replace(WHITESPACE_OR_CONTROL, ' ').trim();
}

/** How much of the description the shared title carries. Matches the pre-ENG-529 slice width. */
export const REPORT_TITLE_DESCRIPTION_LIMIT = 80;

/**
 * The shared report title: `"<prefix>: <single-lined description summary>"`.
 *
 * Normalization happens BEFORE truncation, so the summary is 80 characters of readable text
 * rather than 80 characters that may end mid-newline.
 */
export function buildReportTitle(
  prefix: string,
  description: string,
  limit: number = REPORT_TITLE_DESCRIPTION_LIMIT,
): string {
  const cleanPrefix = toSingleLine(prefix);
  const summary = toSingleLine(description).slice(0, limit).trim();
  return summary ? `${cleanPrefix}: ${summary}` : cleanPrefix;
}

/** The identity of a submitted report — what makes two submissions "the same report". */
export interface ReportIdentity {
  userId: string;
  reportType: string;
  description: string;
  pageUrl?: string;
}

/**
 * Stable fingerprint for a report. Built from the NORMALIZED description so a retry that differs
 * only in whitespace still collapses onto the first filing.
 */
export function reportFingerprint(id: ReportIdentity): string {
  const material = [id.userId, id.reportType, id.pageUrl ?? '', toSingleLine(id.description)].join('\u0000');
  return createHash('sha256').update(material).digest('hex');
}

/**
 * How long a successful filing is replayed for a repeat submission of the same report. Long
 * enough to cover a user clicking submit again after an ambiguous/timed-out response (the ENG-529
 * incident spanned 4.5 minutes), short enough that a genuine re-report later still files.
 */
export const REPORT_REPLAY_WINDOW_MS = 10 * 60 * 1000;
/** Maximum request-level backpressure before the caller gets an explicit retryable response. */
export const REPORT_CAPACITY_WAIT_MS = 5_000;

export class ReportReplayCapacityError extends Error {
  constructor() {
    super('Report replay guard is busy; retry later');
    this.name = 'ReportReplayCapacityError';
  }
}

/**
 * Per-authenticated-user bound. One abusive or broken client can exhaust only its own replay
 * bucket; it cannot turn replay protection into a process-wide admission gate for other users.
 */
const MAX_TRACKED_REPORTS_PER_SCOPE = 500;
/** Process-wide hard bound; per-user isolation must not make aggregate memory unbounded. */
const MAX_TRACKED_REPORTS_TOTAL = 2_000;
const DEFAULT_REPLAY_SCOPE = 'default';

interface TrackedReport {
  promise: Promise<unknown>;
  at: number;
  settled: boolean;
}

/**
 * In-process replay state. The backend serves HTTP from a single process (no cluster fork), so
 * this covers every retry that reaches the API. If the environment is ever scaled out, the guard
 * degrades to per-instance and intake's own canonical dedup still groups the reports — it never
 * becomes wrong, only less tight.
 */
const trackedByScope = new Map<string, Map<string, TrackedReport>>();
let trackedReportCount = 0;
let earliestSettledExpiry = Number.POSITIVE_INFINITY;

function deleteTrackedReport(
  scope: string,
  trackedByFingerprint: Map<string, TrackedReport>,
  fingerprint: string,
  expected?: TrackedReport,
): boolean {
  const current = trackedByFingerprint.get(fingerprint);
  if (!current || (expected && current !== expected)) return false;

  trackedByFingerprint.delete(fingerprint);
  trackedReportCount -= 1;
  if (trackedByFingerprint.size === 0) trackedByScope.delete(scope);
  return true;
}

function pruneExpiredInScope(
  scope: string,
  trackedByFingerprint: Map<string, TrackedReport>,
  now: number,
): void {
  for (const [fingerprint, entry] of trackedByFingerprint) {
    if (entry.settled && now >= entry.at + REPORT_REPLAY_WINDOW_MS) {
      deleteTrackedReport(scope, trackedByFingerprint, fingerprint, entry);
    }
  }
}

/**
 * A full-registry sweep runs only when aggregate admission is blocked and the known earliest
 * settled entry can have expired. Ordinary requests inspect only their bounded user scope.
 */
function pruneAllExpired(now: number): void {
  let nextSettledExpiry = Number.POSITIVE_INFINITY;
  for (const [scope, trackedByFingerprint] of trackedByScope) {
    for (const [fingerprint, entry] of trackedByFingerprint) {
      const expiry = entry.at + REPORT_REPLAY_WINDOW_MS;
      if (entry.settled && now >= expiry) {
        deleteTrackedReport(scope, trackedByFingerprint, fingerprint, entry);
      } else if (entry.settled) {
        nextSettledExpiry = Math.min(nextSettledExpiry, expiry);
      }
    }
  }
  earliestSettledExpiry = nextSettledExpiry;
}

/**
 * At aggregate capacity, admitting a new report evicts the oldest SETTLED replay entry rather
 * than rejecting an unrelated user's filing — other tenants' replay state must never consume a
 * user's right to file. Evicting a settled entry only weakens replay suppression for that one
 * already-completed report (its later retry re-files); it never loses an in-flight filing.
 * Pending entries are never evicted — they are the authoritative in-flight filings — so an
 * all-pending registry still fails closed as genuine overload. Runs only on the rare
 * blocked-admission path; ordinary requests still touch only their own scope.
 */
function evictOldestSettled(): boolean {
  let oldestScope: string | undefined;
  let oldestReports: Map<string, TrackedReport> | undefined;
  let oldestFingerprint: string | undefined;
  let oldestEntry: TrackedReport | undefined;
  for (const [scope, trackedByFingerprint] of trackedByScope) {
    for (const [fingerprint, entry] of trackedByFingerprint) {
      if (entry.settled && (!oldestEntry || entry.at < oldestEntry.at)) {
        oldestScope = scope;
        oldestReports = trackedByFingerprint;
        oldestFingerprint = fingerprint;
        oldestEntry = entry;
      }
    }
  }
  if (!oldestScope || !oldestReports || !oldestFingerprint || !oldestEntry) return false;
  return deleteTrackedReport(oldestScope, oldestReports, oldestFingerprint, oldestEntry);
}

function reportsForScope(scope: string): Map<string, TrackedReport> {
  let reports = trackedByScope.get(scope);
  if (!reports) {
    reports = new Map<string, TrackedReport>();
    trackedByScope.set(scope, reports);
  }
  return reports;
}

/**
 * Wait until one authoritative in-flight filing settles. This is backpressure, not another
 * tracking structure: the fixed-size per-user map remains the only retained replay state, and a
 * waiting request never invokes its filer until it can first claim a tracked slot.
 */
async function waitForTrackedFilingToSettle(
  trackedByFingerprint: Map<string, TrackedReport>,
  waitMs: number,
): Promise<void> {
  const active = Array.from(trackedByFingerprint.values())
    .filter((entry) => !entry.settled)
    .map((entry) => entry.promise.then(
      () => undefined,
      () => undefined,
    ));
  if (active.length === 0) {
    throw new ReportReplayCapacityError();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.race(active),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ReportReplayCapacityError()), waitMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Test-only: clears the replay state so each test starts from a clean slate. */
export function __resetReportIdempotencyForTests(): void {
  trackedByScope.clear();
  trackedReportCount = 0;
  earliestSettledExpiry = Number.POSITIVE_INFINITY;
}

export interface FileReportOnceResult<T> {
  result: T;
  /** True when this call replayed an earlier (in-flight or completed) filing instead of filing. */
  replayed: boolean;
}

/**
 * Run `file` at most once per fingerprint per replay window.
 *
 * A repeat submission that arrives while the first filing is still in flight awaits that same
 * promise; one that arrives after it completed replays the stored result. A FAILED filing is
 * never retained — nothing was tracked, so the user's retry must genuinely re-file. `scope` must
 * be the authenticated user id in production so capacity pressure cannot cross tenant boundaries.
 */
export async function fileReportOnce<T>(
  fingerprint: string,
  file: () => Promise<T>,
  now: number = Date.now(),
  capacityWaitMs: number = REPORT_CAPACITY_WAIT_MS,
  scope: string = DEFAULT_REPLAY_SCOPE,
): Promise<FileReportOnceResult<T>> {
  let trackedByFingerprint = trackedByScope.get(scope);
  if (trackedByFingerprint) {
    pruneExpiredInScope(scope, trackedByFingerprint, now);
    if (trackedByFingerprint.size === 0) trackedByFingerprint = undefined;
  }

  const existing = trackedByFingerprint?.get(fingerprint);
  if (existing) {
    // An active filing is always authoritative, even after the completed-result replay window.
    // Starting a replacement while it is pending makes duplicate durable tickets reachable.
    if (!existing.settled || now - existing.at < REPORT_REPLAY_WINDOW_MS) {
      return { result: (await existing.promise) as T, replayed: true };
    }
    deleteTrackedReport(scope, trackedByFingerprint!, fingerprint, existing);
  }

  // Never evict a fresh replay: doing so would let that report's next retry create a duplicate
  // durable ticket. At capacity, wait briefly for an active filing to fail and release its slot;
  // all-settled capacity (or a bounded wait timeout) returns the explicit retryable overload
  // response. No filer runs without first claiming tracked state.
  if (trackedByFingerprint && trackedByFingerprint.size >= MAX_TRACKED_REPORTS_PER_SCOPE) {
    await waitForTrackedFilingToSettle(trackedByFingerprint, capacityWaitMs);
    return fileReportOnce(fingerprint, file, now, capacityWaitMs, scope);
  }
  if (
    trackedReportCount >= MAX_TRACKED_REPORTS_TOTAL
    && now >= earliestSettledExpiry
  ) {
    pruneAllExpired(now);
  }
  if (trackedReportCount >= MAX_TRACKED_REPORTS_TOTAL && !evictOldestSettled()) {
    // Every tracked entry is an in-flight filing: this is genuine overload, not
    // replay bookkeeping, so the caller gets the explicit retryable response.
    throw new ReportReplayCapacityError();
  }

  trackedByFingerprint ??= reportsForScope(scope);
  const promise = file();
  const entry: TrackedReport = { promise, at: now, settled: false };
  trackedByFingerprint.set(fingerprint, entry);
  trackedReportCount += 1;
  try {
    const result = await promise;
    entry.settled = true;
    earliestSettledExpiry = Math.min(
      earliestSettledExpiry,
      entry.at + REPORT_REPLAY_WINDOW_MS,
    );
    return { result, replayed: false };
  } catch (error) {
    // Never let an older rejection delete a replacement entry.
    deleteTrackedReport(scope, trackedByFingerprint, fingerprint, entry);
    throw error;
  }
}
