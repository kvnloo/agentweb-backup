import { CUSTOM_SUBSCRIPTION_LINK_SOURCE } from './customSubscriptionLinkCheckout';
import { stripeIdOf as idOf } from '../utils/stripeInvoiceFields';

/**
 * ENG-2835 (slice 1): pure trigger decision for the post-payment feedback ask.
 *
 * No storage, no email, not wired into the webhook route. The caller supplies
 * the paid-invoice history and prior asks; this decides whether an `invoice.paid`
 * event for an app-generated custom subscription link should send the ask.
 * Storage (new table) and the outbound email copy are gated follow-ups.
 *
 * Rule: ask on the 2nd consecutive paid invoice of a custom-link subscription
 * (the first renewal, billing_reason === 'subscription_cycle'), at most once per
 * org per 90 days, idempotent on invoice id (Stripe redelivers webhooks).
 */

export const FEEDBACK_ASK_COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000;
export const FEEDBACK_ASK_TARGET_PAID_COUNT = 2;

export interface PriorFeedbackAsk {
  orgId: string;
  invoiceId: string;
  askedAt: number;
}

export interface FeedbackTriggerInput {
  /** The `invoice.paid` event's invoice object (raw Stripe shape). */
  invoice: Record<string, unknown>;
  /**
   * Paid invoices for the same subscription, oldest first, INCLUDING this one.
   * Each entry needs `id` and `status`; anything not `paid` breaks the streak.
   */
  subscriptionInvoices: Array<{ id: string; status: string | null }>;
  priorAsks: PriorFeedbackAsk[];
  now: number;
}

export type FeedbackTriggerDecision =
  | { ask: true; orgId: string; invoiceId: string; subscriptionId: string; idempotencyKey: string }
  | { ask: false; reason: FeedbackSkipReason };

export type FeedbackSkipReason =
  | 'not_custom_link'
  | 'missing_org'
  | 'not_subscription_cycle'
  | 'not_paid'
  | 'not_second_consecutive'
  | 'already_asked_for_invoice'
  | 'org_cooldown';

const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Subscription metadata on an invoice: newer API versions put it under
 * `parent.subscription_details.metadata`, older ones under
 * `subscription_details.metadata`. Invoice-level metadata is the last fallback.
 */
export function invoiceSubscriptionMetadata(invoice: Record<string, unknown>): Record<string, unknown> {
  const parentDetails = obj(obj(invoice.parent).subscription_details);
  const legacyDetails = obj(invoice.subscription_details);
  for (const candidate of [obj(parentDetails.metadata), obj(legacyDetails.metadata), obj(invoice.metadata)]) {
    if (candidate.source !== undefined) return candidate;
  }
  return {};
}

function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  return idOf(obj(obj(invoice.parent).subscription_details).subscription) ?? idOf(invoice.subscription);
}

export function decideFeedbackAsk(input: FeedbackTriggerInput): FeedbackTriggerDecision {
  const { invoice, subscriptionInvoices, priorAsks, now } = input;
  const metadata = invoiceSubscriptionMetadata(invoice);
  if (metadata.source !== CUSTOM_SUBSCRIPTION_LINK_SOURCE) return { ask: false, reason: 'not_custom_link' };

  const orgId = typeof metadata.orgId === 'string' ? metadata.orgId.trim() : '';
  if (!ORG_ID_PATTERN.test(orgId)) return { ask: false, reason: 'missing_org' };

  if (invoice.billing_reason !== 'subscription_cycle') return { ask: false, reason: 'not_subscription_cycle' };
  if (invoice.status !== 'paid') return { ask: false, reason: 'not_paid' };

  const invoiceId = idOf(invoice.id);
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!invoiceId || !subscriptionId) return { ask: false, reason: 'not_second_consecutive' };

  if (priorAsks.some((a) => a.invoiceId === invoiceId)) return { ask: false, reason: 'already_asked_for_invoice' };

  const index = subscriptionInvoices.findIndex((i) => i.id === invoiceId);
  const streak = index >= 0 ? subscriptionInvoices.slice(0, index + 1) : [];
  if (streak.length !== FEEDBACK_ASK_TARGET_PAID_COUNT || streak.some((i) => i.status !== 'paid')) {
    return { ask: false, reason: 'not_second_consecutive' };
  }

  if (priorAsks.some((a) => a.orgId === orgId && now - a.askedAt < FEEDBACK_ASK_COOLDOWN_MS)) {
    return { ask: false, reason: 'org_cooldown' };
  }

  return { ask: true, orgId, invoiceId, subscriptionId, idempotencyKey: `feedback_ask:${invoiceId}` };
}
