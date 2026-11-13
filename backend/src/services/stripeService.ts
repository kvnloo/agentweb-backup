import Stripe from 'stripe';
import { createStripeClient } from './stripeClientFactory';
import dotenv from 'dotenv';
import { userDb, orgDb, User } from './db';
import { getTierConfig, DEFAULT_PAGES } from './subscriptionService';
import { paymentHistoryDb } from './paymentHistoryDb';
import { syncUserUpdateToLeadList } from './crmAutoSyncService';
import { waitlistDb, WaitlistEntry } from './waitlistDb';
import { findSeatLineItem } from './orgSeatBillingService';
import { mirrorHotLeadCallBilling } from './hotLeadCallBillingService';
import { invoiceSubscriptionId } from '../utils/stripeInvoiceFields';

dotenv.config();

// Lazy-initialize Stripe SDK so env vars set at test time are picked up
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

/**
 * Read a subscription's current period end defensively and return it as an ISO
 * string (or undefined if absent).
 *
 * Stripe's Basil API (2025-03-31+, which we pin via apiVersion) moved
 * `current_period_end` off the subscription root onto each item
 * (`items.data[].current_period_end`). Webhook payloads may still carry the
 * root field depending on the account's pinned webhook version, so read the
 * item first and fall back to the root. Value is epoch-seconds (number) on real
 * Stripe; the string branch is kept for defensiveness.
 */
export function getSubscriptionPeriodEndIso(sub: any): string | undefined {
  const raw =
    sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;
  if (raw == null) return undefined;
  return new Date(typeof raw === 'number' ? raw * 1000 : raw).toISOString();
}

/**
 * Identify "the" base-plan subscription item, robust to the presence of the
 * seat-billing extra-seat line item (ENG-2243..2246) that can now coexist on
 * the same subscription alongside the plan item.
 *
 * Every plan-mutating call site in this file (`upgradeSubscription`,
 * `changeSubscriptionPrice`) was written when a subscription could only ever
 * have one item, and picked it with `items.data[0]`. Seat billing breaks that
 * assumption — a subscription can now carry two items — and Stripe does not
 * document `items.data` as being stably ordered with the originally-
 * subscribed item first. If a seat item ever sorted ahead of the plan item,
 * `items.data[0]` would silently become the SEAT item, and a plan
 * upgrade/downgrade would overwrite the seat item's price with the new
 * plan's price — corrupting the seat line item while leaving the real plan
 * item (and its old price) untouched. Explicitly excluding the known seat
 * product id removes the dependency on ordering entirely.
 *
 * Behavior-preserving: returns `items[0]` whenever there's at most one item
 * or the seat product id isn't configured, which is every subscription that
 * predates seat billing.
 */
export function findBasePlanItem(
  subscription: Pick<Stripe.Subscription, 'items'>
): Stripe.SubscriptionItem | undefined {
  const items = subscription.items.data;
  if (items.length <= 1) return items[0];

  const seatProductId = process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID;
  if (!seatProductId) return items[0];

  const seatItem = findSeatLineItem(subscription, seatProductId);
  if (!seatItem) return items[0];

  const nonSeatItems = items.filter((item) => item.id !== seatItem.id);
  return nonSeatItems[0] ?? items[0];
}

/**
 * Extract the two custom checkout fields ("companyname" and
 * "howdoyouplantousethisproduct") from a Stripe Checkout Session's
 * `custom_fields` array. Shared by the authenticated webhook handler
 * (source of truth) so the profile-enrichment side effects that used to
 * live in the public, unauthenticated `GET /api/stripe/session/:sessionId`
 * route (ENG-1756) still happen — just from a signature-verified event.
 */
export function extractCheckoutCustomFields(session: any): {
  companyName?: string;
  productUsageLabel?: string;
} {
  let companyName: string | undefined;
  let productUsageLabel: string | undefined;

  if (session?.custom_fields && Array.isArray(session.custom_fields)) {
    for (const field of session.custom_fields) {
      if (
        field.key === 'companyname' &&
        field.text &&
        typeof field.text.value === 'string'
      ) {
        companyName = field.text.value;
      }
      if (
        field.key === 'howdoyouplantousethisproduct' &&
        field.dropdown &&
        typeof field.dropdown.value === 'string'
      ) {
        const selectedValue = field.dropdown.value;
        const selectedOption = field.dropdown.options?.find(
          (opt: any) => opt.value === selectedValue
        );
        productUsageLabel =
          selectedOption && typeof selectedOption.label === 'string'
            ? selectedOption.label
            : selectedValue;
      }
    }
  }

  return { companyName, productUsageLabel };
}

/**
 * Sync companyName / useCaseCategories from a Checkout Session's custom
 * fields onto the matching user (or waitlist entry) record. Only ever
 * called from the signature-verified webhook handler — this is the write
 * path formerly reachable from the public GET session-lookup route
 * (ENG-1756).
 */
async function syncCheckoutProfileFields(session: any): Promise<void> {
  const { companyName, productUsageLabel } = extractCheckoutCustomFields(session);
  if (!companyName && !productUsageLabel) return;

  let email: string | undefined;
  if (
    session.customer &&
    typeof session.customer === 'object' &&
    !session.customer.deleted &&
    session.customer.email
  ) {
    email = session.customer.email;
  } else if (session.customer_details?.email) {
    email = session.customer_details.email;
  }
  if (!email) return;
  email = email.toLowerCase();

  let stripeCustomerId: string | undefined;
  if (session.customer) {
    if (typeof session.customer === 'string') {
      stripeCustomerId = session.customer;
    } else if (session.customer.id && !session.customer.deleted) {
      stripeCustomerId = session.customer.id;
    }
  }

  try {
    const existingUser = await userDb.getUserByEmail(email);

    if (existingUser && existingUser.userId) {
      const userUpdates: Partial<User> = {};
      if (stripeCustomerId && existingUser.stripe_customer_id !== stripeCustomerId) {
        userUpdates.stripe_customer_id = stripeCustomerId;
      }
      if (companyName && existingUser.companyName !== companyName) {
        userUpdates.companyName = companyName;
      }
      if (
        productUsageLabel &&
        (!existingUser.useCaseCategories ||
          existingUser.useCaseCategories.length !== 1 ||
          existingUser.useCaseCategories[0] !== productUsageLabel)
      ) {
        userUpdates.useCaseCategories = [productUsageLabel];
      }
      if (Object.keys(userUpdates).length > 0) {
        await userDb.updateUser(existingUser.userId, userUpdates);
      }

      const waitlistUpdates: Partial<WaitlistEntry> = {};
      if (stripeCustomerId) waitlistUpdates.stripe_customer_id = stripeCustomerId;
      if (companyName) waitlistUpdates.companyName = companyName;
      if (productUsageLabel) waitlistUpdates.useCaseCategories = [productUsageLabel];
      if (Object.keys(waitlistUpdates).length > 0) {
        const waitlistEntry = await waitlistDb.getByEmail(email);
        if (waitlistEntry) {
          const changesExist = Object.keys(waitlistUpdates).some(
            (key) =>
              waitlistUpdates[key as keyof typeof waitlistUpdates] !==
              waitlistEntry[key as keyof typeof waitlistEntry]
          );
          if (changesExist) {
            await waitlistDb.updateDetails(email, waitlistUpdates);
          }
        }
      }
    } else {
      const existingWaitlistEntry = await waitlistDb.getByEmail(email);
      const waitlistData: Partial<WaitlistEntry> & { email: string } = {
        email,
        companyName: companyName || existingWaitlistEntry?.companyName || 'Freelancer',
        useCaseCategories: productUsageLabel
          ? [productUsageLabel]
          : existingWaitlistEntry?.useCaseCategories || [],
        stripe_customer_id: stripeCustomerId,
        supportNote: existingWaitlistEntry?.supportNote || 'Joined/Updated from Stripe',
        joinedAt: existingWaitlistEntry?.joinedAt || new Date().toISOString(),
        status: 'invited',
        invitedAt: new Date().toISOString(),
      };
      if (existingWaitlistEntry) {
        await waitlistDb.updateDetails(email, waitlistData);
      } else {
        await waitlistDb.add(waitlistData as WaitlistEntry);
      }
    }
  } catch (err: any) {
    console.error(
      `[STRIPE] Failed to sync checkout profile fields for session ${session?.id}:`,
      err.message
    );
  }
}

/**
 * A setup-mode Checkout Session only saves a payment method; it never creates a
 * subscription. ENG-2303: Zoma's "add a payment method" link uses one, and the
 * subscription handlers must not treat its completion as a purchase (that would mark a
 * non-subscriber `subscription_status: active`).
 */
export function isSetupModeCheckoutSession(session: any): boolean {
  return session?.object !== 'subscription' && session?.mode === 'setup';
}

export const ZOMA_PAYMENT_METHOD_PURCHASE_TYPE = 'zoma_payment_method';

/** ENG-2571: what `resolveUserPaymentMethod` found. `customerId` never leaves the backend. */
/** The user-row fields the ENG-2571 customer lookup reads. */
export type CustomerCandidateUser = { stripe_customer_id?: string | null; email?: string | null } | null | undefined;

export interface UserPaymentMethod {
  hasPaymentMethod: boolean;
  customerId: string | null;
  card: { brand: string; last4: string } | null;
  isZoma: boolean;
  /**
   * ENG-668: a method to pin on an off-session invoice, ONLY when the customer has no invoice default
   * (`invoice_settings.default_payment_method` / `default_source`) for Stripe to charge — the newest
   * card, else the first listed. Null when there is a default: an invoice's own
   * `default_payment_method` overrides the customer's for every automatic retry, so pinning it would
   * keep charging the old card after the owner updates theirs. Backend only, like `customerId`.
   */
  fallbackPaymentMethodId?: string | null;
}

/** ENG-668 PR-2: `metadata.purchaseType` on every month-end pay-as-you-go overage invoice. */
export const PAYG_OVERAGE_PURCHASE_TYPE = 'payg_overage';

/**
 * Why an overage invoice is not the one the settlement record expects. `total_differs`: a finalized
 * invoice Stripe is collecting, at another total. The rest collected nothing: `draft_deleted` (its draft
 * total differed, so it was deleted before finalizing), `void`, or `missing` (deleted or unknown to Stripe).
 */
export type PaygOverageInvoiceMismatch = 'total_differs' | 'draft_deleted' | 'void' | 'missing';

/** The part of a Stripe charge the overage-invoice lookup reads. */
export interface PaygChargeRef {
  id?: string;
  payment_intent?: string | { id?: string } | null;
}

/** Pages of invoice payments read for one PaymentIntent (10 each) before giving up on finding its invoice. */
const PAYG_INVOICE_PAYMENT_PAGES = 5;

/** An empty overage draft at least this old has no run in flight behind it (runs take seconds). */
const PAYG_ORPHAN_DRAFT_AGE_SECONDS = 60 * 60;

/** An invoice by id, or null when Stripe reports it deleted or unknown. Any other Stripe error throws. */
async function retrieveInvoiceIfExists(s: Stripe, invoiceId: string): Promise<Stripe.Invoice | null> {
  try {
    const invoice = await s.invoices.retrieve(invoiceId);
    return (invoice as unknown as Stripe.DeletedInvoice).deleted ? null : invoice;
  } catch (error: unknown) {
    const { code, statusCode } = (error ?? {}) as { code?: string; statusCode?: number };
    if (code === 'resource_missing' || statusCode === 404) return null;
    throw error;
  }
}

/** The metadata settlement stamps on an overage invoice (and its line item). */
export interface PaygOverageInvoiceMetadata {
  purchaseType: typeof PAYG_OVERAGE_PURCHASE_TYPE;
  billingUserId: string;
  month: string;
  idempotencyKey: string;
  /**
   * The `createdAt` of the settlement record that created the invoice. `idempotencyKey` is the same for
   * every record of a month (a `retry` re-creates the record), so this is what tells an earlier record's
   * invoice from this one's while the record names no invoice yet.
   */
  recordCreatedAt: string;
}

/**
 * What an overage invoice's failed attempt actually is, from its PaymentIntent (see
 * `paygOverageInvoicePaymentState`): `declined` (a decline, a failed authentication, a canceled
 * attempt), `action_required` (waiting for the customer to confirm: 3-D Secure, a mandate), or
 * `in_progress` (the payment went through or is still processing — `invoice.paid` follows).
 */
export type PaygOverageInvoicePaymentState = 'declined' | 'action_required' | 'in_progress';

/**
 * Stripe Service — wraps Stripe SDK calls with validation.
 */
export const stripeService = {
  /**
   * Create a Stripe Checkout Session for a subscription.
   */
  async createCheckoutSession(
    userId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string
  ) {
    if (!userId) throw new Error('userId is required');
    if (!priceId) throw new Error('priceId is required');
    if (!successUrl) throw new Error('successUrl is required');
    if (!cancelUrl) throw new Error('cancelUrl is required');

    const s = getStripeOrThrow();

    // NOTE: billing_cycle_anchor is NOT supported in checkout.sessions.create
    // subscription_data. To anchor billing to the 1st of the month, we would
    // need to update the subscription after checkout completes via the webhook.
    // For now, subscriptions start billing on the day the customer signs up.
    // TODO: Implement post-checkout anchor in handleCheckoutSessionCompleted.
    return s.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: { userId },
    });
  },

  /**
   * Upgrade an existing subscription to a new price (plan).
   * Uses Stripe's subscription update API with proration.
   * Returns the updated Stripe subscription object.
   */
  async upgradeSubscription(
    stripeSubscriptionId: string,
    newPriceId: string
  ): Promise<Stripe.Subscription> {
    if (!stripeSubscriptionId) throw new Error('stripeSubscriptionId is required');
    if (!newPriceId) throw new Error('newPriceId is required');

    const s = getStripeOrThrow();
    const subscription = await s.subscriptions.retrieve(stripeSubscriptionId);
    const existingItemId = findBasePlanItem(subscription)?.id;

    if (!existingItemId) {
      throw new Error('No subscription item found on the existing subscription.');
    }

    return s.subscriptions.update(stripeSubscriptionId, {
      items: [{ id: existingItemId, price: newPriceId }],
      proration_behavior: 'create_prorations',
    });
  },

  /**
   * Cancel duplicate subscriptions for a customer, keeping only the specified one.
   */
  async cancelDuplicateSubscriptions(
    stripeCustomerId: string,
    keepSubscriptionId: string
  ): Promise<number> {
    const s = getStripeOrThrow();
    let canceledCount = 0;

    for (const status of ['active', 'trialing'] as const) {
      const subs = await s.subscriptions.list({
        customer: stripeCustomerId,
        status,
        limit: 100,
      });

      for (const sub of subs.data) {
        if (sub.id !== keepSubscriptionId) {
          await s.subscriptions.cancel(sub.id);
          canceledCount++;
          console.log(`[STRIPE] Canceled duplicate subscription ${sub.id} for customer ${stripeCustomerId}`);
        }
      }
    }

    return canceledCount;
  },

  /**
   * Find the active/trialing subscription for a customer.
   * Returns the most recent one if multiple exist.
   */
  async findActiveSubscription(
    stripeCustomerId: string
  ): Promise<Stripe.Subscription | null> {
    const s = getStripeOrThrow();

    // Check active first, then trialing
    for (const status of ['active', 'trialing'] as const) {
      const subs = await s.subscriptions.list({
        customer: stripeCustomerId,
        status,
        limit: 1,
      });
      if (subs.data.length > 0) {
        return subs.data[0];
      }
    }

    return null;
  },

  /**
   * Create a Stripe Customer Portal session so the user can manage billing.
   */
  async createCustomerPortalSession(stripeCustomerId: string, returnUrl: string) {
    if (!stripeCustomerId) throw new Error('stripeCustomerId is required');

    const s = getStripeOrThrow();
    return s.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl || undefined,
    });
  },

  /**
   * ENG-2303 — Stripe customers created for a user that has no `stripe_customer_id` yet
   * carry `metadata.userId`, so they can be found again without writing to the user row.
   */
  async findCustomerIdsByUserId(userId: string): Promise<string[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('userId has unexpected characters');
    const s = getStripeOrThrow();
    const result = await s.customers.search({ query: `metadata['userId']:'${userId}'`, limit: 10 });
    return result.data.map((c) => c.id);
  },

  /**
   * ENG-2571 — the customer, or null when Stripe says it is deleted or does not exist
   * (`resource_missing`: a stale id on the user row, or a deleted id still in the lagging
   * search index). Every other Stripe error throws.
   */
  async retrieveLiveCustomer(customerId: string, params?: Stripe.CustomerRetrieveParams): Promise<Stripe.Customer | null> {
    const s = getStripeOrThrow();
    try {
      const customer = await s.customers.retrieve(customerId, params);
      return (customer as Stripe.DeletedCustomer).deleted ? null : (customer as Stripe.Customer);
    } catch (error: any) {
      if (error?.code === 'resource_missing' || error?.statusCode === 404) return null;
      throw error;
    }
  },

  /**
   * ENG-2571 — the user row's `stripe_customer_id` first, then this user's customers by email,
   * then customers found by `metadata.userId`. Search lags new customers by up to a minute, so
   * a card saved through Zoma's setup Checkout would read as "no card" right as the user lands
   * back on Settings; the email list is consistent, and Zoma always creates with the email.
   * Email matches count only when they carry this `metadata.userId`.
   */
  async customerCandidateIds(user: CustomerCandidateUser, userId: string): Promise<string[]> {
    const ids = new Set<string>();
    if (typeof user?.stripe_customer_id === 'string' && user.stripe_customer_id) ids.add(user.stripe_customer_id);
    if (typeof user?.email === 'string' && user.email) {
      const byEmail = await getStripeOrThrow().customers.list({ email: user.email, limit: 10 });
      for (const c of byEmail.data) if (c.metadata?.userId === userId) ids.add(c.id);
    }
    for (const id of await stripeService.findCustomerIdsByUserId(userId)) ids.add(id);
    return [...ids];
  },

  /** ENG-2571 — the first candidate customer that still exists in Stripe, or null. */
  async findLiveCustomerIdForUser(user: CustomerCandidateUser, userId: string): Promise<string | null> {
    // The row's own customer first, so a live one never waits on (or fails with) discovery.
    const rowId = typeof user?.stripe_customer_id === 'string' && user.stripe_customer_id ? user.stripe_customer_id : null;
    if (rowId && (await stripeService.retrieveLiveCustomer(rowId))) return rowId;
    for (const id of await stripeService.customerCandidateIds(user, userId)) {
      if (id === rowId) continue;
      if (await stripeService.retrieveLiveCustomer(id)) return id;
    }
    return null;
  },

  async createCustomerForUser(userId: string, email: string | undefined): Promise<string> {
    if (!userId) throw new Error('userId is required');
    const s = getStripeOrThrow();
    // The idempotency key collapses rapid repeat calls (customer search is eventually
    // consistent), but Stripe replays it for 24h, including after the customer is deleted
    // (ENG-2571). So a replayed customer that is gone chains to a key derived from its id:
    // concurrent callers that both see the same deleted customer still share one key and
    // dedupe, and a deletion never blocks minting a new link.
    let idempotencyKey = `zoma-customer-${userId}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const customer = await s.customers.create({ email, metadata: { userId, source: 'zoma_mcp' } }, { idempotencyKey });
      if (await stripeService.retrieveLiveCustomer(customer.id)) return customer.id;
      idempotencyKey = `zoma-customer-${userId}-after-${customer.id}`;
    }
    throw new Error(`Could not create a live Stripe customer for user ${userId}: every replayed customer is deleted.`);
  },

  /**
   * ENG-2571 — the single answer to "does this user have a payment method, and where".
   * Candidates are the user row's `stripe_customer_id` plus every customer carrying
   * `metadata.userId` (Zoma's setup Checkout never touches the user row). Deleted or unknown
   * candidates are skipped (`retrieveLiveCustomer`). The first live
   * candidate with a payment method wins. `isZoma` means that customer completed Zoma's setup
   * Checkout (a succeeded SetupIntent tagged ZOMA_PAYMENT_METHOD_PURCHASE_TYPE). Stripe errors
   * propagate: callers decide how to report an unknown state, never "no card".
   */
  async resolveUserPaymentMethod(
    user: CustomerCandidateUser,
    userId: string,
  ): Promise<UserPaymentMethod> {
    const s = getStripeOrThrow();
    for (const customerId of await stripeService.customerCandidateIds(user, userId)) {
      const customer = await stripeService.retrieveLiveCustomer(customerId, { expand: ['invoice_settings.default_payment_method'] });
      if (!customer) continue;
      const methods = (await s.paymentMethods.list({ customer: customerId, limit: 100 })).data;
      if (methods.length === 0) continue;

      const defaultPm = customer.invoice_settings?.default_payment_method;
      const newestCard = methods.filter((m) => m.type === 'card' && m.card).sort((a, b) => b.created - a.created)[0];
      const cardPm = typeof defaultPm === 'object' && defaultPm?.card ? defaultPm : newestCard;
      const setupIntents = (await s.setupIntents.list({ customer: customerId, limit: 100 })).data;
      const defaultPmId = typeof defaultPm === 'string' ? defaultPm : defaultPm?.id;
      return {
        hasPaymentMethod: true,
        customerId,
        fallbackPaymentMethodId: defaultPmId || customer.default_source ? null : (newestCard?.id || methods[0].id),
        card: cardPm?.card ? { brand: cardPm.card.brand, last4: cardPm.card.last4 } : null,
        isZoma: setupIntents.some(
          (si) => si.status === 'succeeded' && si.metadata?.purchaseType === ZOMA_PAYMENT_METHOD_PURCHASE_TYPE,
        ),
      };
    }
    return { hasPaymentMethod: false, customerId: null, card: null, isZoma: false };
  },

  /**
   * ENG-668 PR-2: create, fill and finalize one month's pay-as-you-go overage invoice, or pick up the
   * one an earlier attempt already started. Safe to call again for the same month:
   *   - an earlier attempt's invoice id (`invoiceId`) is retrieved directly; with none, Stripe is ALWAYS
   *     searched for this owner's invoice for this month (`metadata` purchaseType + billingUserId +
   *     month) before anything is created, whatever the record's age — so neither a lost response nor
   *     a record removed by hand can lead to a second invoice for the month;
   *   - every Stripe write also carries a key derived from `idempotencyKey` (`:invoice`, `:item`,
   *     `:finalize` — one key cannot be reused across endpoints), which covers the search index's lag
   *     within Stripe's 24h key window.
   * The draft is created with `auto_advance: false` (an empty draft must never auto-finalize as a $0
   * invoice) and `pending_invoice_items_behavior: 'exclude'` (nothing else the customer has pending is
   * swept onto it). Before finalizing, the draft's total is compared with `amountCents`: if Stripe would
   * total anything else (a customer discount or coupon), the draft is deleted and nothing is ever
   * finalized or collected. Finalizing turns `auto_advance` on, so Stripe charges the payment method.
   * `recordInvoiceId` runs as soon as the invoice is known (found or created), before the line item.
   *
   * An invoice the record already names that is void, deleted or unknown to Stripe (a draft deleted on a
   * mismatch before the hold could be written, or voided by hand) is never replaced here: nothing was or
   * will be collected on it, and a person decides whether the month is billed again (`mismatch`).
   */
  async issuePaygOverageInvoice(input: {
    idempotencyKey: string;
    customerId: string | null;
    /** Pinned on the invoice only when given (see `UserPaymentMethod.fallbackPaymentMethodId`). */
    fallbackPaymentMethodId?: string | null;
    amountCents: number;
    description: string;
    lineDescription: string;
    metadata: PaygOverageInvoiceMetadata;
    invoiceId?: string | null;
    recordInvoiceId: (invoiceId: string) => Promise<void>;
  }): Promise<
    | { outcome: 'issued'; invoice: Stripe.Invoice }
    | { outcome: 'mismatch'; invoiceId: string; reason: PaygOverageInvoiceMismatch }
    | { outcome: 'multiple'; invoiceIds: string[] }
    | { outcome: 'no_customer' }
  > {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error('amountCents must be a positive integer');
    const { billingUserId, month } = input.metadata;
    if (!/^[A-Za-z0-9_-]+$/.test(billingUserId) || !/^\d{4}-\d{2}$/.test(month)) {
      throw new Error('billingUserId or month has unexpected characters');
    }
    const s = getStripeOrThrow();
    const metadata: Record<string, string> = { ...input.metadata };

    let invoice: Stripe.Invoice | null = null;
    if (input.invoiceId) {
      invoice = await retrieveInvoiceIfExists(s, input.invoiceId);
      if (!invoice) return { outcome: 'mismatch', invoiceId: input.invoiceId, reason: 'missing' };
      if (invoice.status === 'void') return { outcome: 'mismatch', invoiceId: input.invoiceId, reason: 'void' };
    }
    if (!invoice) {
      const found = await s.invoices.search({
        query: `metadata['purchaseType']:'${PAYG_OVERAGE_PURCHASE_TYPE}' AND metadata['billingUserId']:'${billingUserId}' AND metadata['month']:'${month}'`,
        limit: 10,
      });
      // A void invoice collected nothing; any other one is this month's.
      const live = found.data.filter((candidate) =>
        candidate.metadata?.purchaseType === PAYG_OVERAGE_PURCHASE_TYPE
        && candidate.metadata?.billingUserId === billingUserId
        && candidate.metadata?.month === month
        && candidate.status !== 'void');
      // An EMPTY draft older than any run in flight is an orphan: a run created it and died before
      // recording its id, and the key has since expired. It can never be collected, so it is deleted
      // rather than adopted (adopting it next to the invoice that replaced it would bill twice).
      const orphanBefore = Math.floor(Date.now() / 1000) - PAYG_ORPHAN_DRAFT_AGE_SECONDS;
      const isOrphan = (candidate: Stripe.Invoice) =>
        candidate.status === 'draft' && !(candidate.lines?.data?.length) && candidate.created < orphanBefore;
      for (const orphan of live.filter(isOrphan)) await s.invoices.del(orphan.id!);
      const standing = live.filter((candidate) => !isOrphan(candidate));
      // More than one live invoice for one month: never pick one — a person decides which stands.
      if (standing.length > 1) return { outcome: 'multiple', invoiceIds: standing.map((candidate) => candidate.id!) };
      invoice = standing[0] ?? null;
      if (invoice?.id) await input.recordInvoiceId(invoice.id);
    }
    if (!invoice) {
      if (!input.customerId) return { outcome: 'no_customer' };
      invoice = await s.invoices.create({
        customer: input.customerId,
        collection_method: 'charge_automatically',
        auto_advance: false,
        pending_invoice_items_behavior: 'exclude',
        currency: 'usd',
        description: input.description,
        metadata,
        ...(input.fallbackPaymentMethodId ? { default_payment_method: input.fallbackPaymentMethodId } : {}),
      }, { idempotencyKey: `${input.idempotencyKey}:invoice` });
      await input.recordInvoiceId(invoice.id!);
    }

    if (invoice.status !== 'draft') {
      return invoice.total === input.amountCents
        ? { outcome: 'issued', invoice }
        : { outcome: 'mismatch', invoiceId: invoice.id!, reason: 'total_differs' };
    }
    const customer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customer) throw new Error(`Pay-as-you-go invoice ${invoice.id} has no customer`);
    // Only this item is ever put on the draft (pending items are excluded), so any line means it is there.
    if (!(invoice.lines?.data?.length)) {
      await s.invoiceItems.create({
        customer,
        invoice: invoice.id!,
        amount: input.amountCents,
        currency: 'usd',
        description: input.lineDescription,
        metadata,
      }, { idempotencyKey: `${input.idempotencyKey}:item` });
      invoice = await s.invoices.retrieve(invoice.id!);
    }
    if (invoice.total !== input.amountCents) {
      await s.invoices.del(invoice.id!);
      return { outcome: 'mismatch', invoiceId: invoice.id!, reason: 'draft_deleted' };
    }
    const finalized = await s.invoices.finalizeInvoice(invoice.id!, { auto_advance: true }, { idempotencyKey: `${input.idempotencyKey}:finalize` });
    return { outcome: 'issued', invoice: finalized };
  },

  /**
   * ENG-668 PR-2: the pay-as-you-go overage invoice a charge paid, or null when the charge is anything
   * else. Since API version 2025-03-31.basil a charge no longer carries `invoice`; the link is the
   * invoice payment for the charge's PaymentIntent. Charges without a PaymentIntent are never ours.
   */
  async findPaygOverageInvoiceForCharge(charge: PaygChargeRef): Promise<Stripe.Invoice | null> {
    const paymentIntent = typeof charge?.payment_intent === 'string' ? charge.payment_intent : charge?.payment_intent?.id;
    if (!paymentIntent) return null;
    const s = getStripeOrThrow();
    // Every invoice payment of this PaymentIntent, not just the first one listed — paged while Stripe
    // says there are more (bounded: a PaymentIntent pays one invoice in practice): the one that was paid
    // (a refunded or disputed charge was collected) is preferred, then any other.
    const all: Stripe.InvoicePayment[] = [];
    for (let page = 0; page < PAYG_INVOICE_PAYMENT_PAGES; page++) {
      const payments = await s.invoicePayments.list({
        payment: { type: 'payment_intent', payment_intent: paymentIntent },
        limit: 10,
        expand: ['data.invoice'],
        ...(all.length ? { starting_after: all[all.length - 1].id } : {}),
      });
      all.push(...payments.data);
      if (!payments.has_more || !payments.data.length) break;
    }
    const ordered = [...all.filter((p) => p.status === 'paid'), ...all.filter((p) => p.status !== 'paid')];
    for (const payment of ordered) {
      const linked = payment.invoice;
      if (!linked) continue;
      const invoice = typeof linked === 'string' ? await s.invoices.retrieve(linked) : linked;
      if ((invoice as Stripe.DeletedInvoice).deleted) continue;
      if ((invoice as Stripe.Invoice).metadata?.purchaseType === PAYG_OVERAGE_PURCHASE_TYPE) return invoice as Stripe.Invoice;
    }
    return null;
  },

  /**
   * ENG-668 PR-2: what an overage invoice's payment is NOW, read from its PaymentIntent when a failure is
   * reported (and by the sweep for a payment left unconfirmed). Since 2025-03-31.basil an invoice no
   * longer names its PaymentIntent: it is the invoice's default invoice payment. PaymentIntent statuses
   * (stripe@18 `PaymentIntent.Status`):
   *   - `requires_action` — waiting for the customer (3-D Secure, a mandate): `action_required`. Stripe
   *     sends `invoice.payment_failed` for it too, next to `invoice.payment_action_required`;
   *   - `succeeded`, `processing`, `requires_capture` — the payment went through or is in flight (the
   *     owner confirmed after the failure was sent; a bank debit settling): `in_progress`;
   *   - `requires_payment_method` (a decline, or an authentication the customer failed), `canceled`,
   *     `requires_confirmation`, or no PaymentIntent at all: `declined` — the failure Stripe reported.
   * Stripe errors propagate (the webhook is retried, never guessed).
   */
  async paygOverageInvoicePaymentState(invoiceId: string): Promise<PaygOverageInvoicePaymentState> {
    const s = getStripeOrThrow();
    const payments = await s.invoicePayments.list({ invoice: invoiceId, limit: 10, expand: ['data.payment.payment_intent'] });
    const current = payments.data.find((payment) => payment.is_default) ?? payments.data[0];
    const intent = current?.payment?.payment_intent;
    if (!intent) return 'declined';
    const paymentIntent = typeof intent === 'string' ? await s.paymentIntents.retrieve(intent) : intent;
    if (paymentIntent.status === 'requires_action') return 'action_required';
    if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing' || paymentIntent.status === 'requires_capture') return 'in_progress';
    return 'declined';
  },

  /** ENG-668 PR-2: an overage invoice by id, or null when Stripe reports it deleted or unknown. */
  async retrievePaygOverageInvoice(invoiceId: string): Promise<Stripe.Invoice | null> {
    return retrieveInvoiceIfExists(getStripeOrThrow(), invoiceId);
  },

  /**
   * ENG-668 PR-2: the refunds on a charge (newest first). A charge object no longer includes them
   * (API 2022-11-15+), and a webhook's charge is never expanded.
   */
  async listChargeRefunds(chargeId: string): Promise<Stripe.Refund[]> {
    const refunds = await getStripeOrThrow().refunds.list({ charge: chargeId, limit: 100 });
    return refunds.data;
  },

  /** Stripe-hosted Checkout in setup mode: saves a card, charges nothing. */
  async createPaymentMethodSetupSession(params: {
    stripeCustomerId: string;
    userId: string;
    successUrl: string;
    cancelUrl: string;
  }) {
    if (!params.stripeCustomerId) throw new Error('stripeCustomerId is required');
    if (!params.userId) throw new Error('userId is required');
    const s = getStripeOrThrow();
    const metadata = { userId: params.userId, purchaseType: ZOMA_PAYMENT_METHOD_PURCHASE_TYPE };
    return s.checkout.sessions.create({
      mode: 'setup',
      currency: 'usd',
      customer: params.stripeCustomerId,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      metadata,
      setup_intent_data: { metadata },
      custom_text: { submit: { message: 'Saving a card lets Zoma make changes to your ads. Nothing is charged today.' } },
    });
  },

  /**
   * Retrieve a Checkout Session by ID.
   */
  async getCheckoutSession(sessionId: string) {
    if (!sessionId) throw new Error('sessionId is required');

    const s = getStripeOrThrow();
    return s.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'payment_intent.customer', 'setup_intent.customer'],
    });
  },

  /**
   * List active products with their default prices.
   */
  async listProducts() {
    const s = getStripeOrThrow();
    return s.products.list({ active: true, expand: ['data.default_price'] });
  },

  /**
   * Construct and verify a Stripe webhook event.
   */
  constructWebhookEvent(body: string | Buffer, signature: string): Stripe.Event {
    const s = getStripeOrThrow();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
    }
    return s.webhooks.constructEvent(body, signature, secret);
  },
};

/**
 * Change a subscription's price. Upgrade = immediate with proration,
 * downgrade = scheduled for period-end (clean accounting, user keeps
 * paid tier until period closes, then auto-switches).
 *
 * Rationale: Stripe's default `subscriptions.update` with a cheaper price
 * prorates the unused time into an account-balance credit ($299 refund-
 * looking line on their invoice). Most SaaS (Vercel, Linear, Stripe
 * Billing's own dashboard) instead defer downgrades to period end —
 * cleaner ledger, cleaner UX.
 */
export async function changeSubscriptionPrice(
  subscriptionId: string,
  newPriceId: string
): Promise<{
  kind: 'upgrade_immediate' | 'downgrade_scheduled' | 'same_price';
  effectiveAt?: string; // ISO — only for scheduled downgrades
  subscription: any;
  schedule?: any; // Stripe subscription_schedule — only set on downgrade_scheduled
}> {
  if (!subscriptionId) throw new Error('subscriptionId is required');
  if (!newPriceId) throw new Error('newPriceId is required');

  const stripe = getStripeOrThrow();
  const current = await stripe.subscriptions.retrieve(subscriptionId);
  const currentItem = findBasePlanItem(current);
  if (!currentItem) throw new Error(`Subscription ${subscriptionId} has no items`);

  if (newPriceId === currentItem.price.id) {
    return { kind: 'same_price', subscription: current };
  }

  const currentAmount = currentItem.price.unit_amount ?? 0;
  const newPrice = await stripe.prices.retrieve(newPriceId);
  const newAmount = newPrice.unit_amount ?? 0;

  if (newAmount > currentAmount) {
    // Upgrade — immediate with proration
    const updated = await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: currentItem.id, price: newPriceId }],
      proration_behavior: 'create_prorations',
    });
    return { kind: 'upgrade_immediate', subscription: updated };
  }

  // Downgrade — schedule for period end using Subscription Schedules.
  // Read period_end defensively: in newer Stripe API versions, per-period
  // billing info lives on the item; older responses keep it on the sub root.
  const periodEnd =
    (currentItem as any).current_period_end ??
    (current as any).current_period_end;
  if (!periodEnd) {
    throw new Error('Cannot schedule downgrade: no current_period_end on subscription');
  }

  // Create a schedule from the current subscription. Stripe materializes
  // the current phase so we can append a second phase for the new price.
  const schedule = await stripe.subscriptionSchedules.create({
    from_subscription: subscriptionId,
  });
  const currentPhase = schedule.phases[0];

  // Carry forward every item that ISN'T the plan item being downgraded — in
  // particular the seat-billing extra-seat item (ENG-2243..2246), which can
  // now coexist on the same subscription. Without this, phase 2 would only
  // ever list `newPriceId`, and Stripe would silently drop every other item
  // (including a paid seat item, at whatever quantity it was) the moment the
  // scheduled downgrade takes effect — canceling seat billing entirely
  // without going through removeExtraSeat's occupied-seat safety check.
  const planPriceId = currentItem.price.id;
  const carryForwardItems = currentPhase.items
    .map((i: any) => ({
      price: typeof i.price === 'string' ? i.price : i.price?.id,
      quantity: i.quantity ?? 1,
    }))
    .filter((i: { price: string }) => i.price !== planPriceId);

  const updated = await stripe.subscriptionSchedules.update(schedule.id, {
    phases: [
      {
        items: currentPhase.items.map((i: any) => ({
          price: i.price,
          quantity: i.quantity ?? 1,
        })),
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date ?? periodEnd,
      },
      {
        items: [{ price: newPriceId, quantity: 1 }, ...carryForwardItems],
      },
    ],
    end_behavior: 'release', // After phase 2, drop back to a plain subscription
  });

  return {
    kind: 'downgrade_scheduled',
    effectiveAt: new Date(periodEnd * 1000).toISOString(),
    subscription: current, // Return current sub — it stays unchanged until period end
    schedule: updated, // Updated schedule (with id) so callers can cache scheduledChange
  };
}

// ─── On-Demand Sync ───────────────────────────────────────────────────

/**
 * Sync subscription status from Stripe for a user who has stripe_customer_id
 * but missing subscription data. Called lazily from /api/auth/me.
 *
 * ADDITIVE-ONLY: Only fills null/undefined fields — never overwrites values
 * that webhooks already wrote to DynamoDB. Webhooks are the source of truth;
 * this function only backfills gaps (e.g., when a webhook was missed).
 *
 * Returns the updated fields or null if nothing needed updating.
 */
export async function syncSubscriptionFromStripe(
  userId: string,
  stripeCustomerId: string
): Promise<{ subscription_status?: string; stripe_subscription_id?: string; subscriptionType?: string; current_period_end?: string; has_payment_method?: boolean; activeOffer?: any } | null> {
  try {
    // 1. Read the current user record to know which fields are already set
    const user = await userDb.getUserById(userId);
    if (!user) {
      console.warn(`[STRIPE SYNC] User ${userId} not found in DB`);
      return null;
    }

    // 2. Fetch subscriptions from Stripe and pick the most relevant one
    //    (active > trialing > past_due > canceled), matching reconcileAllStripeUsers logic.
    const stripe = getStripeOrThrow();
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 10,
      expand: ['data.discounts'],
    });

    if (subscriptions.data.length === 0) {
      return null;
    }

    const statusPriority: Record<string, number> = { active: 0, trialing: 1, past_due: 2, canceled: 3 };
    const sorted = [...subscriptions.data].sort(
      (a, b) => (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99)
    );
    const sub = sorted[0];

    // 3. Check if customer has a payment method on file
    let hasPaymentMethod = !!(sub.default_payment_method || (sub as any).default_source);
    if (!hasPaymentMethod) {
      try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        if (customer && !customer.deleted) {
          const cust = customer as any;
          hasPaymentMethod = !!(cust.default_source || cust.invoice_settings?.default_payment_method);
          if (!hasPaymentMethod) {
            const methods = await stripe.paymentMethods.list({ customer: stripeCustomerId, limit: 1 });
            hasPaymentMethod = methods.data.length > 0;
          }
        }
      } catch {
        // Non-fatal — default to subscription-level check
      }
    }

    // 4. Build Stripe-sourced values
    const stripeValues: Record<string, any> = {
      subscription_status: sub.status,
      stripe_subscription_id: sub.id,
      has_payment_method: hasPaymentMethod,
      current_period_end: getSubscriptionPeriodEndIso(sub),
      activeOffer: extractActiveOffer(sub),
    };

    // Derive tier from price if available.
    //
    // NOTE: still `items.data[0]`, not `findBasePlanItem` — left alone by the
    // seat-billing (ENG-2243..2246) correctness review as low-risk, since a
    // wrong read here just skips an additive-only tier backfill rather than
    // corrupting billing state. Don't copy this pattern elsewhere: see
    // findBasePlanItem's doc comment for why position-based lookup breaks
    // once a seat item can coexist on the same subscription.
    const priceId = sub.items?.data?.[0]?.price?.id;
    if (priceId) {
      const derivedType = deriveSubscriptionTypeFromPriceId(priceId);
      if (derivedType) {
        stripeValues.subscriptionType = derivedType;
      }
    }

    // 5. Additive-only merge for most fields, but always overwrite current_period_end
    // and activeOffer (they must reflect Stripe's truth — stale data is why this sync exists).
    const SYNC_FIELDS = ['subscription_status', 'stripe_subscription_id', 'subscriptionType', 'has_payment_method', 'current_period_end', 'activeOffer'] as const;
    const ALWAYS_OVERWRITE: ReadonlyArray<string> = ['current_period_end', 'activeOffer'];
    const updates: Record<string, any> = {};

    for (const field of SYNC_FIELDS) {
      const dbValue = user[field];
      const stripeValue = stripeValues[field];
      if (stripeValue !== undefined && (ALWAYS_OVERWRITE.includes(field) || dbValue === null || dbValue === undefined)) {
        updates[field] = stripeValue;
      }
    }

    // If subscriptionType is being set, also sync tier config (allowedPages/allowedSkills)
    if (updates.subscriptionType) {
      const tierConfig = await getTierConfig(updates.subscriptionType);
      if (tierConfig) {
        updates.allowedPages = tierConfig.allowedPages;
        updates.allowedSkills = tierConfig.allowedSkills;
      }
    }

    // 6. Only write to DB if there are actual updates
    if (Object.keys(updates).length === 0) {
      console.log(`[STRIPE SYNC] No gaps to fill for user ${userId} — webhook data preserved`);
      return null;
    }

    await userDb.updateUser(userId, updates);
    console.log(`[STRIPE SYNC] Backfilled ${Object.keys(updates).join(', ')} for user ${userId} (additive-only)`);

    return updates;
  } catch (error: any) {
    console.error(`[STRIPE SYNC] Failed for user ${userId}:`, error.message);
    return null;
  }
}

// ─── Webhook Event Handlers ────────────────────────────────────────────

export async function handleLlmUsageTopUpCheckoutCompleted(session: any): Promise<void> {
  const metadata = session?.metadata || {};
  if (metadata.purchaseType !== 'llm_usage_top_up') throw new Error('Invalid usage top-up checkout metadata');
  if (session.payment_status !== 'paid') {
    // Async payment methods are granted by checkout.session.async_payment_succeeded.
    return;
  }
  const billingUserId = String(metadata.billingUserId || '');
  const amountMicroUsd = Number(metadata.usageCreditMicroUsd);
  const minimumMarkupBps = Number(metadata.minimumMarkupBps);
  const paidCents = Number(session.amount_total);
  const topUpGrantId = String(metadata.topUpGrantId || session.id || '');
  if (!billingUserId) throw new Error('billingUserId is required');
  if (!topUpGrantId) throw new Error('topUpGrantId is required');
  if (!Number.isInteger(amountMicroUsd) || amountMicroUsd <= 0) throw new Error('Invalid usage credit amount');
  if (!Number.isInteger(minimumMarkupBps) || minimumMarkupBps < 10_000) throw new Error('Invalid usage top-up markup');
  if (!Number.isInteger(paidCents) || paidCents <= 0) throw new Error('Invalid usage top-up payment amount');
  if (paidCents * 10_000 * 10_000 < amountMicroUsd * minimumMarkupBps) {
    throw new Error('Usage top-up payment is below the configured minimum markup');
  }
  const { grantMonthlyLlmUsageCredit } = await import('./llmUsageCreditService');
  await grantMonthlyLlmUsageCredit({
    billingUserId,
    grantId: `stripe:${topUpGrantId}`,
    source: 'purchase',
    amountMicroUsd,
  });
}

/**
 * Handle checkout.session.completed — link Stripe customer/subscription to user.
 */
export async function handleCheckoutSessionCompleted(session: any): Promise<void> {
  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id;
  const stripeSubscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;

  // Find user by metadata.userId first, then fallback to email
  let user = null;
  if (session.metadata?.userId) {
    user = await userDb.getUserById(session.metadata.userId);
  }
  if (!user && session.customer_details?.email) {
    user = await userDb.getUserByEmail(session.customer_details.email);
  }

  if (!user) {
    console.warn(
      `No user found for checkout session. customer=${stripeCustomerId}, email=${session.customer_details?.email}`
    );
    return;
  }

  // Fetch the subscription FIRST. We need it for status AND for the price
  // ID that drives tier derivation. Stripe webhook events for
  // checkout.session.completed do NOT include line_items by default, so
  // deriving the tier from `session.line_items` would always yield
  // undefined → silently promote every user to the fallback tier.
  let actualStatus = 'active';
  let currentPeriodEnd: string | undefined;
  let subscription: any = null;
  if (stripeSubscriptionId) {
    try {
      const s = getStripeOrThrow();
      subscription = await s.subscriptions.retrieve(stripeSubscriptionId, { expand: ['discounts'] });
      actualStatus = subscription.status; // Could be 'trialing', 'active', etc.
      currentPeriodEnd = getSubscriptionPeriodEndIso(subscription);
    } catch (err) {
      console.warn(`Could not fetch subscription ${stripeSubscriptionId} for status:`, err);
    }
  }

  // Derive subscription tier — prefer subscription.items over session.line_items.
  // Returns null when the price ID is unknown/missing; we refuse to silently
  // promote the user in that case (see deriveSubscriptionType notes).
  const subscriptionType = deriveSubscriptionType(session, subscription);
  const tierConfig = subscriptionType ? await getTierConfig(subscriptionType) : null;

  const updateData: Record<string, any> = {
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    subscription_status: actualStatus,
    has_payment_method: true, // completed checkout = has payment method
    activeOffer: extractActiveOffer(subscription),
    // has_used_trial was used to gate the 14-day trial. Trials were removed
    // (product decision, 2026-04). Existing `true` values in DynamoDB are
    // harmless residue; we just stop writing the flag on new checkouts.
  };
  // Only write tier-related fields when derivation succeeded. Otherwise
  // leave the user's existing tier alone — much better than overwriting
  // them with a wrong one (historically we defaulted to 'Super Premium',
  // silently upgrading every checkout with an unrecognised price).
  if (subscriptionType) {
    updateData.subscriptionType = subscriptionType;
    updateData.allowedPages = tierConfig?.allowedPages ?? [...DEFAULT_PAGES];
    updateData.allowedSkills = tierConfig?.allowedSkills ?? ['*'];
  }
  if (currentPeriodEnd) {
    updateData.current_period_end = currentPeriodEnd;
  }

  await userDb.updateUser(user.userId, updateData);
  syncUserUpdateToLeadList(user.email, {
    subscriptionType: updateData.subscriptionType,
    subscription_status: updateData.subscription_status,
    stripe_customer_id: updateData.stripe_customer_id,
  });

  // Sync companyName/useCaseCategories from custom checkout fields — this
  // used to happen from the public, unauthenticated GET session-lookup
  // route (ENG-1756); moved here since this handler is signature-verified.
  // Awaited (not fire-and-forget): this function already catches its own
  // errors internally, so awaiting only ensures the work completes before
  // the webhook handler returns — it cannot make this handler throw.
  await syncCheckoutProfileFields(session);

  // Cancel any duplicate subscriptions for this customer (keep only the latest)
  if (stripeCustomerId && stripeSubscriptionId) {
    try {
      const canceledCount = await stripeService.cancelDuplicateSubscriptions(
        stripeCustomerId,
        stripeSubscriptionId
      );
      if (canceledCount > 0) {
        console.log(
          `[STRIPE] Canceled ${canceledCount} duplicate subscription(s) for customer ${stripeCustomerId}`
        );
      }
    } catch (dupError: any) {
      console.error(`[STRIPE] Failed to cancel duplicates for ${stripeCustomerId}:`, dupError.message);
    }
  }

  // Record in payment history
  await paymentHistoryDb.record({
    userId: user.userId,
    eventType: 'subscription_created',
    amount: 0,
    currency: "usd",
    status: "created",
    timestamp: new Date().toISOString(),
    stripeSubscriptionId,
    metadata: { sessionId: session.id, status: actualStatus },
  });

  console.log(
    `Checkout completed: user ${user.userId} → stripe_customer_id=${stripeCustomerId}, subscription=${stripeSubscriptionId}, status=${actualStatus}, periodEnd=${currentPeriodEnd || 'unknown'}`
  );
}

/**
 * Handle customer.subscription.updated — sync subscription status.
 *
 * When `options.isNew` is true (called from customer.subscription.created),
 * the stale-subscription guard is bypassed because the event IS the authoritative
 * new subscription — the user's DB may still carry a canceled/old stripe_sub_id
 * and we want to overwrite it. For normal .updated events the guard prevents
 * stale/duplicate webhooks from clobbering the latest state.
 */
export async function handleSubscriptionUpdated(
  subscription: any,
  options: { isNew?: boolean } = {}
): Promise<void> {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`No user found for subscription update. customer=${customerId}`);
    return;
  }

  // Stale-webhook guard: for .updated events, only process when the sub id
  // matches the user's current one. Skip for .created — that event IS the
  // new authoritative subscription and the DB's stripe_subscription_id may
  // still point to an old canceled sub.
  if (
    !options.isNew &&
    user.stripe_subscription_id &&
    user.stripe_subscription_id !== subscription.id
  ) {
    console.log(
      `[STRIPE] Ignoring subscription update for ${subscription.id} — user ${user.userId} has current subscription ${user.stripe_subscription_id}`
    );
    return;
  }

  // When a user has requested cancel-at-period-end, Stripe keeps the raw
  // subscription status as "active" (or "trialing") until the period
  // closes. Expose that intent to the UI as status="canceling" so the
  // customer sees "Canceling" instead of "Active" right after they hit
  // cancel. Without this, the subscription.updated webhook that fires
  // ~2 seconds after /api/stripe/cancel-subscription would overwrite
  // our "canceling" marker with the raw Stripe status.
  const effectiveStatus =
    subscription.cancel_at_period_end &&
    (subscription.status === "active" || subscription.status === "trialing")
      ? "canceling"
      : subscription.status;

  const updateData: Record<string, any> = {
    subscription_status: effectiveStatus,
  };

  // Write stripe_subscription_id when:
  //  - It's a new subscription (created event) — overwrite any stale canceled ID
  //  - It was never written (null) — backfill for missed checkout webhooks
  // For .updated events with an existing sub, don't touch it (the guard above
  // already ensures we only run when subscription.id matches the DB value).
  if (options.isNew || !user.stripe_subscription_id) {
    updateData.stripe_subscription_id = subscription.id;
  }

  // Always sync payment method status — this is a point-in-time fact with no guard dependency
  let hasPaymentMethod = !!(subscription.default_payment_method || subscription.default_source);
  if (!hasPaymentMethod && customerId) {
    try {
      const s = getStripeOrThrow();
      const methods = await s.paymentMethods.list({ customer: customerId, limit: 1 });
      hasPaymentMethod = methods.data.length > 0;
    } catch {
      // Non-fatal — default to subscription-level check
    }
  }
  updateData.has_payment_method = hasPaymentMethod;

  // Sync current_period_end so trial end dates are tracked
  const updatedPeriodEndIso = getSubscriptionPeriodEndIso(subscription);
  if (updatedPeriodEndIso) {
    updateData.current_period_end = updatedPeriodEndIso;
  }

  // Sync plan tier on upgrades/downgrades. Use findBasePlanItem rather than
  // items.data[0] — a subscription can now also carry a seat-billing extra-
  // seat item (ENG-2243..2246), and Stripe doesn't guarantee the originally-
  // subscribed item stays first in `items.data` once a second item exists.
  const basePlanPriceId = subscription.items?.data?.length
    ? findBasePlanItem(subscription)?.price?.id
    : undefined;
  if (basePlanPriceId) {
    const newType = deriveSubscriptionTypeFromPriceId(basePlanPriceId);
    if (newType) {
      updateData.subscriptionType = newType;
      const tierConfig = await getTierConfig(newType);
      if (tierConfig) {
        updateData.allowedPages = tierConfig.allowedPages;
        updateData.allowedSkills = tierConfig.allowedSkills;
      }
    }
  }

  // Always sync activeOffer — set to null when discount is removed. A webhook
  // payload carries Basil `discounts` as ids, so fetch them expanded rather
  // than clear a live offer; if that fetch fails, leave activeOffer as it is
  // (the next invoice or reconcile sync corrects it).
  let offerSource: SubscriptionDiscountSource | null = subscription;
  if (typeof pickSubscriptionDiscount(subscription) === 'string') {
    try {
      offerSource = await getStripeOrThrow().subscriptions.retrieve(subscription.id, { expand: ['discounts'] });
    } catch (err) {
      offerSource = null;
      console.warn(`[STRIPE] Failed to expand discounts of ${subscription.id}; activeOffer left unchanged: ${err}`);
    }
  }
  if (offerSource) {
    updateData.activeOffer = extractActiveOffer(offerSource);
  }

  await userDb.updateUser(user.userId, updateData);
  syncUserUpdateToLeadList(user.email, {
    subscriptionType: updateData.subscriptionType,
    subscription_status: updateData.subscription_status,
  });

  // Seat-based billing (ENG-2243..2246): mirror the extra-seat line item's
  // quantity onto Organization.purchasedExtraSeats when this user is an
  // org's billing owner. This webhook is the ONLY writer of that field —
  // orgSeatBillingService reads Stripe live and never writes the mirror.
  // Idempotent (same quantity in = no-op write) and tolerant of an absent
  // line item (treated as 0 extra seats) or an unconfigured product id
  // (skipped entirely rather than guessing).
  if (user.orgId) {
    try {
      const org = await orgDb.getOrgById(user.orgId, ['orgId', 'ownerUserId', 'purchasedExtraSeats']);
      const productId = process.env.STRIPE_EXTRA_SEAT_PRODUCT_ID;
      if (org && org.ownerUserId === user.userId && productId) {
        const seatItem = findSeatLineItem(subscription, productId);
        const newExtraSeats = seatItem?.quantity ?? 0;
        if (org.purchasedExtraSeats !== newExtraSeats) {
          await orgDb.updateOrg(org.orgId, { purchasedExtraSeats: newExtraSeats });
        }
      }
    } catch (seatSyncError: any) {
      console.error(
        `[STRIPE] Failed to sync extra-seat quantity for user ${user.userId}'s org:`,
        seatSyncError.message
      );
    }
  }

  // Hot lead calls add-on (ENG-2783): same idea for its flat-fee item; see mirrorHotLeadCallBilling.
  await mirrorHotLeadCallBilling(user, subscription);

  console.log(
    `Subscription updated: user ${user.userId} → status=${subscription.status}, has_pm=${hasPaymentMethod}, periodEnd=${updateData.current_period_end || 'unchanged'}, offer=${updateData.activeOffer?.couponId ?? 'none'}`
  );
}

/** Subscription statuses that still bill (mrrCollectionGapService's LIVE_STATUSES). */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

/**
 * Subscription statuses that have ended for good: paying one's (final) invoice
 * does not make the customer active again. `incomplete` / `unpaid` are not
 * here — paying their invoice is what activates them.
 */
const ENDED_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/**
 * The customer's live subscription (discounts expanded), or null. Same pick as
 * reconcileStripeUser / syncSubscriptionFromStripe: active > trialing >
 * past_due, and within a status the newest (Stripe lists newest first; the
 * sort is stable).
 */
async function findLiveCustomerSubscription(s: Stripe, customerId: string): Promise<Stripe.Subscription | null> {
  const subscriptions = await s.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
    expand: ['data.discounts'],
  });
  const statusPriority: Record<string, number> = { active: 0, trialing: 1, past_due: 2 };
  const live = subscriptions.data
    .filter((sub) => LIVE_SUBSCRIPTION_STATUSES.has(sub.status))
    .sort((a, b) => statusPriority[a.status] - statusPriority[b.status]);
  return live[0] ?? null;
}

/**
 * Handle invoice.payment_succeeded — confirm subscription is active and sync payment info.
 */
export async function handleInvoicePaymentSucceeded(invoice: any): Promise<void> {
  // ENG-668: a pay-as-you-go overage invoice is not a subscription payment. It must never write
  // subscription_status / subscription_amount / period fields; settlement records it instead.
  if (invoice?.metadata?.purchaseType === PAYG_OVERAGE_PURCHASE_TYPE) {
    const { handlePaygOverageInvoicePaid } = await import('./paygSettlementService');
    await handlePaygOverageInvoicePaid(invoice);
    return;
  }

  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id;

  if (!customerId) {
    console.warn('[STRIPE] invoice.payment_succeeded missing customer ID');
    return;
  }

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[STRIPE] No user found for invoice.payment_succeeded. customer=${customerId}`);
    return;
  }

  const subscriptionId = invoiceSubscriptionId(invoice);
  const storedSubId: string | null = user.stripe_subscription_id || null;

  const updateData: Record<string, any> = {
    has_payment_method: true,
  };

  // Store the amount paid so it can be displayed in the admin Users tab
  if (typeof invoice.amount_paid === 'number' && invoice.amount_paid > 0) {
    updateData.subscription_amount = invoice.amount_paid;
  }

  // Pick the subscription to sync current_period_end / activeOffer from and,
  // when the row has none, to backfill stripe_subscription_id with:
  //  - A live stored subscription stays authoritative (an older, replaced
  //    sub's final invoice, or a second live sub, cannot overwrite it).
  //  - A non-subscription invoice (one-off, quote, PAYG) syncs the stored sub.
  //  - Otherwise prefer the invoice's own subscription when it is live (a
  //    resubscribe whose invoice.paid beats checkout.session.completed /
  //    customer.subscription.created), else the customer's live subscription.
  //  - With none live, nothing is backfilled; the stored sub (if any) is
  //    synced as before. If the invoice's own sub has ENDED (a redelivered
  //    final invoice of a canceled sub), the user is not flipped to active.
  // stripe_subscription_id is only ever backfilled from a LIVE subscription.
  let syncFrom: Stripe.Subscription | null = null;
  let reactivate = true;
  const primaryId = storedSubId || subscriptionId;
  if (primaryId) {
    try {
      const s = getStripeOrThrow();
      const retrieve = (id: string) => s.subscriptions.retrieve(id, { expand: ['discounts'] });
      const primary = await retrieve(primaryId);
      if (LIVE_SUBSCRIPTION_STATUSES.has(primary.status) || !subscriptionId) {
        syncFrom = primary;
      } else {
        let own: Stripe.Subscription | null = subscriptionId === primaryId ? primary : null;
        if (!own) {
          try {
            own = await retrieve(subscriptionId);
          } catch (err) {
            console.warn(`[STRIPE] Failed to fetch invoice subscription ${subscriptionId}: ${err}`);
          }
        }
        if (own && LIVE_SUBSCRIPTION_STATUSES.has(own.status)) {
          syncFrom = own;
        } else {
          syncFrom = await findLiveCustomerSubscription(s, customerId);
          if (!syncFrom) {
            if (storedSubId) syncFrom = primary;
            if (own && ENDED_SUBSCRIPTION_STATUSES.has(own.status)) reactivate = false;
          }
        }
      }
    } catch (err) {
      console.warn(`[STRIPE] Failed to fetch subscription ${primaryId} for period_end sync: ${err}`);
    }
  }

  if (syncFrom) {
    const invoicePeriodEndIso = getSubscriptionPeriodEndIso(syncFrom);
    if (invoicePeriodEndIso) {
      updateData.current_period_end = invoicePeriodEndIso;
    }
    updateData.activeOffer = extractActiveOffer(syncFrom);
  }

  // Backfill stripe_subscription_id if user doesn't have one yet — only with a live subscription
  if (!storedSubId && syncFrom && LIVE_SUBSCRIPTION_STATUSES.has(syncFrom.status)) {
    updateData.stripe_subscription_id = syncFrom.id;
  }

  if (reactivate) {
    updateData.subscription_status = 'active';
  } else {
    console.log(
      `[STRIPE] Invoice ${invoice.id} paid for ended subscription ${subscriptionId} and customer ${customerId} has no live subscription; user ${user.userId} status left unchanged`
    );
  }

  await userDb.updateUser(user.userId, updateData);
  if (reactivate) {
    syncUserUpdateToLeadList(user.email, { subscription_status: 'active' });
  }

  console.log(
    `[STRIPE] Invoice payment succeeded: user ${user.userId} → status=${reactivate ? 'active' : 'unchanged'}, has_payment_method=true${updateData.stripe_subscription_id ? `, backfilled sub=${updateData.stripe_subscription_id}` : ''}${updateData.subscription_amount ? `, amount=${updateData.subscription_amount}` : ''}${updateData.current_period_end ? `, periodEnd=${updateData.current_period_end}` : ''}`
  );
}

/**
 * Handle customer.subscription.deleted — mark subscription as canceled.
 * Handle customer.subscription.deleted — mark subscription as canceled,
 * BUT only if the customer has no other active/trialing subscription.
 *
 * When a subscription is downgraded by canceling the old sub and creating a new
 * cheaper one, Stripe fires customer.subscription.deleted on the OLD sub.
 * We must check for a remaining active sub before marking the user as canceled.
 */
export async function handleSubscriptionDeleted(subscription: any): Promise<void> {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`No user found for subscription deletion. customer=${customerId}`);
    return;
  }

  // Check if the customer still has another active or trialing subscription.
  // This happens during downgrades: old sub is canceled, new (cheaper) sub is created.
  if (customerId) {
    try {
      const s = getStripeOrThrow();
      for (const status of ['active', 'trialing'] as const) {
        const remaining = await s.subscriptions.list({
          customer: customerId,
          status,
          limit: 1,
        });
        if (remaining.data.length > 0) {
          const activeSub = remaining.data[0];
          console.log(
            `[STRIPE] Subscription ${subscription.id} deleted, but customer ${customerId} still has ${status} subscription ${activeSub.id} — treating as downgrade, not cancellation`
          );

          // Sync the user to the remaining active subscription instead of canceling
          const updateData: Record<string, any> = {
            subscription_status: activeSub.status,
            stripe_subscription_id: activeSub.id,
          };

          // Derive tier from the remaining subscription's price.
          //
          // NOTE: still `items.data[0]`, not `findBasePlanItem` — left alone
          // by the seat-billing (ENG-2243..2246) correctness review as
          // low-risk: this only sets subscriptionType/allowedPages, and a
          // seat item sorting first here would just skip that sync rather
          // than corrupt billing state. See findBasePlanItem's doc comment
          // for why position-based lookup is otherwise unsafe once a seat
          // item can coexist on the same subscription.
          const priceId = activeSub.items?.data?.[0]?.price?.id;
          if (priceId) {
            const newType = deriveSubscriptionTypeFromPriceId(priceId);
            if (newType) {
              updateData.subscriptionType = newType;
              const tierConfig = await getTierConfig(newType);
              if (tierConfig) {
                updateData.allowedPages = tierConfig.allowedPages;
                updateData.allowedSkills = tierConfig.allowedSkills;
              }
            }
          }

          // Sync period end
          const activeSubPeriodEndIso = getSubscriptionPeriodEndIso(activeSub);
          if (activeSubPeriodEndIso) {
            updateData.current_period_end = activeSubPeriodEndIso;
          }

          await userDb.updateUser(user.userId, updateData);
          syncUserUpdateToLeadList(user.email, {
            subscriptionType: updateData.subscriptionType,
            subscription_status: updateData.subscription_status,
          });
          console.log(
            `Subscription downgrade: user ${user.userId} → synced to ${activeSub.id} (status=${activeSub.status})`
          );
          return;
        }
      }
    } catch (err: any) {
      console.error(`[STRIPE] Error checking remaining subscriptions for ${customerId}:`, err.message);
      // Fall through to cancel — safer to cancel than to leave in a stale state
    }
  }

  // No remaining active/trialing subscriptions — this is a genuine cancellation
  const freeTierConfig = await getTierConfig('Free');

  await userDb.updateUser(user.userId, {
    subscription_status: 'canceled',
    subscriptionType: 'Free',
    allowedPages: freeTierConfig?.allowedPages ?? [...DEFAULT_PAGES],
    allowedSkills: freeTierConfig?.allowedSkills ?? [],
  });
  syncUserUpdateToLeadList(user.email, { subscription_status: 'canceled', subscriptionType: 'Free' });

  // Record in payment history
  await paymentHistoryDb.record({
    userId: user.userId,
    timestamp: new Date().toISOString(),
    eventType: 'subscription_canceled',
    amount: 0,
    currency: 'usd',
    status: 'canceled',
    stripeSubscriptionId: subscription.id,
  });

  // A deleted subscription takes its add-on item with it (the payload still lists the item, with status 'canceled').
  await mirrorHotLeadCallBilling(user, subscription);

  console.log(`Subscription deleted: user ${user.userId} → downgraded to Free tier`);
}

// ─── invoice.payment_succeeded ──────────────────────────────────────────

/**
 * Handle invoice.payment_succeeded webhook event.
 * Confirms payment went through: sets status to active, backfills
 * stripe_subscription_id if missing, and sets has_payment_method.

/**
 * Handle invoice.payment_failed — mark subscription as past_due and record the failure.
 */

/**
 * Handle invoice.payment_failed — mark subscription as past_due and record the failure.
 */
export async function handleInvoicePaymentFailed(invoice: any): Promise<void> {
  // ENG-668: a failed overage charge suspends pay-as-you-go; it does not make the SUBSCRIPTION past_due.
  if (invoice?.metadata?.purchaseType === PAYG_OVERAGE_PURCHASE_TYPE) {
    const { handlePaygOverageInvoicePaymentFailed } = await import('./paygSettlementService');
    await handlePaygOverageInvoicePaymentFailed(invoice);
    return;
  }

  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id;

  if (!customerId) {
    console.warn('[STRIPE] invoice.payment_failed missing customer ID');
    return;
  }

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[STRIPE] No user found for invoice.payment_failed. customer=${customerId}`);
    return;
  }

  const subscriptionId = invoiceSubscriptionId(invoice);

  await userDb.updateUser(user.userId, {
    subscription_status: 'past_due',
  });
  syncUserUpdateToLeadList(user.email, { subscription_status: 'past_due' });

  // Record in payment history
  await paymentHistoryDb.record({
    userId: user.userId,
    timestamp: new Date().toISOString(),
    eventType: 'payment_failed',
    amount: invoice.amount_due || 0,
    currency: invoice.currency || 'usd',
    status: 'failed',
    stripeSubscriptionId: subscriptionId || undefined,
    stripeInvoiceId: invoice.id,
    metadata: {
      attemptCount: invoice.attempt_count,
      nextPaymentAttempt: invoice.next_payment_attempt,
    },
  });

  console.log(
    `[STRIPE] Invoice payment failed: user ${user.userId} → status=past_due, invoice=${invoice.id}`
  );
}

/**
 * ENG-668 PR-2: the overage invoice behind a refunded or disputed charge. Recognising an overage charge
 * costs a Stripe call per non-top-up charge that has a PaymentIntent.
 *   - Disputes (`raise`) are looked up whether or not settlement is switched on: the switch stops NEW
 *     charges, but a chargeback on an overage invoice already collected must still hold PAYG, and its
 *     closing must still lift (or keep) that hold. For any other charge the outcome is unchanged; a failed
 *     lookup raises, so the webhook answers 500 and Stripe redelivers — acknowledging a chargeback on an
 *     overage charge unrecognised would drop it for good.
 *   - Refunds (`alert`) are looked up only while settlement is on (`requireSwitch`), so with it off the
 *     refund webhook is exactly as before and makes no extra call. When the lookup fails, the refund is
 *     handled as before (it is recorded either way) and on-call is told it could not be checked.
 */
async function findPaygOverageInvoiceForChargeEvent(
  charge: PaygChargeRef,
  event: string,
  onLookupFailure: 'raise' | 'alert',
): Promise<Stripe.Invoice | null> {
  // Only an invoice charge has a PaymentIntent to look up; anything else is never an overage charge.
  if (!charge?.payment_intent) return null;
  if (onLookupFailure === 'alert') {
    const { paygSettlementSwitch } = await import('./paygOverageService');
    if (!(await paygSettlementSwitch.isEnabled())) return null;
  }
  try {
    return await stripeService.findPaygOverageInvoiceForCharge(charge);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (onLookupFailure === 'raise') {
      throw new Error(`${event}: could not check whether charge ${charge?.id} paid a pay-as-you-go invoice (${message}); retry`);
    }
    console.error(`[STRIPE] ${event}: could not check whether charge ${charge?.id} paid a pay-as-you-go invoice; handling it as before:`, message);
    try {
      const { emailService } = await import('./emailService');
      await emailService.sendOncallAlert(
        `PAYG settlement: ${event} for charge ${charge?.id} could not be checked`,
        `Stripe's invoice lookup failed (${message}), so ${event} for charge ${charge?.id} was handled as a `
          + 'non-overage charge. If it paid a pay-as-you-go overage invoice, record it on that month\'s settlement by hand.',
        { 'Alert Class': 'payg-settlement-lookup', chargeId: charge?.id ?? null, event },
      );
    } catch (alertError: unknown) {
      console.error(`[STRIPE] ${event}: on-call alert failed:`, alertError instanceof Error ? alertError.message : alertError);
    }
    return null;
  }
}

/**
 * ENG-668: `invoice.voided`, `invoice.marked_uncollectible` and `invoice.payment_action_required` matter
 * here only for a pay-as-you-go overage invoice (a subscription's are left to Stripe as before): each is
 * handed to settlement, anything else is logged and acknowledged.
 */
export async function handleInvoiceVoided(invoice: Stripe.Invoice): Promise<void> {
  if (invoice?.metadata?.purchaseType !== PAYG_OVERAGE_PURCHASE_TYPE) return;
  const { handlePaygOverageInvoiceVoided } = await import('./paygSettlementService');
  await handlePaygOverageInvoiceVoided(invoice);
}

export async function handleInvoiceMarkedUncollectible(invoice: Stripe.Invoice): Promise<void> {
  if (invoice?.metadata?.purchaseType !== PAYG_OVERAGE_PURCHASE_TYPE) return;
  const { handlePaygOverageInvoiceMarkedUncollectible } = await import('./paygSettlementService');
  await handlePaygOverageInvoiceMarkedUncollectible(invoice);
}

export async function handleInvoicePaymentActionRequired(invoice: Stripe.Invoice): Promise<void> {
  if (invoice?.metadata?.purchaseType !== PAYG_OVERAGE_PURCHASE_TYPE) return;
  const { handlePaygOverageInvoicePaymentActionRequired } = await import('./paygSettlementService');
  await handlePaygOverageInvoicePaymentActionRequired(invoice);
}

/**
 * ENG-668 PR-2: `setup_intent.succeeded` — a customer saved a payment method. Settlement pins a card on
 * an overage invoice (`default_payment_method`) only when the customer has no invoice default — which is
 * every customer who saved a card through the setup-mode Checkout (ENG-2571 / ENG-2303), since that flow
 * sets none. An invoice's own payment method overrides the customer's for every automatic retry (Stripe:
 * "If not set, defaults to ... the default payment method in the customer's invoice settings"), so after
 * the owner saves a new card, Stripe would keep retrying the old one. Each OPEN overage invoice of this
 * customer that is pinned to another method is therefore pointed at the one just saved (an open invoice's
 * `default_payment_method` stays editable after finalizing), and Stripe's next attempt charges it.
 *
 *   - Only to the customer's NEWEST attached card: events are not ordered, so a SetupIntent for an older
 *     card that arrives late never moves the invoice back to it (and a detached or non-card method is
 *     never used).
 *   - Finding the invoices: a SetupIntent tagged with the user (Zoma's Checkout) reads that user's row
 *     (the indexed read); an untagged one asks Stripe for the customer's open invoices (one list call;
 *     AW-Users has no index on `stripe_customer_id`, and a scan per saved card is not acceptable). Either
 *     way an invoice is touched only if its owner's settlement record still names it, unpaid.
 *   - Stripe refusing one update (the card was detached meanwhile) is logged, the other invoices are
 *     still re-pointed, and on-call is told once; the webhook is acknowledged.
 *
 * Nothing else changes: no subscription, checkout or customer field is touched. A failed lookup before any
 * open overage invoice is known is logged and the event acknowledged, as before this handler existed.
 * Requires `setup_intent.succeeded` on the webhook endpoint.
 */
export async function handleSetupIntentSucceeded(setupIntent: Pick<Stripe.SetupIntent, 'id' | 'customer' | 'payment_method' | 'metadata'>): Promise<void> {
  const customerId = typeof setupIntent?.customer === 'string' ? setupIntent.customer : setupIntent?.customer?.id;
  const paymentMethodId = typeof setupIntent?.payment_method === 'string' ? setupIntent.payment_method : setupIntent?.payment_method?.id;
  if (!customerId || !paymentMethodId) return;
  const s = getStripeOrThrow();
  type SettlementRow = { userId?: string; paygSettlements?: Record<string, { status?: string; invoiceId?: string }> };
  const unpaid = (row: SettlementRow | null | undefined, month: string | undefined, invoiceId: string) => {
    const record = month ? row?.paygSettlements?.[month] : undefined;
    return !!record && record.invoiceId === invoiceId && (record.status === 'invoiced' || record.status === 'failed');
  };

  // Discovery: which of this customer's invoices could be open overage invoices. A failure here is
  // logged and the event acknowledged (most saved cards have nothing to do with PAYG).
  let taggedUser: SettlementRow | null = null;
  let listed: Stripe.Invoice[] = [];
  const taggedUserId = String(setupIntent?.metadata?.userId || '');
  try {
    if (taggedUserId) taggedUser = (await userDb.getUserById(taggedUserId)) as SettlementRow | null;
    else listed = (await s.invoices.list({ customer: customerId, status: 'open', limit: 100 })).data
      .filter((invoice) => invoice.metadata?.purchaseType === PAYG_OVERAGE_PURCHASE_TYPE);
  } catch (error: unknown) {
    console.error(`[STRIPE] setup_intent.succeeded ${setupIntent?.id}: could not look up open overage invoices; none re-pointed:`,
      error instanceof Error ? error.message : error);
    return;
  }
  // From here an open overage invoice is known: a Stripe or row-read error fails the webhook so Stripe
  // redelivers (the update itself never does — see below).
  const invoices: Stripe.Invoice[] = [];
  if (taggedUserId) {
    for (const [month, record] of Object.entries(taggedUser?.paygSettlements ?? {})) {
      if (typeof record?.invoiceId !== 'string' || !unpaid(taggedUser, month, record.invoiceId)) continue;
      const invoice = await retrieveInvoiceIfExists(s, record.invoiceId);
      if (invoice && invoice.metadata?.billingUserId === taggedUser?.userId) invoices.push(invoice);
    }
  } else {
    for (const invoice of listed) {
      const owner = (await userDb.getUserById(String(invoice.metadata?.billingUserId || ''))) as SettlementRow | null;
      if (unpaid(owner, invoice.metadata?.month, invoice.id!)) invoices.push(invoice);
    }
  }
  const pinnedElsewhere = invoices.filter((invoice) => {
    const invoiceCustomer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const pinned = typeof invoice.default_payment_method === 'string' ? invoice.default_payment_method : invoice.default_payment_method?.id;
    // Only a pin settlement set, on this customer's open overage invoice, to another method. An unpinned
    // invoice already follows the customer's own default.
    return invoice.status === 'open' && invoice.metadata?.purchaseType === PAYG_OVERAGE_PURCHASE_TYPE
      && invoiceCustomer === customerId && !!pinned && pinned !== paymentMethodId;
  });
  if (!pinnedElsewhere.length) return;

  // The newest card attached to the customer, so out-of-order events can only ever move forward.
  const cards = (await s.paymentMethods.list({ customer: customerId, type: 'card', limit: 100 })).data;
  const newest = [...cards].sort((a, b) => b.created - a.created)[0];
  if (newest?.id !== paymentMethodId) {
    console.log(`[STRIPE] setup_intent.succeeded ${setupIntent?.id}: ${paymentMethodId} is not ${customerId}'s newest attached card (${newest?.id ?? 'none'}); no overage invoice re-pointed`);
    return;
  }
  const refused: Array<{ invoiceId: string; error: string }> = [];
  for (const invoice of pinnedElsewhere) {
    try {
      await s.invoices.update(invoice.id!, { default_payment_method: paymentMethodId }, { idempotencyKey: `payg-repoint:${invoice.id}:${paymentMethodId}` });
      console.log(`[STRIPE] overage invoice ${invoice.id} (${invoice.metadata?.billingUserId}) now charges the newly saved ${paymentMethodId}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[STRIPE] re-pointing overage invoice ${invoice.id} to ${paymentMethodId} was refused:`, message);
      refused.push({ invoiceId: invoice.id!, error: message });
    }
  }
  if (refused.length) {
    try {
      const { emailService } = await import('./emailService');
      await emailService.sendOncallAlert(
        `PAYG: ${refused.length} overage invoice(s) could not be moved to a newly saved card`,
        `Customer ${customerId} saved ${paymentMethodId}, but Stripe refused to make it the payment method of `
          + `${refused.map((r) => r.invoiceId).join(', ')}. Stripe keeps retrying the card pinned on those invoices; the `
          + 'owner can still pay each on its hosted page. Check the card in Stripe and set the invoice\'s payment method by hand if needed.',
        { 'Alert Class': 'payg-settlement-repoint', customerId, paymentMethodId, refused },
      );
    } catch (alertError: unknown) {
      console.error('[STRIPE] re-point on-call alert failed:', alertError instanceof Error ? alertError.message : alertError);
    }
  }
}

/**
 * Handle charge.refunded — record the refund in payment history.
 */
export async function handleChargeRefunded(charge: any): Promise<void> {
  const metadata = charge.metadata || {};
  // ENG-668: a refunded pay-as-you-go overage charge is recorded against its settlement only. It never
  // lifts a suspension (refunding an overage is not a reason to resume billing it).
  if (metadata.purchaseType !== 'llm_usage_top_up') {
    const overageInvoice = await findPaygOverageInvoiceForChargeEvent(charge, 'charge.refunded', 'alert');
    if (overageInvoice) {
      const { handlePaygOverageChargeRefunded } = await import('./paygSettlementService');
      await handlePaygOverageChargeRefunded(charge, overageInvoice);
      return;
    }
  }
  const customerId = typeof charge.customer === 'string'
    ? charge.customer
    : charge.customer?.id;

  if (!customerId) {
    console.warn('[STRIPE] charge.refunded missing customer ID');
    return;
  }

  const metadataBillingUserId = String(metadata.billingUserId || '');
  const user = metadata.purchaseType === 'llm_usage_top_up' && metadataBillingUserId
    ? await userDb.getUserById(metadataBillingUserId)
    : await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[STRIPE] No user found for charge.refunded. customer=${customerId}`);
    return;
  }

  if (metadata.purchaseType === 'llm_usage_top_up') {
    const amountPaidCents = Number(charge.amount);
    const amountRefundedCents = Number(charge.amount_refunded);
    const purchasedMicroUsd = Number(metadata.usageCreditMicroUsd);
    const topUpGrantId = String(metadata.topUpGrantId || '');
    const billingUserId = user.userId;
    if (
      !topUpGrantId ||
      !Number.isInteger(amountPaidCents) || amountPaidCents <= 0 ||
      !Number.isInteger(amountRefundedCents) || amountRefundedCents < 0 ||
      !Number.isInteger(purchasedMicroUsd) || purchasedMicroUsd <= 0
    ) {
      throw new Error(`Invalid usage top-up refund metadata for charge ${charge.id}`);
    }
    const targetReversedMicroUsd = charge.refunded
      ? purchasedMicroUsd
      : Math.min(
          purchasedMicroUsd,
          Math.round((purchasedMicroUsd * amountRefundedCents) / amountPaidCents),
        );
    const { reverseMonthlyPurchasedLlmUsageCredit } = await import('./llmUsageCreditService');
    await reverseMonthlyPurchasedLlmUsageCredit({
      billingUserId,
      grantId: `stripe:${topUpGrantId}`,
      reversalId: `charge:${charge.id}:refunded:${amountRefundedCents}`,
      targetReversedMicroUsd,
    });
  }

  // Record in payment history
  await paymentHistoryDb.record({
    userId: user.userId,
    timestamp: new Date().toISOString(),
    eventType: 'refund',
    amount: charge.amount_refunded || 0,
    currency: charge.currency || 'usd',
    status: 'refunded',
    metadata: {
      chargeId: charge.id,
      refundReason: charge.refunds?.data?.[0]?.reason,
      fullRefund: charge.refunded,
    },
  });

  console.log(
    `[STRIPE] Charge refunded: user ${user.userId}, charge=${charge.id}, amount_refunded=${charge.amount_refunded}`
  );
}

/**
 * Resolve the charge behind a dispute. Stripe's dispute payloads carry only the
 * charge *id*, while the credit-purchase metadata we need (billing user, grant
 * id, purchased capacity) lives on the charge itself, so it has to be fetched.
 */
async function retrieveDisputedCharge(dispute: any): Promise<any | null> {
  const chargeId = typeof dispute.charge === 'string'
    ? dispute.charge
    : dispute.charge?.id;
  if (!chargeId) {
    console.warn(`[STRIPE] dispute ${dispute.id} carries no charge reference`);
    return null;
  }
  return getStripeOrThrow().charges.retrieve(chargeId);
}

/**
 * Handle charge.dispute.created — revoke purchased AgentWeb Credits capacity.
 *
 * The revocation happens when the dispute *opens*, not when it resolves: the
 * funds are already at risk, and a dispute that runs its course would otherwise
 * leave the customer spending against capacity they have reclaimed the money
 * for. `reverseMonthlyPurchasedLlmUsageCredit` targets a cumulative reversal
 * total, so redelivery of this webhook — or a refund that lands on the same
 * grant — settles at the same figure instead of stacking.
 */
export async function handleChargeDisputeCreated(dispute: any): Promise<void> {
  const charge = await retrieveDisputedCharge(dispute);
  if (!charge) return;

  const metadata = charge.metadata || {};
  if (metadata.purchaseType !== 'llm_usage_top_up') {
    // ENG-668: a chargeback on a pay-as-you-go overage charge suspends pay-as-you-go.
    const overageInvoice = await findPaygOverageInvoiceForChargeEvent(charge, 'charge.dispute.created', 'raise');
    if (overageInvoice) {
      const { handlePaygOverageChargeDisputed } = await import('./paygSettlementService');
      await handlePaygOverageChargeDisputed(dispute, charge, overageInvoice);
      return;
    }
    console.log(
      `[STRIPE] Dispute ${dispute.id} is not an AgentWeb Credits purchase; no capacity to revoke`
    );
    return;
  }

  const billingUserId = String(metadata.billingUserId || '');
  const user = billingUserId ? await userDb.getUserById(billingUserId) : null;
  if (!user) {
    console.warn(
      `[STRIPE] No user found for disputed credit purchase. dispute=${dispute.id} billingUserId=${billingUserId}`
    );
    return;
  }

  const amountPaidCents = Number(charge.amount);
  const amountDisputedCents = Number(dispute.amount);
  const purchasedMicroUsd = Number(metadata.usageCreditMicroUsd);
  const topUpGrantId = String(metadata.topUpGrantId || '');
  if (
    !topUpGrantId ||
    !Number.isInteger(amountPaidCents) || amountPaidCents <= 0 ||
    !Number.isInteger(amountDisputedCents) || amountDisputedCents <= 0 ||
    !Number.isInteger(purchasedMicroUsd) || purchasedMicroUsd <= 0
  ) {
    throw new Error(`Invalid usage top-up dispute metadata for dispute ${dispute.id}`);
  }

  const targetReversedMicroUsd = Math.min(
    purchasedMicroUsd,
    Math.round((purchasedMicroUsd * amountDisputedCents) / amountPaidCents),
  );
  const { reverseMonthlyPurchasedLlmUsageCredit } = await import('./llmUsageCreditService');
  const reversalResult = await reverseMonthlyPurchasedLlmUsageCredit({
    billingUserId: user.userId,
    grantId: `stripe:${topUpGrantId}`,
    reversalId: `dispute:${dispute.id}:${amountDisputedCents}`,
    targetReversedMicroUsd,
  });

  // Reversal can no-op when the original grant is not on the current-month
  // ledger (credits are month-scoped and expire at reset, so a past-month
  // grant has nothing left to revoke). Retrying does not help — the semantic
  // condition will persist — so record the *true* outcome in the audit trail
  // and return success. A later run of the reaper picks these up if we ever
  // want to compensate customers whose disputed spend crossed months.
  const revokedMicroUsd = reversalResult.reversed ? targetReversedMicroUsd : 0;
  const reversalOutcome = reversalResult.reversed
    ? 'revoked'
    : 'no_current_month_grant';

  // Atomic idempotency via dedupKey: paymentHistoryDb writes the main row +
  // a marker on the sentinel dedup partition in a single TransactWriteItems.
  // A concurrent redelivery races on ConditionalCheckFailed on the marker
  // and no-ops — no bounded lookback window to slip past. Reversal is
  // already idempotent via its own reversalId key.
  const result = await paymentHistoryDb.record(
    {
      userId: user.userId,
      timestamp: new Date().toISOString(),
      eventType: 'dispute_opened',
      amount: amountDisputedCents,
      currency: dispute.currency || charge.currency || 'usd',
      status: reversalOutcome === 'revoked' ? 'disputed' : 'disputed_no_action',
      metadata: {
        chargeId: charge.id,
        disputeId: dispute.id,
        disputeReason: dispute.reason,
        revokedMicroUsd,
        reversalOutcome,
      },
    },
    { dedupKey: `dispute:opened:${dispute.id}` },
  );
  if (!result.written) {
    console.log(`[STRIPE] dispute_opened for ${dispute.id} already recorded — skipped duplicate history`);
    return;
  }

  console.log(
    `[STRIPE] Credit purchase disputed: user ${user.userId}, dispute=${dispute.id}, revoked=${revokedMicroUsd} microUSD (${reversalOutcome})`
  );
}

/**
 * Handle charge.dispute.closed — record the outcome only.
 *
 * Winning a dispute deliberately does NOT auto-restore the revoked capacity.
 * Credits are scoped to a usage month and expire at reset, while disputes
 * routinely resolve in a later month; re-granting then would deposit a second
 * month of capacity for a single payment, and there is no way to tell from the
 * ledger whether the original capacity was already spent. Restoring a won
 * dispute is therefore an admin one-time-credit decision, made against the
 * audit trail this record leaves behind.
 */
export async function handleChargeDisputeClosed(dispute: any): Promise<void> {
  const charge = await retrieveDisputedCharge(dispute);
  if (!charge) return;

  const metadata = charge.metadata || {};
  if (metadata.purchaseType !== 'llm_usage_top_up') {
    // ENG-668: a closed dispute on a pay-as-you-go overage charge — won lifts its hold, lost writes the
    // month off — whether or not settlement is switched on. A failed lookup errors the webhook so Stripe
    // redelivers (as for the dispute opening).
    const overageInvoice = await findPaygOverageInvoiceForChargeEvent(charge, 'charge.dispute.closed', 'raise');
    if (overageInvoice) {
      const { handlePaygOverageChargeDisputeClosed } = await import('./paygSettlementService');
      await handlePaygOverageChargeDisputeClosed(dispute, charge, overageInvoice);
    }
    return;
  }

  const billingUserId = String(metadata.billingUserId || '');
  const user = billingUserId ? await userDb.getUserById(billingUserId) : null;
  if (!user) {
    console.warn(
      `[STRIPE] No user found for closed credit dispute. dispute=${dispute.id} billingUserId=${billingUserId}`
    );
    return;
  }

  // Atomic idempotency via dedupKey (see handleChargeDisputeCreated for the
  // same rationale — TransactWriteItems marker on the sentinel dedup
  // partition, no bounded lookback to slip past).
  const result = await paymentHistoryDb.record(
    {
      userId: user.userId,
      timestamp: new Date().toISOString(),
      eventType: 'dispute_closed',
      amount: Number(dispute.amount) || 0,
      currency: dispute.currency || charge.currency || 'usd',
      status: dispute.status || 'closed',
      metadata: {
        chargeId: charge.id,
        disputeId: dispute.id,
        disputeStatus: dispute.status,
      },
    },
    { dedupKey: `dispute:closed:${dispute.id}` },
  );
  if (!result.written) {
    console.log(`[STRIPE] dispute_closed for ${dispute.id} already recorded — skipped duplicate history`);
    return;
  }

  console.log(
    `[STRIPE] Credit dispute closed as "${dispute.status}": user ${user.userId}, dispute=${dispute.id}. ` +
      'Revoked capacity is not auto-restored; issue an admin one-time credit if the customer should be made whole.'
  );
}

/**
 * Handle subscription_schedule lifecycle termination. Clears any cached
 * scheduledChange on the user record regardless of which terminal state the
 * schedule hit: `completed` (phase 2 fired), `released` (user canceled the
 * queued change or the schedule's end_behavior=release executed), or
 * `canceled` (the whole schedule was torn down).
 *
 * Note: `.completed` means phase 2 fired successfully → a parallel
 * `customer.subscription.updated` webhook will sync the new tier to DB. We
 * only clear the scheduled-change hint here so the UI stops advertising a
 * pending change that has already happened.
 *
 * Only clears if the schedule ID on the user matches the one in the event —
 * prevents a stale / out-of-order webhook from clobbering a newer scheduled
 * change the user queued right after.
 */
export async function handleSubscriptionScheduleEnded(schedule: any): Promise<void> {
  const customerId = typeof schedule.customer === 'string'
    ? schedule.customer
    : schedule.customer?.id;
  if (!customerId) {
    console.warn('[STRIPE] subscription_schedule event missing customer ID');
    return;
  }

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[STRIPE] No user found for subscription_schedule event. customer=${customerId}`);
    return;
  }

  if (user.scheduledChange?.stripeScheduleId === schedule.id) {
    await userDb.updateUser(user.userId, { scheduledChange: null });
    console.log(
      `[STRIPE] Cleared scheduledChange for user ${user.userId} — schedule ${schedule.id} ended (${schedule.status})`
    );
  } else {
    console.log(
      `[STRIPE] Schedule ${schedule.id} ended (${schedule.status}) but user ${user.userId} has ${user.scheduledChange?.stripeScheduleId || 'no'} cached — no-op`
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** The part of a subscription (any API version) the activeOffer reads. */
interface SubscriptionDiscountSource {
  discounts?: Array<string | Stripe.Discount> | null;
  /** Pre-Basil location. */
  discount?: Stripe.Discount | null;
}

/**
 * The subscription discount an activeOffer describes.
 *
 * Basil (2025-03-31+) removed `subscription.discount`; a subscription carries
 * `discounts: Array<string | Stripe.Discount>`, ids unless expanded with
 * `expand: ['discounts']` (list: `data.discounts`). A Basil Discount embeds its
 * `coupon` (not expandable, no `source` wrapper in this version).
 *
 * When several discounts apply, the first listed entry of `discounts` is used,
 * so the pick is deterministic (Stripe does not document the list order as the
 * order discounts are applied). The legacy `discount` (pre-Basil webhook payloads) is the
 * fallback when that entry is not expanded. Returns the discount's id when it
 * is not expanded and no legacy discount is present (the caller must fetch).
 */
function pickSubscriptionDiscount(
  subscription: SubscriptionDiscountSource | null | undefined
): Stripe.Discount | string | null {
  const first = Array.isArray(subscription?.discounts) ? subscription.discounts[0] : undefined;
  if (first && typeof first === 'object' && first.coupon) return first;
  const legacy = subscription?.discount;
  if (legacy && typeof legacy === 'object' && legacy.coupon) return legacy;
  return typeof first === 'string' && first ? first : null;
}

/**
 * Extract activeOffer from a Stripe subscription's discount (see
 * pickSubscriptionDiscount). Returns null when there is no discount, the
 * discount has no coupon, or it is an unexpanded id.
 */
function extractActiveOffer(subscription: any): {
  couponId: string;
  couponName: string | null;
  percentOff: number | null;
  amountOff: number | null;
  duration: 'forever' | 'once' | 'repeating';
  durationInMonths: number | null;
  endsAt: string | null;
} | null {
  const discount = pickSubscriptionDiscount(subscription);
  if (!discount || typeof discount === 'string') return null;
  const coupon = discount.coupon;
  return {
    couponId: coupon.id,
    couponName: coupon.name ?? null,
    percentOff: typeof coupon.percent_off === 'number' ? coupon.percent_off : null,
    amountOff: typeof coupon.amount_off === 'number' ? coupon.amount_off : null,
    duration: coupon.duration ?? 'once',
    durationInMonths: typeof coupon.duration_in_months === 'number' ? coupon.duration_in_months : null,
    endsAt: typeof discount.end === 'number' ? new Date(discount.end * 1000).toISOString() : null,
  };
}

/**
 * Derive the subscription type from the checkout session's line items price ID.
 * Maps: Starter plan → "Starter" tier, Pro/Complete plan → "Pro" tier.
 * Super Premium is an internal-only tier and is never assigned via paid
 * checkout — unknown prices now return null (caller should preserve
 * existing tier) rather than silently promoting the user.
 */
export function deriveSubscriptionTypeFromPriceId(priceId: string): string | null {
  if (priceId === process.env.STRIPE_STARTER_PRICE_ID) return 'Starter';
  if (priceId === process.env.STRIPE_COMPLETE_PRICE_ID) return 'Pro';
  return null;
}

function deriveSubscriptionType(session: any, subscription?: any): string | null {
  // Stripe webhook events for checkout.session.completed do NOT expand
  // line_items by default, so session.line_items is typically undefined
  // inside a webhook handler. Prefer subscription.items (which the caller
  // fetches explicitly) and fall back to session.line_items only when a
  // caller happens to have expanded them (e.g. an admin-invoked flow that
  // retrieves the session with { expand: ['line_items'] }).
  //
  // NOTE: still `items.data[0]`, not `findBasePlanItem` — left alone by the
  // seat-billing (ENG-2243..2246) correctness review as low-risk: a
  // freshly-completed checkout session's subscription is brand new and
  // can't yet carry a seat line item (that's only added later, via
  // purchaseExtraSeat), so there's nothing for items.data[0] to collide
  // with here. Don't copy this pattern elsewhere a subscription's items can
  // have grown since creation — see findBasePlanItem's doc comment.
  const priceId = subscription?.items?.data?.[0]?.price?.id
    || session.line_items?.data?.[0]?.price?.id
    || session.display_items?.[0]?.price?.id;

  if (!priceId) {
    console.error(
      `[STRIPE] No priceId in checkout session ${session.id} or subscription — cannot derive tier. Skipping tier update.`
    );
    return null;
  }
  if (priceId === process.env.STRIPE_STARTER_PRICE_ID) return 'Starter';
  if (priceId === process.env.STRIPE_COMPLETE_PRICE_ID) return 'Pro';

  // Unknown price: do NOT silently default. Previously this path returned
  // 'Super Premium', which meant every checkout with a price the backend
  // didn't recognise (misconfigured env var, new price in Stripe, stale
  // dev config) got a free upgrade to the top tier. Return null so the
  // handler keeps the user's existing tier untouched and we get a loud log.
  const starterHint = process.env.STRIPE_STARTER_PRICE_ID
    ? `…${process.env.STRIPE_STARTER_PRICE_ID.slice(-10)}`
    : '(unset)';
  const completeHint = process.env.STRIPE_COMPLETE_PRICE_ID
    ? `…${process.env.STRIPE_COMPLETE_PRICE_ID.slice(-10)}`
    : '(unset)';
  console.error(
    `[STRIPE] Unknown priceId '${priceId}' in session ${session.id}. Expected STARTER=${starterHint} or COMPLETE=${completeHint}. Not writing subscriptionType.`
  );
  return null;
}

/**
 * Find a user by their stripe_customer_id.
 * Uses a filtered DynamoDB scan (server-side filter, no GSI required).
 * Consider adding a GSI on stripe_customer_id if user count grows past ~1000.
 */
export async function findUserByStripeCustomerId(stripeCustomerId: string): Promise<any | null> {
  if (!stripeCustomerId) return null;

  try {
    const result = await userDb.scanWithFilter(
      'stripe_customer_id = :cid',
      { ':cid': stripeCustomerId },
    );
    return result[0] || null;
  } catch (error) {
    console.error('Error finding user by stripe_customer_id:', error);
    return null;
  }
}

// ─── Reconciliation ──────────────────────────────────────────────────

/**
 * Reconcile a single user's DynamoDB record against their live Stripe state.
 *
 * AUTHORITATIVE — Stripe wins. Unlike syncSubscriptionFromStripe() (which is
 * additive-only and used by the /auth/me lazy login sync), this overwrites a
 * stale subscription_status. That is what lets an admin unstick an account
 * whose recovery webhook never landed (e.g. stuck on "past_due" while Stripe
 * reports "active").
 *
 * Returns the map of fields actually changed (a non-empty object), or null when
 * the user has no Stripe customer, has no subscriptions, or already matches.
 * The "canceling" pseudo-status written by /api/stripe/cancel-subscription is
 * preserved via the same effectiveStatus derivation as handleSubscriptionUpdated.
 */
export async function reconcileStripeUser(
  user: Record<string, any>
): Promise<Record<string, any> | null> {
  if (!user.stripe_customer_id) {
    return null;
  }

  const stripe = getStripeOrThrow();

  // Fetch subscriptions from Stripe and pick the most relevant one
  const subscriptions = await stripe.subscriptions.list({
    customer: user.stripe_customer_id,
    status: 'all',
    limit: 10,
    expand: ['data.discounts'],
  });

  // Find the most relevant subscription: active > trialing > past_due > canceled
  const statusPriority: Record<string, number> = { active: 0, trialing: 1, past_due: 2, canceled: 3 };
  const sorted = [...subscriptions.data].sort(
    (a, b) => (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99)
  );
  const sub = sorted[0]; // best subscription, or undefined

  if (!sub) {
    // No subscriptions in Stripe — ensure DynamoDB reflects that.
    // Guard excludes null/free/canceled to avoid overwriting records that
    // were manually provisioned or already cleaned up.
    const noSubStatuses = new Set([undefined, null, 'canceled', 'free', '']);
    if (!noSubStatuses.has(user.subscription_status as any)) {
      const updates = { subscription_status: 'canceled', has_payment_method: false };
      await userDb.updateUser(user.userId, updates);
      return updates;
    }
    return null;
  }

  // Check payment methods
  let hasPaymentMethod = !!(sub.default_payment_method || (sub as any).default_source);
  if (!hasPaymentMethod) {
    const methods = await stripe.paymentMethods.list({ customer: user.stripe_customer_id, limit: 1 });
    hasPaymentMethod = methods.data.length > 0;
  }

  // Derive tier.
  //
  // NOTE: still `items.data[0]`, not `findBasePlanItem`. Same hazard class as
  // syncSubscriptionFromStripe above (not one of the sites the seat-billing
  // ENG-2243..2246 correctness review named, but identical in kind): a seat
  // item sorting first here would just leave this admin-triggered
  // reconciliation skipping a tier overwrite rather than corrupting billing
  // state. See findBasePlanItem's doc comment before reusing this pattern
  // anywhere a subscription's items can include a seat line item.
  const priceId = sub.items?.data?.[0]?.price?.id;
  const derivedType = priceId ? deriveSubscriptionTypeFromPriceId(priceId) : null;

  // Build updates only for fields that are wrong
  const updates: Record<string, any> = {};

  // Mirror handleSubscriptionUpdated's effectiveStatus derivation so the
  // reconcile does not clobber the "canceling" pseudo-status that
  // /api/stripe/cancel-subscription writes. Without this, reconciling a
  // canceling user would flip them back to "active" and the UI would lose
  // the "Canceling" badge.
  const effectiveStatus =
    sub.cancel_at_period_end &&
    (sub.status === 'active' || sub.status === 'trialing')
      ? 'canceling'
      : sub.status;
  if (user.subscription_status !== effectiveStatus) {
    updates.subscription_status = effectiveStatus;
  }
  if (user.stripe_subscription_id !== sub.id) {
    updates.stripe_subscription_id = sub.id;
  }
  if (user.has_payment_method !== hasPaymentMethod) {
    updates.has_payment_method = hasPaymentMethod;
  }
  if (derivedType && user.subscriptionType !== derivedType) {
    updates.subscriptionType = derivedType;
    const tierConfig = await getTierConfig(derivedType);
    if (tierConfig) {
      updates.allowedPages = tierConfig.allowedPages;
      updates.allowedSkills = tierConfig.allowedSkills;
    }
  }

  const periodEndIso = getSubscriptionPeriodEndIso(sub);
  if (periodEndIso && user.current_period_end !== periodEndIso) {
    updates.current_period_end = periodEndIso;
  }

  // Sync activeOffer — always overwrite so removed discounts are cleared
  const newOffer = extractActiveOffer(sub);
  const existingOfferJson = user.activeOffer ? JSON.stringify(user.activeOffer) : null;
  const newOfferJson = newOffer ? JSON.stringify(newOffer) : null;
  if (existingOfferJson !== newOfferJson) {
    updates.activeOffer = newOffer;
  }

  if (Object.keys(updates).length === 0) {
    return null;
  }

  await userDb.updateUser(user.userId, updates);
  syncUserUpdateToLeadList(user.email, {
    subscriptionType: updates.subscriptionType,
    subscription_status: updates.subscription_status,
  });
  return updates;
}

/**
 * Reconcile a single user by id. Authoritative (Stripe wins). Returns the
 * fields changed, or null when the user is missing / has no Stripe customer /
 * already matches Stripe. Used by the admin per-user "Sync Stripe" button.
 */
export async function reconcileStripeUserById(userId: string): Promise<Record<string, any> | null> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    console.warn(`[STRIPE RECONCILE] User ${userId} not found in DB`);
    return null;
  }
  return reconcileStripeUser(user);
}

/**
 * Reconcile all users who have a stripe_customer_id by checking their actual
 * Stripe subscription status. Fixes any drift between DynamoDB and Stripe.
 *
 * Returns a summary of what was fixed.
 */
export async function reconcileAllStripeUsers(): Promise<{
  checked: number;
  fixed: number;
  errors: number;
  details: Array<{ email: string; action: string }>;
}> {
  getStripeOrThrow(); // fail fast before scanning the whole table if Stripe is unconfigured
  const summary = { checked: 0, fixed: 0, errors: 0, details: [] as Array<{ email: string; action: string }> };

  // Find all users with a stripe_customer_id
  const users = await userDb.scanWithFilter(
    'attribute_exists(stripe_customer_id)',
    {},
  );

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    summary.checked++;

    // Rate limit: pause 100ms every 10 users to stay well under Stripe's 100 req/s limit
    if (i > 0 && i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
      const updates = await reconcileStripeUser(user);
      if (updates && Object.keys(updates).length > 0) {
        // Build a human-readable change list for the admin summary. Only the
        // primary fields are surfaced; allowedPages/allowedSkills ride along
        // with a tier change and don't need their own line.
        const changes: string[] = [];
        if ('subscription_status' in updates) {
          changes.push(`status ${user.subscription_status || 'null'} -> ${updates.subscription_status}`);
        }
        if ('stripe_subscription_id' in updates) changes.push('sub_id synced');
        if ('has_payment_method' in updates) {
          changes.push(`payment_method ${user.has_payment_method} -> ${updates.has_payment_method}`);
        }
        if ('subscriptionType' in updates) {
          changes.push(`tier ${user.subscriptionType || 'null'} -> ${updates.subscriptionType}`);
        }
        if ('current_period_end' in updates) changes.push('period_end synced');
        if ('activeOffer' in updates) {
          changes.push(updates.activeOffer ? `offer synced (${updates.activeOffer.couponId})` : 'offer cleared');
        }
        summary.fixed++;
        summary.details.push({ email: user.email, action: changes.join(', ') });
        console.log(`[STRIPE RECONCILE] Fixed ${user.email}: ${changes.join(', ')}`);
      }
    } catch (err: any) {
      summary.errors++;
      console.error(`[STRIPE RECONCILE] Error for ${user.email}:`, err.message);
      summary.details.push({ email: user.email, action: `ERROR: ${err.message}` });
    }
  }

  console.log(`[STRIPE RECONCILE] Done: checked=${summary.checked}, fixed=${summary.fixed}, errors=${summary.errors}`);
  return summary;
}

// ─── Subscription Amount Resync ───────────────────────────────────────────────

/**
 * Resync all paying users against Stripe. For each user this:
 *   1. Authoritatively reconciles subscription_status / has_payment_method /
 *      tier / period_end / offer via reconcileStripeUser (Stripe wins), so a
 *      stale "past_due"/overdue account whose recovery webhook never landed
 *      gets unstuck.
 *   2. Refreshes subscription_amount from the latest paid invoice.
 *
 * Can be triggered on demand from the admin UI ("Resync Payments").
 *
 * `updated` counts amount changes; `reconciled` counts users whose
 * status/payment-method/etc. drift was corrected.
 */
export async function resyncAllSubscriptionAmounts(): Promise<{
  checked: number;
  updated: number;
  reconciled: number;
  skipped: number;
  errors: number;
}> {
  const stripe = getStripeOrThrow();
  const summary = { checked: 0, updated: 0, reconciled: 0, skipped: 0, errors: 0 };

  // Exclude empty strings — attribute_exists matches "" which causes Stripe errors
  const users = await userDb.scanWithFilter(
    'attribute_exists(stripe_customer_id) AND stripe_customer_id <> :empty',
    { ':empty': '' },
  );

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    summary.checked++;

    // Rate limit: 100ms pause every 10 users
    if (i > 0 && i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
      // 1. Authoritative status/payment-method/tier reconcile (Stripe wins).
      //    This is what unsticks an overdue account, not the amount sync below.
      const reconcileUpdates = await reconcileStripeUser(user);
      if (reconcileUpdates && Object.keys(reconcileUpdates).length > 0) {
        summary.reconciled++;
        console.log(`[STRIPE RESYNC] ${user.email}: reconciled ${Object.keys(reconcileUpdates).join(', ')}`);
      }

      // 2. Refresh subscription_amount from the latest paid invoice. A pay-as-you-go overage invoice
      //    (ENG-668) is not the subscription's price, so it is skipped.
      const invoices = await stripe.invoices.list({
        customer: user.stripe_customer_id,
        status: 'paid',
        limit: 10,
      });

      const latestPaid = invoices.data.find((inv) => inv.metadata?.purchaseType !== PAYG_OVERAGE_PURCHASE_TYPE);
      if (!latestPaid || typeof latestPaid.amount_paid !== 'number' || latestPaid.amount_paid <= 0) {
        if (!reconcileUpdates) summary.skipped++;
        continue;
      }

      if (user.subscription_amount === latestPaid.amount_paid) {
        if (!reconcileUpdates) summary.skipped++;
        continue;
      }

      await userDb.updateUser(user.userId, { subscription_amount: latestPaid.amount_paid });
      summary.updated++;
      console.log(`[STRIPE RESYNC] ${user.email}: subscription_amount = ${latestPaid.amount_paid}`);
    } catch (err: any) {
      summary.errors++;
      console.error(`[STRIPE RESYNC] Error for ${user.email}:`, err.message);
    }
  }

  console.log(`[STRIPE RESYNC] Done: checked=${summary.checked}, updated=${summary.updated}, reconciled=${summary.reconciled}, skipped=${summary.skipped}, errors=${summary.errors}`);
  return summary;
}
