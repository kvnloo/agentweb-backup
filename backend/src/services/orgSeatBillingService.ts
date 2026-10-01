/**
 * Seat-based billing (ENG-2243..2246), Phase 2 — Stripe billing plumbing.
 *
 * Builds on Phase 1 (`orgSeatService.ts`, `Organization.purchasedExtraSeats`):
 * this module is the ONLY place that talks to Stripe about an org's extra
 * seats. `Organization.purchasedExtraSeats` remains a pure mirror of the
 * Stripe subscription's seat line-item quantity, written by the billing
 * webhook (`stripeService.handleSubscriptionUpdated`) — never by this module.
 * Stripe is the source of truth for "how many extra seats does this org pay
 * for right now"; this module reads that live state on every call rather
 * than trusting the DB mirror, which can lag a webhook delivery.
 *
 * Re-pricing model (decided, not a bug to "fix"): every time a seat is added
 * or removed, the seat line item's `price_data` is rebuilt fresh from
 * whatever `seatPricing.priceCents` is CURRENTLY configured for the owner's
 * tier, and `quantity` is set to the new total extra-seat count. An org's
 * per-seat rate can therefore change the next time it adds/removes a seat,
 * but stays fixed while the subscription is otherwise untouched — Stripe
 * does not silently reprice a dormant subscription item.
 *
 * CRITICAL (verified against the installed stripe@18.2.1 SDK's own type
 * docs, `SubscriptionItemUpdateParams.price_data`): updating a subscription
 * item's `price`/`price_data` resets `quantity` to 1 unless `quantity` is
 * passed explicitly in the SAME update call. Every call here that sets
 * `price_data` on an existing item also passes `quantity` — see the dedicated
 * mutation-checked test in orgSeatBillingService.test.ts.
 */

import Stripe from 'stripe';
import { createStripeClient } from './stripeClientFactory';
import { orgDb, userDb, type Organization } from './db';
import { getUserSubscriptionType, getTierConfig } from './subscriptionService';
import { baseSeatsForTier } from './orgSeatService';

let _stripe: Stripe | null = null;

function getStripeOrThrow(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('Stripe SDK not initialized. Missing STRIPE_SECRET_KEY.');
    }
    _stripe = createStripeClient(key);
  }
  return _stripe;
}

function requireExtraSeatProductId(): string {
  const productId = process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID;
  if (!productId) {
    throw new Error(
      'STRIPE_EXTRA_SEAT_PRODUCT_ID is not configured; cannot manage extra-seat billing.'
    );
  }
  return productId;
}

/**
 * Find the subscription's extra-seat line item by matching the item's price's
 * `product` against `STRIPE_EXTRA_SEAT_PRODUCT_ID` — no separate stored
 * item-ID field, so there's nothing to drift. Works whether `price.product`
 * comes back as a bare string ID (the default, unexpanded) or an expanded
 * Product object.
 */
export function findSeatLineItem(
  subscription: Pick<Stripe.Subscription, 'items'>,
  productId: string
): Stripe.SubscriptionItem | undefined {
  return subscription.items.data.find((item) => {
    const product = item.price?.product;
    const itemProductId = typeof product === 'string' ? product : product?.id;
    return itemProductId === productId;
  });
}

interface OwnerSubscriptionContext {
  org: Organization;
  ownerUserId: string;
  stripeSubscriptionId: string;
}

async function getOwnerWithLiveSubscription(orgId: string): Promise<OwnerSubscriptionContext> {
  const org = await orgDb.getOrgById(orgId, ['orgId', 'ownerUserId']);
  if (!org) {
    throw new Error(`Organization ${orgId} not found`);
  }

  const owner = await userDb.getUserById(org.ownerUserId);
  if (!owner) {
    throw new Error(`Owner ${org.ownerUserId} of organization ${orgId} not found`);
  }
  if (!owner.stripe_subscription_id) {
    throw new Error(
      `Organization ${orgId}'s owner (${org.ownerUserId}) has no Stripe subscription; cannot manage extra seats`
    );
  }

  return { org, ownerUserId: org.ownerUserId, stripeSubscriptionId: owner.stripe_subscription_id };
}

/**
 * Reads the seat line item's quantity directly off the live Stripe
 * subscription (never the possibly-stale `Organization.purchasedExtraSeats`
 * mirror). Absent line item = 0.
 */
async function getLiveSeatQuantity(orgId: string): Promise<number> {
  const { stripeSubscriptionId } = await getOwnerWithLiveSubscription(orgId);
  const productId = requireExtraSeatProductId();
  const stripe = getStripeOrThrow();
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const seatItem = findSeatLineItem(subscription, productId);
  return seatItem?.quantity ?? 0;
}

/**
 * Core primitive: set the org's Stripe-side extra-seat count to exactly
 * `totalExtraSeats`.
 *
 * - `totalExtraSeats > 0`: creates the seat line item (if absent) or updates
 *   it (if present) with FRESH `price_data` sourced from the owner tier's
 *   CURRENTLY configured `seatPricing.priceCents`, and explicit
 *   `quantity: totalExtraSeats`.
 * - `totalExtraSeats === 0`: removes the seat line item entirely if present;
 *   a no-op if it's already absent.
 *
 * Does NOT write `Organization.purchasedExtraSeats` — that mirror is kept in
 * sync by the billing webhook (`stripeService.handleSubscriptionUpdated`),
 * which is the only writer.
 */
export async function setOrgSeatQuantity(orgId: string, totalExtraSeats: number): Promise<void> {
  if (!Number.isInteger(totalExtraSeats) || totalExtraSeats < 0) {
    throw new Error(`totalExtraSeats must be a non-negative integer; got ${totalExtraSeats}`);
  }

  const { ownerUserId, stripeSubscriptionId } = await getOwnerWithLiveSubscription(orgId);
  const productId = requireExtraSeatProductId();
  const stripe = getStripeOrThrow();
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const seatItem = findSeatLineItem(subscription, productId);

  if (totalExtraSeats === 0) {
    if (seatItem) {
      await stripe.subscriptionItems.del(seatItem.id);
    }
    return;
  }

  const ownerTier = await getUserSubscriptionType(ownerUserId);
  const tierConfig = await getTierConfig(ownerTier);
  const seatPricing = tierConfig?.seatPricing;
  if (!seatPricing) {
    throw new Error(
      `Subscription tier '${ownerTier}' has no seatPricing configured; cannot bill extra seats for organization ${orgId}`
    );
  }

  const priceData: Stripe.SubscriptionItemCreateParams.PriceData = {
    currency: 'usd',
    unit_amount: seatPricing.priceCents,
    product: productId,
    recurring: { interval: 'month' },
  };

  if (seatItem) {
    // CRITICAL: see module doc. `price_data` on an UPDATE resets quantity to
    // 1 unless quantity is passed in this same call — both fields MUST be
    // set together here.
    await stripe.subscriptionItems.update(seatItem.id, {
      price_data: priceData,
      quantity: totalExtraSeats,
    });
  } else {
    await stripe.subscriptionItems.create({
      subscription: stripeSubscriptionId,
      price_data: priceData,
      quantity: totalExtraSeats,
    });
  }
}

/**
 * Adds one extra seat. Reads the CURRENT quantity live from Stripe (not the
 * DB mirror, which can lag) and increments it.
 *
 * Caller must have already authorized this (owner-only check happens at the
 * route level, not here).
 */
export async function purchaseExtraSeat(orgId: string): Promise<{ newTotalSeats: number }> {
  const currentTotal = await getLiveSeatQuantity(orgId);
  const newTotalSeats = currentTotal + 1;
  await setOrgSeatQuantity(orgId, newTotalSeats);
  return { newTotalSeats };
}

/**
 * Removes one extra seat, floored at 0. Refuses — throwing a descriptive
 * error — if doing so would drop the org's total extra seats below the
 * number of extra seats it actually needs right now, computed as
 * `max(0, currentMemberCount - baseSeatsForTier(ownerTier))`. A tier with no
 * seat cap (`baseSeatsForTier` returns null) never needs extra seats, so the
 * refusal never fires for it.
 *
 * Caller must have already authorized this (owner-only check happens at the
 * route level, not here).
 */
export async function removeExtraSeat(orgId: string): Promise<{ newTotalSeats: number }> {
  const currentTotal = await getLiveSeatQuantity(orgId);
  const newTotalSeats = Math.max(0, currentTotal - 1);

  const org = await orgDb.getOrgById(orgId, ['orgId', 'ownerUserId']);
  if (!org) {
    throw new Error(`Organization ${orgId} not found`);
  }
  const ownerTier = await getUserSubscriptionType(org.ownerUserId);
  const baseSeats = baseSeatsForTier(ownerTier);
  const currentMemberCount = await orgDb.getOrgMemberCount(orgId);
  const currentlyNeeded = baseSeats == null ? 0 : Math.max(0, currentMemberCount - baseSeats);

  if (newTotalSeats < currentlyNeeded) {
    throw new Error(
      `Cannot remove extra seat for organization ${orgId}: it has ${currentMemberCount} member(s) ` +
        `and only ${baseSeats} free seat(s) on the ${ownerTier} tier, so it needs at least ` +
        `${currentlyNeeded} extra seat(s) (currently has ${currentTotal}). Remove a member first.`
    );
  }

  await setOrgSeatQuantity(orgId, newTotalSeats);
  return { newTotalSeats };
}
