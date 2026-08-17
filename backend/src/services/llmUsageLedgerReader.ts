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
 *
 * ## Discovery is a current-state question; attribution is a historical one
 *
 * Those are two questions, and the first cut answered both with `inheritsOrgBilling`
 * against TODAY's user record. That is sound only if nobody's billing changes
 * inside the window being read, and the whole point of a cycle-length window is
 * that things change inside it. A member who starts their own subscription
 * mid-cycle takes their entire cycle-to-date out of the org's burn; one who
 * cancels theirs hands the org a cycle it was never billed for. The first
 * direction is the dangerous one — burn falls, runway lengthens, and the customer
 * is reassured shortly before running out.
 *
 * Membership is not versioned anywhere (`getOrgMembers` queries a GSI on the
 * user's CURRENT `orgId`), so discovery cannot be anything but current-state. The
 * split is therefore:
 *
 *   - **Discovery** widens to every current member, self-payers included. Their
 *     partition may still hold rows billed to the root from earlier in the cycle,
 *     and a partition never queried is a row no later filter can recover.
 *   - **Attribution** is decided per row, by the row, whenever the row knows.
 *
 * A row knows when its `billingUserId` differs from the acting `userId`: nothing
 * writes that except a caller deliberately naming the payer, so it is a statement
 * made at write time about where the money went. A row whose `billingUserId`
 * equals its `userId` says nothing — `recordUsage` defaults it that way — and for
 * those the current-membership inference remains, unchanged and no worse than
 * what it replaces.
 *
 * ## Why the row test alone is not enough
 *
 * Filtering purely on `row.billingUserId === subject` is the obvious form of this
 * fix and it is a trap, because the attribute is not yet populated. `recordUsage`
 * falls back to `ctx.billingUserId || userId`, and until ENG-1217 tagged the
 * agent-mode path no LLM call site ever passed one. Measured on production
 * `AW-UsageRecords`: **0 of 4,629 rows** carry a `billingUserId` that differs from
 * the acting user, while 12 non-owner org members hold **1,007 rows** that
 * `inheritsOrgBilling` says pool onto their root. A bare equality filter drops
 * every one of them — reinstating the very defect this module exists to fix, in
 * its dangerous direction, because `costUsedMicroUsd` stays pooled either way.
 *
 * Hence the ordering: the row wins where it has something to say, and the
 * membership inference catches the rows that do not. As the tag rolls forward the
 * fallback matters less, and the 180-day TTL eventually retires it entirely.
 *
 * ## What this still does not fix, stated plainly
 *
 * Every agent-mode row written before ENG-1217 is untagged, so a transition that
 * predates the tag is still read through today's membership. The tag is being
 * added going forward rather than reconstructed backwards — the same choice
 * ENG-1210 made for scheduled-vs-interactive provenance — and the 180-day TTL
 * retires the untagged rows on its own. Two residuals have no fix at this layer:
 * a member who has LEFT the org is not discoverable at all, and `billingUserId`
 * is SET (not `if_not_exists`) on a daily aggregate row, so a transition landing
 * mid-day resolves that day to whichever call wrote last.
 */

import { userDb, orgDb } from "./db";
import { inheritsOrgBilling } from "./orgAuthz";
import { usageRecordDb, type UsageRecordRow } from "./usageRecordDb";

/**
 * Every `userId` partition that could hold a row billed to `billingUserId`.
 *
 * CANDIDATES, not a verdict. Membership is deliberately not filtered by
 * `inheritsOrgBilling` here: a member paying for themselves today may have been
 * pooling onto the root last week, and their partition is the only place those
 * rows exist. Whether each row actually counts is decided in
 * `readPooledLedgerRows`, which can tell the two apart per row.
 *
 * Returns `[billingUserId]` for a solo user, for an unresolvable org, and for a
 * subject that is not its org's billing root. That last case is defensive:
 * callers resolve the billing subject before calling, so it should not arise —
 * but widening a non-root's read to the whole org would expose one tenant's usage
 * to another, so the safe direction on an unexpected input is to narrow.
 */
export async function resolvePooledLedgerUserIds(billingUserId: string): Promise<string[]> {
  return (await resolveLedgerScope(billingUserId)).candidateUserIds;
}

/**
 * The two answers, from one set of reads.
 *
 * `candidateUserIds` is every partition worth querying; `inheritingUserIds` is
 * the subset that pools onto the subject as of NOW, consulted only for rows that
 * cannot say who paid for them. Resolved together because they come from the
 * same three records and splitting them would triple-read the org on every call.
 */
async function resolveLedgerScope(
  billingUserId: string,
): Promise<{ candidateUserIds: string[]; inheritingUserIds: Set<string> }> {
  const solo = { candidateUserIds: [billingUserId], inheritingUserIds: new Set<string>() };

  const user = await userDb.getUserById(billingUserId);
  if (!user?.orgId) return solo;

  const org = await orgDb.getOrgById(user.orgId);
  // No org record means no membership can be established. Reading the subject
  // alone understates an org's burn, but inventing membership is worse.
  if (!org?.ownerUserId) return solo;
  if (org.ownerUserId !== billingUserId) return solo;

  const members = await orgDb.getOrgMembers(user.orgId);

  // A Set both de-duplicates (getOrgMembers includes the owner) and keeps the
  // root present even if the member listing is empty or omits it.
  const candidates = new Set<string>([billingUserId]);
  const inheriting = new Set<string>();
  for (const member of members || []) {
    if (!member?.userId) continue;
    candidates.add(member.userId);
    if (member.userId === billingUserId) continue;
    if (
      inheritsOrgBilling(
        { userId: member.userId, orgId: user.orgId, subscription_status: member.subscription_status },
        org,
      )
    ) {
      inheriting.add(member.userId);
    }
  }
  return { candidateUserIds: [...candidates], inheritingUserIds: inheriting };
}

/**
 * Whether one row's spend is billed to `subject`.
 *
 * `actor` is the partition the row was READ from, not `row.userId`. They are the
 * same thing in storage — `userId` is the partition key — but taking it from the
 * query means a row is never mis-placed by a missing or malformed attribute, and
 * the caller already knows the answer without trusting the payload.
 *
 * Ordered so the strongest evidence wins. The subject's own partition is theirs
 * by definition and is checked FIRST — `inheritsOrgBilling` returns false for a
 * billing root (`isBillingRoot`), so reaching the fallback with the root's own
 * rows would discard the largest partition in most orgs.
 */
function isBilledTo(
  row: UsageRecordRow,
  actor: string,
  subject: string,
  inheritingMembers: ReadonlySet<string>,
): boolean {
  if (actor === subject) return true;
  const recorded = row.billingUserId;
  if (recorded && recorded !== actor) return recorded === subject;
  return inheritingMembers.has(actor);
}

/**
 * All ledger rows BILLED TO the subject between two dates (inclusive).
 *
 * Queries every candidate partition and then keeps only the rows that belong to
 * this subject — see `isBilledTo`. Reading a partition is not the same as
 * charging it: a member's partition is read so their pooled rows can be found,
 * and their self-billed rows in the same partition are dropped.
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
  const { candidateUserIds, inheritingUserIds } = await resolveLedgerScope(billingUserId);
  const perUser = await Promise.all(
    candidateUserIds.map(async (userId) => {
      const rows = await usageRecordDb.queryByUserDateRange(userId, startDate, endDate);
      return (rows || []).filter((row) =>
        isBilledTo(row, userId, billingUserId, inheritingUserIds),
      );
    }),
  );
  return perUser.flat();
}

/**
 * ENG-1251 — every row billed to this subject, by BOTH routes into the ledger.
 *
 * The two strategies are each blind to rows the other sees, and the blindness is
 * structural rather than incidental:
 *
 *  - The partition fan-out above reaches rows with no `billingUserId` at all,
 *    because it infers attribution from org membership. That is the only way to
 *    see spend recorded before the attribute was stamped at write time — but it
 *    can only ask about people who are members NOW.
 *  - `queryByBillingUserDateRange` filters on the stamped attribute, so it
 *    reaches rows belonging to people who have since LEFT the org and are
 *    unreachable by any partition query — but only rows that carry the stamp.
 *
 * `/usage/itemized` used the scan alone and undercounted the founders org by
 * 60.5% over Aug 12-15 ($86.23 against a true $218.13), because most historical
 * rows predate the stamp. The union recovers that without touching stored data:
 * both strategies read what already exists, so there is no backfill to run, no
 * migration to reverse, and nothing that can go wrong halfway.
 *
 * Dedupe is on `{userId, sk}` — the table's own primary key, not `sk` alone,
 * which is `date#model#feature` and therefore collides whenever two people do
 * the same kind of work on the same day. Overlap between the two paths is the
 * common case rather than the exception (any current member with the attribute
 * stamped appears in both), so getting this wrong would double an org's bill.
 * On a billing surface an overcount is the worse failure of the two.
 *
 * Neither half degrades to empty on error, for the same reason the fan-out
 * doesn't: half a ledger presented as a whole one is the defect being fixed.
 */
export async function readBilledLedgerRows(
  billingUserId: string,
  startDate: string,
  endDate: string,
): Promise<UsageRecordRow[]> {
  const [pooled, stamped] = await Promise.all([
    readPooledLedgerRows(billingUserId, startDate, endDate),
    usageRecordDb.queryByBillingUserDateRange(billingUserId, startDate, endDate),
  ]);

  const byPrimaryKey = new Map<string, UsageRecordRow>();
  for (const row of [...pooled, ...(stamped || [])]) {
    byPrimaryKey.set(`${row.userId} ${row.sk}`, row);
  }
  return [...byPrimaryKey.values()];
}
