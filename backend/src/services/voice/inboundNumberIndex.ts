import { orgDb } from '../db';
import { allowlistedE164 } from '../hotLeadCallConfig';

/**
 * Which org owns a dialled caller number (ENG-2271 inbound callbacks). AW-Organizations has no index on the
 * number, so the answer comes from a scan of the orgs that hold one, kept for a short time in this process.
 * One index serves every number, so an unknown number (or a flood of them) costs no scan beyond the next refresh:
 * a miss is answered from the same snapshot, which is the negative cache. The price is that a number bought or
 * released within the last TTL is not seen yet; the caller of this index re-reads the org and checks its live
 * config, so a stale hit can only ever end in a polite refusal, never a connection.
 */

const TTL_MS = 60_000;

let snapshot: { at: number; byNumber: Map<string, string> } | null = null;
let inflight: Promise<Map<string, string>> | null = null;

/** Tests only: forget the snapshot. */
export function resetInboundNumberIndexForTests(): void {
  snapshot = null;
  inflight = null;
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

/**
 * The id of the org whose caller number is `e164`, or null when none (or more than one) holds it. Throws when
 * the scan fails: the caller treats that as "cannot serve" and does not cache it.
 */
export async function findOrgIdByCallerNumber(e164: string): Promise<string | null> {
  if (!snapshot || Date.now() - snapshot.at >= TTL_MS) {
    inflight ??= load().finally(() => { inflight = null; });
    snapshot = { at: Date.now(), byNumber: await inflight };
  }
  return snapshot.byNumber.get(e164) ?? null;
}
