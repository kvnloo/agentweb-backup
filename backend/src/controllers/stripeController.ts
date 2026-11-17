import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { userDb } from '../services/db';
import {
  stripeService,
  handleCheckoutSessionCompleted,
  handleLlmUsageTopUpCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  findUserByStripeCustomerId,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleChargeRefunded,
  handleChargeDisputeCreated,
  handleChargeDisputeClosed,
  handleSubscriptionScheduleEnded,
  handleInvoiceVoided,
  handleInvoiceMarkedUncollectible,
  handleInvoicePaymentActionRequired,
  handleSetupIntentSucceeded,
  reconcileAllStripeUsers,
  findBasePlanItem,
  getSubscriptionPeriodEndIso,
  isSetupModeCheckoutSession,
  PAYG_OVERAGE_PURCHASE_TYPE,
} from '../services/stripeService';
import { invoiceLinePriceId, invoiceSubscriptionId } from '../utils/stripeInvoiceFields';
import { handleZomaBillingWebhookEvent } from '../mcp/zomaBilling';
import { emitStripeSignals, emitAccountSignal } from '../services/serverSignalEmitter';
import {
  InMemoryPaymentFeedbackAskLedger,
  isPaymentFeedbackAskEnabled,
  shouldSendPaymentFeedbackAsk,
} from '../services/paymentFeedbackTrigger';

const CUSTOMER_FRONTEND_URL =
  process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

/**
 * Determine if a webhook processing error is non-retryable (permanent).
 * Permanent errors: user not found, invalid data shape, missing required fields.
 * Everything else (DynamoDB throttle, Stripe API timeout) is transient and should retry.
 */
function isNonRetryableError(error: any): boolean {
  const msg = (error.message || '').toLowerCase();
  const permanentPatterns = [
    'no user found',
    'user not found',
    'userid is required',
    'priceid is required',
  ];
  return permanentPatterns.some(p => msg.includes(p));
}

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

    // ENG-2684: fire-and-forget hireemma.ai session-list signal; never affects the response.
    void userDb.getUserById(userId)
      .then((user: any) => emitAccountSignal(user, 'checkout_started', { checkoutSessionId: session.id || '', priceId: String(priceId).slice(0, 120) }))
      .catch(() => undefined);

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
    // ENG-3131: Zoma plan objects (own Stripe customer, tagged metadata) are handled on their own
    // and never reach the Emma subscription handlers or the CRM/billing-signal mirrors, which would
    // sync the user row's tier from a price they do not know.
    if (await handleZomaBillingWebhookEvent(event as any)) {
      return res.json({ received: true });
    }

    switch (event.type) {
      case 'checkout.session.completed':
        if (isSetupModeCheckoutSession(event.data.object)) {
          // Saved a payment method only (ENG-2303 Zoma onboarding); no subscription exists.
          console.log(`[STRIPE] Setup-mode checkout ${event.data.object?.id} completed; no subscription changes.`);
        } else if (event.data.object?.metadata?.purchaseType === 'llm_usage_top_up') {
          await handleLlmUsageTopUpCheckoutCompleted(event.data.object);
        } else {
          await handleCheckoutSessionCompleted(event.data.object);
          await recordSubscriptionEvent(event.data.object, 'subscription_created');
        }
        break;
      case 'checkout.session.async_payment_succeeded':
        if (event.data.object?.metadata?.purchaseType === 'llm_usage_top_up') {
          await handleLlmUsageTopUpCheckoutCompleted(event.data.object);
        }
        break;
      // Handle subs created OUTSIDE Checkout (admin provisioning, API,
      // reconciliation). Pass { isNew: true } so the stale-webhook guard
      // is bypassed — this IS the authoritative new sub and any canceled
      // stripe_subscription_id in the DB should be overwritten.
      case 'customer.subscription.created':
        await handleSubscriptionUpdated(event.data.object, { isNew: true });
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
      // Stripe sends both `invoice.paid` (current) and
      // `invoice.payment_succeeded` (legacy) for the same event. Handle
      // both so renewal cycles sync regardless of which wire format the
      // webhook endpoint was configured with.
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        // A pay-as-you-go overage invoice is recorded by settlement under its own payment types.
        if (!isPaygOverageInvoiceEvent(event)) await handleInvoicePayment(event.data.object, 'payment_succeeded');
        logPaymentFeedbackAskDecision(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object);
        if (!isPaygOverageInvoiceEvent(event)) await handleInvoicePayment(event.data.object, 'payment_failed');
        break;
      // ENG-668: pay-as-you-go overage invoices only (subscription invoices are a no-op here). Like the
      // dispute events, these must be enabled on the Stripe webhook endpoint.
      case 'invoice.voided':
        await handleInvoiceVoided(event.data.object);
        break;
      case 'invoice.marked_uncollectible':
        await handleInvoiceMarkedUncollectible(event.data.object);
        break;
      case 'invoice.payment_action_required':
        await handleInvoicePaymentActionRequired(event.data.object);
        break;
      // ENG-668: a newly saved card replaces the one settlement pinned on an open overage invoice, so
      // Stripe's retries charge it. Must be enabled on the webhook endpoint like the events above.
      case 'setup_intent.succeeded':
        await handleSetupIntentSucceeded(event.data.object);
        break;
      case 'charge.refunded':
        await handleChargeRefunded(event.data.object);
        break;
      // Chargebacks on AgentWeb Credits purchases. Capacity is revoked when the
      // dispute opens; `.closed` only records the outcome (a won dispute does
      // not auto-restore capacity — see handleChargeDisputeClosed).
      // NOTE: requires both events to be enabled on the Stripe webhook endpoint
      // (Developers → Webhooks → edit), same as the subscription_schedule ones.
      case 'charge.dispute.created':
        await handleChargeDisputeCreated(event.data.object);
        break;
      case 'charge.dispute.closed':
        await handleChargeDisputeClosed(event.data.object);
        break;
      // subscription_schedule lifecycle: clear any cached scheduledChange
      // on the user record when the schedule reaches a terminal state. See
      // handleSubscriptionScheduleEnded for details on each event.
      // NOTE: requires these events to be enabled on the Stripe webhook
      // endpoint (Developers → Webhooks → edit → tick the 3 boxes).
      case 'subscription_schedule.released':
      case 'subscription_schedule.canceled':
      case 'subscription_schedule.completed':
        await handleSubscriptionScheduleEnded(event.data.object);
        break;
      default:
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }

    // CRM signal (B3): mirror billing events into AW-ContactEvents so lifecycle
    // and health scores reflect live billing state. Fire-and-forget — never
    // blocks the webhook ack. Errors are swallowed inside the hook.
    // A setup-mode checkout is not a subscription event (it would map to payment.subscribed).
    // Nor is a pay-as-you-go overage invoice (ENG-668): the CRM mirror models the subscription.
    // Nor is a saved payment method (`setup_intent.succeeded`).
    if (!(event.type === 'checkout.session.completed' && isSetupModeCheckoutSession(event.data.object))
      && event.type !== 'setup_intent.succeeded'
      && !isPaygOverageInvoiceEvent(event)) {
      void sendStripeEventToCrm(event);
    }

    // ENG-2684: billing signals into the hireemma.ai session list. Fire-and-forget; emitStripeSignals
    // never throws, so the webhook ack is unaffected by any emission failure.
    if (!isPaygOverageInvoiceEvent(event)) void emitStripeSignals(event);

    res.json({ received: true });
  } catch (error: any) {
    console.error(`Error handling webhook event ${event.type}:`, error.message);

    // Classify the error: permanent failures return 200 (don't retry),
    // transient failures return 500 so Stripe retries (up to 3 days).
    const permanent = isNonRetryableError(error);
    if (permanent) {
      console.warn(`[STRIPE WEBHOOK] Non-retryable error for ${event.type}, acknowledging: ${error.message}`);
      res.status(200).json({ received: true, error: error.message });
    } else {
      console.error(`[STRIPE WEBHOOK] Transient error for ${event.type}, requesting retry: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
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

    // `data` is the subscription object for customer.subscription.* events
    // (which has `.items`) or a checkout session for checkout.session.completed
    // (which doesn't — falls through to `line_items`). For the subscription
    // case, use `findBasePlanItem` rather than `items.data[0]` — a
    // subscription can carry a seat-billing extra-seat line item
    // (ENG-2243..2246) alongside the plan item, and `items.data` order is
    // not guaranteed. `items.data[0]` could record the seat's price instead
    // of the plan's in this payment-history audit trail (ENG-2257). See
    // `findBasePlanItem`'s doc comment in stripeService.ts.
    const basePlanItem = data.items?.data?.length ? findBasePlanItem(data) : undefined;

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
      priceId: basePlanItem?.price?.id || data.line_items?.data?.[0]?.price?.id || undefined,
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
      stripeSubscriptionId: invoiceSubscriptionId(invoice) || undefined,
      priceId: invoiceLinePriceId(invoice.lines?.data?.[0]) || undefined,
      planName: invoice.lines?.data?.[0]?.description || undefined,
    });
  } catch (err: any) {
    console.error(`[PaymentHistory] Failed to record ${eventType}: ${err.message}`);
  }
}

// ENG-2856: process-local idempotency; the dark trigger only logs, so a restart re-asking is harmless.
const paymentFeedbackAskLedger = new InMemoryPaymentFeedbackAskLedger();

/** ENG-2856: dark post-payment feedback-ask trigger. Logs the decision only; never throws into the webhook. */
function logPaymentFeedbackAskDecision(invoice: unknown): void {
  try {
    const enabled = isPaymentFeedbackAskEnabled();
    if (!enabled) return;
    const decision = shouldSendPaymentFeedbackAsk(invoice, { enabled, ledger: paymentFeedbackAskLedger });
    console.log('[PaymentFeedbackAsk] decision', JSON.stringify(decision));
  } catch (err: any) {
    console.error(`[PaymentFeedbackAsk] decision failed: ${err?.message || err}`);
  }
}

/** ENG-668: an `invoice.*` event for a pay-as-you-go overage invoice (settlement's, not the subscription's). */
function isPaygOverageInvoiceEvent(event: { type: string; data: { object: unknown } }): boolean {
  const metadata = (event.data?.object as { metadata?: Record<string, string> | null } | undefined)?.metadata;
  return event.type.startsWith('invoice.') && !!metadata?.purchaseType && metadata.purchaseType === PAYG_OVERAGE_PURCHASE_TYPE;
}

/**
 * Mirror a Stripe event into AW-ContactEvents for CRM lifecycle/health scoring (B3).
 *
 * Runs fire-and-forget after the primary webhook handler. Idempotent on the
 * Stripe event id (sourceRecordId = `stripe-<eventId>`). After the event is
 * logged, triggers lifecycle + health recompute for the affected contact.
 */
async function sendStripeEventToCrm(event: any): Promise<void> {
  try {
    const obj = event?.data?.object || {};
    const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
    // Basil moved an invoice's subscription under `parent` (ENG-2599).
    const subscriptionId = obj.object === 'invoice'
      ? invoiceSubscriptionId(obj) || undefined
      : typeof obj.subscription === 'string'
        ? obj.subscription
        : obj.subscription?.id || (obj.object === 'subscription' ? obj.id : undefined);

    // Resolve email: prefer customer_details from checkout; fallback to user lookup by Stripe customer id.
    let email: string | undefined = obj.customer_details?.email || obj.customer_email || undefined;
    let user: any = null;
    if (!email && customerId) {
      user = await findUserByStripeCustomerId(customerId);
      if (user?.email) email = user.email;
    } else if (customerId) {
      user = await findUserByStripeCustomerId(customerId);
    }
    if (!email) {
      console.warn(`[stripe->crm] no email for event ${event.type} / ${event.id}, skipping CRM sync`);
      return;
    }

    const status = (obj.status as string | undefined) || undefined;
    // Basil moved current_period_end onto subscription items (ENG-405).
    // Use the base-plan item, not items.data[0] (a seat add-on may sort
    // first), keeping the legacy root-field fallback — mirrors routes/crm.ts.
    const basePlanItem = obj?.items?.data?.length ? findBasePlanItem(obj) : undefined;
    const currentPeriodEnd = getSubscriptionPeriodEndIso(
      basePlanItem
        ? { items: { data: [basePlanItem] }, current_period_end: obj.current_period_end }
        : obj
    );

    const { onStripeSubscriptionEvent } = await import('../services/crmSignalHooks');
    await onStripeSubscriptionEvent({
      eventId: event.id,
      eventType: event.type,
      email,
      firstName: obj.customer_details?.name?.split(' ')?.[0] || null,
      stripeCustomerId: customerId || null,
      stripeSubscriptionId: subscriptionId || null,
      status: status || null,
      subscriptionType: user?.subscriptionType || null,
      currentPeriodEnd: currentPeriodEnd || null,
    });

    // Downstream heat/health/lifecycle recompute is wired through the
    // contactSyncService when a real signal loader is available (D2). For
    // now the event alone is enough — lifecycleService + healthScoreService
    // require an AW-Leads-backed loadSignals fetcher we'll inject centrally
    // once D2 ships, so every CRM signal recomputes the same way.
  } catch (err: any) {
    console.error('[stripe->crm] failed to mirror event:', err?.message || err);
  }
}

/**
 * POST /api/stripe/reconcile
 * Admin-only: reconcile all users' Stripe subscription data with DynamoDB.
 * Fixes any drift caused by missed webhooks.
 */
export async function reconcile(req: Request, res: Response) {
  try {
    const result = await reconcileAllStripeUsers();
    res.json(result);
  } catch (error: any) {
    console.error('Error running Stripe reconciliation:', error.message);
    res.status(500).json({ error: 'Reconciliation failed.' });
  }
}
