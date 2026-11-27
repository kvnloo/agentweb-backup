/**
 * Early-signup free period for Zoma billing. Dark until ZOMA_EARLY_SIGNUP_FREE_ENABLED=true.
 *
 * While on, a user whose account was created inside [ZOMA_EARLY_SIGNUP_FROM, ZOMA_EARLY_SIGNUP_UNTIL]
 * skips the first-publish $1 trial paywall until ZOMA_EARLY_SIGNUP_FREE_UNTIL. Everyone else, and
 * everyone once the free period ends, gets the normal paywall.
 *
 * Signup date is the user record's immutable `createdAt` (db.ts never updates it). The user record
 * has no `dateRegistered`; that field exists only on the activation-tracker rows.
 *
 * Fails closed: flag off, any missing/unparseable date, or an unreadable user means no skip.
 */
export interface ZomaEarlySignupConfig {
  from: number;
  until: number;
  freeUntil: number;
  /** The free-until value as configured, for display. */
  freeUntilRaw: string;
}

// An explicit offset is required: a date-only or offset-less value would shift the window by hours.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseInstant(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !ISO_WITH_OFFSET.test(value)) return undefined;
  // Reject impossible calendar dates (2027-02-30): Date.parse would roll them over silently.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const cal = new Date(Date.UTC(y, m - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== m - 1 || cal.getUTCDate() !== d) return undefined;
  const [hh, mm, ss] = value.slice(11, 19).split(':').map(Number);
  if (hh > 23 || mm > 59 || (ss ?? 0) > 59) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function getZomaEarlySignupConfig(env: NodeJS.ProcessEnv = process.env): ZomaEarlySignupConfig | undefined {
  if (env.ZOMA_EARLY_SIGNUP_FREE_ENABLED !== 'true') return undefined;
  const from = parseInstant(env.ZOMA_EARLY_SIGNUP_FROM);
  const until = parseInstant(env.ZOMA_EARLY_SIGNUP_UNTIL);
  const freeUntil = parseInstant(env.ZOMA_EARLY_SIGNUP_FREE_UNTIL);
  if (from === undefined || until === undefined || freeUntil === undefined || from > until) {
    console.error('[zoma-billing] ZOMA_EARLY_SIGNUP_FREE_ENABLED is on but the window config is missing or invalid; no one skips the paywall.');
    return undefined;
  }
  return { from, until, freeUntil, freeUntilRaw: env.ZOMA_EARLY_SIGNUP_FREE_UNTIL!.trim() };
}

/** True when this signup time is inside the window and the free period has not ended. */
export function isEarlySignupFree(createdAt: unknown, now: number, cfg: ZomaEarlySignupConfig | undefined): boolean {
  if (!cfg || now >= cfg.freeUntil || typeof createdAt !== 'string') return false;
  const signedUp = Date.parse(createdAt);
  return Number.isFinite(signedUp) && signedUp >= cfg.from && signedUp <= cfg.until;
}

/** "Jan 1, 2027" from the configured free-until value, in the date it was written in. */
export function formatEarlySignupFreeUntil(cfg: Pick<ZomaEarlySignupConfig, 'freeUntilRaw'>): string {
  const [y, m, d] = cfg.freeUntilRaw.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Resolves the user and checks the window. Any lookup failure means no skip (normal paywall). */
export async function userHasEarlySignupFree(
  userId: string,
  getUser: (userId: string) => Promise<any>,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ZomaEarlySignupConfig | undefined> {
  const cfg = getZomaEarlySignupConfig(env);
  if (!cfg || now >= cfg.freeUntil) return undefined;
  try {
    const user = await getUser(userId);
    return isEarlySignupFree(user?.createdAt, now, cfg) ? cfg : undefined;
  } catch (error) {
    console.error('[zoma-billing] early-signup user lookup failed:', error instanceof Error ? error.message : error);
    return undefined;
  }
}
