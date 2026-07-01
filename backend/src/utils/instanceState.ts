/**
 * Instance-local state for graceful shutdown coordination.
 *
 * cronEnabled starts true on every new instance. gracefulShutdown() calls
 * disableCron() as its very first action so that:
 *   - /run-scheduled-chats returns 503 immediately (agent-engine reroutes to
 *     the new instance within one 5-second poll cycle)
 *   - every setInterval/setTimeout background worker skips its next tick
 *
 * This flag is intentionally in-memory only — no DynamoDB or Redis needed.
 * Each new instance always starts with cronEnabled = true.
 */

let cronEnabled = true;

export const isCronEnabled = (): boolean => cronEnabled;

export const disableCron = (): void => {
  cronEnabled = false;
  console.log('[instanceState] Cron disabled — instance is draining, no new scheduled work accepted');
};

/**
 * Interactive-request acceptance flag. gracefulShutdown() flips this OFF so
 * /generate (and the shared-conversation variant) return 503 SHUTTING_DOWN
 * during the drain — no new runs start while in-flight ones are drained.
 * Clients retry and the ALB routes them to the new instance. Same in-memory,
 * per-instance semantics as cronEnabled.
 */
let acceptingRequests = true;

export const isAcceptingRequests = (): boolean => acceptingRequests;

export const stopAcceptingRequests = (): void => {
  acceptingRequests = false;
  console.log('[instanceState] Request acceptance disabled — instance is draining, /generate now returns 503 SHUTTING_DOWN');
};

/** Test-only: restore both flags to their boot state. */
export const __resetInstanceStateForTests = (): void => {
  cronEnabled = true;
  acceptingRequests = true;
};
