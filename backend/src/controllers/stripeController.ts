import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { userDb } from '../services/db';
import {
  stripeService,
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  findUserByStripeCustomerId,
} from '../services/stripeService';

const CUSTOMER_FRONTEND_URL =
  process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

/**
 * POST /api/stripe/create-checkout-session
 * Creates a Stripe Checkout Session for a subscription purchase.
 */
export async function createCheckoutSession(req: Request, res: Response) {
  try {
    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated.' });
    }

    const { priceId, successUrl, cancelUrl } = req.body;
    if (!priceId) {
      return res.status(400).json({ message: 'priceId is required.' });
    }

    const session = await stripeService.createCheckoutSession(
      userId,
      priceId,
      successUrl || `${CUSTOMER_FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl || `${CUSTOMER_FRONTEND_URL}/pricing`
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (error: any) {
    console.error('Error creating checkout session:', error.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
}

/**
 * POST /api/stripe/webhook
 * Handles incoming Stripe webhook events.
 * Must receive raw body (not JSON-parsed) for signature verification.
 */
export async function handleWebhook(req: Request, res: Response) {
  const signature = req.headers['stripe-signature'] as string;
  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header.' });
  }

  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, signature);
  } catch (error: any) {
    console.error('Webhook signature verification failed:', error.message);
    return res.status(400).json({ error: `Webhook Error: ${error.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        await recordSubscriptionEvent(event.data.object, 'subscription_created');
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        await recordSubscriptionEvent(event.data.object, 'subscription_updated');
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        await recordSubscriptionEvent(event.data.object, 'subscription_canceled');
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePayment(event.data.object, 'payment_succeeded');
        break;
      case 'invoice.payment_failed':
        await handleInvoicePayment(event.data.object, 'payment_failed');
        break;
      case 'charge.refunded':
        await handleChargeRefunded(event.data.object);
        break;
      default:
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error(`Error handling webhook event ${event.type}:`, error.message);
    // Return 200 to Stripe so it doesn't retry, but log the error
    res.status(200).json({ received: true, error: error.message });
  }
}

/**
 * GET /api/stripe/products
 * Lists active Stripe products with prices.
 */
export async function listProducts(req: Request, res: Response) {
  try {
    const products = await stripeService.listProducts();
    res.json(products);
  } catch (error: any) {
    console.error('Error listing products:', error.message);
    res.status(500).json({ error: 'Failed to list products.' });
  }
}

/**
 * GET /api/stripe/payment-history/:userId
 * Admin-only: returns the last 50 payment events for a user.
 */
export async function getPaymentHistory(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required.' });
    }

    const { paymentHistoryDb } = await import('../services/paymentHistoryDb');
    const history = await paymentHistoryDb.getByUserId(userId, 50);
    res.json({ userId, events: history });
  } catch (error: any) {
    console.error('Error fetching payment history:', error.message);
    res.status(500).json({ error: 'Failed to fetch payment history.' });
  }
}

/**
 * Record subscription lifecycle events in payment history.
 * Called after the main handler so the user record is already updated.
 */
async function recordSubscriptionEvent(
  data: any,
  eventType: 'subscription_created' | 'subscription_updated' | 'subscription_canceled'
): Promise<void> {
  try {
    const customerId = typeof data.customer === 'string'
      ? data.customer
      : data.customer?.id;

    if (!customerId) return;

    const user = await findUserByStripeCustomerId(customerId);
    if (!user) return;

    const { paymentHistoryDb } = await import('../services/paymentHistoryDb');
    await paymentHistoryDb.record({
      userId: user.userId,
      timestamp: new Date().toISOString(),
      eventType,
      amount: data.amount_total || 0,
      currency: data.currency || 'usd',
      status: data.status || eventType,
      stripeInvoiceId: data.invoice || undefined,
      stripeSubscriptionId: (typeof data.subscription === 'string' ? data.subscription : data.subscription?.id) || data.id || undefined,
      priceId: data.items?.data?.[0]?.price?.id || data.line_items?.data?.[0]?.price?.id || undefined,
      planName: undefined,
    });
  } catch (err: any) {
    console.error(`[PaymentHistory] Failed to record ${eventType}: ${err.message}`);
  }
}

/**
 * Handle invoice.payment_succeeded / invoice.payment_failed
 */
async function handleInvoicePayment(
  invoice: any,
  eventType: 'payment_succeeded' | 'payment_failed'
): Promise<void> {
  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer?.id;

  if (!customerId) {
    console.warn(`[PaymentHistory] No customer on invoice ${invoice.id}`);
    return;
  }

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[PaymentHistory] No user found for customer ${customerId}`);
    return;
  }

  try {
    const { paymentHistoryDb } = await import('../services/paymentHistoryDb');
    await paymentHistoryDb.record({
      userId: user.userId,
      timestamp: new Date().toISOString(),
      eventType,
      amount: invoice.amount_paid ?? invoice.amount_due ?? 0,
      currency: invoice.currency || 'usd',
      status: invoice.status || eventType,
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: invoice.subscription || undefined,
      priceId: invoice.lines?.data?.[0]?.price?.id || undefined,
      planName: invoice.lines?.data?.[0]?.description || undefined,
    });
  } catch (err: any) {
    console.error(`[PaymentHistory] Failed to record ${eventType}: ${err.message}`);
  }
}

/**
 * Handle charge.refunded
 */
async function handleChargeRefunded(charge: any): Promise<void> {
  const customerId = typeof charge.customer === 'string'
    ? charge.customer
    : charge.customer?.id;

  if (!customerId) {
    console.warn(`[PaymentHistory] No customer on charge ${charge.id}`);
    return;
  }

  const user = await findUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[PaymentHistory] No user found for customer ${customerId}`);
    return;
  }

  try {
    const { paymentHistoryDb } = await import('../services/paymentHistoryDb');
    await paymentHistoryDb.record({
      userId: user.userId,
      timestamp: new Date().toISOString(),
      eventType: 'refund',
      amount: charge.amount_refunded || 0,
      currency: charge.currency || 'usd',
      status: 'refunded',
      stripeInvoiceId: charge.invoice || undefined,
      metadata: { chargeId: charge.id },
    });
  } catch (err: any) {
    console.error(`[PaymentHistory] Failed to record refund: ${err.message}`);
  }
}
