/**
 * Hot lead calls add-on billing (ENG-2783): a flat $70 per month, per organization, charged to the org owner as ONE
 * extra item on the owner's existing active Stripe subscription. It includes one calling number and 150 lead calls
 * per month; calls beyond the configured monthly limit are not priced, they simply stop at the limit.
 *
 * Modelled on orgSeatBillingService.ts. This module is the only place that adds the item. Stripe is the source of
 * truth: the item is found live by its product id (STRIPE_HOT_LEAD_CALL_PRODUCT_ID), never from the DB mirror.
 * `Organization.hotLeadCallBilling` is a mirror written only by the billing webhook through
 * `mirrorHotLeadCallBilling` (called from stripeService.handleSubscriptionUpdated / handleSubscriptionDeleted).
 *
 * Whether the mirror is enforced is a separate kill switch: see hotLeadCallEntitlement.isHotLeadCallBillingRequired.
 */

import Stripe from 'stripe';
import { createStripeClient } from './stripeClientFactory';
import { orgDb, userDb, type HotLeadCallBilling } from './db';

export const HOT_LEAD_CALL_ADDON_PRICE_CENTS = 7000;
/** The wording of the approval card and of the digest the approval is bound to; a different price needs a new card. */
export const HOT_LEAD_CALL_ADDON_PRICE_TEXT = '$70 per month, includes one calling number and 150 lead calls per month, billed to your subscription';

/** Plain, user-safe refusal. Never carries a Stripe message, key or id. */
export class HotLeadCallBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HotLeadCallBillingError';
  }
}

const NOT_AVAILABLE = 'The hot lead calls add-on cannot be billed right now. Nothing was charged or turned on; please contact support.';
const TRIAL_SUBSCRIPTION = 'The hot lead calls add-on can be added once your subscription has taken its first payment (it is in a trial now). Nothing was charged or turned on.';
const NOT_MONTHLY = 'The hot lead calls add-on is billed monthly and can only be added to a monthly subscription. Nothing was charged or turned on; please contact support.';
const PAID_NOT_SAVED = 'Your payment for the hot lead calls add-on went through, but we could not finish turning it on. Calling is still off. Try again in a moment: you will not be charged twice.';
const NO_SUBSCRIPTION = 'The hot lead calls add-on is added to the organization owner’s paid subscription, and none is active. Subscribe to a plan first, then try again. Nothing was charged or turned on.';

let _stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return (_stripe ??= createStripeClient(key));
}

/** The item for `productId` on the subscription, whether `price.product` is a bare id or an expanded object. */
export function findHotLeadCallItem(
  subscription: Pick<Stripe.Subscription, 'items'>, productId: string,
): Stripe.SubscriptionItem | undefined {
  return subscription.items.data.find((item) => {
    const product = item.price?.product;
    return (typeof product === 'string' ? product : product?.id) === productId;
  });
}

/** How the add-on stands on a subscription: the item's id and a status from the subscription's own status, or null when there is no item. */
export function hotLeadCallBillingOf(
  subscription: Pick<Stripe.Subscription, 'items' | 'status'>, productId: string,
): { itemId: string; status: HotLeadCallBilling['status'] } | null {
  const item = findHotLeadCallItem(subscription, productId);
  if (!item) return null;
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      return { itemId: item.id, status: 'active' };
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return { itemId: item.id, status: 'past_due' };
    default:
      return { itemId: item.id, status: 'canceled' };
  }
}

/** Writes the mirror from a known-good live fact. Never throws; returns whether it was stored (the Stripe change already happened either way). */
async function writeMirror(orgId: string, live: { itemId: string; status: HotLeadCallBilling['status'] }): Promise<boolean> {
  try {
    await orgDb.updateOrg(orgId, { hotLeadCallBilling: { ...live, updatedAt: new Date().toISOString() } });
    return true;
  } catch (err) {
    console.error('[hotLeadCallBilling] mirror write failed', { orgId, type: err instanceof Error ? err.name : 'error' });
    return false;
  }
}

function productIdOf(item: Stripe.SubscriptionItem): string | undefined {
  const product = item.price?.product;
  return typeof product === 'string' ? product : product?.id;
}

/** Keeps the earliest add-on item on the subscription and deletes the rest with a credit; returns the kept item id. */
async function removeDuplicateItems(stripe: Stripe, subscriptionId: string, productId: string, orgId: string): Promise<string> {
  const fresh = await stripe.subscriptions.retrieve(subscriptionId);
  const items = fresh.items.data
    .filter((i) => productIdOf(i) === productId)
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  for (const extra of items.slice(1)) {
    await stripe.subscriptionItems.del(extra.id, { proration_behavior: 'always_invoice' });
    console.warn('[hotLeadCallBilling] removed a duplicate add-on item', { orgId });
  }
  return items[0].id;
}

/** removeDuplicateItems that logs a failure instead of throwing (the add-on is paid); the next add attempt retries it. */
async function removeDuplicatesQuietly(stripe: Stripe, subscriptionId: string, productId: string, orgId: string, fallbackId: string): Promise<string> {
  try {
    return await removeDuplicateItems(stripe, subscriptionId, productId, orgId);
  } catch (err) {
    console.error('[hotLeadCallBilling] duplicate cleanup failed; it is retried on the next add', { orgId, type: (err as { type?: string })?.type ?? 'error' });
    return fallbackId;
  }
}

/**
 * Adds the add-on to the org owner's active subscription, once. Call it only after the user approved the price.
 * Idempotent: when the live subscription already has the item nothing is created. Throws HotLeadCallBillingError
 * (plain message, nothing charged) when the owner has no active subscription, the product id is not configured, or
 * Stripe fails; the caller must then not turn calling on.
 */
export async function addHotLeadCallBilling(orgId: string): Promise<{ itemId: string; alreadyPresent: boolean }> {
  const productId = process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID;
  const stripe = getStripe();
  if (!productId || !stripe) {
    console.error('[hotLeadCallBilling] add refused: STRIPE_HOT_LEAD_CALL_PRODUCT_ID or STRIPE_SECRET_KEY is not configured', { orgId });
    throw new HotLeadCallBillingError(NOT_AVAILABLE);
  }
  try {
    const org = await orgDb.getOrgById(orgId, ['orgId', 'ownerUserId']);
    const owner = org ? await userDb.getUserById(org.ownerUserId) : null;
    if (!org || !owner?.stripe_subscription_id) {
      console.warn('[hotLeadCallBilling] add refused: owner has no Stripe subscription', { orgId });
      throw new HotLeadCallBillingError(NO_SUBSCRIPTION);
    }
    const subscription = await stripe.subscriptions.retrieve(owner.stripe_subscription_id);
    if (subscription.status === 'trialing') {
      // always_invoice charges nothing during a trial, so calling would be free: wait for the first payment.
      console.warn('[hotLeadCallBilling] add refused: subscription is in a trial', { orgId });
      throw new HotLeadCallBillingError(TRIAL_SUBSCRIPTION);
    }
    if (subscription.status !== 'active') {
      console.warn('[hotLeadCallBilling] add refused: subscription is not active', { orgId, status: subscription.status });
      throw new HotLeadCallBillingError(NO_SUBSCRIPTION);
    }
    const existing = findHotLeadCallItem(subscription, productId);
    if (existing) {
      // Paid already (for example a retry after the settings write failed): make sure entitlement can see it now.
      // A duplicate left by an earlier failed cleanup is retried here, so it cannot keep billing for good.
      const keptId = subscription.items.data.filter((i) => productIdOf(i) === productId).length > 1
        ? await removeDuplicatesQuietly(stripe, subscription.id, productId, orgId, existing.id)
        : existing.id;
      if (!await writeMirror(orgId, { itemId: keptId, status: 'active' })) throw new HotLeadCallBillingError(PAID_NOT_SAVED);
      return { itemId: keptId, alreadyPresent: true };
    }
    if (subscription.items.data.some((i) => i.price?.recurring?.interval !== 'month')) {
      console.warn('[hotLeadCallBilling] add refused: subscription is not monthly', { orgId });
      throw new HotLeadCallBillingError(NOT_MONTHLY);
    }

    // The key only stops a double click racing the live check above from creating two items; it is bucketed per
    // minute so a retry after a failure is a fresh request instead of Stripe replaying the old error.
    const item = await stripe.subscriptionItems.create({
      subscription: subscription.id,
      price_data: { currency: 'usd', unit_amount: HOT_LEAD_CALL_ADDON_PRICE_CENTS, product: productId, recurring: { interval: 'month' } },
      quantity: 1,
      // Charge the prorated month now and refuse the change when the card fails, so calling is never on unpaid.
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    }, { idempotencyKey: `hot-lead-call-addon:${orgId}:${subscription.id}:${Math.floor(Date.now() / 60_000)}` });
    console.info('[hotLeadCallBilling] add-on added', { orgId, priceCents: HOT_LEAD_CALL_ADDON_PRICE_CENTS });
    // Two requests straddling a minute boundary can both pass the live check above and use different keys, so look again
    // and remove any extra item (credited), keeping the earliest one. A failure here is logged, never thrown: the add-on is paid.
    const keptId = await removeDuplicatesQuietly(stripe, subscription.id, productId, orgId, item.id);
    // Entitlement reads the mirror; do not wait for the webhook (it can lag or arrive out of order). When it cannot be
    // stored, calling must not turn on (dispatch would refuse it); the retry finds the paid item and writes the mirror.
    if (!await writeMirror(orgId, { itemId: keptId, status: 'active' })) throw new HotLeadCallBillingError(PAID_NOT_SAVED);
    return { itemId: keptId, alreadyPresent: false };
  } catch (err) {
    if (err instanceof HotLeadCallBillingError) throw err;
    // Only the error type and Stripe code are logged: never the message body, which can echo request details.
    const e = err as { type?: string; code?: string };
    console.error('[hotLeadCallBilling] add failed', { orgId, type: e?.type ?? 'error', code: e?.code });
    throw new HotLeadCallBillingError('The hot lead calls add-on could not be added to your subscription, for example because the card was declined. Nothing was turned on; check your payment method and try again.');
  }
}

/** The live subscription, or null when Stripe cannot be read: an event payload may be stale, so it never decides alone. */
async function retrieveLive(payload: Pick<Stripe.Subscription, 'items' | 'status'> & { id?: string }): Promise<Pick<Stripe.Subscription, 'items' | 'status'> | null> {
  const stripe = getStripe();
  if (!stripe || !payload.id) return payload;
  try {
    return await stripe.subscriptions.retrieve(payload.id);
  } catch (err) {
    console.error('[hotLeadCallBilling] live subscription read failed; the mirror is left unchanged', (err as { type?: string })?.type ?? 'error');
    return null;
  }
}

/**
 * Webhook mirror: writes Organization.hotLeadCallBilling from the live subscription when `user` is the org's billing
 * owner. Item present: itemId and a status from the subscription's status. Item gone: 'canceled', only when a mirror
 * already exists (orgs that never bought it are not written). Skipped when the product id is not configured. Idempotent.
 * Never throws (the webhook must not fail on it).
 */
export async function mirrorHotLeadCallBilling(
  user: { userId: string; orgId?: string }, subscription: Pick<Stripe.Subscription, 'items' | 'status'> & { id?: string },
): Promise<void> {
  const productId = process.env.STRIPE_HOT_LEAD_CALL_PRODUCT_ID;
  if (!user.orgId || !productId) return;
  try {
    const org = await orgDb.getOrgById(user.orgId, ['orgId', 'ownerUserId', 'hotLeadCallBilling']);
    if (!org || org.ownerUserId !== user.userId) return;
    const stored = org.hotLeadCallBilling;
    // Decide from Stripe's current state, not the event payload: events can arrive late or out of order, and a stale one
    // must not flip a paid add-on to canceled. When Stripe cannot be read the mirror is left unchanged.
    const liveSubscription = await retrieveLive(subscription);
    if (!liveSubscription) return;
    const live = hotLeadCallBillingOf(liveSubscription, productId)
      ?? (stored && stored.status !== 'canceled' ? { itemId: stored.itemId, status: 'canceled' as const } : null);
    if (!live || (stored?.itemId === live.itemId && stored.status === live.status)) return;
    await orgDb.updateOrg(org.orgId, { hotLeadCallBilling: { ...live, updatedAt: new Date().toISOString() } });
  } catch (err) {
    console.error('[hotLeadCallBilling] mirror failed for org of user', user.userId, err instanceof Error ? err.name : 'error');
  }
}
