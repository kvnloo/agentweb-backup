import { isDoNotContact } from '../../utils/leadContactStatus';
import { keyedDigest } from './keyedDigest';
import { getLimitStore } from './limitStore';

/**
 * Org-level do-not-call list for hot-lead calls (ENG-2783). A lead who presses 3 at the screening prompt is recorded
 * twice: on the lead row (contact status, see the webhook) and here, keyed by org and phone number, so the same
 * person submitting the form again as a new lead (or from another list of the org) is not called either.
 *
 * The marker is a limit-store claim (`hlc#dnc#<keyed digest>`, no raw number) that lives about ten years. Removing
 * one is an operator data write (docs/integrations/hot-lead-call.md, "Do-not-call list").
 */

const DNC_TTL_S = 10 * 365 * 24 * 3600;
const DNC_TOKEN = 'dnc';

export const dncKey = (orgId: string, phoneE164: string): string => `hlc#dnc#${keyedDigest('hot_lead_call.dnc', orgId, phoneE164)}`;

/** Writes the marker. Idempotent: an existing live marker is the desired state. Throws when the store fails. */
export async function markNumberDoNotCall(orgId: string, phoneE164: string, now: Date = new Date()): Promise<void> {
  const nowS = Math.floor(now.getTime() / 1000);
  await getLimitStore().claim(dncKey(orgId, phoneE164), DNC_TOKEN, nowS + DNC_TTL_S, nowS);
}

/** True when the number is on the org's list. Throws when the store fails (the caller fails closed). */
export async function isNumberDoNotCall(orgId: string, phoneE164: string, now: Date = new Date()): Promise<boolean> {
  return (await getLimitStore().holder(dncKey(orgId, phoneE164), Math.floor(now.getTime() / 1000))) !== null;
}

/** The lead row's own contact status (any channel's unsubscribe or do-not-contact) or the org's marker for its number. */
export async function isLeadDoNotCall(input: { orgId: string; lead: unknown; phoneE164: string }): Promise<boolean> {
  return isDoNotContact(input.lead) || await isNumberDoNotCall(input.orgId, input.phoneE164);
}
