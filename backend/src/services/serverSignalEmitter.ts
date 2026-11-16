/**
 * ENG-2684 (ENG-2682 slice 1): server-side billing signals for the hireemma.ai session list.
 *
 * Stripe webhook events (and checkout creation) are mapped to tracking-plan event names and written as
 * `custom` tracker events into the hireemma.ai session list through the SAME ingest path the browser SDK
 * uses (ingestTrackerEvent → upsertSessionLead), so no table, schema or key changes are involved.
 *
 * Keying: one server-side session row per account — sessionId `acct-<userId>`, sessionStartMs = the
 * account's createdAt (stable, so every event for the account lands on the same row). Linking that row
 * to anonymous visitor sessions is ENG-2682's identity-stitching slice, not this one.
 *
 * Contract: fire-and-forget. emitSignal never throws; a missing list, unknown customer or a write failure
 * is logged and swallowed so the Stripe webhook ack is never affected.
 *
 * ENG-2686 adds two more families on the same row/ingest path: app lifecycle (login, onboarding,
 * integration_connected, trial_activated) and engagement with PLATFORM email — mail AgentWeb itself
 * sends to its users, identified by the system sender. Customer-sent email is never emitted.
 */
import type { ParsedIngest } from '../utils/trackingIngest';
import { invoiceSubscriptionId } from '../utils/stripeInvoiceFields';
import { RESEND_SYSTEM_EMAIL } from '../config';

export const DEFAULT_HIREEMMA_SIGNAL_LIST_ID = 'list_1793037224311_9umtchng7';

export const signalListId = (): string =>
  (process.env.HIREEMMA_SIGNAL_LIST_ID || DEFAULT_HIREEMMA_SIGNAL_LIST_ID).trim();

export type BillingSignalName =
  | 'checkout_started'
  | 'payment_completed'
  | 'payment_failed'
  | 'refund_issued'
  | 'subscription_started'
  | 'subscription_renewed'
  | 'subscription_plan_changed'
  | 'subscription_cancelled'
  // ENG-2686: a subscription created in Stripe's `trialing` status.
  | 'trial_activated';

/** ENG-2686: engagement with PLATFORM email (AgentWeb → its own users), never customer-sent email. */
export type EngagementSignalName =
  | 'email_sent'
  | 'email_suppressed'
  | 'email_opened'
  | 'email_clicked'
  | 'email_unsubscribed'
  | 'email_bounced';
// ENG-2740: `retargeting_audience_added` dropped — no platform-owned retargeting audience sync exists.
// Re-add it (one fire-and-forget emit + mocked test) when one ships.

/** ENG-2686: account lifecycle inside the app. */
export type AppSignalName =
  | 'login'
  | 'logout'
  // ENG-2738: a new account was created (password or Google OAuth signup).
  | 'registration_completed'
  | 'trial_activated'
  | 'onboarding_step_completed'
  | 'onboarding_completed'
  | 'onboarding_skipped'
  | 'onboarding_abandoned'
  | 'integration_connected';

export type ServerSignalName = BillingSignalName | EngagementSignalName | AppSignalName;

export interface BillingSignal {
  name: BillingSignalName;
  /** Stripe customer id; resolved to the account by the emitter. */
  stripeCustomerId: string;
  props: Record<string, string | number>;
}

const customerIdOf = (obj: any): string =>
  typeof obj?.customer === 'string' ? obj.customer : typeof obj?.customer?.id === 'string' ? obj.customer.id : '';

// Basil (2025-03-31+) moved invoice.subscription to parent.subscription_details.subscription.
const subscriptionIdOf = (obj: any): string => invoiceSubscriptionId(obj) || '';

const priceIdsOf = (items: any): string =>
  Array.isArray(items?.data) ? items.data.map((i: any) => i?.price?.id).filter(Boolean).sort().join(',') : '';

/**
 * Pure: the billing signals one Stripe event produces (usually one; a renewal invoice is both a
 * payment and a renewal). Returns [] for events outside the tracking plan.
 *
 * Deliberately not mapped:
 *  - checkout.session.completed: the subscription it creates also fires customer.subscription.created,
 *    and the payment fires invoice.paid — mapping it too would double-count both.
 *  - invoice.payment_succeeded when the endpoint also sends invoice.paid: both are mapped because the
 *    endpoint may be configured with either wire format; the session row is last-write-wins on the
 *    event name, so a duplicate delivery re-asserts the same state rather than inflating a counter.
 */
export function mapStripeEventToSignals(event: { id?: string; type?: string; data?: { object?: any; previous_attributes?: any } }): BillingSignal[] {
  const obj = event?.data?.object;
  const customer = customerIdOf(obj);
  if (!obj || !customer) return [];
  const base = { stripeEventId: String(event.id || '') };

  switch (event.type) {
    case 'customer.subscription.created': {
      const props = { ...base, subscriptionId: obj.id || '', status: obj.status || '' };
      const out: BillingSignal[] = [{ name: 'subscription_started', stripeCustomerId: customer, props }];
      if (obj.status === 'trialing') out.push({ name: 'trial_activated', stripeCustomerId: customer, props });
      return out;
    }
    case 'customer.subscription.deleted':
      return [{ name: 'subscription_cancelled', stripeCustomerId: customer, props: { ...base, subscriptionId: obj.id || '' } }];
    case 'customer.subscription.updated': {
      const prevItems = event.data?.previous_attributes?.items;
      if (!prevItems) return [];
      const from = priceIdsOf(prevItems);
      const to = priceIdsOf(obj.items);
      if (!from || from === to) return [];
      return [{ name: 'subscription_plan_changed', stripeCustomerId: customer, props: { ...base, subscriptionId: obj.id || '', fromPrice: from.slice(0, 120), toPrice: to.slice(0, 120) } }];
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const props = { ...base, invoiceId: obj.id || '', subscriptionId: subscriptionIdOf(obj), amount: Number(obj.amount_paid) || 0, currency: obj.currency || 'usd' };
      const out: BillingSignal[] = [{ name: 'payment_completed', stripeCustomerId: customer, props }];
      if (obj.billing_reason === 'subscription_cycle') out.push({ name: 'subscription_renewed', stripeCustomerId: customer, props });
      return out;
    }
    case 'invoice.payment_failed':
      return [{ name: 'payment_failed', stripeCustomerId: customer, props: { ...base, invoiceId: obj.id || '', subscriptionId: subscriptionIdOf(obj), amount: Number(obj.amount_due) || 0, currency: obj.currency || 'usd' } }];
    case 'charge.refunded':
      return [{ name: 'refund_issued', stripeCustomerId: customer, props: { ...base, chargeId: obj.id || '', amount: Number(obj.amount_refunded) || 0, currency: obj.currency || 'usd' } }];
    default:
      return [];
  }
}

export interface EmitterDeps {
  getList: (listId: string) => Promise<Record<string, any> | null | undefined>;
  ingest: (input: { list: Record<string, any>; parsed: ParsedIngest; userAgent: string; visitorIp: string }) => Promise<unknown>;
  findUserByStripeCustomerId: (customerId: string) => Promise<any | null>;
  findUserById: (userId: string) => Promise<any | null>;
  findUserByEmail: (email: string) => Promise<any | null>;
  now: () => number;
  logger: Pick<typeof console, 'warn' | 'error'>;
}

async function defaultDeps(): Promise<EmitterDeps> {
  const { getIngestList, ingestTrackerEvent } = await import('./trackerIngestService');
  const { findUserByStripeCustomerId } = await import('./stripeService');
  const { userDb } = await import('./db');
  return {
    getList: getIngestList,
    ingest: ingestTrackerEvent,
    findUserByStripeCustomerId,
    findUserById: (id) => userDb.getUserById(id),
    findUserByEmail: (email) => userDb.getUserByEmail(email),
    now: Date.now,
    logger: console,
  };
}

/** Pure: the ParsedIngest for one server signal on an account's row. */
export function buildSignalIngest(listId: string, user: { userId: string; createdAt?: string }, name: string, props: Record<string, string | number>, nowMs: number): ParsedIngest {
  const created = Date.parse(user.createdAt || '');
  const lastCustomProps = JSON.stringify(props).slice(0, 500);
  return {
    listId,
    identity: { sessionId: `acct-${user.userId}`, sessionStartMs: Number.isFinite(created) ? created : 0 },
    event: 'custom',
    customName: name,
    // eventCount drives the merge's monotonic journey guard: wall-clock seconds keep later events winning.
    client: { accountId: user.userId, eventCount: Math.floor(nowMs / 1000), lastEvent: `custom:${name}`, lastCustomProps },
    landingUrl: '',
    referrer: '',
    firstTouchLanding: '',
  };
}

/** Writes one signal for an already-resolved account. Never throws. */
export async function emitAccountSignal(
  user: { userId: string; createdAt?: string } | null | undefined,
  name: ServerSignalName,
  props: Record<string, string | number>,
  overrides: Partial<EmitterDeps> = {},
): Promise<boolean> {
  try {
    const deps = { ...(await defaultDeps()), ...overrides };
    if (!user?.userId) return false;
    const listId = signalListId();
    const list = await deps.getList(listId);
    if (!list || list.listType !== 'session') {
      deps.logger.warn(`[serverSignal] list ${listId} missing or not a session list; dropping ${name}`);
      return false;
    }
    await deps.ingest({ list, parsed: buildSignalIngest(listId, user, name, props, deps.now()), userAgent: '', visitorIp: '' });
    return true;
  } catch (err: any) {
    (overrides.logger || console).error(`[serverSignal] ${name} failed: ${err?.message ?? err}`);
    return false;
  }
}

/** Webhook entry point: maps the Stripe event and emits each signal. Never throws. */
export async function emitStripeSignals(event: any, overrides: Partial<EmitterDeps> = {}): Promise<number> {
  try {
    const signals = mapStripeEventToSignals(event);
    if (!signals.length) return 0;
    const deps = { ...(await defaultDeps()), ...overrides };
    const user = await deps.findUserByStripeCustomerId(signals[0].stripeCustomerId);
    if (!user) return 0;
    let n = 0;
    for (const s of signals) if (await emitAccountSignal(user, s.name, s.props, deps)) n++;
    return n;
  } catch (err: any) {
    (overrides.logger || console).error(`[serverSignal] stripe ${event?.type} failed: ${err?.message ?? err}`);
    return 0;
  }
}

// ── ENG-2686: app lifecycle ─────────────────────────────────────────────────────────────────────────

/**
 * Pure: the app signal one persisted onboarding event produces. Lateral (analytics-only) events
 * produce none — they never move the lifecycle, so they don't belong in the funnel either.
 */
export function mapOnboardingEventToSignal(
  event: string,
  lateral: boolean,
): { name: AppSignalName; props: Record<string, string> } | null {
  if (!event || lateral) return null;
  if (event === 'onboarding_completed' || event === 'onboarding_skipped' || event === 'onboarding_abandoned') {
    return { name: event, props: {} };
  }
  return { name: 'onboarding_step_completed', props: { step: event.slice(0, 80) } };
}

/** App entry point: emits for an account object or a userId (resolved; unknown → dropped). Never throws. */
export async function emitAppSignal(
  userOrUserId: { userId: string; createdAt?: string } | string | null | undefined,
  name: AppSignalName,
  props: Record<string, string | number> = {},
  overrides: Partial<EmitterDeps> = {},
): Promise<boolean> {
  try {
    if (!userOrUserId) return false;
    if (typeof userOrUserId !== 'string') return await emitAccountSignal(userOrUserId, name, props, overrides);
    const deps = { ...(await defaultDeps()), ...overrides };
    const user = await deps.findUserById(userOrUserId);
    if (!user) return false;
    return await emitAccountSignal(user, name, props, deps);
  } catch (err: any) {
    (overrides.logger || console).error(`[serverSignal] app ${name} failed: ${err?.message ?? err}`);
    return false;
  }
}

// ── ENG-2686: platform email engagement ─────────────────────────────────────────────────────────────

/** The only sender whose mail is AgentWeb's own platform email (config.RESEND_SYSTEM_EMAIL). */
export const PLATFORM_EMAIL_SENDER = RESEND_SYSTEM_EMAIL.toLowerCase();

const bareEmail = (addr: unknown): string => {
  const s = String(addr || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
};

const RESEND_ENGAGEMENT: Record<string, EngagementSignalName> = {
  'email.sent': 'email_sent',
  'email.suppressed': 'email_suppressed',
  'email.opened': 'email_opened',
  'email.clicked': 'email_clicked',
  'email.bounced': 'email_bounced',
  // A spam complaint is the recipient opting out of our mail; Resend has no separate unsubscribe event.
  'email.complained': 'email_unsubscribed',
};

export interface EngagementSignal {
  name: EngagementSignalName;
  recipient: string;
  props: Record<string, string>;
}

/**
 * Pure: the engagement signal for one Resend webhook event, or null. Only mail sent FROM the
 * platform sender qualifies — anything a customer (or Emma on a customer's behalf) sends to their
 * own contacts is customer data, not hireemma.ai funnel, and is dropped here.
 */
export function mapResendEventToEngagementSignal(event: { type?: string; data?: any }): EngagementSignal | null {
  const name = RESEND_ENGAGEMENT[String(event?.type || '')];
  if (!name || bareEmail(event?.data?.from) !== PLATFORM_EMAIL_SENDER) return null;
  const to = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
  const recipient = bareEmail(to.find(Boolean));
  if (!recipient) return null;
  const props: Record<string, string> = { emailId: String(event.data.email_id || ''), subject: String(event.data.subject || '').slice(0, 120) };
  if (name === 'email_clicked') {
    // Path only: clicked links can carry tokens (e.g. domain-join) in the query string.
    const raw = String(event.data.click?.link || '');
    let linkPath = '';
    try { linkPath = new URL(raw).pathname; } catch { linkPath = raw.split(/[?#]/)[0]; }
    props.link = linkPath.slice(0, 200);
  }
  if (name === 'email_bounced') props.bounceType = String(event.data.bounce?.type || '');
  if (event.type === 'email.complained') props.reason = 'spam_complaint';
  return { name, recipient, props };
}

/**
 * Engagement entry point: resolves the recipient email to an AgentWeb account and emits on its row.
 * No account → dropped (returns false). Never throws.
 */
export async function emitEmailEngagementSignal(
  recipientEmail: string,
  name: EngagementSignalName,
  props: Record<string, string | number> = {},
  overrides: Partial<EmitterDeps> = {},
): Promise<boolean> {
  try {
    const email = bareEmail(recipientEmail);
    if (!email) return false;
    const deps = { ...(await defaultDeps()), ...overrides };
    const user = await deps.findUserByEmail(email);
    if (!user?.userId) return false;
    return await emitAccountSignal(user, name, props, deps);
  } catch (err: any) {
    (overrides.logger || console).error(`[serverSignal] email ${name} failed: ${err?.message ?? err}`);
    return false;
  }
}

/** Resend webhook entry point. Never throws. */
export async function emitResendEngagementSignal(event: any, overrides: Partial<EmitterDeps> = {}): Promise<boolean> {
  try {
    const signal = mapResendEventToEngagementSignal(event);
    if (!signal) return false;
    return await emitEmailEngagementSignal(signal.recipient, signal.name, signal.props, overrides);
  } catch (err: any) {
    (overrides.logger || console).error(`[serverSignal] resend ${event?.type} failed: ${err?.message ?? err}`);
    return false;
  }
}
