/**
 * Short-lived cache for GET /api/meta/v2/pixels (ENG-1141).
 *
 * That endpoint fans out ONE Graph call per connected ad account, and both callers — the
 * landing-page create dialog and the Connected Accounts card — refetch every time they open.
 * An agency with 20 accounts would otherwise spend 20 Graph calls per dialog-open, with the
 * picker (and the Generate button behind it) waiting on all of them.
 *
 * TTL alone is NOT sufficient, which is the whole reason this lives in its own module rather
 * than inline in the route. The dangerous flow is onboarding: connect a Meta account, then
 * immediately open the create dialog. `/connected-accounts` is uncached and reports the new
 * account, but a `/pixels` entry cached moments earlier (when there were none) would return
 * an empty list — and "no pixels" reads as "nothing ambiguous to pick", so the page ships
 * SILENTLY UNTRACKED. That is precisely the failure this ticket exists to prevent, and a
 * 60-second self-heal does not help: the untracked page is permanent.
 *
 * So connect/disconnect invalidate this explicitly (see connectedAccountsDb), and the TTL is
 * only a backstop for changes made outside our system — a pixel created directly in Meta
 * Business Manager, which we never observe.
 *
 * Deliberately per-process and in-memory: the backend runs multiple instances, so two requests
 * can briefly disagree. That is acceptable for a picker's option list (worst case a customer
 * sees a slightly stale set and reopens), and is not acceptable for anything that decides what
 * gets written — which is why nothing but this endpoint reads it.
 */

const TTL_MS = 60_000;
/** Bounded so a large tenant can't grow this without limit; oldest entry is evicted. */
const MAX_ENTRIES = 500;

export interface CachedPixel {
  pixelId: string;
  accountId: string;
  accountName?: string;
}

const cache = new Map<string, { at: number; pixels: CachedPixel[] }>();

export function getCachedPixels(userId: string): CachedPixel[] | null {
  const hit = cache.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(userId);
    return null;
  }
  return hit.pixels;
}

export function setCachedPixels(userId: string, pixels: CachedPixel[]): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, { at: Date.now(), pixels });
}

/**
 * Drop a user's entry. Called whenever a connected account is created or deleted — the two
 * events that change which pixels exist for that user. Cheap and safe to over-call: a miss
 * just means the next request pays the normal fan-out.
 */
export function invalidateCachedPixels(userId: string): void {
  cache.delete(userId);
}

/** Test-only: process-level state would otherwise leak between cases in one suite. */
export function __clearPixelsCacheForTests(): void {
  cache.clear();
}
