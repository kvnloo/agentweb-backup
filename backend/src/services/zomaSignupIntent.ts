import { createHmac, timingSafeEqual } from 'crypto';
import { getJwtSecret } from '../config/jwt';

// Domain-separated from login tokens. The consent page already forwards signupIntent.
const signature = (payload: string) => createHmac('sha256', getJwtSecret()).update(`zoma-signup:${payload}`).digest('base64url');
export function mintZomaSignupIntent(): string {
  const payload = String(Math.floor(Date.now() / 1000) + 3600);
  return `${payload}.${signature(payload)}`;
}

/** True only for an unexpired, server-signed Zoma intent (minted by /oauth/authorize). */
export function hasValidZomaSignupIntent(intent: unknown): boolean {
  if (typeof intent !== 'string' || intent.length > 100) return false;
  const [expiry, mac, extra] = intent.split('.');
  if (extra !== undefined || !/^\d+$/.test(expiry) || !mac || Number(expiry) <= Date.now() / 1000) return false;
  const expected = Buffer.from(signature(expiry));
  const actual = Buffer.from(mac);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isZomaSignup(body: { signupProduct?: unknown; signupIntent?: unknown }): boolean {
  if (body.signupProduct === 'zoma') return true;
  return hasValidZomaSignupIntent(body.signupIntent);
}

/**
 * ENG-3124: Google OAuth `state`. Google round-trips it verbatim, so a Zoma signup carries its
 * signed intent as `<portal>~<intent>`; the intent's own HMAC + expiry is what makes it trusted.
 * A plain portal name (the pre-existing format) still parses unchanged.
 */
export type GooglePortal = 'customer' | 'genius' | 'partner';
const STATE_SEPARATOR = '~';

export function encodeGoogleOAuthState(portal: GooglePortal, signupIntent?: unknown): string {
  if (portal === 'customer' && hasValidZomaSignupIntent(signupIntent)) return `${portal}${STATE_SEPARATOR}${signupIntent}`;
  return portal;
}

export function parseGoogleOAuthState(state: unknown): { portal: GooglePortal; zomaSignup: boolean } {
  const raw = typeof state === 'string' ? state : '';
  const [head, intent, extra] = raw.split(STATE_SEPARATOR);
  const portal: GooglePortal = head === 'customer' || head === 'genius' ? head : 'partner';
  const zomaSignup = portal === 'customer' && extra === undefined && hasValidZomaSignupIntent(intent);
  return { portal, zomaSignup };
}
