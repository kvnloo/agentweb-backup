import { userDb } from "../services/db";

/**
 * Read the user for a decision that depends on what THIS process (or the step
 * just before it) wrote moments ago: who owns an onboarding axis, whether a run
 * it just finished failed, what results the upstream step produced.
 *
 * `userDb.getUserById` queries the UserIdIndex GSI, which is eventually
 * consistent: for a moment after a write it still returns the PREVIOUS row. A
 * run that reads it back milliseconds after claiming an axis then sees the
 * previous run's identity or outcome, concludes someone else owns the axis (and
 * silently stops) or that nothing failed. `getUserByIdConsistent` resolves the
 * email from the index but returns the base-table row, which always reflects
 * the write.
 *
 * Falls back to the index read only when the consistent read is unavailable,
 * finds nothing, or throws; a thrown error is logged because that fallback is
 * exactly the stale read this exists to avoid.
 */
export async function readUserForOwnership(userId: string): Promise<any> {
  const consistent = (userDb as any).getUserByIdConsistent;
  if (typeof consistent === "function") {
    try {
      const fresh = await consistent.call(userDb, userId);
      if (fresh) return fresh;
    } catch (err) {
      console.warn("[readUserForOwnership] consistent read failed, falling back to the index", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return userDb.getUserById(userId);
}
