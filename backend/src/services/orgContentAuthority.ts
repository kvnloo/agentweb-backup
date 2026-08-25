import { callerCan, type AuthzOrg } from "./orgAuthz";

/**
 * ENG-1533 — one answer to "may this caller manage that owner's content".
 *
 * ## Why this is its own module
 *
 * It lived beside `callerCan` in `orgAuthz` for one commit, and that placement
 * silently disarmed a test. `llmModelChangeService.test.ts` guards a specific
 * drift — that the code asks for `org:content:manage` and not merely SOME org
 * permission — by spying on the `callerCan` import. A caller inside `orgAuthz`
 * reaches the module-local binding, not the mocked export, so the spy saw
 * nothing and the guard was blind while still passing.
 *
 * That guard is not decorative. `org:members:read` and `org:content:manage` are
 * both owner+admin today, so swapping one for the other leaves every
 * behavioural test in the suite green — and reading a roster is a benign thing
 * to widen to members later, while switching their colleagues' models is not.
 * Importing `callerCan` across a module boundary is what keeps it observable.
 */
/**
 * Whether `callerUserId` may manage content OWNED BY `ownerUserId`, and whether
 * the two share an org.
 *
 * Extracted for ENG-1533 so one predicate answers the question in both
 * directions. `llmModelChangeService` asks it to decide whether a write is
 * allowed; the drivers resolver asks it to decide whether to OFFER the write at
 * all. Those two answers disagreeing is the whole defect — a button that is
 * shown precisely when pressing it will fail. Two copies of this logic would
 * drift apart on the first change to the role model, so there is one copy.
 *
 * `sameOrg` is returned alongside because the caller needs it to choose between
 * "forbidden" and "not found": the write path reports not-found to a stranger
 * deliberately, so the endpoint cannot be used to discover which ids exist. That
 * distinction is the caller's to make — this function reports facts, not status
 * codes.
 *
 * Resolved defensively. A failure to read the user or org record is an ABSENCE
 * of authority, never a grant: an authority lookup must not become a 500 on a
 * customer-facing button, and must not fail open.
 */
export async function contentAuthorityOver(
  callerUserId: string | undefined | null,
  ownerUserId: string | undefined | null,
): Promise<{ permitted: boolean; sameOrg: boolean }> {
  if (!callerUserId || !ownerUserId) return { permitted: false, sameOrg: false };
  // Own content needs no org role at all, and must not depend on a lookup that
  // could fail — the common case stays true even if the org records are unreadable.
  if (callerUserId === ownerUserId) return { permitted: true, sameOrg: true };

  try {
    const { userDb, orgDb } = await import("./db");
    const owner = await userDb.getUserById(ownerUserId);
    // The OWNER's org, never the caller's: asking about the caller's own org
    // would let authority carry across a tenant boundary.
    const org: AuthzOrg | null = owner?.orgId ? await orgDb.getOrgById(owner.orgId) : null;
    if (!org) return { permitted: false, sameOrg: false };

    const permitted = await callerCan(callerUserId, org, "org:content:manage");
    const callerOrgId = (await userDb.getUserById(callerUserId))?.orgId;
    return { permitted, sameOrg: Boolean(callerOrgId && callerOrgId === org.orgId) };
  } catch {
    return { permitted: false, sameOrg: false };
  }
}
