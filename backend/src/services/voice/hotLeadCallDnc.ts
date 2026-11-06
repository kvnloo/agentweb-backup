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

/**
 * The org's marker for the number, or the lead's contact status being exactly 'do-not-contact' (set by a person, a sales
 * rep or a press of 3). An email unsubscribe ('unsubscribed'), a bounce or the legacy group-email flag does NOT block: a
 * person who left a newsletter and then asks for a call must be called.
 */
export async function isLeadDoNotCall(input: { orgId: string; lead: unknown; phoneE164: string }): Promise<boolean> {
  const status = (input.lead as { contactStatus?: unknown } | null | undefined)?.contactStatus;
  return status === 'do-not-contact' || await isNumberDoNotCall(input.orgId, input.phoneE164);
}

const RETRY_BACKOFF_MS = [50, 150];
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Test-only: replace the backoff sleep; null restores it. */
export function setDncRetryDelayForTests(replacement: ((ms: number) => Promise<void>) | null): void {
  sleep = replacement ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** `markNumberDoNotCall` tried up to three times in-process (50 ms, then 150 ms apart). True once it landed. Never throws. */
export async function markNumberDoNotCallWithRetry(orgId: string, phoneE164: string): Promise<boolean> {
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      await markNumberDoNotCall(orgId, phoneE164);
      return true;
    } catch {
      if (attempt < RETRY_BACKOFF_MS.length) await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  return false;
}
