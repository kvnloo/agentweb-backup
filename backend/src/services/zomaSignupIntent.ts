import { createHmac, timingSafeEqual } from 'crypto';
import { getJwtSecret } from '../config/jwt';

// Domain-separated from login tokens. The consent page already forwards signupIntent.
const signature = (payload: string) => createHmac('sha256', getJwtSecret()).update(`zoma-signup:${payload}`).digest('base64url');
export function mintZomaSignupIntent(): string {
  const payload = String(Math.floor(Date.now() / 1000) + 3600);
  return `${payload}.${signature(payload)}`;
}

export function isZomaSignup(body: { signupProduct?: unknown; signupIntent?: unknown }): boolean {
  if (body.signupProduct === 'zoma') return true;
  if (typeof body.signupIntent !== 'string' || body.signupIntent.length > 100) return false;
  const [expiry, mac, extra] = body.signupIntent.split('.');
  if (extra || !/^\d+$/.test(expiry) || !mac || Number(expiry) <= Date.now() / 1000) return false;
  const expected = Buffer.from(signature(expiry));
  const actual = Buffer.from(mac);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
