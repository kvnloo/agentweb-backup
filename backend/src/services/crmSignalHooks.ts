/**
 * CRM Signal Hooks (B2)
 *
 * Thin fire-and-forget wrappers around contactSyncService so call sites
 * (signup, Emma sessions, Stripe webhook) don't have to know about the
 * sync payload shape or error-swallow semantics.
 *
 * Every hook:
 *  - Catches and logs errors (never throws — CRM sync must not break the caller)
 *  - Returns a promise callers can optionally await in tests
 *  - Uses dependency injection for unit testability
 */

import { syncContact as defaultSyncContact } from './contactSyncService';
import type { SyncInput, SyncResult } from './contactSyncService';
import type { AttributionTouch } from '../types/attribution';

export interface SignalHookDeps {
  syncContact?: (input: SyncInput) => Promise<SyncResult>;
  logger?: Pick<typeof console, 'error' | 'warn'>;
}

export interface SignupHookInput {
  userId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  companyName?: string | null;
  signupSource?: string | null;
  isOAuthUser?: boolean;
  createdAt?: string;
  /**
   * Optional attribution blob captured on the signup request. When present,
   * flows through to SyncInput.payload.attribution and gets flattened into
   * the enrolled lead's customFields by signupAutoEnrollService so the CRM
   * Source column + Attribution filter can bucket by channel.
   */
  attribution?: AttributionTouch;
}

export async function onUserSignup(
  input: SignupHookInput,
  deps: SignalHookDeps = {}
): Promise<SyncResult | null> {
  const sync = deps.syncContact || defaultSyncContact;
  const logger = deps.logger || console;

  if (!input.email || !input.userId) {
    logger.warn('[crmSignalHooks.onUserSignup] missing email/userId, skipping');
    return null;
  }

  try {
    const first =
      input.firstName ||
      (input.displayName ? input.displayName.split(' ')[0] : null) ||
      null;
    const last =
      input.lastName ||
      (input.displayName && input.displayName.split(' ').length > 1
        ? input.displayName.split(' ').slice(1).join(' ')
        : null) ||
      null;

    return await sync({
      source: 'signup',
      sourceRecordId: `user-${input.userId}`,
      identity: {
        email: input.email,
        firstName: first,
        lastName: last,
      },
      companyName: input.companyName || null,
      eventType: 'contact.created',
      payload: {
        signupDate: input.createdAt || new Date().toISOString(),
        signupSource: input.signupSource || (input.isOAuthUser ? 'oauth' : 'password'),
        userId: input.userId,
        ...(input.attribution && { attribution: input.attribution }),
      },
    });
  } catch (err: any) {
    logger.error('[crmSignalHooks.onUserSignup] sync failed:', err?.message || err);
    return null;
  }
}

export interface EmmaSessionHookInput {
  sessionId: string;
  userId: string;
  email: string;
  portalType?: string | null;
  sessionType?: string | null;
  pageIdentifier?: string | null;
  createdAt?: string;
}

export async function onEmmaSessionStart(
  input: EmmaSessionHookInput,
  deps: SignalHookDeps = {}
): Promise<SyncResult | null> {
  const sync = deps.syncContact || defaultSyncContact;
  const logger = deps.logger || console;

  if (!input.email || !input.sessionId) {
    logger.warn('[crmSignalHooks.onEmmaSessionStart] missing email/sessionId, skipping');
    return null;
  }

  try {
    return await sync({
      source: 'emma_session',
      sourceRecordId: `emma-session-${input.sessionId}`,
      identity: { email: input.email },
      eventType: 'engagement.emma_session',
      payload: {
        sessionId: input.sessionId,
        userId: input.userId,
        portalType: input.portalType || null,
        sessionType: input.sessionType || null,
        pageIdentifier: input.pageIdentifier || null,
        startedAt: input.createdAt || new Date().toISOString(),
      },
    });
  } catch (err: any) {
    logger.error('[crmSignalHooks.onEmmaSessionStart] sync failed:', err?.message || err);
    return null;
  }
}

export interface StripeSubscriptionHookInput {
  /** Stripe event id — used as the idempotency key (sourceRecordId). */
  eventId: string;
  /** Stripe event type, e.g. 'customer.subscription.updated'. */
  eventType: string;
  /** Customer email from the subscription/customer object. */
  email: string;
  /** Optional richer identity if known. */
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  /** Stripe customer id, for cross-linking. */
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status?: string | null;
  subscriptionType?: string | null;
  mrr?: number | null;
  currentPeriodEnd?: string | null;
  payload?: Record<string, unknown>;
}

function mapStripeEventType(eventType: string): import('./contactEventsDb').ContactEventType {
  switch (eventType) {
    case 'customer.subscription.created':
    case 'checkout.session.completed':
      return 'payment.subscribed';
    case 'customer.subscription.deleted':
      return 'payment.canceled';
    case 'customer.subscription.updated':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
    default:
      return 'payment.updated';
  }
}

/**
 * CRM signal hook for Stripe billing events (B3).
 *
 * Idempotent on the Stripe event id (sourceRecordId = `stripe-<eventId>`),
 * so Stripe's at-least-once delivery is safe.
 */
export async function onStripeSubscriptionEvent(
  input: StripeSubscriptionHookInput,
  deps: SignalHookDeps = {}
): Promise<SyncResult | null> {
  const sync = deps.syncContact || defaultSyncContact;
  const logger = deps.logger || console;

  if (!input.email || !input.eventId) {
    logger.warn('[crmSignalHooks.onStripeSubscriptionEvent] missing email/eventId, skipping');
    return null;
  }

  try {
    return await sync({
      source: 'stripe',
      sourceRecordId: `stripe-${input.eventId}`,
      identity: {
        email: input.email,
        firstName: input.firstName || null,
        lastName: input.lastName || null,
      },
      companyName: input.companyName || null,
      eventType: mapStripeEventType(input.eventType),
      payload: {
        stripeEventType: input.eventType,
        stripeCustomerId: input.stripeCustomerId || null,
        stripeSubscriptionId: input.stripeSubscriptionId || null,
        status: input.status || null,
        subscriptionType: input.subscriptionType || null,
        mrr: input.mrr || null,
        currentPeriodEnd: input.currentPeriodEnd || null,
        ...(input.payload || {}),
      },
    });
  } catch (err: any) {
    logger.error('[crmSignalHooks.onStripeSubscriptionEvent] sync failed:', err?.message || err);
    return null;
  }
}
