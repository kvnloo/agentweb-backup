import { orgDb } from '../db';
import { allowlistedE164 } from '../hotLeadCallConfig';

/**
 * Which org owns a dialled caller number (ENG-2271 inbound callbacks). AW-Organizations has no index on the
 * number, so the answer comes from a scan of the orgs that hold one, kept in this process. One snapshot serves
 * every number, so an unknown number (or a flood of them) costs no scan of its own: a miss is answered from the
 * same snapshot, which is the negative cache.
 *
 * Stale-while-revalidate: once a snapshot older than the TTL exists, calls are answered from it and one background
 * refresh runs (at most one in flight, retried no sooner than RETRY_MS after the last try, a failure only logged),
 * so the scan is never in the call path and a failing scan is not hammered. Only the first lookup after a start,
 * with no snapshot at all, awaits the scan; if that fails it throws (the call is refused) and nothing is cached.
 * The price is that a number bought or released within the last TTL, or while refreshes fail, is not seen yet; the
 * caller re-reads the org and checks its live config, so a stale hit can only ever end in a refusal.
 */

const TTL_MS = 60_000;
const RETRY_MS = 5_000;

let snapshot: { at: number; byNumber: Map<string, string> } | null = null;
let inflight: Promise<Map<string, string>> | null = null;
let lastRefreshTryAt = 0;

/** Tests only: forget the snapshot. */
export function resetInboundNumberIndexForTests(): void {
  snapshot = null;
  inflight = null;
  lastRefreshTryAt = 0;
}

async function load(): Promise<Map<string, string>> {
  const byNumber = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { orgId, twilioNumber } of await orgDb.listHotLeadCallNumbers()) {
    // Only numbers that could be a valid stored caller number; anything else can never match a dialled one.
    if (!allowlistedE164(twilioNumber)) continue;
    if (byNumber.has(twilioNumber) && byNumber.get(twilioNumber) !== orgId) ambiguous.add(twilioNumber);
    byNumber.set(twilioNumber, orgId);
  }
  // Two orgs claiming one number cannot be told apart, so neither is served.
  for (const number of ambiguous) {
    byNumber.delete(number);
    console.error('[hotLeadCall] inbound: one caller number is stored on more than one org; it is not served');
  }
  return byNumber;
}

/** One scan at a time; every concurrent caller shares it. */
function refresh(): Promise<Map<string, string>> {
  inflight ??= load()
    .then((byNumber) => { snapshot = { at: Date.now(), byNumber }; return byNumber; })
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * The id of the org whose caller number is `e164`, or null when none (or more than one) holds it. Throws only when
 * there is no snapshot yet and the scan fails: the caller treats that as "cannot serve".
 */
export async function findOrgIdByCallerNumber(e164: string): Promise<string | null> {
  let byNumber: Map<string, string>;
  if (!snapshot) {
    byNumber = await refresh();
  } else {
    byNumber = snapshot.byNumber;
    const now = Date.now();
    if (now - snapshot.at >= TTL_MS && now - lastRefreshTryAt >= RETRY_MS) {
      lastRefreshTryAt = now;
      refresh().catch((err) => console.error('[hotLeadCall] inbound number index refresh failed:', err instanceof Error ? err.name : 'unknown error'));
    }
  }
  return byNumber.get(e164) ?? null;
}
