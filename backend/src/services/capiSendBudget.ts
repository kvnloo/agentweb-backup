/**
 * Shared CAPI send throttling — two independent layers, extracted from `routes/webhooks.ts`
 * (ENG-926 §C) so the CRM → Meta conversion relay throttles against the same counters as
 * the form-submission path rather than growing a second set that drifts. Same reasoning as
 * pulling `metaAccountCredentials` out of `metaV2.ts`: one implementation, not two.
 *
 * Leaf module by design — imports nothing from services/ or routes/, so both the relay and
 * the webhook route can depend on it without a cycle.
 */

// ENG-492: bounds how often the Meta CAPI send is actually ATTEMPTED per lead list, so a
// scripted flood against one customer's list can't pollute their live ad account with
// unlimited fake "Lead" conversions. Deliberately NOT an HTTP-level rate limiter (like
// express-rate-limit) — this only ever gates the optional, fire-and-forget CAPI call, never
// the lead save/response itself, so hitting the cap has zero customer-visible effect: the
// lead still saves normally, the response is still 201, the only consequence is that this
// one submission doesn't get forwarded to Meta.
const capiSendTimestampsByListId = new Map<string, number[]>();
const CAPI_SEND_BUDGET_MAX = 100;
const CAPI_SEND_BUDGET_WINDOW_MS = 15 * 60 * 1000;

export function shouldAttemptCapiSend(listId: string): boolean {
  const now = Date.now();
  const recent = (capiSendTimestampsByListId.get(listId) || []).filter(
    (t) => now - t < CAPI_SEND_BUDGET_WINDOW_MS,
  );
  if (recent.length >= CAPI_SEND_BUDGET_MAX) {
    capiSendTimestampsByListId.set(listId, recent);
    // Logged every time (not just on the first overflow) so the actual overflow VOLUME is
    // visible in logs, not just that it happened once — that's what tells us whether
    // CAPI_SEND_BUDGET_MAX is too low for a real customer's real traffic (tune it up) vs.
    // a genuine flood (leave it, or investigate the source).
    console.warn(
      `[CAPI] Send budget exhausted for list ${listId} (${recent.length}/${CAPI_SEND_BUDGET_MAX} ` +
      `in the last ${CAPI_SEND_BUDGET_WINDOW_MS / 60000}min) — this submission's Lead event will NOT be forwarded to Meta. Lead itself still saved normally.`
    );
    return false;
  }
  recent.push(now);
  capiSendTimestampsByListId.set(listId, recent);
  return true;
}

// Second, independent layer on top of the per-listId budget above: that budget is an
// invented internal number, not Meta's actual rate limit. Meta documents NO fixed CAPI
// rate limit of its own — CAPI calls count against the ad account's dynamic Business Use
// Case (BUC) allowance, reported on every response via the X-Business-Use-Case-Usage
// header (see metaService.sendCapiLeadEvent's CapiUsage return). A customer with many
// lists, each individually within its own per-list budget, could still collectively
// exceed what THEIR OWN Meta access token is actually allowed. This tracks that real
// signal per ad account and pauses sends for that account using Meta's own reported
// cooldown — Meta's own documented advice is to stop calling once throttled, since
// calling through it only extends the throttle.
const capiAccountPausedUntil = new Map<string, number>();

export function isCapiAccountPaused(accountId: string): boolean {
  const pausedUntil = capiAccountPausedUntil.get(accountId);
  return !!pausedUntil && Date.now() < pausedUntil;
}

export function recordCapiUsage(
  accountId: string,
  usage?: { callCountPct: number; totalTimePct: number; totalCpuTimePct: number; estimatedMinutesToRegainAccess?: number },
): void {
  if (!usage || usage.estimatedMinutesToRegainAccess === undefined) return;
  const atLimit = usage.callCountPct >= 100 || usage.totalTimePct >= 100 || usage.totalCpuTimePct >= 100;
  if (!atLimit) return;
  const pausedUntil = Date.now() + usage.estimatedMinutesToRegainAccess * 60_000;
  capiAccountPausedUntil.set(accountId, pausedUntil);
  console.warn(
    `[CAPI] Meta ad account ${accountId} at its Business Use Case rate limit ` +
    `(call_count=${usage.callCountPct}%, total_time=${usage.totalTimePct}%, total_cputime=${usage.totalCpuTimePct}%) — ` +
    `pausing CAPI sends for this account for ~${usage.estimatedMinutesToRegainAccess}min. Leads still save normally.`
  );
}

/** Test-only reset. Both maps are module-level singletons, so one suite's sends otherwise
 *  silently satisfy (or exhaust) the next suite's budget — the same hazard already
 *  documented for metaPixelsCache's `__clearPixelsCacheForTests`. */
export function __resetCapiSendBudgetForTests(): void {
  capiSendTimestampsByListId.clear();
  capiAccountPausedUntil.clear();
}
