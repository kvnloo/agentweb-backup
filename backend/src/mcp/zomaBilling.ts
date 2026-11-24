/**
 * ENG-3130 / ENG-3131 — the Zoma plan: $50/month including 5,000 successful tool calls, then
 * 1 cent per call, entered through a $1 7-day trial that is required only at the first write
 * that makes ads live (publish/launch). Signup, reads and drafting stay free.
 *
 * Everything is dark until ZOMA_BILLING_ENABLED=true. Prices are Stripe price ids from env;
 * the dollar figures shown to users come from env too (defaults match the plan above).
 *
 * State is DERIVED from Stripe, never stored (data-plane gate): the plan subscription lives
 * on a Zoma-only Stripe customer tagged `metadata.zomaBillingUserId`. That customer is never
 * the user row's `stripe_customer_id` and never carries `metadata.userId`, so the Emma
 * subscription code (tier sync, downgrade detection, PAYG) can never pick it up. Funnel
 * events go to the existing MCP usage-event rows; the day-3 reminder marker is subscription
 * metadata.
 *
 * Overage is billed by Stripe: every successful call is one meter event, and the overage
 * price is a graduated metered price whose first tier (0–5,000 units) is $0.
 */
import crypto from 'crypto';
import type Stripe from 'stripe';
import { getJwtSecret } from '../config/jwt';
import { createStripeClient } from '../services/stripeClientFactory';
import { userDb } from '../services/db';
import { createZomaReferralWebhookHandler, type ZomaReferralWebhookHandler } from '../services/zomaReferralWebhook';
import {
  getMcpUserUsage,
  recordZomaBillingFunnel,
  type McpUserUsage,
  type ZomaBillingFunnelInput,
} from '../services/mcpUsageEventsService';
import { getBackendUrl } from './oauth/authChallenge';
import { ZomaNotReadyError } from './zomaErrors';

export const ZOMA_PLAN_PRODUCT_TAG = 'zoma_plan';
/** Stripe ends a trial that has no payment method a little after trial_end, not at the same second. */
const TRIAL_END_GRACE_S = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export interface ZomaBillingConfig {
  enabled: boolean;
  /** Licensed monthly price ($50). */
  planPriceId?: string;
  /** Metered, graduated price attached to the meter: 0–includedCalls at $0, then overage. */
  overagePriceId?: string;
  /** One-time price ($1) charged when the trial starts. */
  trialFeePriceId?: string;
  meterEventName: string;
  includedCalls: number;
  overageCentsPerCall: number;
  planCents: number;
  trialFeeCents: number;
  trialDays: number;
  /** Day of the trial the "ends soon" email goes out (3). */
  reminderDay: number;
  /** Stripe customer-portal login link (Dashboard → Billing → Customer portal) for cancelling. */
  billingPortalUrl?: string;
}

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getZomaBillingConfig(env: NodeJS.ProcessEnv = process.env): ZomaBillingConfig {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return {
    enabled: env.ZOMA_BILLING_ENABLED === 'true',
    planPriceId: clean(env.ZOMA_STRIPE_PLAN_PRICE_ID),
    overagePriceId: clean(env.ZOMA_STRIPE_OVERAGE_PRICE_ID),
    trialFeePriceId: clean(env.ZOMA_STRIPE_TRIAL_FEE_PRICE_ID),
    meterEventName: clean(env.ZOMA_STRIPE_METER_EVENT_NAME) ?? 'zoma_tool_call',
    includedCalls: intEnv(env.ZOMA_PLAN_INCLUDED_CALLS, 5000),
    overageCentsPerCall: intEnv(env.ZOMA_PLAN_OVERAGE_CENTS_PER_CALL, 1),
    planCents: intEnv(env.ZOMA_PLAN_PRICE_CENTS, 5000),
    trialFeeCents: intEnv(env.ZOMA_TRIAL_FEE_CENTS, 100),
    trialDays: Math.max(1, intEnv(env.ZOMA_TRIAL_DAYS, 7)),
    reminderDay: intEnv(env.ZOMA_TRIAL_REMINDER_DAY, 3),
    billingPortalUrl: clean(env.ZOMA_BILLING_PORTAL_URL),
  };
}

/** Env vars a live deployment still needs; non-empty means checkout cannot be offered. */
export function missingZomaBillingConfig(cfg: ZomaBillingConfig): string[] {
  return [
    ...(!cfg.planPriceId ? ['ZOMA_STRIPE_PLAN_PRICE_ID'] : []),
    ...(!cfg.overagePriceId ? ['ZOMA_STRIPE_OVERAGE_PRICE_ID'] : []),
    ...(!cfg.trialFeePriceId ? ['ZOMA_STRIPE_TRIAL_FEE_PRICE_ID'] : []),
  ];
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

export interface ZomaUsageBill {
  included: number;
  used: number;
  overage: number;
  overageCents: number;
}

/** Included / used / overage for one period. Stripe is the bill of record; this is the same math. */
export function computeZomaUsageBill(usedCalls: number, cfg: Pick<ZomaBillingConfig, 'includedCalls' | 'overageCentsPerCall'>): ZomaUsageBill {
  const used = Math.max(0, Math.floor(usedCalls));
  const overage = Math.max(0, used - cfg.includedCalls);
  return { included: cfg.includedCalls, used, overage, overageCents: overage * cfg.overageCentsPerCall };
}

/**
 * A finished call is billable unless it failed. Thrown calls never reach metering; this
 * covers results that report failure in-band (`success: false`). A PREVIEW (nothing sent
 * yet, by design) and a dispatched write with a read-back verdict are not failures.
 */
export function isBillableResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true;
  const r = result as Record<string, unknown>;
  if (r.success !== false) return true;
  return r.status === 'PREVIEW' || typeof r.verification === 'string';
}

/**
 * Writes that make ads live: Meta status → ACTIVE (CREATE and COPY are always PAUSED), and
 * Google Ads status → ENABLED on CREATE or UPDATE. Everything else — reads, drafts, paused
 * creates, pauses, edits — stays free.
 */
export function isZomaPublishWrite(platform: 'meta' | 'google_ads' | 'x_ads', args: any): boolean {
  if (platform === 'google_ads') return args?.status === 'ENABLED';
  // ENG-3142: creates are always PAUSED. The X write validator coerces `action` with String(), so the paywall
  // must classify the same coerced value: a non-string action (e.g. ["ACTIVATE"]) must not skip it.
  if (platform === 'x_ads') return String(args?.action ?? '') === 'ACTIVATE';
  return String(args?.action ?? '').toUpperCase() === 'UPDATE' && args?.params?.status === 'ACTIVE';
}

export type ZomaPlanStatus = 'none' | Stripe.Subscription.Status;

export interface ZomaPlanState {
  status: ZomaPlanStatus;
  subscriptionId?: string;
  customerId?: string;
  trialStart?: string;
  trialEnd?: string;
  periodStart?: string;
  periodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  /** The $1 fee invoice (the only invoice a trial has) is paid. Stripe can start a trial before it settles. */
  latestInvoicePaid?: boolean;
  /** The user has held a Zoma plan before (a cancelled one counts): no second $1 trial. */
  hadPlan?: boolean;
}

/**
 * `active` is paid by definition (a failed renewal moves the subscription to past_due), so its
 * latest invoice, often a draft for the first hour of a cycle, is not consulted. A `trialing`
 * subscription needs its upfront $1 invoice paid first.
 */
export const planAllowsPublish = (state: ZomaPlanState) =>
  state.status === 'active' || (state.status === 'trialing' && state.latestInvoicePaid === true);

/** A live subscription whose $1 payment has not settled: wait for it, never mint a second plan. */
export const planPaymentPending = (state: ZomaPlanState) => state.status === 'trialing' && !planAllowsPublish(state);

/** A plan that exists but whose payment failed: fix the card on that plan, never buy a second one. */
export const planPaymentFailed = (state: ZomaPlanState) => state.status === 'past_due' || state.status === 'unpaid';

export const PAYMENT_PENDING_MESSAGE =
  'Your Zoma payment is still being confirmed, so nothing went live. Wait a minute and ask again. If it keeps failing, check your card with Stripe.';

export const paymentFailedMessage = (cfg: Pick<ZomaBillingConfig, 'billingPortalUrl'>) =>
  `The last Zoma payment did not go through, so nothing went live. Update your card on the existing plan${cfg.billingPortalUrl ? ` → ${cfg.billingPortalUrl}` : ' (see the payment-failed email from Stripe)'}, then ask again. Do not start a second plan.`;

const isoFromEpoch = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : undefined);

const invoiceIsPaid = (sub: Stripe.Subscription) =>
  typeof sub.latest_invoice === 'object' && sub.latest_invoice !== null && sub.latest_invoice.status === 'paid';

/** Most relevant Zoma plan subscription: one that allows publishing, else the newest. */
export function planStateFromSubscriptions(customerId: string | null, subs: Stripe.Subscription[]): ZomaPlanState {
  const zoma = subs.filter((s) => s.metadata?.product === ZOMA_PLAN_PRODUCT_TAG).sort((a, b) => b.created - a.created);
  // An entitled plan wins over a newer trial whose $1 has not settled; then any live one; then the newest.
  const live = zoma.filter((s) => s.status === 'trialing' || s.status === 'active');
  const sub = live.find((s) => s.status === 'active' || invoiceIsPaid(s)) ?? live[0] ?? zoma[0];
  if (!sub) return { status: 'none', ...(customerId ? { customerId } : {}) };
  const item: any = sub.items?.data?.[0];
  return {
    status: sub.status,
    subscriptionId: sub.id,
    customerId: customerId ?? undefined,
    trialStart: isoFromEpoch(sub.trial_start),
    trialEnd: isoFromEpoch(sub.trial_end),
    periodStart: isoFromEpoch(item?.current_period_start ?? (sub as any).current_period_start),
    periodEnd: isoFromEpoch(item?.current_period_end ?? (sub as any).current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    latestInvoicePaid: invoiceIsPaid(sub),
    // A subscription that never started (incomplete*) is not a used trial.
    hadPlan: zoma.some((s) => s.status !== 'incomplete' && s.status !== 'incomplete_expired'),
  };
}

/** Calendar month (UTC) containing `now`, as [start, end) ISO strings. */
export function calendarMonth(now: number): { start: string; end: string } {
  const d = new Date(now);
  return {
    start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(),
  };
}

/** Billing period for usage: the subscription's current period when there is one, else the UTC month. */
export function usagePeriod(state: ZomaPlanState, now: number): { start: string; end: string } {
  return state.periodStart && state.periodEnd ? { start: state.periodStart, end: state.periodEnd } : calendarMonth(now);
}

// ---------------------------------------------------------------------------------------------
// Stripe-backed operations (all injectable)
// ---------------------------------------------------------------------------------------------

export interface ZomaBillingDeps {
  config: () => ZomaBillingConfig;
  getUser: (userId: string) => Promise<any>;
  findCustomerId: (userId: string) => Promise<string | null>;
  createCustomer: (userId: string) => Promise<string>;
  listSubscriptions: (customerId: string) => Promise<Stripe.Subscription[]>;
  createCheckoutSession: (params: Stripe.Checkout.SessionCreateParams) => Promise<{ id: string; url?: string | null }>;
  retrieveCheckoutSession: (id: string) => Promise<Stripe.Checkout.Session | null>;
  /** An open Zoma plan Checkout for this customer with at least `minLifeMs` left, so one link serves repeat asks. */
  findOpenCheckoutSession: (customerId: string, minLifeMs: number) => Promise<{ id: string } | null>;
  sendMeterEvent: (p: { eventName: string; customerId: string; value: number; identifier: string; timestamp: number }) => Promise<void>;
  searchTrialingSubscriptions: () => Promise<Stripe.Subscription[]>;
  setSubscriptionMetadata: (subscriptionId: string, metadata: Record<string, string>) => Promise<void>;
  sendEmail: (to: string, subject: string, text: string, html: string) => Promise<'sent' | 'suppressed' | 'failed' | void>;
  getUsage: (userId: string, range: { start: string; end: string }) => Promise<McpUserUsage>;
  /** One-line account-level ad performance for the range, or undefined when there is nothing to report. */
  getAdsSummary: (userId: string, range: { start: string; end: string }) => Promise<string | undefined>;
  recordFunnel: (input: ZomaBillingFunnelInput) => Promise<boolean>;
  backendUrl: () => string;
  now: () => number;
}

let stripeClient: Stripe | null = null;
function stripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY).');
    stripeClient = createStripeClient(key);
  }
  return stripeClient;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export const defaultZomaBillingDeps: ZomaBillingDeps = {
  config: () => getZomaBillingConfig(),
  getUser: (userId) => userDb.getUserById(userId),
  async findCustomerId(userId) {
    if (!SAFE_ID.test(userId)) throw new Error('userId has unexpected characters');
    const found = await stripe().customers.search({ query: `metadata['zomaBillingUserId']:'${userId}'`, limit: 10 });
    return found.data.find((c) => !(c as any).deleted)?.id ?? null;
  },
  async createCustomer(userId) {
    // No email on purpose: Emma looks customers up by email alone, and must never adopt this one.
    // The idempotency key collapses concurrent first checkouts while search still lags.
    const customer = await stripe().customers.create(
      { metadata: { zomaBillingUserId: userId, product: ZOMA_PLAN_PRODUCT_TAG } },
      { idempotencyKey: `zoma-plan-customer-${userId}` },
    );
    return customer.id;
  },
  async listSubscriptions(customerId) {
    return (await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 20, expand: ['data.latest_invoice'] })).data;
  },
  async createCheckoutSession(params) {
    const session = await stripe().checkout.sessions.create(params);
    return { id: session.id, url: session.url };
  },
  async findOpenCheckoutSession(customerId, minLifeMs) {
    const open = await stripe().checkout.sessions.list({ customer: customerId, status: 'open', limit: 10 });
    const usable = open.data.find((s) => s.metadata?.product === ZOMA_PLAN_PRODUCT_TAG && s.url && s.expires_at * 1000 - Date.now() > minLifeMs);
    return usable ? { id: usable.id } : null;
  },
  async retrieveCheckoutSession(id) {
    try {
      return await stripe().checkout.sessions.retrieve(id);
    } catch (error: any) {
      if (error?.code === 'resource_missing' || error?.statusCode === 404) return null;
      throw error;
    }
  },
  async sendMeterEvent({ eventName, customerId, value, identifier, timestamp }) {
    await stripe().billing.meterEvents.create({
      event_name: eventName,
      identifier,
      timestamp,
      payload: { stripe_customer_id: customerId, value: String(value) },
    });
  },
  async searchTrialingSubscriptions() {
    const out: Stripe.Subscription[] = [];
    let page: string | undefined;
    do {
      const res = await stripe().subscriptions.search({
        query: `status:'trialing' AND metadata['product']:'${ZOMA_PLAN_PRODUCT_TAG}'`,
        limit: 100,
        ...(page ? { page } : {}),
      });
      out.push(...res.data);
      page = res.has_more ? (res.next_page ?? undefined) : undefined;
    } while (page);
    return out;
  },
  async setSubscriptionMetadata(subscriptionId, metadata) {
    await stripe().subscriptions.update(subscriptionId, { metadata });
  },
  async sendEmail(to, subject, text, html) {
    const { emailService } = await import('../services/emailService');
    return emailService.sendEmail(to, subject, text, html);
  },
  getUsage: (userId, range) => getMcpUserUsage(userId, range),
  async getAdsSummary(userId, range) {
    const [{ getAccountsByUserIdIncludingOrgShared }, { META_PROVIDER }, { runZomaAdsReport }] = await Promise.all([
      import('../services/connectedAccountsDb'), import('./zomaProviders'), import('./zomaAdsReport'),
    ]);
    const now = Date.now();
    const account = (await getAccountsByUserIdIncludingOrgShared(userId)).find((a) => META_PROVIDER.isAdAccount(a) && META_PROVIDER.isUsable(a, now));
    const accountId = account && META_PROVIDER.accountIds(account)[0];
    if (!account || !accountId) return undefined;
    const report = await runZomaAdsReport(account, accountId, { level: 'account', since: range.start.slice(0, 10), until: range.end.slice(0, 10) });
    return report.totals.spend > 0 || report.totals.impressions > 0 ? report.summary : undefined;
  },
  recordFunnel: (input) => recordZomaBillingFunnel(input),
  backendUrl: getBackendUrl,
  now: () => Date.now(),
};

export async function getZomaPlanState(userId: string, deps: Pick<ZomaBillingDeps, 'findCustomerId' | 'listSubscriptions'> = defaultZomaBillingDeps): Promise<ZomaPlanState> {
  const customerId = await deps.findCustomerId(userId);
  if (!customerId) return { status: 'none' };
  return planStateFromSubscriptions(customerId, await deps.listSubscriptions(customerId));
}

/** The pay link the agent relays: our redirect, so opening it records `checkout_started`. */
export function zomaCheckoutRedirectUrl(sessionId: string, deps: Pick<ZomaBillingDeps, 'backendUrl'>): string {
  return `${deps.backendUrl().replace(/\/+$/, '')}/api/zoma/billing/checkout/${encodeURIComponent(sessionId)}`;
}

/**
 * Mint the $1 → 7-day trial → $50/month Checkout (subscription mode). The one-time trial fee
 * is charged at checkout; the plan and the metered overage start billing when the trial ends.
 */
export async function createZomaTrialCheckoutLink(userId: string, deps: ZomaBillingDeps = defaultZomaBillingDeps): Promise<string> {
  const cfg = deps.config();
  const missing = missingZomaBillingConfig(cfg);
  if (missing.length) throw new Error(`Zoma billing is enabled but not configured: ${missing.join(', ')}`);
  const user = await deps.getUser(userId);
  if (!user) throw new ZomaNotReadyError('No AgentWeb account was found for this login.');
  const customerId = (await deps.findCustomerId(userId)) ?? (await deps.createCustomer(userId));
  // A second open session would let one user buy two plans (two $1 charges, two metered subscriptions).
  const reusable = await deps.findOpenCheckoutSession(customerId, 60 * 60 * 1000);
  if (reusable) return zomaCheckoutRedirectUrl(reusable.id, deps);
  const done = `${deps.backendUrl().replace(/\/+$/, '')}/api/zoma/billing/done`;
  const metadata = { product: ZOMA_PLAN_PRODUCT_TAG, userId };
  // The $1 trial is once per user: someone who already had a plan buys the plan itself, starting today.
  const returning = planStateFromSubscriptions(customerId, await deps.listSubscriptions(customerId)).hadPlan === true;
  const terms = `${dollars(cfg.planCents)}/month with ${cfg.includedCalls.toLocaleString('en-US')} calls included and ${cfg.overageCentsPerCall}¢ per call after that.`;
  const session = await deps.createCheckoutSession({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: userId,
    line_items: [
      { price: cfg.planPriceId!, quantity: 1 },
      { price: cfg.overagePriceId! },
      ...(returning ? [] : [{ price: cfg.trialFeePriceId!, quantity: 1 }]),
    ],
    payment_method_collection: 'always',
    // Prices are quoted in USD everywhere (tool text, email); do not let Checkout show a converted amount.
    adaptive_pricing: { enabled: false },
    subscription_data: {
      ...(returning ? {} : {
        trial_period_days: cfg.trialDays,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } },
      }),
      metadata,
    },
    metadata,
    success_url: `${done}?result=paid`,
    cancel_url: zomaCheckoutCancelUrl(done, userId),
    // Stripe allows 30 min – 24 h; the agent may relay the link a while after minting it.
    expires_at: Math.floor(deps.now() / 1000) + 23 * 60 * 60,
    custom_text: {
      submit: {
        message: returning
          ? `${terms} Billed monthly. Cancel any time.`
          : `${dollars(cfg.trialFeeCents)} today for a ${cfg.trialDays}-day trial. Then ${terms} Cancel any time before the trial ends.`,
      },
    },
  });
  if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
  return zomaCheckoutRedirectUrl(session.id, deps);
}

// Stripe does not substitute the session id into cancel_url, so the cancel redirect carries the
// user id with an HMAC. The signature stops anyone from inflating another user's cancel count.
const cancelSignature = (userId: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(`zoma-checkout-cancel:${userId}`).digest('hex').slice(0, 32);

export function zomaCheckoutCancelUrl(doneUrl: string, userId: string, secret: string = getJwtSecret()): string {
  return `${doneUrl}?${new URLSearchParams({ result: 'canceled', u: userId, s: cancelSignature(userId, secret) })}`;
}

/** The user landed on the cancel redirect: they left Stripe at card entry. At most once per hour. */
export async function recordZomaCheckoutCanceled(
  query: { u?: unknown; s?: unknown },
  deps: Pick<ZomaBillingDeps, 'recordFunnel'> = defaultZomaBillingDeps,
  now: number = Date.now(),
  secret: string = getJwtSecret(),
): Promise<boolean> {
  const userId = typeof query.u === 'string' ? query.u : '';
  const given = Buffer.from(typeof query.s === 'string' ? query.s : '');
  const expected = Buffer.from(userId ? cancelSignature(userId, secret) : '');
  if (!userId || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  return deps.recordFunnel({ userId, step: 'checkout_canceled', dedupeKey: `${userId}#${new Date(now).toISOString().slice(0, 13)}`, dimensions: { surface: 'cancel_redirect' } });
}

export function paywallMessage(cfg: ZomaBillingConfig, link: string, returning = false): string {
  const calls = `${cfg.includedCalls.toLocaleString('en-US')} calls included, then ${cfg.overageCentsPerCall}¢ per call`;
  return [
    returning
      ? `Going live needs the Zoma plan: ${dollars(cfg.planCents)}/month, charged today → ${link}`
      : `Going live needs the Zoma plan. Start it with a ${dollars(cfg.trialFeeCents)} ${cfg.trialDays}-day trial → ${link}`,
    returning
      ? `That is ${calls}. Cancel any time. Nothing was changed in the ad account.`
      : `After the trial your card is charged ${dollars(cfg.planCents)}/month automatically (cancel before day ${cfg.trialDays} to avoid it), with ${calls}. Reads and drafts are free until you start the plan, after which every successful call, reads included, counts toward the included calls. Nothing was changed in the ad account.`,
    'Tell me when it is done and I will try again.',
  ].join('\n');
}

export class ZomaPaywallError extends ZomaNotReadyError {
  readonly link?: string;
  constructor(message: string, link?: string) {
    super(message);
    this.name = 'ZomaPaywallError';
    this.link = link;
  }
}

/**
 * The paywall for writes that make ads live. No-op while billing is off. Fails closed: an
 * unreadable plan state never lets an ad go live.
 */
export async function assertZomaPublishAllowed(
  userId: string,
  context: { platform: string; toolName?: string },
  deps: ZomaBillingDeps = defaultZomaBillingDeps,
): Promise<void> {
  const cfg = deps.config();
  if (!cfg.enabled) return;
  let state: ZomaPlanState;
  try {
    state = await getZomaPlanState(userId, deps);
  } catch (error) {
    console.error('[zoma-billing] plan check failed:', error instanceof Error ? error.message : error);
    throw new ZomaPaywallError('Could not check the Zoma plan right now, so nothing went live. Try again shortly.');
  }
  if (planAllowsPublish(state)) return;
  if (planPaymentPending(state)) throw new ZomaPaywallError(PAYMENT_PENDING_MESSAGE);
  if (planPaymentFailed(state)) throw new ZomaPaywallError(paymentFailedMessage(cfg));
  let link: string | undefined;
  try {
    link = await createZomaTrialCheckoutLink(userId, deps);
  } catch (error) {
    console.error('[zoma-billing] checkout link failed:', error instanceof Error ? error.message : error);
  }
  void deps.recordFunnel({
    userId,
    step: 'paywall_shown',
    dedupeKey: `write_guard#${new Date(deps.now()).toISOString().slice(0, 13)}`,
    dimensions: { surface: 'write_guard', platform: context.platform, toolName: context.toolName, planStatus: state.status },
  }).catch((e) => console.error('[zoma-billing] funnel record failed:', e));
  if (!link) throw new ZomaPaywallError('Going live needs the Zoma plan, but the payment link could not be created right now. Nothing was changed. Try again shortly.');
  throw new ZomaPaywallError(paywallMessage(cfg, link, state.hadPlan === true), link);
}

// ---------------------------------------------------------------------------------------------
// zoma_status / zoma_usage
// ---------------------------------------------------------------------------------------------

export interface ZomaPlanSummary {
  status: ZomaPlanStatus;
  publish_enabled: boolean;
  trial_ends_at?: string;
  /** Cancelled: the plan ends at the end of the current period and will not renew. */
  cancels_at_period_end?: boolean;
  period?: { start: string; end: string };
  link?: string;
  /** Had a plan before: the link sells the plan itself, with no trial. */
  returning?: boolean;
  error?: string;
}

/** zoma_status plan section. Mints a pay link only when there is no plan that allows publishing. */
export async function getZomaPlanSummary(userId: string, deps: ZomaBillingDeps = defaultZomaBillingDeps): Promise<ZomaPlanSummary | undefined> {
  const cfg = deps.config();
  if (!cfg.enabled) return undefined;
  try {
    const state = await getZomaPlanState(userId, deps);
    const summary: ZomaPlanSummary = {
      status: state.status,
      publish_enabled: planAllowsPublish(state),
      ...(state.status === 'trialing' && state.trialEnd ? { trial_ends_at: state.trialEnd } : {}),
      ...(state.cancelAtPeriodEnd ? { cancels_at_period_end: true } : {}),
      ...(state.hadPlan ? { returning: true } : {}),
      ...(state.periodStart && state.periodEnd ? { period: { start: state.periodStart, end: state.periodEnd } } : {}),
    };
    if (planPaymentPending(state)) {
      summary.error = PAYMENT_PENDING_MESSAGE;
    } else if (planPaymentFailed(state)) {
      summary.error = paymentFailedMessage(cfg);
    } else if (!summary.publish_enabled) {
      summary.link = await createZomaTrialCheckoutLink(userId, deps);
      void deps.recordFunnel({ userId, step: 'paywall_shown', dedupeKey: `zoma_status#${new Date(deps.now()).toISOString().slice(0, 13)}`, dimensions: { surface: 'zoma_status', planStatus: state.status } })
        .catch((e) => console.error('[zoma-billing] funnel record failed:', e));
    }
    return summary;
  } catch (error) {
    console.error('[zoma-billing] plan summary failed:', error instanceof Error ? error.message : error);
    return { status: 'none', publish_enabled: false, error: 'Could not check the Zoma plan right now. Try zoma_status again shortly.' };
  }
}

export function formatZomaPlanLine(plan: ZomaPlanSummary, cfg: ZomaBillingConfig): string {
  const box = plan.publish_enabled ? '[x]' : '[ ]';
  if (plan.error) return `  ${box} Zoma plan (needed to make ads live): ${plan.error}`;
  if (plan.status === 'trialing') {
    const until = plan.trial_ends_at ? ` until ${plan.trial_ends_at.slice(0, 10)}` : '';
    return plan.cancels_at_period_end
      ? `  [x] Zoma plan: trial${until}, cancelled, it will not renew`
      : `  [x] Zoma plan: trial${until}, then ${dollars(cfg.planCents)}/month`;
  }
  if (plan.status === 'active') {
    return plan.cancels_at_period_end
      ? `  [x] Zoma plan: active until ${plan.period?.end.slice(0, 10) ?? 'the end of the period'}, cancelled, it will not renew`
      : `  [x] Zoma plan: active (${dollars(cfg.planCents)}/month, ${cfg.includedCalls.toLocaleString('en-US')} calls included)`;
  }
  return plan.returning
    ? `  ${box} Zoma plan (needed to make ads live): ${dollars(cfg.planCents)}/month → ${plan.link}`
    : `  ${box} Zoma plan (only needed to make ads live; reads and drafts are free until you start it): ${dollars(cfg.trialFeeCents)} ${cfg.trialDays}-day trial → ${plan.link}`;
}

export interface ZomaBillingUsage {
  plan: ZomaPlanStatus;
  period: { start: string; end: string };
  included: number;
  used: number;
  overage: number;
  overage_cents: number;
  overage_cents_per_call: number;
  plan_price_cents: number;
}

/** zoma_usage billing block: calls in the plan's current period (or the UTC month without one). */
export async function getZomaBillingUsage(userId: string, deps: ZomaBillingDeps = defaultZomaBillingDeps): Promise<ZomaBillingUsage | undefined> {
  const cfg = deps.config();
  if (!cfg.enabled) return undefined;
  const state = await getZomaPlanState(userId, deps).catch((error) => {
    console.error('[zoma-billing] plan read failed:', error instanceof Error ? error.message : error);
    return { status: 'none' } as ZomaPlanState;
  });
  const period = usagePeriod(state, deps.now());
  const usage = await deps.getUsage(userId, period);
  const bill = computeZomaUsageBill(usage.toolCalls, cfg);
  return {
    plan: state.status,
    period,
    included: bill.included,
    used: bill.used,
    overage: bill.overage,
    overage_cents: bill.overageCents,
    overage_cents_per_call: cfg.overageCentsPerCall,
    plan_price_cents: cfg.planCents,
  };
}

export function formatZomaBillingUsage(b: ZomaBillingUsage): string[] {
  return [
    `Zoma plan: ${b.plan === 'none' ? 'not started (reads and drafts are free)' : b.plan}`,
    `  Billing period: ${b.period.start.slice(0, 10)} → ${b.period.end.slice(0, 10)}`,
    `  Successful calls: ${b.used.toLocaleString('en-US')} of ${b.included.toLocaleString('en-US')} included`,
    `  Overage: ${b.overage.toLocaleString('en-US')} calls × ${b.overage_cents_per_call}¢ = ${dollars(b.overage_cents)}`,
  ];
}

// ---------------------------------------------------------------------------------------------
// Metering: one Stripe meter event per successful call
// ---------------------------------------------------------------------------------------------

const NO_CUSTOMER_TTL_MS = 5 * 60 * 1000;
const customerCache = new Map<string, { id: string | null; checkedAt: number }>();

export function resetZomaBillingCacheForTests() {
  customerCache.clear();
}

/**
 * Report one successful Zoma call to the Stripe meter. Only users who have a Zoma billing
 * customer (they opened checkout) can be billed, so others are skipped; a found customer is
 * cached for the process, a miss for five minutes. Stripe bills only usage inside a live
 * subscription period, so events before the plan starts cost nothing.
 */
export async function reportZomaBillableCall(
  userId: string,
  identifier: string,
  deps: ZomaBillingDeps = defaultZomaBillingDeps,
): Promise<boolean> {
  const cfg = deps.config();
  if (!cfg.enabled) return false;
  const now = deps.now();
  let cached = customerCache.get(userId);
  if (!cached || (cached.id === null && now - cached.checkedAt > NO_CUSTOMER_TTL_MS)) {
    cached = { id: await deps.findCustomerId(userId), checkedAt: now };
    customerCache.set(userId, cached);
  }
  if (!cached.id) return false;
  await deps.sendMeterEvent({ eventName: cfg.meterEventName, customerId: cached.id, value: 1, identifier, timestamp: Math.floor(now / 1000) });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------

function subscriptionMetadataOfInvoice(invoice: any): Record<string, string> | undefined {
  return invoice?.parent?.subscription_details?.metadata ?? invoice?.subscription_details?.metadata ?? undefined;
}

/** True for any Stripe object that belongs to the Zoma plan (session, subscription or its invoice). */
export function isZomaPlanObject(obj: any): boolean {
  return obj?.metadata?.product === ZOMA_PLAN_PRODUCT_TAG || subscriptionMetadataOfInvoice(obj)?.product === ZOMA_PLAN_PRODUCT_TAG;
}

/** Built on first use so importing this module never opens a Stripe or DynamoDB client. */
let defaultReferralHandler: ZomaReferralWebhookHandler | undefined;

/**
 * Handle a Zoma plan Stripe event. Returns true when the event belonged to the plan, in which
 * case the caller must skip the Emma subscription handlers (they would sync the user row's
 * tier from a price they do not know). Funnel rows are keyed on the Stripe event id, so
 * retries never double count. Not gated on ZOMA_BILLING_ENABLED: a plan object that exists
 * must never reach the Emma handlers.
 */
export async function handleZomaBillingWebhookEvent(
  event: Pick<Stripe.Event, 'id' | 'type' | 'created'> & { data: { object: any; previous_attributes?: any } },
  deps: Pick<ZomaBillingDeps, 'recordFunnel'> = defaultZomaBillingDeps,
  referral: ZomaReferralWebhookHandler = (defaultReferralHandler ??= createZomaReferralWebhookHandler({ isZomaPlanObject })),
): Promise<boolean> {
  const obj = event.data.object;
  // A credit note carries no plan metadata, so it is matched to a Zoma invoice inside the handler
  // (ENG-3132, dark behind ZOMA_REFERRAL_ENABLED). It still falls through to the Emma path, which ignores it.
  if (event.type === 'credit_note.created' || event.type === 'credit_note.voided') {
    await (event.type === 'credit_note.created' ? referral.onCreditNoteCreated(obj) : referral.onCreditNoteVoided(obj));
    return false;
  }
  if (!isZomaPlanObject(obj)) return false;
  const userId: string | undefined = obj?.metadata?.userId ?? subscriptionMetadataOfInvoice(obj)?.userId;
  if (!userId) return true;
  const record = (step: ZomaBillingFunnelInput['step'], dimensions: Record<string, unknown> = {}) =>
    deps.recordFunnel({ userId, step, dedupeKey: event.id, now: new Date(event.created * 1000), dimensions });

  switch (event.type) {
    case 'checkout.session.completed': {
      const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer?.id;
      if (customer) customerCache.set(userId, { id: customer, checkedAt: Date.now() });
      await record('paid', { sessionId: obj.id, amountTotal: obj.amount_total });
      break;
    }
    case 'checkout.session.expired':
      // Not a user action: the 23h session lapsed unused. The cancel redirect records checkout_canceled.
      await record('checkout_expired', { sessionId: obj.id });
      break;
    case 'customer.subscription.updated':
      if (event.data.previous_attributes?.status === 'trialing' && obj.status === 'active') {
        await record('trial_converted', { subscriptionId: obj.id });
      }
      break;
    case 'customer.subscription.deleted': {
      const endedInTrial = typeof obj.trial_end === 'number' && typeof obj.ended_at === 'number' && obj.ended_at <= obj.trial_end + TRIAL_END_GRACE_S;
      await record(endedInTrial ? 'trial_canceled' : 'subscription_canceled', { subscriptionId: obj.id });
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      // Both fire per payment; commission is keyed on the invoice id, so the second is a no-op (ENG-3132).
      await referral.onInvoicePaid(obj);
      break;
    default:
      // subscription.created, other invoice events etc.: Stripe owns the state; nothing to mirror.
      break;
  }
  return true;
}

/**
 * GET /api/zoma/billing/checkout/:id — record `checkout_started` once per session and send the
 * browser to Stripe. Only open Zoma plan sessions redirect.
 */
export async function openZomaCheckout(
  sessionId: string,
  deps: Pick<ZomaBillingDeps, 'retrieveCheckoutSession' | 'recordFunnel' | 'findCustomerId' | 'listSubscriptions'> = defaultZomaBillingDeps,
): Promise<{ kind: 'redirect'; url: string } | { kind: 'gone' | 'not_found' }> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { kind: 'not_found' };
  const session = await deps.retrieveCheckoutSession(sessionId);
  if (!session || session.metadata?.product !== ZOMA_PLAN_PRODUCT_TAG) return { kind: 'not_found' };
  if (session.status !== 'open' || !session.url) return { kind: 'gone' };
  const userId = session.metadata?.userId;
  // A link minted before the user subscribed stays open for 23h; completing it would start a second plan.
  if (userId && ['trialing', 'active'].includes((await getZomaPlanState(userId, deps)).status)) return { kind: 'gone' };
  if (userId) {
    await deps.recordFunnel({ userId, step: 'checkout_started', dedupeKey: session.id, now: new Date(session.created * 1000) })
      .catch((e) => console.error('[zoma-billing] funnel record failed:', e));
  }
  return { kind: 'redirect', url: session.url };
}

// ---------------------------------------------------------------------------------------------
// Day-3 "trial ends soon" email
// ---------------------------------------------------------------------------------------------

export const TRIAL_REMINDER_METADATA_KEY = 'zoma_trial_reminder_sent_at';

/** Due once the trial is `reminderDay` days old, not yet sent, and the trial has not ended. */
export function trialReminderDue(sub: Pick<Stripe.Subscription, 'status' | 'trial_start' | 'trial_end' | 'metadata' | 'cancel_at_period_end'>, now: number, reminderDay: number): boolean {
  if (sub.status !== 'trialing' || !sub.trial_start || !sub.trial_end) return false;
  // They already cancelled: "cancel before you are charged" would be wrong and unwelcome.
  if (sub.cancel_at_period_end) return false;
  if (sub.metadata?.[TRIAL_REMINDER_METADATA_KEY]) return false;
  return now >= sub.trial_start * 1000 + reminderDay * DAY_MS && now < sub.trial_end * 1000;
}

export function trialReminderEmail(input: { usage: McpUserUsage; adsSummary?: string; trialEnd: string; cfg: ZomaBillingConfig }) {
  const { usage, cfg, adsSummary } = input;
  const kinds = usage.recentWrites.length ? `\nRecent changes: ${usage.recentWrites.map((w) => `${w.action ?? ''} ${w.entityType ?? ''}`.trim()).join(', ')}.` : '';
  const endDate = input.trialEnd.slice(0, 10);
  const summary = [
    `Since your trial started, Zoma ran ${usage.toolCalls.toLocaleString('en-US')} successful calls for you`,
    `and sent ${usage.writes.total} change(s) to your ad accounts (${usage.writes.confirmed} confirmed by read-back).${kinds}`,
  ].join(' ');
  const subject = `Your Zoma trial ends on ${endDate}`;
  const text = [
    'Hi,',
    '',
    `Your Zoma trial ends on ${endDate} (UTC). Unless you cancel before then, your card is charged automatically for the plan: ${dollars(cfg.planCents)}/month with ${cfg.includedCalls.toLocaleString('en-US')} calls included and ${cfg.overageCentsPerCall}¢ per call after that.`,
    '',
    ...(adsSummary ? [`How your ads are doing: ${adsSummary}`, ''] : []),
    summary,
    '',
    cfg.billingPortalUrl
      ? `To keep going, do nothing. To cancel before you are charged: ${cfg.billingPortalUrl}`
      : 'To keep going, do nothing. To cancel before you are charged, reply to this email.',
  ].join('\n');
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
  const html = text.split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return { subject, text, html };
}

/**
 * Hourly job: email every Zoma trial on its reminder day, once.
 *
 * Each pass first claims the (subscription, hour) with a conditional funnel write, so only one
 * backend instance sends in a given hour, then puts the "sent" marker on the subscription, then
 * sends (`sendEmail` never throws; it reports 'sent' | 'suppressed' | 'failed'). A failed send
 * removes the marker so the next pass retries; a delivered one is never repeated.
 */
export async function runZomaTrialReminders(deps: ZomaBillingDeps = defaultZomaBillingDeps): Promise<{ checked: number; sent: number }> {
  const cfg = deps.config();
  if (!cfg.enabled) return { checked: 0, sent: 0 };
  const now = deps.now();
  const hour = new Date(now).toISOString().slice(0, 13);
  const subs = await deps.searchTrialingSubscriptions();
  let sent = 0;
  for (const sub of subs) {
    if (sub.metadata?.product !== ZOMA_PLAN_PRODUCT_TAG || !trialReminderDue(sub, now, cfg.reminderDay)) continue;
    const userId = sub.metadata?.userId;
    try {
      const user = userId ? await deps.getUser(userId) : null;
      if (!user?.email) continue;
      const claimed = await deps.recordFunnel({ userId: userId!, step: 'trial_reminder_claimed', dedupeKey: `${sub.id}#${hour}`, dimensions: { subscriptionId: sub.id } });
      if (!claimed) continue;
      // The marker is written BEFORE the send: if this write fails nothing is sent (retried next hour), so a
      // marker that cannot be stored can never turn into one email per hour. A failed send removes it again.
      await deps.setSubscriptionMetadata(sub.id, { [TRIAL_REMINDER_METADATA_KEY]: new Date(now).toISOString() });
      const range = { start: new Date(sub.trial_start! * 1000).toISOString(), end: new Date(now).toISOString() };
      const [usage, adsSummary] = await Promise.all([
        deps.getUsage(userId!, range),
        deps.getAdsSummary(userId!, range).catch((e) => { console.error('[zoma-billing] ads summary failed:', e instanceof Error ? e.message : e); return undefined; }),
      ]);
      const email = trialReminderEmail({ usage, adsSummary, trialEnd: new Date(sub.trial_end! * 1000).toISOString(), cfg });
      const outcome = await deps.sendEmail(user.email, email.subject, email.text, email.html);
      if (outcome === 'failed') {
        console.error(`[zoma-billing] trial reminder for ${sub.id} was not delivered; retrying next pass`);
        // Stripe drops a metadata key set to ''. If this fails the user misses the email, but never gets two.
        await deps.setSubscriptionMetadata(sub.id, { [TRIAL_REMINDER_METADATA_KEY]: '' })
          .catch((e) => console.error('[zoma-billing] could not clear the reminder marker:', e instanceof Error ? e.message : e));
        continue;
      }
      // 'suppressed' is the non-prod mail guard: nothing left the box, so it is done but not counted.
      if (outcome !== 'sent') continue;
      sent += 1;
      await deps.recordFunnel({ userId: userId!, step: 'trial_reminder_sent', dedupeKey: sub.id, dimensions: { subscriptionId: sub.id } })
        .catch((e) => console.error('[zoma-billing] funnel record failed:', e));
    } catch (error) {
      console.error(`[zoma-billing] trial reminder failed for ${sub.id}:`, error instanceof Error ? error.message : error);
    }
  }
  return { checked: subs.length, sent };
}
