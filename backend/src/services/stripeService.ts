import Stripe from 'stripe';
import dotenv from 'dotenv';
import { userDb } from './db';
import { getTierConfig, DEFAULT_PAGES } from './subscriptionService';

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
    return s.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
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

// ─── On-Demand Sync ───────────────────────────────────────────────────

/**
 * Sync subscription status from Stripe for a user who has stripe_customer_id
 * but missing subscription_status. Called lazily from /api/auth/me.
 * Returns the updated fields or null if no active subscription found.
 */
export async function syncSubscriptionFromStripe(
  userId: string,
  stripeCustomerId: string
): Promise<{ subscription_status: string; stripe_subscription_id?: string; subscriptionType?: string; current_period_end?: string; has_payment_method?: boolean } | null> {
  try {
    const stripe = getStripeOrThrow();
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return null;
    }

    const sub = subscriptions.data[0];
    const status = sub.status; // active, trialing, past_due, canceled, etc.

    // Check if customer has a payment method on file
    // Payment method can be on the subscription OR the customer level
    let hasPaymentMethod = !!(sub.default_payment_method || (sub as any).default_source);
    if (!hasPaymentMethod) {
      try {
        const customer = await stripe.customers.retrieve(stripeCustomerId);
        if (customer && !customer.deleted) {
          const cust = customer as any;
          hasPaymentMethod = !!(cust.default_source || cust.invoice_settings?.default_payment_method);
          // Also check if any payment methods exist
          if (!hasPaymentMethod) {
            const methods = await stripe.paymentMethods.list({ customer: stripeCustomerId, limit: 1 });
            hasPaymentMethod = methods.data.length > 0;
          }
        }
      } catch {
        // Non-fatal — default to subscription-level check
      }
    }

    const updates: any = {
      subscription_status: status,
      stripe_subscription_id: sub.id,
      current_period_end: (sub as any).current_period_end
        ? new Date(typeof (sub as any).current_period_end === 'number'
            ? (sub as any).current_period_end * 1000
            : (sub as any).current_period_end
          ).toISOString()
        : undefined,
      has_payment_method: hasPaymentMethod,
    };

    // Derive tier from price if available
    const priceId = sub.items?.data?.[0]?.price?.id;
    if (priceId) {
      const derivedType = deriveSubscriptionTypeFromPriceId(priceId);
      if (derivedType) {
        updates.subscriptionType = derivedType;
        const tierConfig = await getTierConfig(derivedType);
        if (tierConfig) {
          updates.allowedPages = tierConfig.allowedPages;
          updates.allowedSkills = tierConfig.allowedSkills;
        }
      }
    }

    await userDb.updateUser(userId, updates);
    console.log(`[STRIPE SYNC] Synced subscription for user ${userId}: status=${status}, sub=${sub.id}`);

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

  // Derive subscription tier from the price ID in the checkout session
  const subscriptionType = deriveSubscriptionType(session);
  const tierConfig = await getTierConfig(subscriptionType);

  // Fetch the actual subscription to get accurate status and period end
  let actualStatus = 'active';
  let currentPeriodEnd: string | undefined;
  if (stripeSubscriptionId) {
    try {
      const s = getStripeOrThrow();
      const sub = await s.subscriptions.retrieve(stripeSubscriptionId) as any;
      actualStatus = sub.status; // Could be 'trialing', 'active', etc.
      if (sub.current_period_end) {
        currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
      }
    } catch (err) {
      console.warn(`Could not fetch subscription ${stripeSubscriptionId} for status:`, err);
    }
  }

  const updateData: Record<string, any> = {
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    subscriptionType,
    subscription_status: actualStatus,
    has_payment_method: true, // completed checkout = has payment method
    has_used_trial: true, // Mark trial as used so future upgrades don't offer trial
    allowedPages: tierConfig?.allowedPages ?? [...DEFAULT_PAGES],
    allowedSkills: tierConfig?.allowedSkills ?? ['*'],
  };
  if (currentPeriodEnd) {
    updateData.current_period_end = currentPeriodEnd;
  }

  await userDb.updateUser(user.userId, updateData);

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

  console.log(
    `Checkout completed: user ${user.userId} → stripe_customer_id=${stripeCustomerId}, subscription=${stripeSubscriptionId}, status=${actualStatus}, periodEnd=${currentPeriodEnd || 'unknown'}`
  );
}

/**
 * Handle customer.subscription.updated — sync subscription status.
 */
export async function handleSubscriptionUpdated(subscription: any): Promise<void> {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`No user found for subscription update. customer=${customerId}`);
    return;
  }

  // Only process this webhook if it's for the user's current subscription
  // (prevents stale/duplicate subscription webhooks from overwriting the latest state)
  if (user.stripe_subscription_id && user.stripe_subscription_id !== subscription.id) {
    console.log(
      `[STRIPE] Ignoring subscription update for ${subscription.id} — user ${user.userId} has current subscription ${user.stripe_subscription_id}`
    );
    return;
  }

  const updateData: Record<string, any> = {
    subscription_status: subscription.status,
  };

  // Backfill stripe_subscription_id if it was never written (e.g., missed checkout webhook).
  // Only write when null to preserve the line 362 guard against stale webhooks.
  if (!user.stripe_subscription_id) {
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

  await userDb.updateUser(user.userId, updateData);

  console.log(
    `Subscription updated: user ${user.userId} → status=${subscription.status}, has_pm=${hasPaymentMethod}, periodEnd=${updateData.current_period_end || 'unchanged'}`
  );
}

/**
 * Handle customer.subscription.deleted — mark subscription as canceled.
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

  const freeTierConfig = await getTierConfig('Free');

  await userDb.updateUser(user.userId, {
    subscription_status: 'canceled',
    subscriptionType: 'Free',
    allowedPages: freeTierConfig?.allowedPages ?? [...DEFAULT_PAGES],
    allowedSkills: freeTierConfig?.allowedSkills ?? [],
  });

  console.log(`Subscription deleted: user ${user.userId} → downgraded to Free tier`);
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Derive the subscription type from the checkout session's line items price ID.
 * Maps: Starter plan → "Basic", Pro/Complete plan → "Super Premium".
 * Falls back to "Super Premium" if the price cannot be determined.
 */
export function deriveSubscriptionTypeFromPriceId(priceId: string): string | null {
  if (priceId === process.env.STRIPE_STARTER_PRICE_ID) return 'Basic';
  if (priceId === process.env.STRIPE_COMPLETE_PRICE_ID) return 'Super Premium';
  return null;
}

function deriveSubscriptionType(session: any): string {
  const priceId = session.line_items?.data?.[0]?.price?.id
    || session.display_items?.[0]?.price?.id;

  if (priceId) {
    if (priceId === process.env.STRIPE_STARTER_PRICE_ID) {
      return 'Basic';
    }
    if (priceId === process.env.STRIPE_COMPLETE_PRICE_ID) {
      return 'Super Premium';
    }
  }

  return 'Super Premium';
}

/**
 * Find a user by their stripe_customer_id.
 * Uses a filtered DynamoDB scan (server-side filter, no GSI required).
 * Consider adding a GSI on stripe_customer_id if user count grows past ~1000.
 */
async function findUserByStripeCustomerId(stripeCustomerId: string): Promise<any | null> {
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
  const stripe = getStripeOrThrow();
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
      // Fetch active/trialing subscriptions from Stripe
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: 'all',
        limit: 10,
      });

      // Find the most relevant subscription: active > trialing > past_due > canceled
      const statusPriority: Record<string, number> = { active: 0, trialing: 1, past_due: 2, canceled: 3 };
      const sorted = [...subscriptions.data].sort(
        (a, b) => (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99)
      );
      const sub = sorted[0]; // best subscription, or undefined

      if (!sub) {
        // No subscriptions in Stripe — ensure DynamoDB reflects that
        if (user.subscription_status && user.subscription_status !== 'canceled' && user.subscription_status !== 'free') {
          await userDb.updateUser(user.userId, {
            subscription_status: 'canceled',
            has_payment_method: false,
          });
          summary.fixed++;
          summary.details.push({ email: user.email, action: `status ${user.subscription_status} -> canceled (no Stripe subs)` });
        }
        continue;
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
      const changes: string[] = [];

      if (user.subscription_status !== sub.status) {
        updates.subscription_status = sub.status;
        changes.push(`status ${user.subscription_status || 'null'} -> ${sub.status}`);
      }
      if (user.stripe_subscription_id !== sub.id) {
        updates.stripe_subscription_id = sub.id;
        changes.push(`sub_id synced`);
      }
      if (user.has_payment_method !== hasPaymentMethod) {
        updates.has_payment_method = hasPaymentMethod;
        changes.push(`payment_method ${user.has_payment_method} -> ${hasPaymentMethod}`);
      }
      if (derivedType && user.subscriptionType !== derivedType) {
        updates.subscriptionType = derivedType;
        const tierConfig = await getTierConfig(derivedType);
        if (tierConfig) {
          updates.allowedPages = tierConfig.allowedPages;
          updates.allowedSkills = tierConfig.allowedSkills;
        }
        changes.push(`tier ${user.subscriptionType || 'null'} -> ${derivedType}`);
      }

      const periodEnd = (sub as any).current_period_end;
      if (periodEnd) {
        const periodEndIso = new Date(typeof periodEnd === 'number' ? periodEnd * 1000 : periodEnd).toISOString();
        if (user.current_period_end !== periodEndIso) {
          updates.current_period_end = periodEndIso;
          changes.push(`period_end synced`);
        }
      }

      if (Object.keys(updates).length > 0) {
        await userDb.updateUser(user.userId, updates);
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
