/**
 * ENG-1212 / ENG-1213 — read the cost ledger for a whole billing subject.
 *
 * ## The distinction this module exists to hold
 *
 * Resolving the billing user and reading that user's ledger partition are two
 * different things, and conflating them is silently wrong. `recordUsage` writes
 * every row under the **acting** user's `userId` (the partition key) and carries
 * `billingUserId` only as an attribute; `AW-UsageRecords` has no GSI on it. So an
 * org root's partition contains the root's own calls and nothing else, even
 * though the root is billed for the whole org.
 *
 * The failure compounds rather than merely dropping rows. `costUsedMicroUsd`
 * comes from `getUserTokenUsage(billingUserId)`, and `incrementUserTokenUsage`
 * resolves to the billing root before incrementing — so the consumed-cost
 * numerator IS pooled while a root-partition-only daily burn is not. Dividing a
 * whole account's consumption by one person's burn rate reports a runway several
 * times too long: the customer is told they are fine and then stops mid-cycle,
 * which is precisely the surprise ENG-1200 exists to prevent.
 *
 * ## Why this mirrors, but does not reuse, the admin rollup
 *
 * `usageAnalyticsService`'s org rollup (ENG-200 follow-up) solved this shape for
 * the admin cost modal by summing across `orgDb.getOrgMembers`. This is the same
 * pattern for the customer path, with one required difference: that rollup sums
 * ALL members because it reconciles gross burn, whereas quota must follow money.
 * ENG-1084 established that a member holding their own live subscription does not
 * pool onto the root, so counting their spend against the org's runway would
 * charge the org for usage that member is separately billed for.
 *
 * The membership test is therefore `inheritsOrgBilling` — the very predicate
 * `resolveBillingUserId` uses to decide where spend lands. Deriving both from one
 * predicate is deliberate: entitlement and quota have already drifted apart three
 * times (ENG-288, ENG-954, ENG-1084).
 */

import { userDb, orgDb } from "./db";
import { inheritsOrgBilling } from "./orgAuthz";
import { usageRecordDb, type UsageRecordRow } from "./usageRecordDb";

/**
 * Every `userId` partition whose spend is billed to `billingUserId`.
 *
 * Returns `[billingUserId]` for a solo user, for an unresolvable org, and for a
 * subject that is not its org's billing root. That last case is defensive:
 * callers resolve the billing subject before calling, so it should not arise —
 * but widening a non-root's read to the whole org would expose one tenant's usage
 * to another, so the safe direction on an unexpected input is to narrow.
 */
export async function resolvePooledLedgerUserIds(billingUserId: string): Promise<string[]> {
  const user = await userDb.getUserById(billingUserId);
  if (!user?.orgId) return [billingUserId];

  const org = await orgDb.getOrgById(user.orgId);
  // No org record means no membership can be established. Reading the subject
  // alone understates an org's burn, but inventing membership is worse.
  if (!org?.ownerUserId) return [billingUserId];
  if (org.ownerUserId !== billingUserId) return [billingUserId];

  const members = await orgDb.getOrgMembers(user.orgId);

  // A Set both de-duplicates (getOrgMembers includes the owner) and keeps the
  // root present even if the member listing is empty or omits it.
  const ids = new Set<string>([billingUserId]);
  for (const member of members || []) {
    if (!member?.userId || member.userId === billingUserId) continue;
    if (
      inheritsOrgBilling(
        { userId: member.userId, orgId: user.orgId, subscription_status: member.subscription_status },
        org,
      )
    ) {
      ids.add(member.userId);
    }
  }
  return [...ids];
}

/**
 * All ledger rows for the billing subject between two dates (inclusive).
 *
 * A per-partition read failure REJECTS rather than degrading to empty rows. The
 * same choice is documented in the admin rollup for the same reason: swallowing
 * it understates burn, which inflates the runway and produces a confidently wrong
 * number. A customer-visible error is recoverable; a forecast that quietly
 * promised twice the runway it should have is not.
 */
export async function readPooledLedgerRows(
  billingUserId: string,
  startDate: string,
  endDate: string,
): Promise<UsageRecordRow[]> {
  const userIds = await resolvePooledLedgerUserIds(billingUserId);
  const perUser = await Promise.all(
    userIds.map((userId) => usageRecordDb.queryByUserDateRange(userId, startDate, endDate)),
  );
  return perUser.flat();
}
