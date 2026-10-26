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
 */
import type { ParsedIngest } from '../utils/trackingIngest';

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
  | 'subscription_cancelled';

export interface BillingSignal {
  name: BillingSignalName;
  /** Stripe customer id; resolved to the account by the emitter. */
  stripeCustomerId: string;
  props: Record<string, string | number>;
}

const customerIdOf = (obj: any): string =>
  typeof obj?.customer === 'string' ? obj.customer : typeof obj?.customer?.id === 'string' ? obj.customer.id : '';

const subscriptionIdOf = (obj: any): string =>
  typeof obj?.subscription === 'string' ? obj.subscription : obj?.subscription?.id || '';

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
    case 'customer.subscription.created':
      return [{ name: 'subscription_started', stripeCustomerId: customer, props: { ...base, subscriptionId: obj.id || '', status: obj.status || '' } }];
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
  now: () => number;
  logger: Pick<typeof console, 'warn' | 'error'>;
}

async function defaultDeps(): Promise<EmitterDeps> {
  const { getIngestList, ingestTrackerEvent } = await import('./trackerIngestService');
  const { findUserByStripeCustomerId } = await import('./stripeService');
  return { getList: getIngestList, ingest: ingestTrackerEvent, findUserByStripeCustomerId, now: Date.now, logger: console };
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
  name: BillingSignalName,
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
