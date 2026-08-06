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
  field: OrgProfileField
): Promise<any> {
  if (!org) return user?.[field];
  if (org[field]) return org[field];

  console.warn(
    `[orgProfileResolver] org ${org.orgId} has no ${field} — falling back to the owner's user record`
  );

  const ownerUserId = org.ownerUserId;
  if (!ownerUserId || ownerUserId === user?.userId) return user?.[field];

  try {
    const owner: any = await userDb.getUserById(ownerUserId);
    return owner?.[field];
  } catch (error: any) {
    console.error(
      `[orgProfileResolver] failed to load owner ${ownerUserId} for org ${org.orgId}:`,
      error?.message
    );
    return user?.[field];
  }
}
