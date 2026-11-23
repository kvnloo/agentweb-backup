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
 * ENG-3170: may someone using this share link run SENSITIVE actions (delete data, send or post to people outside the account,
 * change ad spend, disconnect an account; the list is `SHARE_VISITOR_SENSITIVE_*` in `services/toolRestrictionProfiles.ts`)?
 *
 * A share-link visitor runs under the owner's userId, so the answer is a property of the LINK, chosen by the owner when they
 * create it (or later, from the share dialog) and stored on the session's `interactiveShareMetadata.allowSensitiveActions`.
 *
 *  - an explicit boolean is the owner's choice, whatever else is on the link;
 *  - a link with no choice stored is a link made BEFORE this setting existed. A link with a timed expiry (`expiresAt`) was made on
 *    purpose in the share dialog, so it keeps today's behaviour (allowed) until it expires. A link with no expiry is one of the
 *    auto-made kind (work-plan launches, links mailed or posted to recipients) or a very old one: it is OFF, because the person
 *    holding it is usually not the owner's delegate. Every link minted from now on stores an explicit boolean (see
 *    `chatbotDb.createOrReuseInteractiveShare`), so this fallback only ever reads links that already existed;
 *  - no share record at all (or nothing readable) is OFF.
 */
export function interactiveShareAllowsSensitiveActions(
  share: { allowSensitiveActions?: unknown; expiresAt?: unknown } | null | undefined,
): boolean {
  if (!share || typeof share !== 'object') return false;
  if (typeof share.allowSensitiveActions === 'boolean') return share.allowSensitiveActions;
  return typeof share.expiresAt === 'string' && share.expiresAt.length > 0;
}
