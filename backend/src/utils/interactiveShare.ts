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
