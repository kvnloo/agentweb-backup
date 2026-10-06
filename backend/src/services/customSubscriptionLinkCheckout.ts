import type Stripe from 'stripe';

/**
 * ENG-2304 (slice of ENG-2266): pure builder for Stripe Checkout Session params
 * behind a partner-portal "custom subscription link". No persistence, no
 * network, not wired to a route yet — the caller owns stripe.checkout.sessions.create.
 */

export const CUSTOM_SUBSCRIPTION_LINK_SOURCE = 'custom_subscription_link';
/** Upper bound for a single custom link charge, in USD. */
export const MAX_CUSTOM_LINK_AMOUNT_USD = 50_000;
/** Stripe product names allow more, but keep invoice/receipt lines readable. */
export const MAX_CUSTOM_LINK_LABEL_LENGTH = 120;

export type CustomLinkFrequency = 'one_time' | 'week' | 'month' | 'quarter' | 'year';

export interface CustomSubscriptionLinkInput {
  orgId: string;
  stripeCustomerId?: string;
  /** Used only when no stripeCustomerId exists: prefills checkout and seeds the new customer. */
  customerEmail?: string;
  label: string;
  amountUsd: number;
  frequency: CustomLinkFrequency;
  createdBy: string;
  successUrl: string;
  cancelUrl: string;
}

export class CustomSubscriptionLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomSubscriptionLinkError';
  }
}

const RECURRING: Record<Exclude<CustomLinkFrequency, 'one_time'>, { interval: 'week' | 'month' | 'year'; interval_count: number }> = {
  week: { interval: 'week', interval_count: 1 },
  month: { interval: 'month', interval_count: 1 },
  quarter: { interval: 'month', interval_count: 3 },
  year: { interval: 'year', interval_count: 1 },
};

export function toUnitAmountCents(amountUsd: number): number {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd)) {
    throw new CustomSubscriptionLinkError('amountUsd must be a finite number');
  }
  if (amountUsd <= 0) throw new CustomSubscriptionLinkError('amountUsd must be greater than 0');
  if (amountUsd > MAX_CUSTOM_LINK_AMOUNT_USD) {
    throw new CustomSubscriptionLinkError(`amountUsd exceeds max ${MAX_CUSTOM_LINK_AMOUNT_USD}`);
  }
  const cents = Math.round(amountUsd * 100);
  // Reject >2 decimal places: the rounded cents must reproduce the input exactly.
  if (Math.abs(cents / 100 - amountUsd) > 1e-9) {
    throw new CustomSubscriptionLinkError('amountUsd may have at most 2 decimal places');
  }
  return cents;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CustomSubscriptionLinkError(`${field} is required`);
  }
  return value.trim();
}

export function buildCustomSubscriptionLinkCheckoutParams(
  input: CustomSubscriptionLinkInput,
): Stripe.Checkout.SessionCreateParams {
  const orgId = requireNonEmpty(input.orgId, 'orgId');
  const createdBy = requireNonEmpty(input.createdBy, 'createdBy');
  const label = requireNonEmpty(input.label, 'label');
  if (label.length > MAX_CUSTOM_LINK_LABEL_LENGTH) {
    throw new CustomSubscriptionLinkError(`label exceeds ${MAX_CUSTOM_LINK_LABEL_LENGTH} characters`);
  }
  const successUrl = requireNonEmpty(input.successUrl, 'successUrl');
  const cancelUrl = requireNonEmpty(input.cancelUrl, 'cancelUrl');
  const unitAmount = toUnitAmountCents(input.amountUsd);

  const isOneTime = input.frequency === 'one_time';
  const recurring = isOneTime ? undefined : RECURRING[input.frequency as Exclude<CustomLinkFrequency, 'one_time'>];
  if (!isOneTime && !recurring) {
    throw new CustomSubscriptionLinkError(`unsupported frequency: ${String(input.frequency)}`);
  }

  const metadata: Record<string, string> = {
    source: CUSTOM_SUBSCRIPTION_LINK_SOURCE,
    orgId,
    createdBy,
    linkLabel: label,
    frequency: input.frequency,
  };

  const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
    currency: 'usd',
    unit_amount: unitAmount,
    product_data: { name: label, metadata: { source: CUSTOM_SUBSCRIPTION_LINK_SOURCE } },
    ...(recurring ? { recurring } : {}),
  };

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: isOneTime ? 'payment' : 'subscription',
    line_items: [{ quantity: 1, price_data: priceData }],
    metadata,
    client_reference_id: orgId,
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  // Mirror metadata onto the resulting object so webhooks (out of scope here)
  // can identify custom-link revenue apart from plan line items (ENG-2257).
  if (isOneTime) params.payment_intent_data = { metadata };
  else params.subscription_data = { metadata };

  const stripeCustomerId = input.stripeCustomerId?.trim();
  if (stripeCustomerId) {
    params.customer = stripeCustomerId;
  } else {
    // No existing customer: subscription mode always creates one; payment mode
    // must opt in so the org gets a reusable Stripe customer.
    if (isOneTime) params.customer_creation = 'always';
    const email = input.customerEmail?.trim();
    if (email) params.customer_email = email;
  }

  return params;
}
