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
