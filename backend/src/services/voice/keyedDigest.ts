import { createHmac } from 'crypto';
import { getJwtSecret } from '../../config/jwt';

/**
 * HMAC-SHA256 under the server secret over a domain label and the parts (NUL-separated, so no two part lists can
 * join into the same text). Used wherever a hot-lead-call value must be stored or compared without the value itself
 * (a phone number, a verification code): the label keeps the digests of different uses unrelated, and the secret
 * keeps a leaked table from being reversed by hashing the ~10^10 phone numbers.
 */
export function keyedDigest(label: string, ...parts: string[]): string {
  return createHmac('sha256', getJwtSecret()).update([label, ...parts].join('\0')).digest('hex');
}
