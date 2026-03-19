import Stripe from 'stripe';
import dotenv from 'dotenv';
import { userDb } from './db';
import { getDefaultTierConfig } from './subscriptionService';

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
  const tierConfig = getDefaultTierConfig(subscriptionType);

  await userDb.updateUser(user.userId, {
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    subscriptionType,
    subscription_status: 'active',
    ...(tierConfig && {
      allowedPages: tierConfig.allowedPages,
      allowedSkills: tierConfig.allowedSkills,
    }),
  });

  console.log(
    `Checkout completed: user ${user.userId} → stripe_customer_id=${stripeCustomerId}, subscription=${stripeSubscriptionId}`
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

  await userDb.updateUser(user.userId, {
    subscription_status: subscription.status,
  });

  console.log(
    `Subscription updated: user ${user.userId} → status=${subscription.status}`
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

  const freeTierConfig = getDefaultTierConfig('Free');
  if (!freeTierConfig) {
    console.error('Free tier config not found — cannot downgrade user on subscription deletion');
    return;
  }

  await userDb.updateUser(user.userId, {
    subscription_status: 'canceled',
    subscriptionType: 'Free',
    allowedPages: freeTierConfig.allowedPages,
    allowedSkills: freeTierConfig.allowedSkills,
  });

  console.log(`Subscription deleted: user ${user.userId} → downgraded to Free tier`);
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Derive the subscription type from the checkout session's line items price ID.
 * Maps: Starter plan → "Basic", Pro/Complete plan → "Super Premium".
 * Falls back to "Super Premium" if the price cannot be determined.
 */
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
