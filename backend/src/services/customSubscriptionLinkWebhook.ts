import type Stripe from 'stripe';
import { CUSTOM_SUBSCRIPTION_LINK_SOURCE } from './customSubscriptionLinkCheckout';

/**
 * ENG-2366 (slice B of ENG-2266): pure classifier for Stripe events produced by
 * custom subscription links (slice A, ENG-2304). No DB writes, not wired into
 * the live webhook route — applying the result is gated in ENG-2305.
 *
 * Events whose object metadata lacks `source === CUSTOM_SUBSCRIPTION_LINK_SOURCE`
 * resolve to `not_custom_link`, so existing plan handling is untouched.
 */

export const CUSTOM_LINK_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;

export type CustomLinkEventType = (typeof CUSTOM_LINK_EVENT_TYPES)[number];

export interface CustomLinkResolution {
  kind: 'custom_link';
  eventType: CustomLinkEventType;
  orgId: string;
  /** Slice A stamps `createdBy`, not a separate userId; `metadata.userId` wins when present. */
  userId: string | null;
  linkLabel: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId?: string;
  status: string | null;
  idempotencyKey: string;
}

export type CustomLinkEventResult = CustomLinkResolution | { kind: 'not_custom_link' };

export class CustomLinkWebhookError extends Error {
  constructor(message: string, readonly eventId: string) {
    super(message);
    this.name = 'CustomLinkWebhookError';
  }
}

const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function idOf(ref: unknown): string | null {
  if (typeof ref === 'string') return ref || null;
  if (ref && typeof ref === 'object' && typeof (ref as { id?: unknown }).id === 'string') {
    return (ref as { id: string }).id || null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isHandledType(type: string): type is CustomLinkEventType {
  return (CUSTOM_LINK_EVENT_TYPES as readonly string[]).includes(type);
}

export function resolveCustomLinkEvent(event: Pick<Stripe.Event, 'id' | 'type' | 'data'>): CustomLinkEventResult {
  if (!event || !isHandledType(event.type)) return { kind: 'not_custom_link' };

  const obj = event.data?.object as unknown as Record<string, unknown> | undefined;
  const metadata = (obj?.metadata ?? {}) as Record<string, unknown>;
  if (metadata.source !== CUSTOM_SUBSCRIPTION_LINK_SOURCE) return { kind: 'not_custom_link' };

  const rawOrgId = metadata.orgId;
  if (typeof rawOrgId !== 'string' || !ORG_ID_PATTERN.test(rawOrgId.trim())) {
    throw new CustomLinkWebhookError('custom_link event has missing or malformed orgId metadata', event.id);
  }
  const orgId = rawOrgId.trim();

  const isCheckout = event.type === 'checkout.session.completed';
  const subscriptionId = isCheckout ? idOf(obj?.subscription) : idOf(obj?.id);
  const status = isCheckout
    ? str(obj?.payment_status) ?? str(obj?.status)
    : str(obj?.status);

  // Stripe redelivers a retried event with the same event id, so subscription
  // lifecycle events key on it (distinct updates must not collapse). A checkout
  // session completes once, so it keys on the session id.
  const idempotencyKey = isCheckout
    ? `custom_link:checkout:${idOf(obj?.id) ?? event.id}`
    : `custom_link:${event.type}:${subscriptionId ?? 'nosub'}:${event.id}`;

  return {
    kind: 'custom_link',
    eventType: event.type,
    orgId,
    userId: str(metadata.userId) ?? str(metadata.createdBy),
    linkLabel: str(metadata.linkLabel),
    stripeCustomerId: idOf(obj?.customer),
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    status,
    idempotencyKey,
  };
}
