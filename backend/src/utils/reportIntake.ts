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

/**
 * Prune threshold. Distinct reports inside a 10-minute window are few, so the map stays tiny;
 * this only exists so a pathological burst can't grow it without bound.
 */
const MAX_TRACKED_REPORTS = 500;

interface TrackedReport {
  promise: Promise<unknown>;
  at: number;
}

/**
 * In-process replay state. The backend serves HTTP from a single process (no cluster fork), so
 * this covers every retry that reaches the API. If the environment is ever scaled out, the guard
 * degrades to per-instance and intake's own canonical dedup still groups the reports — it never
 * becomes wrong, only less tight.
 */
const trackedByFingerprint = new Map<string, TrackedReport>();

function pruneExpired(now: number): void {
  if (trackedByFingerprint.size < MAX_TRACKED_REPORTS) return;
  for (const [key, entry] of trackedByFingerprint) {
    if (now - entry.at >= REPORT_REPLAY_WINDOW_MS) trackedByFingerprint.delete(key);
  }
}

/** Test-only: clears the replay state so each test starts from a clean slate. */
export function __resetReportIdempotencyForTests(): void {
  trackedByFingerprint.clear();
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
 * never retained — nothing was tracked, so the user's retry must genuinely re-file.
 */
export async function fileReportOnce<T>(
  fingerprint: string,
  file: () => Promise<T>,
  now: number = Date.now(),
): Promise<FileReportOnceResult<T>> {
  pruneExpired(now);

  const existing = trackedByFingerprint.get(fingerprint);
  if (existing && now - existing.at < REPORT_REPLAY_WINDOW_MS) {
    return { result: (await existing.promise) as T, replayed: true };
  }

  const promise = file();
  trackedByFingerprint.set(fingerprint, { promise, at: now });
  try {
    return { result: await promise, replayed: false };
  } catch (error) {
    trackedByFingerprint.delete(fingerprint);
    throw error;
  }
}
