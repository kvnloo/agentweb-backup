/**
 * Seat-based billing (ENG-TBD) — cap math only.
 *
 * Base free seats are a pure, hardcoded-for-now lookup by the org owner's
 * tier (Starter: 2, Pro: 5; every other tier is unlimited/not applicable —
 * Free can't have an org at all, Managed is excluded from the flat
 * seat-billing mechanism entirely and stays custom/negotiated per the
 * product decision this ticket is built against). A later ticket moves this
 * lookup into the admin-configurable `subscription_types` setting alongside
 * the rest of the per-tier config (see the partner-portal `seatPricing`
 * field plan) — this module's surface is written so that swap only touches
 * `baseSeatsForTier`, not any caller.
 *
 * `purchasedExtraSeats` is read off the `Organization` row, which is a pure
 * mirror of the Stripe subscription's seat line-item quantity (kept in sync
 * by a billing webhook elsewhere) — never incremented/decremented here or
 * anywhere in this module. See the removed `memberCount < maxMembers` gate
 * this intentionally does NOT resemble: that counter was deleted because it
 * had no reader besides the gate it served and required a fragile
 * transactional increment/decrement on every join/leave. This module instead
 * reads org headcount live, on demand, from the existing GSI-backed source
 * of truth (`orgDb.getOrgMemberCount`) — there is no new counter to drift.
 *
 * IMPORTANT: `assertSeatAvailable` is intentionally NOT wired into any route
 * yet. Invite-time enforcement must not ship before the existing-org
 * rollout backfill (computing and persisting `purchasedExtraSeats` for orgs
 * already over their new base, plus the in-product notification) is live —
 * otherwise every such org would start failing invites with zero warning
 * the moment this function is called from a route. Wiring it in is a later,
 * separate change.
 */

import { orgDb, type Organization } from './db';
import { getUserSubscriptionType } from './subscriptionService';

export const SEAT_LIMIT_REACHED = 'SEAT_LIMIT_REACHED' as const;

/**
 * Base free seats per tier. `null` means "no seat cap applies to this tier"
 * — either because the tier can't have an org at all (not reachable here in
 * practice, since callers only have an orgId to begin with) or because it's
 * deliberately excluded from the flat seat-billing mechanism (Managed, and
 * any tier not listed here).
 */
const SEAT_BASE_BY_TIER: Readonly<Record<string, number>> = {
  Starter: 2,
  Pro: 5,
};

export function baseSeatsForTier(tierName: string): number | null {
  return Object.prototype.hasOwnProperty.call(SEAT_BASE_BY_TIER, tierName)
    ? SEAT_BASE_BY_TIER[tierName]
    : null;
}

/**
 * `null` return means "unlimited for this org" (tier has no base seat
 * concept) — callers must treat `null` as "do not enforce a cap", not as 0.
 */
export function effectiveSeatCap(
  baseSeats: number | null,
  purchasedExtraSeats: number | null | undefined
): number | null {
  if (baseSeats == null) return null;
  const extra = typeof purchasedExtraSeats === 'number' && Number.isFinite(purchasedExtraSeats) && purchasedExtraSeats > 0
    ? Math.floor(purchasedExtraSeats)
    : 0;
  return baseSeats + extra;
}

export class SeatLimitReachedError extends Error {
  code = SEAT_LIMIT_REACHED;
  constructor(
    public readonly orgId: string,
    public readonly cap: number,
    public readonly currentMemberCount: number
  ) {
    super(
      `Organization ${orgId} has ${currentMemberCount} member(s), at or above its seat cap of ${cap}.`
    );
    this.name = 'SeatLimitReachedError';
  }
}

async function resolveOwnerTier(org: Pick<Organization, 'ownerUserId'>): Promise<string> {
  return getUserSubscriptionType(org.ownerUserId);
}

/**
 * Throws `SeatLimitReachedError` if the org is already at or above its
 * effective seat cap (base seats for the owner's tier, plus any purchased
 * extra seats) — i.e. if admitting one more member would exceed the cap.
 * Resolves with no error (including when the org is on a tier with no cap,
 * e.g. Managed) otherwise.
 *
 * Deliberately does not take a pre-fetched `Organization`/count — every
 * call re-reads live state, since the whole point of deriving headcount
 * from the GSI-backed member list (rather than a stored counter) is to
 * never trust a value that could have gone stale between an earlier read
 * and this check.
 */
export async function assertSeatAvailable(orgId: string): Promise<void> {
  const org = await orgDb.getOrgById(orgId, ['orgId', 'ownerUserId', 'purchasedExtraSeats']);
  if (!org) {
    throw new Error(`Organization ${orgId} not found`);
  }

  const ownerTier = await resolveOwnerTier(org);
  const baseSeats = baseSeatsForTier(ownerTier);
  const cap = effectiveSeatCap(baseSeats, org.purchasedExtraSeats);
  if (cap == null) {
    return;
  }

  const currentMemberCount = await orgDb.getOrgMemberCount(orgId);
  if (currentMemberCount >= cap) {
    throw new SeatLimitReachedError(orgId, cap, currentMemberCount);
  }
}
