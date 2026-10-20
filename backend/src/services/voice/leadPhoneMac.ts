import { createHmac } from 'crypto';
import { getJwtSecret } from '../../config/jwt';

/**
 * Keyed HMAC of a lead's E.164 phone, stored on the call record when the call passes the gates and compared
 * by the voice webhooks before they dial or screen the lead. Same construction as the per-phone dedupe key
 * (server secret, never the number itself) with its own domain label, so the two digests are unrelated.
 */
export function leadPhoneMacOf(orgId: string, e164: string): string {
  return createHmac('sha256', getJwtSecret()).update(`hlc-lead-phone-v1\0${orgId}\0${e164}`).digest('hex');
}
