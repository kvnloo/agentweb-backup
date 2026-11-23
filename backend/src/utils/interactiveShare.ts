/**
 * Interactive ("conversable") share helpers shared by every public route that accepts a share token
 * (agentModeController's /ishare routes, controllers/tasks.ts getTaskExecutionPublic).
 */

/**
 * Returns the effective expiration date for an interactive share.
 *
 * Only an explicit `expiresAt` causes expiry. Shares created without one —
 * every public plan/ishare link (createSessionWithPlan sets `sharedAt` only)
 * and all legacy shares — never expire on a timer; their availability is
 * governed solely by the `isActive` flag. (Previously, a missing `expiresAt`
 * was treated as "sharedAt + 7 days", which silently 410'd every such link a
 * week after creation and broke all ishare links.)
 */
export function getInteractiveShareExpiresAt(share: { expiresAt?: string; sharedAt?: string }): Date {
  if (share.expiresAt) return new Date(share.expiresAt);
  return new Date(8640000000000000); // No expiresAt — never expires
}

/**
 * The lifetimes, in days, that the owner's share dialog offers (customer portal `ShareDialog`: 1, 3, 7, 14, 30, 90 and 365 days; the
 * route's default is 7). A link made BEFORE the sensitive-actions setting existed, with a lifetime that is one of these, was made on
 * purpose by an owner in the dialog. Any other lifetime was not: AgentWeb's admin Chat History tab mints a 45-day link on every
 * conversation a member of staff lists (`routes/admin.ts` `ensureIshareLinkForReview`), and on 2026-11-23 890 of the 921 live links
 * that have an expiry were of that kind.
 */
export const SHARE_DIALOG_LIFETIMES_DAYS: readonly number[] = [1, 3, 7, 14, 30, 90, 365];

/**
 * ENG-3170: may someone using this share link run SENSITIVE actions (delete data, send or post to people outside the account, change ad
 * spend, disconnect an account; the list is `SHARE_VISITOR_SENSITIVE_*` in `services/toolRestrictionProfiles.ts`)?
 *
 * A share-link visitor runs under the owner's userId, so the answer is a property of the LINK, chosen by the owner when they
 * create it (or later, from the share dialog) and stored on the session's `interactiveShareMetadata.allowSensitiveActions`.
 *
 *  - an explicit boolean is the owner's choice, whatever else is on the link;
 *  - a link with no choice stored is a link made BEFORE this setting existed. If its lifetime (`expiresAt` minus `sharedAt`) is one the
 *    share dialog offers, it was made on purpose by the owner and keeps today's behaviour (allowed) until it expires. Every other link
 *    is OFF: one with no expiry (work-plan launches, links mailed or posted to recipients, very old links), one made by the admin
 *    review tab (45 days), and any lifetime nobody can account for. Every link minted from now on stores an explicit boolean (see
 *    `chatbotDb.createOrReuseInteractiveShare`), so this fallback only ever reads links that already existed;
 *  - no share record at all (or nothing readable) is OFF.
 */
export function interactiveShareAllowsSensitiveActions(
  share: { allowSensitiveActions?: unknown; expiresAt?: unknown; sharedAt?: unknown } | null | undefined,
): boolean {
  if (!share || typeof share !== 'object') return false;
  if (typeof share.allowSensitiveActions === 'boolean') return share.allowSensitiveActions;
  if (typeof share.expiresAt !== 'string' || typeof share.sharedAt !== 'string') return false;
  const expires = Date.parse(share.expiresAt);
  const shared = Date.parse(share.sharedAt);
  if (!Number.isFinite(expires) || !Number.isFinite(shared)) return false;
  const lifetimeDays = Math.round((expires - shared) / 86_400_000);
  return SHARE_DIALOG_LIFETIMES_DAYS.includes(lifetimeDays);
}
