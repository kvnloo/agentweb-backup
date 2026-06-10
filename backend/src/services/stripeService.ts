import Stripe from 'stripe';
import dotenv from 'dotenv';
import { userDb } from './db';
import { getTierConfig, DEFAULT_PAGES } from './subscriptionService';
import { paymentHistoryDb } from './paymentHistoryDb';
import { syncUserUpdateToLeadList } from './crmAutoSyncService';

dotenv.config();

// Lazy-initialize Stripe SDK so env vars set at test time are picked up
let _stripe: Stripe | null = null;

function getStripeOrThrow(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('Stripe SDK not initialized. Missing STRIPE_SECRET_KEY.');
    }
    _stripe = new Stripe(key, {
      apiVersion: '2025-05-28.basil' as any,
    });
  }
  return _stripe;
}

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
    const existingItemId = subscription.items.data[0]?.id;

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
  const currentItem = current.items.data[0];
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
        items: [{ price: newPriceId, quantity: 1 }],
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
      expand: ['data.discount.coupon'],
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
      current_period_end: (sub as any).current_period_end
        ? new Date(typeof (sub as any).current_period_end === 'number'
            ? (sub as any).current_period_end * 1000
            : (sub as any).current_period_end
          ).toISOString()
        : undefined,
      activeOffer: extractActiveOffer(sub),
    };

    // Derive tier from price if available
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
      subscription = await s.subscriptions.retrieve(stripeSubscriptionId, { expand: ['discount.coupon'] });
      actualStatus = subscription.status; // Could be 'trialing', 'active', etc.
      if (subscription.current_period_end) {
        currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
      }
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
  if (subscription.current_period_end) {
    updateData.current_period_end = new Date(
      typeof subscription.current_period_end === 'number'
        ? subscription.current_period_end * 1000
        : subscription.current_period_end
    ).toISOString();
  }

  // Sync plan tier on upgrades/downgrades
  if (subscription.items?.data?.[0]?.price?.id) {
    const newType = deriveSubscriptionTypeFromPriceId(subscription.items.data[0].price.id);
    if (newType) {
      updateData.subscriptionType = newType;
      const tierConfig = await getTierConfig(newType);
      if (tierConfig) {
        updateData.allowedPages = tierConfig.allowedPages;
        updateData.allowedSkills = tierConfig.allowedSkills;
      }
    }
  }

  // Always sync activeOffer — set to null when discount is removed
  updateData.activeOffer = extractActiveOffer(subscription);

  await userDb.updateUser(user.userId, updateData);
  syncUserUpdateToLeadList(user.email, {
    subscriptionType: updateData.subscriptionType,
    subscription_status: updateData.subscription_status,
  });

  console.log(
    `Subscription updated: user ${user.userId} → status=${subscription.status}, has_pm=${hasPaymentMethod}, periodEnd=${updateData.current_period_end || 'unchanged'}, offer=${updateData.activeOffer?.couponId ?? 'none'}`
  );
}

/**
 * Handle invoice.payment_succeeded — confirm subscription is active and sync payment info.
 */
export async function handleInvoicePaymentSucceeded(invoice: any): Promise<void> {
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

  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id || null;

  const updateData: Record<string, any> = {
    subscription_status: 'active',
    has_payment_method: true,
  };

  // Backfill stripe_subscription_id if user doesn't have one yet
  if (!user.stripe_subscription_id && subscriptionId) {
    updateData.stripe_subscription_id = subscriptionId;
  }

  // Store the amount paid so it can be displayed in the admin Users tab
  if (typeof invoice.amount_paid === 'number' && invoice.amount_paid > 0) {
    updateData.subscription_amount = invoice.amount_paid;
  }

  // Sync current_period_end and activeOffer from the live subscription
  const subIdToFetch = subscriptionId || user.stripe_subscription_id;
  if (subIdToFetch) {
    try {
      const s = getStripeOrThrow();
      const subscription = await s.subscriptions.retrieve(subIdToFetch, { expand: ['discount.coupon'] }) as any;
      if (subscription.current_period_end) {
        updateData.current_period_end = new Date(subscription.current_period_end * 1000).toISOString();
      }
      updateData.activeOffer = extractActiveOffer(subscription);
    } catch (err) {
      console.warn(`[STRIPE] Failed to fetch subscription ${subIdToFetch} for period_end sync: ${err}`);
    }
  }

  await userDb.updateUser(user.userId, updateData);
  syncUserUpdateToLeadList(user.email, { subscription_status: 'active' });

  console.log(
    `[STRIPE] Invoice payment succeeded: user ${user.userId} → status=active, has_payment_method=true${updateData.stripe_subscription_id ? `, backfilled sub=${subscriptionId}` : ''}${updateData.subscription_amount ? `, amount=${updateData.subscription_amount}` : ''}${updateData.current_period_end ? `, periodEnd=${updateData.current_period_end}` : ''}`
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

          // Derive tier from the remaining subscription's price
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
          const periodEnd = (activeSub as any).current_period_end;
          if (periodEnd) {
            updateData.current_period_end = new Date(
              typeof periodEnd === 'number' ? periodEnd * 1000 : periodEnd
            ).toISOString();
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

  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id || null;

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
 * Handle charge.refunded — record the refund in payment history.
 */
export async function handleChargeRefunded(charge: any): Promise<void> {
  const customerId = typeof charge.customer === 'string'
    ? charge.customer
    : charge.customer?.id;

  if (!customerId) {
    console.warn('[STRIPE] charge.refunded missing customer ID');
    return;
  }

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[STRIPE] No user found for charge.refunded. customer=${customerId}`);
    return;
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

/**
 * Extract activeOffer from a Stripe subscription's discount field.
 * Returns null when there is no discount or the discount has no coupon.
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
  const discount = subscription?.discount;
  if (!discount || !discount.coupon) return null;
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
    expand: ['data.discount.coupon'],
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

  // Derive tier
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

  const periodEnd = (sub as any).current_period_end;
  if (periodEnd) {
    const periodEndIso = new Date(typeof periodEnd === 'number' ? periodEnd * 1000 : periodEnd).toISOString();
    if (user.current_period_end !== periodEndIso) {
      updates.current_period_end = periodEndIso;
    }
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

      // 2. Refresh subscription_amount from the latest paid invoice.
      const invoices = await stripe.invoices.list({
        customer: user.stripe_customer_id,
        status: 'paid',
        limit: 1,
      });

      const latestPaid = invoices.data[0];
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
