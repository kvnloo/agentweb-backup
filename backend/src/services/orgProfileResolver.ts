import { userDb } from "./db";

/**
 * Profile pillars that become org-authoritative the moment a user joins or
 * creates an organization.
 */
export type OrgProfileField = "brandGuidelines" | "marketStrategy";

/**
 * Resolve an org-authoritative profile pillar with an owner-record fallback.
 *
 * `orgDb.createOrg` writes only structural fields (name, owner, maxMembers,
 * shareSettings) — copying the owner's profile onto the Organization record is
 * a separate, optional, dismissible action (`POST /api/org/:orgId/copy-profile`).
 * A hard override (`value = org[field]`) therefore blanks the pillar for every
 * org whose owner skipped that prompt, even though the owner's user record
 * still holds the data intact (ENG-927).
 *
 * Precedence, mirroring `analyticsConfigResolver`'s migration fallback:
 *   1. the Organization record, when it has been populated;
 *   2. the org OWNER's user record (the caller's own record when the caller is
 *      the owner, which is the common case);
 *   3. the caller's own record, when there is no org at all.
 *
 * Callers pass the org record they already loaded (or `null`/`undefined` for
 * solo users) so this never issues a redundant org read. The owner lookup only
 * happens on the fallback path for non-owner members.
 */
export async function resolveOrgProfileField(
  user: any,
  org: any | null | undefined,
  field: OrgProfileField,
  opts?: { forWrite?: boolean }
): Promise<any> {
  if (!org) return user?.[field];
  if (org[field]) return org[field];

  const ownerUserId = org.ownerUserId;
  let fallback: any;

  if (!ownerUserId || ownerUserId === user?.userId) {
    fallback = user?.[field];
  } else {
    // A failed owner read propagates. Substituting the caller's own record here
    // would not be a harmless read degradation: the write paths merge whatever
    // this returns and persist it as the ORGANIZATION profile, so one transient
    // owner-read failure during an editor's partial save would promote that
    // editor's personal brand/strategy to the whole org. `analyticsConfigResolver`
    // leaves its owner lookup unguarded for the same reason.
    const owner: any = await userDb.getUserById(ownerUserId);
    // A MISSING owner record is not the same as an owner who has no brand yet,
    // and on a write path the difference is permanent. The caller is about to
    // merge this baseline and persist it as the ORG profile — and once the org
    // record is populated the fallback stops firing for good, so a partial save
    // built on a phantom-empty baseline masks the owner's real data forever.
    // That is precisely the ENG-927 failure this resolver exists to prevent.
    // `getUserById` reads the eventually consistent UserIdIndex GSI, so "not
    // found" can just mean "not visible yet". Fail closed where the result gets
    // persisted; on reads, degrade as before — nothing is written and the next
    // request self-heals, whereas throwing would turn a transient GSI miss into
    // a 500 on /me and the settings pages.
    if (!owner && opts?.forWrite) {
      throw new Error(
        `orgProfileResolver: owner ${ownerUserId} of org ${org.orgId} not found — refusing to build a ${field} write baseline`
      );
    }
    fallback = owner?.[field];
  }

  // Warn only when the fallback actually recovered something. An org that has
  // simply never had a brand/strategy anywhere is the normal empty state, and
  // this resolver runs on every `/me` — warning there would be pure noise.
  if (fallback) {
    console.warn(
      `[orgProfileResolver] org ${org.orgId} has no ${field} — serving the owner's user record instead`
    );
  }

  return fallback;
}
