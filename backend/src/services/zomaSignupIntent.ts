import { createHmac, timingSafeEqual } from 'crypto';
import { getJwtSecret } from '../config/jwt';

// Domain-separated from login tokens. The consent page already forwards signupIntent.
const signature = (payload: string) => createHmac('sha256', getJwtSecret()).update(`zoma-signup:${payload}`).digest('base64url');
/**
 * ENG-2781: an intent minted for a Databricks-origin OAuth client is `<expiry>.db.<mac>`, the mac
 * covering the `db` marker, so the marker can be neither added to nor stripped from a token.
 * Every other intent keeps its original `<expiry>.<mac>` form.
 */
const DATABRICKS_MARKER = 'db';
export function mintZomaSignupIntent(opts: { databricks?: boolean } = {}): string {
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  if (!opts.databricks) return `${expiry}.${signature(expiry)}`;
  const payload = `${expiry}.${DATABRICKS_MARKER}`;
  return `${payload}.${signature(payload)}`;
}

/** The signed intent's content, or null when it is forged, malformed or expired. */
function readZomaSignupIntent(intent: unknown): { databricks: boolean } | null {
  if (typeof intent !== 'string' || intent.length > 100) return null;
  const parts = intent.split('.');
  const databricks = parts.length === 3 && parts[1] === DATABRICKS_MARKER;
  if (parts.length !== 2 && !databricks) return null;
  const expiry = parts[0];
  const mac = parts[parts.length - 1];
  if (!/^\d+$/.test(expiry) || !mac || Number(expiry) <= Date.now() / 1000) return null;
  const expected = Buffer.from(signature(databricks ? `${expiry}.${DATABRICKS_MARKER}` : expiry));
  const actual = Buffer.from(mac);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? { databricks } : null;
}

/** True only for an unexpired, server-signed Zoma intent (minted by /oauth/authorize). */
export function hasValidZomaSignupIntent(intent: unknown): boolean {
  return readZomaSignupIntent(intent) !== null;
}

/** True only for a valid signed intent that /oauth/authorize minted for a Databricks-origin client. */
export function isDatabricksSignupIntent(intent: unknown): boolean {
  return readZomaSignupIntent(intent)?.databricks === true;
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

export function parseGoogleOAuthState(state: unknown): { portal: GooglePortal; zomaSignup: boolean; databricksSignup?: true } {
  const raw = typeof state === 'string' ? state : '';
  const [head, intent, extra] = raw.split(STATE_SEPARATOR);
  const portal: GooglePortal = head === 'customer' || head === 'genius' ? head : 'partner';
  const zomaSignup = portal === 'customer' && extra === undefined && hasValidZomaSignupIntent(intent);
  // ENG-2781: only present when true, so every other state parses to exactly what it always did.
  return { portal, zomaSignup, ...(zomaSignup && isDatabricksSignupIntent(intent) ? { databricksSignup: true as const } : {}) };
}
