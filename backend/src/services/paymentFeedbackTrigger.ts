import { CUSTOM_SUBSCRIPTION_LINK_SOURCE } from './customSubscriptionLinkCheckout';
import { invoiceSubscriptionId, stripeIdOf } from '../utils/stripeInvoiceFields';

/**
 * ENG-2856: pure decision for the post-payment feedback ask on custom
 * subscription links (ENG-2266). Dark: behind PAYMENT_FEEDBACK_ASK_ENABLED
 * (default off) and, when on, the caller only logs the decision — no email,
 * no persistence, no Slack.
 *
 * The ask fires on the 2nd consecutive payment: Stripe marks the first invoice
 * of a subscription `subscription_create` and every renewal `subscription_cycle`,
 * so the first `subscription_cycle` invoice is payment #2. The ledger is keyed
 * per subscription, so a redelivered invoice (or `invoice.paid` +
 * `invoice.payment_succeeded` for the same invoice) never asks twice, and later
 * cycles do not re-ask.
 */

export const PAYMENT_FEEDBACK_ASK_FLAG = 'PAYMENT_FEEDBACK_ASK_ENABLED';

/** Idempotency port. `claim` returns true only the first time a key is seen. */
export interface PaymentFeedbackAskLedger {
  claim(key: string): boolean;
}

export class InMemoryPaymentFeedbackAskLedger implements PaymentFeedbackAskLedger {
  private readonly seen = new Set<string>();

  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export type PaymentFeedbackSkipReason =
  | 'flag_off'
  | 'not_custom_link'
  | 'not_second_payment'
  | 'already_asked';

export type PaymentFeedbackAskDecision =
  | { ask: true; invoiceId: string; subscriptionId: string; orgId: string }
  | { ask: false; reason: PaymentFeedbackSkipReason };

export function isPaymentFeedbackAskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PAYMENT_FEEDBACK_ASK_FLAG] === 'true';
}

type Metadata = Record<string, unknown> | null | undefined;

function subscriptionMetadata(invoice: Record<string, any>): Metadata {
  // Basil moved subscription_details under `parent`; older endpoint versions keep it at the root.
  return invoice.parent?.subscription_details?.metadata ?? invoice.subscription_details?.metadata;
}

export function shouldSendPaymentFeedbackAsk(
  invoice: unknown,
  deps: { enabled: boolean; ledger: PaymentFeedbackAskLedger },
): PaymentFeedbackAskDecision {
  if (!deps.enabled) return { ask: false, reason: 'flag_off' };
  if (!invoice || typeof invoice !== 'object') return { ask: false, reason: 'not_custom_link' };
  const inv = invoice as Record<string, any>;

  const metadata = subscriptionMetadata(inv);
  const orgId = typeof metadata?.orgId === 'string' ? metadata.orgId.trim() : '';
  const subscriptionId = invoiceSubscriptionId(inv);
  const invoiceId = stripeIdOf(inv.id);
  if (metadata?.source !== CUSTOM_SUBSCRIPTION_LINK_SOURCE || !orgId || !subscriptionId || !invoiceId) {
    return { ask: false, reason: 'not_custom_link' };
  }

  if (inv.billing_reason !== 'subscription_cycle') return { ask: false, reason: 'not_second_payment' };

  if (!deps.ledger.claim(`payment_feedback_ask:${subscriptionId}`)) {
    return { ask: false, reason: 'already_asked' };
  }
  return { ask: true, invoiceId, subscriptionId, orgId };
}
