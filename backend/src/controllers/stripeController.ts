import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { userDb } from '../services/db';
import {
  stripeService,
  handleCheckoutSessionCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
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
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
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
