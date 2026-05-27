/**
 * In-memory tracker for Slack-message timestamps that have already been
 * dispatched to cloud-dev. Used by the /api/slack/events reaction_added
 * handler to prevent a second ✅ on the same ai-eval-funnel digest DM
 * from spawning duplicate EC2 instances.
 *
 * Trade-off (v1, intentional):
 *   - In-memory Map → resets on backend redeploy. A dispatched message
 *     could theoretically re-dispatch ONCE after a deploy if Harsha (or
 *     anyone) re-reacts to the old DM post-deploy. Acceptable for now —
 *     the daily DMs roll fresh each morning anyway.
 *   - v2 will move this to DynamoDB AW-LoopDispatches if the redeploy
 *     edge case bites in practice.
 *
 * TTL: entries older than 7 days are swept on each call to mark/is/get.
 */

interface DispatchEntry {
  dispatchedAt: Date;
  pageIds: string[];
}

export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const store = new Map<string, DispatchEntry>();

function sweepExpired(now: number = Date.now()): void {
  for (const [ts, entry] of store) {
    if (now - entry.dispatchedAt.getTime() > TTL_MS) {
      store.delete(ts);
    }
  }
}

/**
 * Record that `messageTs` has been dispatched. Idempotent — calling twice
 * does not throw, but the latest call's `pageIds` overwrites prior. The
 * dispatchedAt timestamp is reset to "now" on each call so the TTL clock
 * restarts.
 */
export function markDispatched(messageTs: string, pageIds: string[]): void {
  sweepExpired();
  store.set(messageTs, {
    dispatchedAt: new Date(),
    pageIds: [...pageIds],
  });
}

/**
 * True if `messageTs` was already dispatched and the entry hasn't expired.
 */
export function isDispatched(messageTs: string): boolean {
  sweepExpired();
  return store.has(messageTs);
}

/**
 * Return the full entry for `messageTs`, or null if never dispatched
 * (or already expired). The returned object is the live map value — tests
 * may mutate it for fake-clock scenarios; production callers should
 * treat it as read-only.
 */
export function getDispatched(messageTs: string): DispatchEntry | null {
  sweepExpired();
  return store.get(messageTs) ?? null;
}

// ---------------------------------------------------------------------------
// Test helpers — not exported from index.
// ---------------------------------------------------------------------------

export function _resetForTesting(): void {
  store.clear();
}

export function _sweepForTesting(now: number): void {
  sweepExpired(now);
}
