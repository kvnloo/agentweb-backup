import { userDb, User } from './db';

type StripeEvent = {
  type: string;
  data: {
    object: any;
  };
};

const HANDLED_EVENTS = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
];

export function isHandledEvent(eventType: string): boolean {
  return HANDLED_EVENTS.includes(eventType);
}

export async function handleWebhookEvent(event: StripeEvent): Promise<void> {
  if (!isHandledEvent(event.type)) {
    return;
  }

  const obj = event.data.object;
  const customerId = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;

  if (!customerId) {
    console.warn(`[Stripe Webhook] No customer ID in event ${event.type}`);
    return;
  }

  const user = await userDb.getUserByStripeCustomerId(customerId);
  if (!user) {
    console.warn(`[Stripe Webhook] No user found for stripe_customer_id=${customerId} (event: ${event.type})`);
    return;
  }

  switch (event.type) {
    case 'customer.subscription.created':
      await handleSubscriptionCreated(user, obj);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(user, obj);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(user, obj);
      break;
    case 'customer.subscription.resumed':
      await handleSubscriptionResumed(user, obj);
      break;
    case 'invoice.paid':
      await handleInvoicePaid(user, obj);
      break;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(user, obj);
      break;
  }
}

async function handleSubscriptionCreated(user: User, subscription: any): Promise<void> {
  const updates: Partial<User> = {
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionStatus: subscription.status,
    stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
  };

  await userDb.updateUser(user.userId, updates);
  console.log(`[Stripe Webhook] subscription.created: user=${user.userId}, sub=${subscription.id}`);
}

async function handleSubscriptionUpdated(user: User, subscription: any): Promise<void> {
  const updates: Partial<User> = {
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionStatus: subscription.status,
    stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
  };

  if (subscription.cancel_at_period_end && subscription.canceled_at) {
    updates.stripeCanceledAt = new Date(subscription.canceled_at * 1000).toISOString();
  }

  await userDb.updateUser(user.userId, updates);
  console.log(`[Stripe Webhook] subscription.updated: user=${user.userId}, status=${subscription.status}`);
}

async function handleSubscriptionDeleted(user: User, subscription: any): Promise<void> {
  const now = new Date().toISOString();
  const updates: Partial<User> = {
    stripeSubscriptionStatus: 'canceled',
    stripeChurnedAt: now,
    stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
  };

  await userDb.updateUser(user.userId, updates);
  await userDb.deactivateUser(user.userId);
  console.log(`[Stripe Webhook] subscription.deleted: user=${user.userId} deactivated`);
}

async function handleSubscriptionResumed(user: User, subscription: any): Promise<void> {
  const updates: Partial<User> = {
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionStatus: 'active',
    stripeCurrentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    isActive: true,
    stripeChurnedAt: '',
    stripeCanceledAt: '',
  };

  await userDb.updateUser(user.userId, updates);
  console.log(`[Stripe Webhook] subscription.resumed: user=${user.userId} reactivated`);
}

async function handleInvoicePaid(user: User, invoice: any): Promise<void> {
  const updates: Partial<User> = {
    stripeLastPaymentAt: new Date().toISOString(),
    stripeLastPaymentAmount: invoice.amount_paid,
    stripeSubscriptionStatus: 'active',
  };

  await userDb.updateUser(user.userId, updates);
  console.log(`[Stripe Webhook] invoice.paid: user=${user.userId}, amount=${invoice.amount_paid}`);
}

async function handleInvoicePaymentFailed(user: User, invoice: any): Promise<void> {
  const updates: Partial<User> = {
    stripeFailedPaymentAt: new Date().toISOString(),
    stripeSubscriptionStatus: 'past_due',
  };

  await userDb.updateUser(user.userId, updates);
  console.log(`[Stripe Webhook] invoice.payment_failed: user=${user.userId}`);
}
