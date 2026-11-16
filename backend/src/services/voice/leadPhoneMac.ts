import { keyedDigest } from './keyedDigest';

/**
 * Keyed HMAC of a lead's E.164 phone, stored on the call record when the call passes the gates and compared
 * by the voice webhooks before they dial or screen the lead. Same construction as the per-phone dedupe key
 * (server secret, never the number itself) with its own domain label, so the two digests are unrelated.
 */
export function leadPhoneMacOf(orgId: string, e164: string): string {
  return keyedDigest('hlc-lead-phone-v1', orgId, e164);
}
