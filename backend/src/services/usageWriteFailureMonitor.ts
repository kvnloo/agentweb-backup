/**
 * Retry-then-surface for vendor usage writes (ENG-702 AC3 and AC6).
 *
 * The defect this closes, quoted from the row: `recordUsage` "swallows every
 * error and logs at most once per 60 seconds; all callers fire with `void`. A
 * DynamoDB outage produces one log line and unbounded unattributed revenue
 * loss, with **no counter of what was lost**."
 *
 * The missing counter is the real problem. A throttled log line tells you
 * something failed; it cannot tell you how much money stopped being recorded,
 * which is the only question worth asking during an outage.
 *
 * ## Why "surfaced" is not "thrown"
 *
 * Every caller invokes `recordVendorUsage` fire-and-forget. A rejection there
 * becomes an unhandled promise rejection and takes the process down — metering
 * killing the product it meters, which is a far worse outcome than a lost row
 * and is a crash we have already shipped once (ENG-1804). So AC3 is served by
 * an aggregated, loud, countable alert rather than by throwing into a caller
 * that cannot catch it. AC4's "never blocks or fails the caller's operation"
 * points the same way.
 *
 * ## Why retry is gated on idempotency
 *
 * A retry is only safe when the write is idempotent. On the token path
 * (ENG-702 AC1) the conditional transaction makes a replay a no-op, so
 * retrying costs nothing. On the tokenless legacy path the aggregate write is
 * an unconditional `ADD`: if the first attempt actually landed and only its
 * response was lost, a retry double-counts — the precise failure AC1 exists to
 * prevent. There we fail toward UNDER-counting, which reconciliation (AC5)
 * detects, rather than toward over-charging a customer, which it cannot undo.
 */

/** Retryable: the write may not have happened, and trying again may work. */
const TRANSIENT_CODES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "Throttling",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
  "TransactionConflictException",
  "TimeoutError",
  "NetworkingError",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
]);

/**
 * A permanent failure retried is just a slower failure, and it delays the alert
 * that says spend is going unrecorded. Validation errors, a missing table and a
 * denied write will never succeed on attempt three.
 */
export function isTransientWriteError(error: unknown): boolean {
  const code = (error as { code?: string; name?: string })?.code ?? (error as { name?: string })?.name;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

export interface RetryOptions {
  attempts?: number;
  /** Base delay; each attempt waits baseDelayMs * 2^(n-1). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `write`, retrying only transient failures.
 *
 * Bounded at three attempts on purpose: this runs inside a request's lifetime,
 * and a longer ladder turns a DynamoDB brownout into latency the customer feels
 * for a row nothing reads synchronously.
 */
export async function retryTransientWrite<T>(write: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await write();
    } catch (error) {
      lastError = error;
      if (!isTransientWriteError(error) || attempt === attempts) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

export interface DroppedWrite {
  provider: string;
  operation: string;
  costMicroUsd: number;
  billingUserId: string;
  reason: string;
}

export interface DroppedWriteWindow {
  count: number;
  /** The number the row said was missing: how much spend stopped being recorded. */
  lostMicroUsd: number;
  byProvider: Record<string, number>;
  firstAt: string;
  lastAt: string;
  sampleReason: string;
}

/** How long one alert covers. A sustained outage produces one line per window. */
export const ALERT_WINDOW_MS = 60_000;

/**
 * How long the drops must have stopped before a successful write may close the
 * open window early. Short enough that a brief outage is reported promptly,
 * long enough that interleaved failures do not each get their own alert.
 */
export const RECOVERY_QUIET_MS = 5_000;

let window: DroppedWriteWindow | null = null;
let windowStartedAt = 0;
let cumulative = { count: 0, lostMicroUsd: 0 };

type Emit = (summary: DroppedWriteWindow) => void;

/**
 * Default sink: one structured line per window, on a marker other tooling can
 * key an alarm off. Injectable so a caller can route it at a real alerting
 * surface without this module reaching for one.
 */
let emit: Emit = (summary) => {
  console.error(
    "[usageWriteFailure] ALERT vendor usage writes are being dropped:",
    JSON.stringify({
      count: summary.count,
      lostUsd: (summary.lostMicroUsd / 1e6).toFixed(6),
      byProvider: summary.byProvider,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
      sampleReason: summary.sampleReason,
    }),
  );
};

export function setDroppedWriteAlertSink(sink: Emit): void {
  emit = sink;
}

/**
 * Emit, clearing the window FIRST and swallowing a sink failure.
 *
 * `emit` is injectable, so it can throw (CodeRabbit, PR #2807). On the
 * fire-and-forget vendor path that exception escapes as an unhandled rejection
 * and takes the process down — alerting about lost writes becoming a bigger
 * outage than the lost writes. Clearing before the call also stops a
 * persistently broken sink from re-emitting the same window forever.
 */
function emitAndClear(): void {
  const pending = window;
  window = null;
  if (!pending) return;
  try {
    emit(pending);
  } catch (error) {
    console.error(
      "[usageWriteFailure] alert sink threw; dropped-write summary lost:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Record a write that could not be persisted, and alert at most once per
 * window (AC6).
 *
 * The window is flushed when the NEXT drop arrives after it has expired, so a
 * burst of a thousand failures inside one minute produces exactly one alert
 * carrying all thousand — rather than a thousand alerts, which is the failure
 * mode AC6 names and the reason nobody reads them.
 */
export function recordDroppedWrite(drop: DroppedWrite, now: number = Date.now()): void {
  cumulative = { count: cumulative.count + 1, lostMicroUsd: cumulative.lostMicroUsd + drop.costMicroUsd };

  if (window && now - windowStartedAt >= ALERT_WINDOW_MS) {
    emitAndClear();
  }

  if (!window) {
    windowStartedAt = now;
    window = {
      count: 0,
      lostMicroUsd: 0,
      byProvider: {},
      firstAt: new Date(now).toISOString(),
      lastAt: new Date(now).toISOString(),
      sampleReason: drop.reason,
    };
  }

  window.count += 1;
  window.lostMicroUsd += drop.costMicroUsd;
  window.byProvider[drop.provider] = (window.byProvider[drop.provider] || 0) + 1;
  window.lastAt = new Date(now).toISOString();
}

/**
 * Emit whatever the open window holds, if anything.
 *
 * Without this the last window of an outage is never reported: `recordDroppedWrite`
 * only flushes when a LATER drop arrives, so when the failures stop — which is
 * exactly when someone starts investigating — the final and often largest batch
 * would sit unemitted forever.
 */
export function flushDroppedWriteAlerts(now: number = Date.now()): void {
  if (!window) return;

  // Two independent reasons to close a window, and the age check alone was
  // wrong (CodeRabbit, PR #2807): if writes fail for ten seconds and then
  // recover, the window is only ten seconds old, so an age-gated flush is a
  // no-op — and with no later drop to close it, that alert never fires at all.
  // Recovery is itself the signal that a window is complete.
  //
  // The quiet period is what keeps AC6 intact. Flushing on every success
  // outright would emit one alert per failure whenever failures and successes
  // interleave, which is precisely the "one alert per dropped record" AC6
  // forbids. A window only closes once no new drop has landed for
  // RECOVERY_QUIET_MS, so a sustained outage still produces one alert per
  // ALERT_WINDOW_MS and nothing more.
  const expired = now - windowStartedAt >= ALERT_WINDOW_MS;
  const settled = now - Date.parse(window.lastAt) >= RECOVERY_QUIET_MS;

  if (expired || settled) emitAndClear();
}

/** Totals since process start. Surfaces what was lost, per AC3. */
export function getDroppedWriteTotals(): { count: number; lostMicroUsd: number } {
  return { ...cumulative };
}

/** Test seam. */
export function resetDroppedWriteState(): void {
  window = null;
  windowStartedAt = 0;
  cumulative = { count: 0, lostMicroUsd: 0 };
}
