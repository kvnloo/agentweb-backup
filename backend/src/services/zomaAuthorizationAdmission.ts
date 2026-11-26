import { admitZomaSignup, zomaAdmissionEnabled, type ZomaSignupOrigin } from './zomaAdmission';

/** Backstop for someone following Sign in -> Google/plain register from Zoma consent.
 * Emma signup itself is never gated. At Zoma authorization, only accounts created
 * since this launch cohort began need a seat. Older accounts remain grandfathered.
 * Registration and authorization use the same email decision, so retries cannot double-count.
 * ENG-2781: `origin.databricks` (the authorizing OAuth client is Databricks-origin) exempts the
 * account from the seat cap for this authorization only; nothing is recorded on the account, so a
 * later authorization through any other client is decided on its own.
 */
export async function admitZomaAuthorizationSignup(userId: string, origin?: ZomaSignupOrigin): Promise<string> {
  if (!zomaAdmissionEnabled()) return 'approved';
  const startedAt = Date.parse(process.env.ZOMA_WAITLIST_COHORT_STARTED_AT ?? '');
  if (!Number.isFinite(startedAt)) throw new Error('Zoma launch cohort start is not configured');
  const { userDb } = await import('./db');
  const user = await userDb.getUserById(userId);
  if (!user?.email) throw new Error('Zoma authorization user is unavailable');
  // Legacy rows without a creation date predate this launch. All new registrations stamp it.
  if (!user.createdAt) return 'approved';
  const createdAt = Date.parse(user.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error('Zoma authorization user creation date is invalid');
  if (createdAt < startedAt) return 'approved';
  return origin?.databricks ? admitZomaSignup(user.email, undefined, { ...origin, userId }) : admitZomaSignup(user.email);
}
