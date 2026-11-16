/**
 * ENG-668 PR-2 — month-end pay-as-you-go settlement through Stripe, and the webhooks after it.
 *
 * The owner's AW-Users row is real state here: every conditional write settlement makes is evaluated
 * against it (helpers/userRowFake.ts), so "a rerun is a no-op", "pending is written before Stripe" and
 * "only the first failure suspends" are proven by the row, not by the arguments handed to a mock.
 * Stripe is a fake that honours idempotency keys (and lets them expire, like Stripe after 24h).
 */

// ── Stripe: a fake that replays idempotent writes and can lose a response ────────────────────────────
type FakeInvoice = {
  id: string;
  object: 'invoice';
  customer: string;
  status: 'draft' | 'open' | 'paid' | 'void';
  metadata: Record<string, string>;
  total: number;
  default_payment_method?: string;
  hosted_invoice_url: string;
  lines: { data: Array<{ amount: number; metadata: Record<string, string> }> };
  [key: string]: unknown;
};
const mockStripeState = {
  invoices: new Map<string, FakeInvoice>(),
  keys: new Map<string, unknown>(),
  seq: 0,
  /** Throw AFTER performing the next call of this kind, as if the response were lost. */
  loseResponse: new Set<string>(),
  /** A customer-level discount Stripe applies to every line (what makes a total differ from the item). */
  discountCents: 0,
  /** Refunds Stripe holds per charge (`refunds.list`). */
  refunds: new Map<string, Array<{ id: string; amount: number; status: string; currency?: string; created?: number }>>(),
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
type StripeOpts = { idempotencyKey?: string } | undefined;
type InvoiceParams = {
  customer: string;
  metadata?: Record<string, string>;
  default_payment_method?: string;
  auto_advance?: boolean;
  collection_method?: string;
  pending_invoice_items_behavior?: string;
};
function mockIdempotent<T>(kind: string, key: string | undefined, run: () => T): T {
  if (!key) throw new Error(`fake stripe: ${kind} without an idempotency key`);
  if (mockStripeState.keys.has(key)) return clone(mockStripeState.keys.get(key)) as T;
  const result = run();
  mockStripeState.keys.set(key, clone(result));
  if (mockStripeState.loseResponse.delete(kind)) throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });
  return result;
}
const mockStripe = {
  invoices: {
    create: jest.fn(async (params: InvoiceParams, opts: StripeOpts) => mockIdempotent('invoices.create', opts?.idempotencyKey, () => {
      const invoice: FakeInvoice = {
        id: `in_${++mockStripeState.seq}`,
        object: 'invoice',
        customer: params.customer,
        status: 'draft',
        metadata: { ...params.metadata },
        total: 0,
        ...(params.default_payment_method ? { default_payment_method: params.default_payment_method } : {}),
        hosted_invoice_url: `https://invoice.stripe.com/i/${mockStripeState.seq}`,
        lines: { data: [] },
        created: Math.floor(Date.now() / 1000),
        auto_advance: params.auto_advance,
        collection_method: params.collection_method,
        pending_invoice_items_behavior: params.pending_invoice_items_behavior,
      };
      mockStripeState.invoices.set(invoice.id, invoice);
      return clone(invoice);
    })),
    retrieve: jest.fn(async (id: string) => {
      const invoice = mockStripeState.invoices.get(id);
      if (!invoice) throw Object.assign(new Error(`No such invoice: '${id}'`), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 });
      return clone(invoice);
    }),
    search: jest.fn(async ({ query }: { query: string }) => {
      const wanted = [...query.matchAll(/metadata\['(\w+)'\]:'([^']+)'/g)].map(([, k, v]) => [k, v]);
      return {
        data: [...mockStripeState.invoices.values()]
          .filter((i) => wanted.length > 0 && wanted.every(([k, v]) => i.metadata[k] === v))
          .map(clone),
      };
    }),
    del: jest.fn(async (id: string) => {
      if (mockStripeState.invoices.get(id)?.status !== 'draft') throw new Error('only drafts can be deleted');
      mockStripeState.invoices.delete(id);
      return { id, object: 'invoice', deleted: true };
    }),
    finalizeInvoice: jest.fn(async (id: string, params: { auto_advance?: boolean } | undefined, opts: StripeOpts) => mockIdempotent('invoices.finalize', opts?.idempotencyKey, () => {
      const invoice = mockStripeState.invoices.get(id)!;
      invoice.status = 'open';
      invoice.auto_advance = params?.auto_advance;
      return clone(invoice);
    })),
    list: jest.fn(),
    update: jest.fn(async (id: string, params: { default_payment_method?: string }) => {
      const invoice = mockStripeState.invoices.get(id)!;
      Object.assign(invoice, params);
      return clone(invoice);
    }),
  },
  invoiceItems: {
    create: jest.fn(async (params: { invoice: string; amount: number; metadata?: Record<string, string> }, opts: StripeOpts) => mockIdempotent('invoiceItems.create', opts?.idempotencyKey, () => {
      const invoice = mockStripeState.invoices.get(params.invoice)!;
      invoice.lines.data.push({ amount: params.amount, metadata: { ...params.metadata } });
      invoice.total += params.amount - mockStripeState.discountCents;
      return { id: `ii_${++mockStripeState.seq}`, invoice: params.invoice, amount: params.amount };
    })),
  },
  invoicePayments: { list: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
  refunds: { list: jest.fn(async ({ charge }: { charge: string }) => ({ data: clone(mockStripeState.refunds.get(charge) ?? []) })) },
  charges: { retrieve: jest.fn() },
  subscriptions: { retrieve: jest.fn() },
};
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe));

// ── Storage and collaborators ────────────────────────────────────────────────────────────────────────
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByIdConsistent: jest.fn(),
    updateUser: jest.fn(),
    scanWithFilter: jest.fn(),
  },
  orgDb: {},
}));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(async () => 'Pro'),
  getSubscriptionTypeConfig: jest.fn(),
  getTierConfig: jest.fn(),
  DEFAULT_PAGES: [],
}));
jest.mock('../services/spendEventDb', () => ({
  ...jest.requireActual('../services/spendEventDb'),
  listSpendEvents: jest.fn(),
}));
jest.mock('../services/spendProjectionDb', () => ({ getProjection: jest.fn() }));
jest.mock('../services/paygOverageService', () => ({ paygSettlementSwitch: { isEnabled: jest.fn() } }));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: jest.fn(async () => ({ written: true })) } }));
jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn(async () => undefined),
    sendPaygOverageInvoiceEmail: jest.fn(async () => 'sent'),
    sendPaygOveragePaymentFailedEmail: jest.fn(async () => 'sent'),
    sendPaygOveragePaymentActionRequiredEmail: jest.fn(async () => 'sent'),
    sendPaygOveragePaymentUnconfirmedEmail: jest.fn(async () => 'sent'),
  },
}));
jest.mock('../services/crmAutoSyncService', () => ({ syncUserUpdateToLeadList: jest.fn() }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';

import { userDb } from '../services/db';
import { getSubscriptionTypeConfig } from '../services/subscriptionService';
import { listSpendEvents } from '../services/spendEventDb';
import { getProjection } from '../services/spendProjectionDb';
import { paygSettlementSwitch } from '../services/paygOverageService';
import { emailService } from '../services/emailService';
import {
  handleChargeDisputeCreated,
  handleChargeRefunded,
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  stripeService,
} from '../services/stripeService';
import { runPaygSettlement, settlePaygOverageMonth } from '../services/paygSettlementService';
import { evaluatePaygAdmission, type PaygAdmittedMonth, type PaygOverageSettings } from '../services/paygOverage';
import { SPEND_LEDGER_ENFORCEMENT_ENV } from '../services/spendEnforcementBasis';
import { createUserRowFake } from './helpers/userRowFake';

const USD = 1_000_000;
const OWNER = 'owner-1';
const M = '2026-09';
const NEXT = '2026-10';
const DAY2 = new Date('2026-10-02T12:00:00.000Z');
const KEY = `payg:${OWNER}:${M}`;
/** Stripe's idempotency keys are scoped to the settlement record (its createdAt). */
const SKEY = `${KEY}:${DAY2.toISOString()}`;

const policy = {
  version: 'pro-2026-09',
  enforcementState: 'hard_only' as const,
  optimizationCostThresholdMicroUsd: 50 * USD,
  hardCostThresholdMicroUsd: 100 * USD,
  optimizedModelIds: ['gpt-5-chat-2'],
  optimizedDefaultModel: 'gpt-5-chat-2',
};

/** What September's admissions were measured against: a $100 plan pool, a 50% ($50) cap, a 1.5x markup. */
const admitted = (month: string, over: Partial<PaygAdmittedMonth> = {}): PaygAdmittedMonth => ({
  month,
  capHighWaterMicroUsd: 50 * USD,
  tierPoolHighWaterMicroUsd: 100 * USD,
  markupBps: 15_000,
  spendBasis: 'spend_ledger',
  ...over,
});

const payg = (over: Partial<PaygOverageSettings> = {}): PaygOverageSettings => ({
  enabled: true,
  capPercentOfPool: 50,
  // The gate already rolled the mark over on day 1; September's mark is the closed copy.
  poolHighWater: { month: NEXT, thresholdMicroUsd: 100 * USD },
  poolHighWaterClosed: { month: M, thresholdMicroUsd: 100 * USD },
  admittedMonths: [admitted(NEXT), admitted(M)],
  updatedBy: OWNER,
  updatedAt: '2026-08-01T00:00:00.000Z',
  version: 3,
  ...over,
});

const ownerRow = (over: Record<string, unknown> = {}) => ({
  userId: OWNER,
  email: 'owner@example.com',
  stripe_customer_id: 'cus_row',
  subscription_status: 'active',
  subscription_amount: 4900,
  has_payment_method: true,
  paygOverage: payg(),
  ...over,
});

const spend = (settledUsd: number, projectedUsd: number | null = settledUsd, month = M) => {
  (listSpendEvents as jest.Mock).mockResolvedValue([
    {
      billingUserId: OWNER, eventId: `e1-${month}`, occurredAt: `${month}-15T10:00:00.000Z`, billingMonth: month,
      actingUserId: OWNER, provider: 'openai', operation: 'chat', unit: 'call', quantity: 1,
      costMicroUsd: settledUsd * USD, costSource: 'measured', lifecycle: 'settled',
    },
    // A reservation never counts as spend.
    {
      billingUserId: OWNER, eventId: `e2-${month}`, occurredAt: `${month}-20T10:00:00.000Z`, billingMonth: month,
      actingUserId: OWNER, provider: 'openai', operation: 'chat', unit: 'call', quantity: 1,
      costMicroUsd: 7 * USD, costSource: 'measured', lifecycle: 'reserved',
    },
  ]);
  (getProjection as jest.Mock).mockResolvedValue(
    projectedUsd === null ? null : { billingUserId: OWNER, billingMonth: month, settledMicroUsd: projectedUsd * USD, computedAt: DAY2.toISOString() },
  );
};

let store: ReturnType<typeof createUserRowFake>;
const settlement = () => store.row.paygSettlements?.[M];

function setup(row: Record<string, unknown> = ownerRow(), opts: { switchOn?: boolean } = {}) {
  store = createUserRowFake(row);
  (userDb.getUserByIdConsistent as jest.Mock).mockImplementation(store.read);
  (userDb.getUserById as jest.Mock).mockImplementation(store.read);
  (userDb.updateUser as jest.Mock).mockImplementation(store.updateUser);
  (userDb.scanWithFilter as jest.Mock).mockImplementation(async () => [store.row]);
  (paygSettlementSwitch.isEnabled as jest.Mock).mockResolvedValue(opts.switchOn ?? true);
  // The tier as it stands at SETTLEMENT time: deliberately different from what September recorded, so
  // any test that read it instead of the month's admission record would bill the wrong amount.
  (getSubscriptionTypeConfig as jest.Mock).mockResolvedValue({
    name: 'Pro', allowedPages: [], allowedSkills: [],
    llmUsagePolicy: { ...policy, hardCostThresholdMicroUsd: 400 * USD },
    paygOverage: { allowed: true, markupBps: 30_000 },
  });
  jest.spyOn(stripeService, 'resolveUserPaymentMethod').mockResolvedValue({
    hasPaymentMethod: true, customerId: 'cus_card', fallbackPaymentMethodId: 'pm_card', card: { brand: 'visa', last4: '4242' }, isZoma: false,
  });
  jest.spyOn(stripeService, 'findLiveCustomerIdForUser').mockResolvedValue('cus_row');
}

beforeEach(() => {
  // "Today" is pinned to the fixtures' day (3 Oct 2026, so the month being settled is September). The sweep
  // is calendar-sensitive (it does nothing on day 1 of a month, and settles the PREVIOUS month) and the
  // service stamps `new Date()` into its records, so the fixtures' fixed day offsets only mean what they say
  // if today is fixed too. Unpinned, the suite failed on the last ~9 days of every month. Only Date is
  // faked: timers, ticks and promises stay real.
  jest.useFakeTimers({
    now: new Date('2026-10-03T12:00:00.000Z'),
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
  jest.clearAllMocks();
  jest.restoreAllMocks();
  mockStripeState.invoices.clear();
  mockStripeState.keys.clear();
  mockStripeState.loseResponse.clear();
  mockStripeState.seq = 0;
  mockStripeState.discountCents = 0;
  mockStripeState.refunds.clear();
  // No invoice payment by default: a failed attempt is a decline unless a test says the bank awaits confirmation.
  mockStripe.invoicePayments.list.mockReset().mockResolvedValue({ data: [] });
  process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = 'true';
  spend(130);
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  delete process.env[SPEND_LEDGER_ENFORCEMENT_ENV];
});

describe('ENG-668 settlement — what is billed', () => {
  it('bills min(overage, cap) x markup in whole cents, as one auto-charged invoice on the card\'s customer', async () => {
    setup();
    // $130 settled on a $100 pool: $30 overage (60% of the $50 cap) x 1.5 = $45.00.
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('invoiced');

    expect(settlement()).toMatchObject({
      status: 'invoiced',
      idempotencyKey: KEY,
      overageCostMicroUsd: 30 * USD,
      billedMicroUsd: 45 * USD,
      amountCents: 4500,
      markupBps: 15_000,
      percentOfCap: 60,
      settledMicroUsd: 130 * USD,
      projectedMicroUsd: 130 * USD,
      invoiceId: 'in_1',
    });
    const [params, opts] = mockStripe.invoices.create.mock.calls[0];
    expect(opts).toEqual({ idempotencyKey: `${SKEY}:invoice` });
    expect(params).toMatchObject({
      customer: 'cus_card',
      default_payment_method: 'pm_card',
      collection_method: 'charge_automatically',
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
    });
    expect(mockStripe.invoiceItems.create.mock.calls[0][0]).toMatchObject({ invoice: 'in_1', amount: 4500, currency: 'usd' });
    expect(mockStripe.invoiceItems.create.mock.calls[0][1]).toEqual({ idempotencyKey: `${SKEY}:item` });
    expect(mockStripe.invoices.finalizeInvoice).toHaveBeenCalledWith('in_1', { auto_advance: true }, { idempotencyKey: `${SKEY}:finalize` });
    expect(mockStripeState.invoices.get('in_1')).toMatchObject({ status: 'open', total: 4500 });

    // One owner email: a percentage of the cap and the Stripe invoice link — never an amount.
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith({
      to: 'owner@example.com', month: M, percentOfCap: 60, invoiceUrl: 'https://invoice.stripe.com/i/1', paid: false,
    });
  });

  it('never bills past the cap, and rounds every step down', async () => {
    // $171.234567 settled: $71.23 overage, capped at $50. $50 x 1.3333 = $66.665 -> 6666 cents.
    setup(ownerRow({ paygOverage: payg({ admittedMonths: [admitted(M, { markupBps: 13_333 })] }) }));
    spend(171.234567);
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect(settlement()).toMatchObject({
      overageCostMicroUsd: 50 * USD,
      billedMicroUsd: 66_665_000,
      amountCents: 6666,
      percentOfCap: 100,
    });
  });

  it('subtracts the closed month\'s opt-in baseline', async () => {
    // Opted in on September 10 with $20 already standing; October's opt-in replaced it on the row.
    setup(ownerRow({
      paygOverage: payg({
        optIn: { month: NEXT, overageBaselineMicroUsd: 0, poolAtOptInMicroUsd: 100 * USD },
        optInClosed: { month: M, overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD },
      }),
    }));
    await settlePaygOverageMonth(OWNER, M, DAY2);
    // $30 gross - $20 baseline = $10 x 1.5 = $15.
    expect(settlement()).toMatchObject({ overageCostMicroUsd: 10 * USD, amountCents: 1500 });
  });

  it('uses the closed month\'s credits after the ledger rolled over on day 1', async () => {
    setup(ownerRow({
      // Day 1's seat-credit sweep replaced September's ledger; it is kept as the closed copy.
      llmUsageCredits: {
        month: NEXT, version: 1, totalPurchasedMicroUsd: 20 * USD, totalMigrationOffsetMicroUsd: 0,
        grantIds: [`seat-credit:org-1:${NEXT}`], grants: [],
      },
      llmUsageCreditsClosed: {
        month: M, version: 4, totalPurchasedMicroUsd: 20 * USD, totalMigrationOffsetMicroUsd: 0,
        grantIds: ['stripe:cs_topup'],
        grants: [{ id: 'stripe:cs_topup', source: 'purchase', amountMicroUsd: 20 * USD, grantedAt: `${M}-12T00:00:00.000Z` }],
      },
    }));
    await settlePaygOverageMonth(OWNER, M, DAY2);
    // September's pool was $100 + the $20 top-up: $10 overage x 1.5 = $15 — not the $45 a missing ledger bills.
    expect(settlement()).toMatchObject({ overageCostMicroUsd: 10 * USD, amountCents: 1500 });
  });

  it('measures against the closed month\'s high-water mark, so a downgrade on day 1 adds no overage', async () => {
    setup(ownerRow({ paygOverage: payg({ poolHighWaterClosed: { month: M, thresholdMicroUsd: 120 * USD } }) }));
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect(settlement()).toMatchObject({ overageCostMicroUsd: 10 * USD, amountCents: 1500 });
  });

  it('zero overage is recorded as nothing_to_bill with no Stripe call', async () => {
    setup();
    spend(95);
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('nothing_to_bill');
    expect(settlement()).toMatchObject({ status: 'nothing_to_bill', nothingToBillReason: 'no_overage', amountCents: 0 });
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
    expect(stripeService.resolveUserPaymentMethod).not.toHaveBeenCalled();
    expect(emailService.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
  });

  it('less than Stripe\'s 50-cent minimum is not billed (it would land on the subscription invoice)', async () => {
    setup();
    spend(100.3); // $0.30 overage x 1.5 = 45 cents
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('nothing_to_bill');
    expect(settlement()).toMatchObject({ status: 'nothing_to_bill', nothingToBillReason: 'below_minimum', amountCents: 45 });
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
  });

  it('a month PAYG never admitted anything in is never billed, whatever ran past the pool', async () => {
    setup(ownerRow({ paygOverage: payg({ enabled: false, admittedMonths: [admitted(NEXT)] }) }));
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('not_admitted');
    expect(store.row.paygSettlements).toBeUndefined();
    expect(listSpendEvents).not.toHaveBeenCalled();
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
  });

  it('PAYG turned off after the month still settles the month it was used in', async () => {
    setup(ownerRow({ paygOverage: payg({ enabled: false }) }));
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('invoiced');
  });
});

describe('ENG-668 settlement — refuses to bill on inputs it cannot vouch for', () => {
  it('spend events and the projection the gate read disagree: held, one on-call alert, no Stripe call', async () => {
    setup();
    spend(130, 128);
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(settlement()).toMatchObject({
      status: 'held', heldReason: 'spend_drift', settledMicroUsd: 130 * USD, projectedMicroUsd: 128 * USD, amountCents: 0,
    });
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
    expect(stripeService.resolveUserPaymentMethod).not.toHaveBeenCalled();
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect((emailService.sendOncallAlert as jest.Mock).mock.calls[0][2]).toMatchObject({
      'Alert Class': 'payg-settlement-held', heldCount: 1, held: [{ billingUserId: OWNER, month: M, heldReason: 'spend_drift' }],
    });

    // Every later run of the month skips it: no second alert, still no charge.
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('already_recorded');
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
  });

  it('real spend with no projection behind it is drift too', async () => {
    setup();
    spend(130, null);
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(settlement()).toMatchObject({ heldReason: 'spend_drift', projectedMicroUsd: null });
  });

  it.each(['legacy', 'mixed'] as const)(
    'a month whose admissions the gate measured on the %s basis is held — even with the ledger cutover on by settlement (rv4 MAJOR 1)',
    async (spendBasis) => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = 'true';
      setup(ownerRow({ paygOverage: payg({ admittedMonths: [admitted(M, { spendBasis })] }) }));
      expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
      expect(settlement()).toMatchObject({ heldReason: 'legacy_spend_basis' });
      expect(mockStripe.invoices.create).not.toHaveBeenCalled();
      expect(listSpendEvents).not.toHaveBeenCalled();
    },
  );

  it('a month measured on the ledger throughout is billed even if the cutover is rolled back by settlement (rv4 MAJOR 1)', async () => {
    process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = 'legacy';
    setup();
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('invoiced');
    expect(settlement()).toMatchObject({ amountCents: 4500 });
  });

  it('a month admitted while the tier had no markup is held (never billed at cost by default)', async () => {
    setup(ownerRow({ paygOverage: payg({ admittedMonths: [admitted(M, { markupBps: null })] }) }));
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(settlement()).toMatchObject({ heldReason: 'no_price' });
  });

  it('no live Stripe customer: held from pending, alerted once', async () => {
    setup();
    (stripeService.resolveUserPaymentMethod as jest.Mock).mockResolvedValue({ hasPaymentMethod: false, customerId: null, card: null, isZoma: false });
    (stripeService.findLiveCustomerIdForUser as jest.Mock).mockResolvedValue(null);
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(settlement()).toMatchObject({ status: 'held', heldReason: 'no_stripe_customer', amountCents: 4500 });
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
  });
});

describe('ENG-668 settlement — idempotent', () => {
  it('a rerun after success does nothing: no second invoice, no second email', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('already_recorded');
    expect(mockStripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(mockStripeState.invoices.size).toBe(1);
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it('pending is recorded before Stripe is called', async () => {
    setup();
    mockStripe.invoices.create.mockImplementationOnce(async () => {
      expect(settlement()).toMatchObject({ status: 'pending', idempotencyKey: KEY, amountCents: 4500 });
      throw new Error('stripe down');
    });
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('stripe down');
    expect(settlement()).toMatchObject({ status: 'pending' });
  });

  it('a crash after pending retries with the same key and the stored amount — one invoice', async () => {
    setup();
    // The invoice is created but the response is lost before its id can be recorded.
    mockStripeState.loseResponse.add('invoices.create');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    expect(settlement()).toMatchObject({ status: 'pending' });
    expect(settlement()?.invoiceId).toBeUndefined();

    // Spend moved since (late events): the retry must charge what was recorded, not a recomputation.
    spend(140);
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-02T15:00:00.000Z'))).toBe('invoiced');
    expect(mockStripeState.invoices.size).toBe(1);
    expect(mockStripeState.invoices.get('in_1')).toMatchObject({ status: 'open', total: 4500 });
    expect(settlement()).toMatchObject({ status: 'invoiced', invoiceId: 'in_1', amountCents: 4500 });
  });

  it('...and if Stripe\'s search has not indexed it yet, the replayed key returns the same invoice', async () => {
    setup();
    mockStripeState.loseResponse.add('invoices.create');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    mockStripe.invoices.search.mockResolvedValueOnce({ data: [] }); // index lag: up to a minute
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-02T12:00:30.000Z'))).toBe('invoiced');
    const keys = mockStripe.invoices.create.mock.calls.map(([, opts]) => opts?.idempotencyKey);
    expect(keys).toEqual([`${SKEY}:invoice`, `${SKEY}:invoice`]);
    expect(mockStripeState.invoices.size).toBe(1);
  });

  it('a crash after the line item resumes the recorded draft by id: one line, finalized', async () => {
    setup();
    mockStripeState.loseResponse.add('invoiceItems.create');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    expect(settlement()).toMatchObject({ status: 'pending', invoiceId: 'in_1' });

    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('invoiced');
    expect(mockStripe.invoices.retrieve).toHaveBeenCalledWith('in_1');
    expect(mockStripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(mockStripeState.invoices.get('in_1')!.lines.data).toHaveLength(1);
    expect(mockStripeState.invoices.get('in_1')).toMatchObject({ status: 'open', total: 4500 });
  });

  it('a pending with no invoice id searches Stripe by metadata before creating, even once the keys expired', async () => {
    setup();
    mockStripeState.loseResponse.add('invoices.create');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    // A day later Stripe has forgotten the key: replaying it would create a SECOND invoice.
    mockStripeState.keys.clear();

    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('invoiced');
    expect(mockStripe.invoices.search).toHaveBeenLastCalledWith({
      query: `metadata['purchaseType']:'payg_overage' AND metadata['billingUserId']:'${OWNER}' AND metadata['month']:'${M}'`,
      limit: 10,
    });
    expect(mockStripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(mockStripeState.invoices.size).toBe(1);
    expect(settlement()).toMatchObject({ status: 'invoiced', invoiceId: 'in_1' });
    expect(mockStripeState.invoices.get('in_1')).toMatchObject({ status: 'open', total: 4500 });
  });

  it('two runs racing on the same month: one records it, the other backs off', async () => {
    setup();
    const stale = store.row;
    await settlePaygOverageMonth(OWNER, M, DAY2);
    // The second run read the row before the first wrote it.
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce(stale);
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('raced');
    expect(mockStripe.invoices.create).toHaveBeenCalledTimes(1);
  });

  it('keeps only the last 12 months of settlement records', async () => {
    setup(ownerRow({
      paygSettlements: {
        '2025-09': { status: 'paid' },
        '2025-10': { status: 'paid' },
        '2026-08': { status: 'paid' },
      },
    }));
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect(Object.keys(store.row.paygSettlements).sort()).toEqual(['2025-10', '2026-08', M]);
  });
});

describe('ENG-668 settlement — the daily sweep', () => {
  it('switch off: nothing is read, written or charged', async () => {
    setup(ownerRow(), { switchOn: false });
    const summary = await runPaygSettlement(DAY2);
    expect(summary.skipped).toBe('switch_off');
    expect(userDb.scanWithFilter).not.toHaveBeenCalled();
    expect(userDb.updateUser).not.toHaveBeenCalled();
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
  });

  it('day 1 of the month does nothing; day 2 settles the previous month', async () => {
    setup();
    expect((await runPaygSettlement(new Date('2026-10-01T12:00:00.000Z'))).skipped).toBe('before_day_2');
    expect(userDb.scanWithFilter).not.toHaveBeenCalled();

    const summary = await runPaygSettlement(DAY2);
    expect(userDb.scanWithFilter).toHaveBeenCalledWith('attribute_exists(paygOverage)', {});
    expect(summary).toMatchObject({ month: M, scanned: 1, outcomes: { invoiced: 1 }, failed: 0 });
  });

  it('one owner failing does not stop the sweep, and is retried by the next run', async () => {
    setup();
    mockStripe.invoices.create.mockImplementationOnce(async () => { throw new Error('stripe down'); });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await runPaygSettlement(DAY2);
    errorLog.mockRestore();
    expect(first).toMatchObject({ failed: 1 });
    expect((await runPaygSettlement(new Date('2026-10-02T18:00:00.000Z'))).outcomes).toEqual({ invoiced: 1 });
  });
});

describe('ENG-668 webhooks — an overage invoice never touches the subscription', () => {
  async function issued() {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    return { ...mockStripeState.invoices.get('in_1')!, amount_paid: 4500, amount_due: 4500, currency: 'usd', subscription: null };
  }
  const subscriptionFieldsWritten = () => (userDb.updateUser as jest.Mock).mock.calls
    .flatMap(([, fields]) => Object.keys(fields || {}))
    .filter((key) => key.startsWith('subscription_') || key === 'current_period_end' || key === 'activeOffer' || key === 'stripe_subscription_id');

  it('paid: settlement paid; subscription_status / subscription_amount untouched', async () => {
    const invoice = await issued();
    (userDb.updateUser as jest.Mock).mockClear();
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid' });
    expect(settlement()).toMatchObject({ status: 'paid', invoiceId: 'in_1' });
    expect(subscriptionFieldsWritten()).toEqual([]);
    expect(store.row).toMatchObject({ subscription_status: 'active', subscription_amount: 4900 });
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(userDb.scanWithFilter).not.toHaveBeenCalled(); // no lookup by customer id either
  });

  it('failed: settlement failed, PAYG suspended, one email — and the subscription is NOT past_due', async () => {
    const invoice = await issued();
    (userDb.updateUser as jest.Mock).mockClear();
    await handleInvoicePaymentFailed({ ...invoice, attempt_count: 1 });
    await handleInvoicePaymentFailed({ ...invoice, attempt_count: 2 }); // Stripe retries the charge

    expect(settlement()).toMatchObject({ status: 'failed', invoiceId: 'in_1' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_1' });
    expect(subscriptionFieldsWritten()).toEqual([]);
    expect(store.row.subscription_status).toBe('active');
    expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledWith({
      to: 'owner@example.com', month: M, invoiceUrl: 'https://invoice.stripe.com/i/1',
    });

    // The gate now refuses PAYG for this owner.
    const admission = evaluatePaygAdmission({
      decision: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
      switchOn: true,
      tier: { allowed: true, markupBps: 15_000 },
      account: { ...store.row.paygOverage, poolHighWater: { month: NEXT, thresholdMicroUsd: 100 * USD } },
      hasPaymentMethod: true,
      subscriptionStatus: 'active',
      costUsedMicroUsd: 110 * USD,
      overageThresholdMicroUsd: 100 * USD,
      month: NEXT,
    });
    expect(admission.decision.admissionAllowed).toBe(false);
    expect(admission.block).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'payment_failed' });
  });

  it('paying the failed invoice later lifts THAT suspension', async () => {
    const invoice = await issued();
    await handleInvoicePaymentFailed(invoice);
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid' });
    expect(settlement()).toMatchObject({ status: 'paid' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('an out-of-order failure after payment changes nothing', async () => {
    const invoice = await issued();
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid' });
    await handleInvoicePaymentFailed(invoice);
    expect(settlement()).toMatchObject({ status: 'paid' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
    expect(emailService.sendPaygOveragePaymentFailedEmail).not.toHaveBeenCalled();
  });

  it('an invoice this settlement did not issue is ignored', async () => {
    const invoice = await issued();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handleInvoicePaymentFailed({ ...invoice, id: 'in_other' });
    warn.mockRestore();
    expect(settlement()).toMatchObject({ status: 'invoiced' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('a subscription invoice still takes the subscription path', async () => {
    setup();
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([store.row]);
    await handleInvoicePaymentFailed({ id: 'in_sub', customer: 'cus_row', amount_due: 4900, metadata: {} });
    expect(store.row.subscription_status).toBe('past_due');
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });
});

describe('ENG-668 webhooks — disputes and refunds on an overage charge', () => {
  const charge = { id: 'ch_1', customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: 'pi_1', metadata: {} };
  async function paid() {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    await handleInvoicePaymentSucceeded({ ...mockStripeState.invoices.get('in_1')!, status: 'paid' });
    // Basil: the charge has no `invoice`; the link is the invoice payment for its PaymentIntent.
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: clone(mockStripeState.invoices.get('in_1')) }] });
    mockStripe.charges.retrieve.mockResolvedValue(charge);
  }

  it('a dispute suspends PAYG (dispute) and is recorded on the settlement', async () => {
    await paid();
    await handleChargeDisputeCreated({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd', reason: 'fraudulent' });
    expect(mockStripe.invoicePayments.list).toHaveBeenCalledWith({
      payment: { type: 'payment_intent', payment_intent: 'pi_1' }, limit: 10, expand: ['data.invoice'],
    });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', invoiceId: 'in_1' });
    expect(settlement()).toMatchObject({ status: 'paid', disputes: { dp_1: { at: expect.any(String) } } });
    expect(settlement().disputes.dp_1).not.toHaveProperty('closedAt');
  });

  it('a dispute replaces a payment-failure suspension, and paying never lifts it', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const invoice = mockStripeState.invoices.get('in_1')!;
    await handleInvoicePaymentFailed(invoice);
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: clone(invoice) }] });
    mockStripe.charges.retrieve.mockResolvedValue(charge);
    await handleChargeDisputeCreated({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd' });
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
  });

  it('a refund is recorded and never resumes a suspended PAYG', async () => {
    await paid();
    await handleChargeDisputeCreated({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd' });
    mockStripeState.refunds.set('ch_1', [{ id: 're_1', amount: 4500, status: 'succeeded' }]);
    await handleChargeRefunded({ ...charge, amount_refunded: 4500, refunded: true });
    expect(settlement()).toMatchObject({ refundedCents: 4500, status: 'paid' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
    // Partial-then-full redelivery lands on the cumulative figure, not a sum.
    await handleChargeRefunded({ ...charge, amount_refunded: 4500, refunded: true });
    expect(settlement()).toMatchObject({ refundedCents: 4500 });
  });

  it('a refund on an unsuspended account does not create or lift anything', async () => {
    await paid();
    mockStripeState.refunds.set('ch_1', [{ id: 're_1', amount: 1000, status: 'succeeded' }]);
    await handleChargeRefunded({ ...charge, amount_refunded: 1000, refunded: false });
    expect(settlement()).toMatchObject({ refundedCents: 1000 });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });
});

describe('ENG-668 settlement — the bill is what was in force DURING the month (review M1/M2)', () => {
  it('cap LOWERED after the usage: bills the overage admitted under September\'s 200% cap', async () => {
    // September ran $180 past the $100 pool under a 200% ($200) cap; on Oct 1 the owner lowered it to 25%.
    setup(ownerRow({ paygOverage: payg({ capPercentOfPool: 25, admittedMonths: [admitted(M, { capHighWaterMicroUsd: 200 * USD })] }) }));
    spend(280);
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect(settlement()).toMatchObject({ overageCostMicroUsd: 180 * USD, amountCents: 27000, percentOfCap: 90 });
  });

  it('cap RAISED after the month: never bills past September\'s 25% cap', async () => {
    // September's cap was 25% ($25); in-flight work overran to $40; on Oct 1 the owner raised it to 200%.
    setup(ownerRow({ paygOverage: payg({ capPercentOfPool: 200, admittedMonths: [admitted(M, { capHighWaterMicroUsd: 25 * USD })] }) }));
    spend(140);
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect(settlement()).toMatchObject({ overageCostMicroUsd: 25 * USD, amountCents: 3750, percentOfCap: 100 });
  });

  it('a plan upgrade or a markup change after the month leaves its bill unchanged', async () => {
    // setup() puts the tier at a $400 pool and a 3x markup NOW; September recorded $100 and 1.5x.
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect(settlement()).toMatchObject({ overageCostMicroUsd: 30 * USD, amountCents: 4500, markupBps: 15_000 });
    expect(getSubscriptionTypeConfig).not.toHaveBeenCalled();
  });
});

describe('ENG-668 settlement — a suspension lasts while any month is unpaid (review M4)', () => {
  const NOV2 = new Date('2026-11-02T12:00:00.000Z');
  it('September and October both fail: paying September alone keeps PAYG suspended; paying October lifts it', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const sep = mockStripeState.invoices.get(settlement()!.invoiceId!)!;
    await handleInvoicePaymentFailed(sep);
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: sep.id });

    // October had PAYG admissions before the suspension; it is settled on November 2 and fails too.
    store.row = {
      ...store.row,
      paygOverage: { ...store.row.paygOverage, admittedMonths: [admitted('2026-11'), admitted(NEXT)] },
    };
    spend(130, 130, NEXT);
    expect(await settlePaygOverageMonth(OWNER, NEXT, NOV2)).toBe('invoiced');
    const octId = store.row.paygSettlements[NEXT].invoiceId;
    const oct = mockStripeState.invoices.get(octId)!;
    expect(oct.metadata.month).toBe(NEXT);
    await handleInvoicePaymentFailed(oct);
    expect(store.row.paygSettlements[NEXT].status).toBe('failed');

    await handleInvoicePaymentSucceeded({ ...sep, status: 'paid' });
    expect(store.row.paygSettlements[M].status).toBe('paid');
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });

    await handleInvoicePaymentSucceeded({ ...oct, status: 'paid' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('a stale read that has not seen October fail yet still cannot lift the suspension (the write checks)', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const sep = mockStripeState.invoices.get(settlement()!.invoiceId!)!;
    await handleInvoicePaymentFailed(sep);
    store.row = {
      ...store.row,
      paygOverage: { ...store.row.paygOverage, admittedMonths: [admitted('2026-11'), admitted(NEXT)] },
    };
    spend(130, 130, NEXT);
    await settlePaygOverageMonth(OWNER, NEXT, NOV2);
    const beforeOctFailed = store.row;
    await handleInvoicePaymentFailed(mockStripeState.invoices.get(store.row.paygSettlements[NEXT].invoiceId)!);

    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce(beforeOctFailed);
    await handleInvoicePaymentSucceeded({ ...sep, status: 'paid' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
  });

  it('paying never lifts a dispute suspension', async () => {
    setup(ownerRow({ paygOverage: payg({ suspended: { reason: 'dispute', at: '2026-09-20T00:00:00.000Z' } }) }));
    await settlePaygOverageMonth(OWNER, M, DAY2);
    await handleInvoicePaymentSucceeded({ ...mockStripeState.invoices.get('in_1')!, status: 'paid' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
  });
});

describe('ENG-668 settlement — Stripe total differs from the record (review M5)', () => {
  it('a discounted draft is deleted before finalizing: held, nothing collected, and clearing it later issues ONE invoice', async () => {
    setup();
    mockStripeState.discountCents = 500; // a customer coupon: Stripe would charge $40.00, not $45.00
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(mockStripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(mockStripe.invoices.del).toHaveBeenCalledWith('in_1');
    expect(mockStripeState.invoices.size).toBe(0);
    expect(settlement()).toMatchObject({
      status: 'held', heldReason: 'invoice_mismatch', uncollectedInvoice: { invoiceId: 'in_1', reason: 'draft_deleted' },
    });
    expect(settlement()?.invoiceId).toBeUndefined();
    const [, alertBody] = (emailService.sendOncallAlert as jest.Mock).mock.calls[0];
    expect(alertBody).toContain('nothing was collected');
    expect(alertBody).not.toContain('Do NOT remove');

    // On-call removes the coupon and the record, as the alert says; the next run settles it once.
    mockStripeState.discountCents = 0;
    store.row = { ...store.row, paygSettlements: {} };
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('invoiced');
    const live = [...mockStripeState.invoices.values()].filter((i) => i.metadata.month === M && i.status !== 'void');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'open', total: 4500 });
  });

  it('a finalized invoice found by search with another total is held with its id; the alert says not to remove it', async () => {
    setup();
    mockStripeState.invoices.set('in_9', {
      id: 'in_9', object: 'invoice', customer: 'cus_card', status: 'open', total: 4000,
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
      hosted_invoice_url: 'https://invoice.stripe.com/i/9', lines: { data: [{ amount: 4500, metadata: {} }] },
    });
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
    expect(settlement()).toMatchObject({ status: 'held', heldReason: 'invoice_mismatch', invoiceId: 'in_9' });
    const [, alertBody] = (emailService.sendOncallAlert as jest.Mock).mock.calls[0];
    expect(alertBody).toContain('Do NOT remove or retry paygSettlements.2026-09');

    // Stripe still collects it; the webhook records the outcome on the held record.
    await handleInvoicePaymentSucceeded({ ...mockStripeState.invoices.get('in_9')!, status: 'paid' });
    expect(settlement()).toMatchObject({ status: 'paid', invoiceId: 'in_9' });
  });

  it('a held record with no invoice is never moved by a webhook', async () => {
    setup();
    mockStripeState.discountCents = 500;
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handleInvoicePaymentSucceeded({ id: 'in_x', status: 'paid', metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M } });
    warn.mockRestore();
    expect(settlement()).toMatchObject({ status: 'held' });
  });
});

describe('ENG-668 settlement — races and orphans (review follow-ups)', () => {
  it('month 2+: a stale reader backs off when paygSettlements already exists', async () => {
    setup(ownerRow({ paygSettlements: { '2026-08': { status: 'paid' } } }));
    const stale = store.row;
    await settlePaygOverageMonth(OWNER, M, DAY2);
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce(stale);
    mockStripeState.keys.clear();
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('raced');
    expect(mockStripeState.invoices.size).toBe(1);
  });

  it('the sweep resumes an older month left pending, not only the month that just closed', async () => {
    const august = {
      status: 'pending', idempotencyKey: `payg:${OWNER}:2026-08`, overageCostMicroUsd: 10 * USD, billedMicroUsd: 15 * USD,
      amountCents: 1500, markupBps: 15_000, percentOfCap: 20, settledMicroUsd: 110 * USD, projectedMicroUsd: 110 * USD,
      createdAt: '2026-09-02T12:00:00.000Z', updatedAt: '2026-09-02T12:00:00.000Z',
    };
    // August is long gone from admittedMonths; its pending record is what must be resumed.
    setup(ownerRow({ paygSettlements: { '2026-08': august } }));
    const summary = await runPaygSettlement(DAY2);
    expect(summary.outcomes).toEqual({ invoiced: 2 });
    expect(store.row.paygSettlements['2026-08']).toMatchObject({ status: 'invoiced' });
    const aug = [...mockStripeState.invoices.values()].find((i) => i.metadata.month === '2026-08')!;
    expect(aug).toMatchObject({ status: 'open', total: 1500 });
  });
});

describe('ENG-668 webhooks — with settlement switched off, refunds are exactly as before; disputes are still recognised (review M6, rv5 MINOR 7)', () => {
  const subscriptionCharge = {
    id: 'ch_sub', customer: 'cus_row', amount: 4900, amount_refunded: 4900, refunded: true, currency: 'usd', payment_intent: 'pi_sub', metadata: {},
  };
  const { paymentHistoryDb } = jest.requireMock('../services/paymentHistoryDb');

  it('switch off: no invoice-payment lookup, and the refund is recorded as before', async () => {
    setup(ownerRow(), { switchOn: false });
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([store.row]);
    await handleChargeRefunded(subscriptionCharge);
    expect(mockStripe.invoicePayments.list).not.toHaveBeenCalled();
    expect(paymentHistoryDb.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'refund', userId: OWNER, amount: 4900 }));
  });

  it('switch off: a dispute on a subscription charge is looked up (one call) and handled exactly as before — nothing suspended', async () => {
    setup(ownerRow(), { switchOn: false });
    mockStripe.charges.retrieve.mockResolvedValue({ ...subscriptionCharge, refunded: false, amount_refunded: 0 });
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: { id: 'in_sub', object: 'invoice', metadata: {} } }] });
    await handleChargeDisputeCreated({ id: 'dp_sub', charge: 'ch_sub', amount: 4900, currency: 'usd' });
    await handleChargeDisputeClosed({ id: 'dp_sub', charge: 'ch_sub', amount: 4900, currency: 'usd', status: 'won' });
    expect(mockStripe.invoicePayments.list).toHaveBeenCalledTimes(2);
    expect(store.row.paygOverage.suspended).toBeUndefined();
    expect(store.row.paygSettlements).toBeUndefined();
  });

  it('switch off: a dispute on an overage charge still holds PAYG, and winning it lifts the hold (rv5 MINOR 7)', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    await handleInvoicePaymentSucceeded({ ...mockStripeState.invoices.get('in_1')!, status: 'paid' });
    mockStripe.charges.retrieve.mockResolvedValue({ id: 'ch_1', customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: 'pi_1', metadata: {} });
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: clone(mockStripeState.invoices.get('in_1')) }] });
    (paygSettlementSwitch.isEnabled as jest.Mock).mockResolvedValue(false); // switched off while the dispute is open
    await handleChargeDisputeCreated({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', disputeId: 'dp_1' });
    await handleChargeDisputeClosed({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd', status: 'won' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
    expect(settlement().disputes.dp_1).toMatchObject({ status: 'won', closedAt: expect.any(String) });
  });

  it('switch on but the lookup fails: the refund is still recorded, the webhook does not fail, on-call is told (rv4 MINOR 3)', async () => {
    setup();
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([store.row]);
    mockStripe.invoicePayments.list.mockRejectedValueOnce(new Error('stripe 500'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handleChargeRefunded(subscriptionCharge)).resolves.toBeUndefined();
    errorLog.mockRestore();
    expect(paymentHistoryDb.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'refund', amount: 4900 }));
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect((emailService.sendOncallAlert as jest.Mock).mock.calls[0][2]).toMatchObject({ 'Alert Class': 'payg-settlement-lookup', chargeId: 'ch_sub' });
  });

  it('switch on but the lookup fails on a chargeback: the webhook errors so Stripe redelivers; the retry suspends PAYG (rv4 MINOR 3)', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    await handleInvoicePaymentSucceeded({ ...mockStripeState.invoices.get('in_1')!, status: 'paid' });
    mockStripe.charges.retrieve.mockResolvedValue({ id: 'ch_1', customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: 'pi_1', metadata: {} });
    mockStripe.invoicePayments.list.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { type: 'StripeRateLimitError' }));
    const dispute = { id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd', reason: 'fraudulent' };
    await expect(handleChargeDisputeCreated(dispute)).rejects.toThrow(/could not check whether charge ch_1 paid a pay-as-you-go invoice/);
    expect(store.row.paygOverage.suspended).toBeUndefined();

    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: clone(mockStripeState.invoices.get('in_1')) }] });
    await handleChargeDisputeCreated(dispute); // Stripe's redelivery
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', invoiceId: 'in_1' });
  });
});

describe('ENG-668 settlement — a recorded invoice that is void or gone is never invoiced over (final review R1/R4)', () => {
  /** A pending month whose draft in_1 is recorded, then the run dies before the line item lands. */
  async function pendingOnDraft() {
    setup();
    mockStripeState.loseResponse.add('invoiceItems.create');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    expect(settlement()).toMatchObject({ status: 'pending', invoiceId: 'in_1' });
    (emailService.sendOncallAlert as jest.Mock).mockClear();
  }

  it('R1: the recorded invoice was voided: held (uncollected), no invoiced email, one alert, no new invoice', async () => {
    await pendingOnDraft();
    mockStripeState.invoices.get('in_1')!.status = 'void';
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('held');
    expect(settlement()).toMatchObject({
      status: 'held', heldReason: 'invoice_mismatch', uncollectedInvoice: { invoiceId: 'in_1', reason: 'void' },
    });
    expect(settlement()?.invoiceId).toBeUndefined();
    expect(emailService.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect(mockStripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(mockStripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    // A rerun stays quiet.
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-04T12:00:00.000Z'))).toBe('already_recorded');
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('R4: the recorded draft is gone (deleted on a mismatch, then the run died before the hold): held + alerted, not stuck', async () => {
    await pendingOnDraft();
    mockStripeState.invoices.delete('in_1'); // Stripe now answers 404 resource_missing for it
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('held');
    expect(settlement()).toMatchObject({
      status: 'held', heldReason: 'invoice_mismatch', uncollectedInvoice: { invoiceId: 'in_1', reason: 'missing' },
    });
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    const [, alertBody] = (emailService.sendOncallAlert as jest.Mock).mock.calls[0];
    expect(alertBody).toContain('deleted or unknown, so nothing was collected');
    expect(alertBody).not.toContain('Do NOT remove');
    expect(mockStripe.invoices.create).toHaveBeenCalledTimes(1);
  });

  it('any other Stripe error on the recorded invoice still throws (retried next run, not mistaken for missing)', async () => {
    await pendingOnDraft();
    mockStripe.invoices.retrieve.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }));
    await expect(settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).rejects.toThrow('rate limited');
    expect(settlement()).toMatchObject({ status: 'pending', invoiceId: 'in_1' });
  });

  it('the sweep isolates one owner\'s failure: the next owner is still settled', async () => {
    setup();
    (userDb.scanWithFilter as jest.Mock).mockImplementation(async () => [
      { userId: 'ghost', paygOverage: payg() },
      store.row,
    ]);
    (userDb.getUserByIdConsistent as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'ghost') throw new Error('throttled');
      return store.read();
    });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const summary = await runPaygSettlement(DAY2);
    errorLog.mockRestore();
    expect(summary).toMatchObject({ scanned: 2, failed: 1, outcomes: { invoiced: 1 } });
    expect(summary.errors).toEqual([{ billingUserId: 'ghost', month: M, error: 'throttled' }]);
  });
});

describe('ENG-668 webhooks — a failure after the paid webhook\'s read keeps PAYG suspended (final review R2)', () => {
  it('Sept failed; its paid webhook reads; Oct is settled AND fails before the lift is written: still suspended', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const sep = mockStripeState.invoices.get(settlement()!.invoiceId!)!;
    await handleInvoicePaymentFailed(sep);
    // The paid webhook's read: October does not exist yet on the row.
    const readBeforeOctober = store.row;

    store.row = {
      ...store.row,
      paygOverage: { ...store.row.paygOverage, admittedMonths: [admitted('2026-11'), admitted(NEXT)] },
    };
    spend(130, 130, NEXT);
    await settlePaygOverageMonth(OWNER, NEXT, new Date('2026-11-02T12:00:00.000Z'));
    const oct = mockStripeState.invoices.get(store.row.paygSettlements[NEXT].invoiceId)!;
    await handleInvoicePaymentFailed(oct);
    // The later failure re-stamped the suspension with its own invoice.
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: oct.id });

    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce(readBeforeOctober);
    await handleInvoicePaymentSucceeded({ ...sep, status: 'paid' });
    expect(store.row.paygSettlements[M].status).toBe('paid');
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: oct.id });
  });

  it('a payment failure never downgrades a dispute suspension', async () => {
    setup(ownerRow({ paygOverage: payg({ suspended: { reason: 'dispute', at: '2026-09-20T00:00:00.000Z', invoiceId: 'in_old' } }) }));
    await settlePaygOverageMonth(OWNER, M, DAY2);
    await handleInvoicePaymentFailed(mockStripeState.invoices.get('in_1')!);
    // Still the dispute hold; the failure only stamps `paymentFailedAt` on it (so a won-dispute lift that
    // read the row before this failure is refused and re-reads).
    expect(store.row.paygOverage.suspended).toEqual({
      reason: 'dispute', at: '2026-09-20T00:00:00.000Z', invoiceId: 'in_old', paymentFailedAt: expect.any(String),
    });
  });
});

describe('ENG-668 webhooks — failure events can only suspend for a month that is unpaid on that invoice (rv3 MAJOR 1)', () => {
  it('P1: a redelivered failure for a month already failed, landing between the paid read and the lift, does not strand the suspension', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const sep = mockStripeState.invoices.get('in_1')!;
    await handleInvoicePaymentFailed(sep);
    const paidRead = store.row; // the paid webhook's read: September failed, suspended
    await handleInvoicePaymentFailed(sep); // Stripe redelivers / retries the charge meanwhile
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce(paidRead);
    await handleInvoicePaymentSucceeded({ ...sep, status: 'paid' });
    expect(store.row.paygSettlements[M].status).toBe('paid');
    expect(Object.values(store.row.paygSettlements).filter((r) => (r as { status: string }).status === 'failed')).toHaveLength(0);
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('P2: a failure that read `invoiced` but lands after the payment does not suspend', async () => {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const sep = mockStripeState.invoices.get('in_1')!;
    const failureRead = store.row; // status invoiced
    await handleInvoicePaymentSucceeded({ ...sep, status: 'paid' });
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValueOnce(failureRead);
    await handleInvoicePaymentFailed(sep);
    expect(store.row.paygSettlements[M].status).toBe('paid');
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('a failure that newly fails a month still suspends (and re-stamps an existing payment-failure suspension)', async () => {
    setup(ownerRow({ paygOverage: payg({ suspended: { reason: 'payment_failed', at: '2026-09-05T00:00:00.000Z', invoiceId: 'in_old' } }) }));
    await settlePaygOverageMonth(OWNER, M, DAY2);
    await handleInvoicePaymentFailed(mockStripeState.invoices.get('in_1')!);
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_1' });
  });
});

describe('ENG-668 settlement — set-aside invoices and recovery (rv3 MINOR 2/3/4)', () => {
  /** September pending on draft in_1 (the run died after the line item), then voided by hand in Stripe. */
  async function heldOnVoid() {
    setup();
    mockStripeState.loseResponse.add('invoiceItems.create');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    mockStripeState.invoices.get('in_1')!.status = 'void';
    (emailService.sendOncallAlert as jest.Mock).mockClear();
    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('held');
  }

  it('P3: a late payment_failed for the voided invoice is ignored — no failed month, no suspension', async () => {
    await heldOnVoid();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handleInvoicePaymentFailed(mockStripeState.invoices.get('in_1')!);
    await handleInvoicePaymentSucceeded({ ...mockStripeState.invoices.get('in_1')!, status: 'paid' });
    warn.mockRestore();
    expect(settlement()).toMatchObject({ status: 'held' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('a dispute or refund event naming the set-aside invoice is ignored too: nothing suspended or recorded', async () => {
    await heldOnVoid();
    const voided = clone(mockStripeState.invoices.get('in_1')!);
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: voided }] });
    mockStripe.charges.retrieve.mockResolvedValue({ id: 'ch_v', customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: 'pi_v', metadata: {} });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await handleChargeDisputeCreated({ id: 'dp_v', charge: 'ch_v', amount: 4500, currency: 'usd' });
    await handleChargeRefunded({ id: 'ch_v', customer: 'cus_card', amount: 4500, amount_refunded: 4500, refunded: true, currency: 'usd', payment_intent: 'pi_v', metadata: {} });
    warn.mockRestore();
    expect(store.row.paygOverage.suspended).toBeUndefined();
    expect(settlement()).not.toHaveProperty('dispute');
    expect(settlement()).not.toHaveProperty('refundedCents');
  });

  it('P8: the void alert says the invoice was finalized and voided, and to check for payments — not "nothing was finalized"', async () => {
    await heldOnVoid();
    const [, body] = (emailService.sendOncallAlert as jest.Mock).mock.calls[0];
    expect(body).toContain('was finalized and later voided');
    expect(body).toContain('whether any payment was taken on it');
    expect(body).not.toContain('No invoice was finalized');
    expect(body).toContain(`set paygSettlements.${M}.status to "retry"`);
  });

  it('P4: retry within the next month issues ONE fresh live invoice', async () => {
    await heldOnVoid();
    store.row = { ...store.row, paygSettlements: { [M]: { ...store.row.paygSettlements[M], status: 'retry' } } };
    const summary = await runPaygSettlement(new Date('2026-10-04T12:00:00.000Z'));
    expect(summary.outcomes).toEqual({ invoiced: 1 });
    const live = [...mockStripeState.invoices.values()].filter((i) => i.status !== 'void' && i.metadata.month === M);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'open', total: 4500 });
    expect(settlement()).toMatchObject({ status: 'invoiced', invoiceId: live[0].id, retriedAt: '2026-10-04T12:00:00.000Z' });
  });

  it('P5: a month held long after it closed is re-settled on retry from the inputs frozen on its record', async () => {
    await heldOnVoid();
    expect(settlement()?.inputs).toEqual({
      credits: { purchasedMicroUsd: 0, adminGrantedMicroUsd: 0, migrationOffsetMicroUsd: 0 },
      poolHighWater: { month: M, thresholdMicroUsd: 100 * USD },
    });
    // Two months on, the row no longer holds September's mark (or credits); on-call sets retry in December.
    store.row = {
      ...store.row,
      paygOverage: { ...store.row.paygOverage, poolHighWater: { month: '2026-12', thresholdMicroUsd: 10 * USD }, poolHighWaterClosed: undefined },
      paygSettlements: { [M]: { ...store.row.paygSettlements[M], status: 'retry' } },
    };
    const summary = await runPaygSettlement(new Date('2026-12-02T12:00:00.000Z'));
    expect(summary.outcomes).toMatchObject({ invoiced: 1 });
    // Billed on September's own $100 pool: $30 x 1.5, exactly as the first measurement had it.
    expect(settlement()).toMatchObject({ status: 'invoiced', amountCents: 4500 });
    expect([...mockStripeState.invoices.values()].filter((i) => i.status !== 'void' && i.metadata.month === M)).toHaveLength(1);
  });

  it('an admitted month with no record, older than the month that just closed, is held (inputs gone) — loudly, never billed blind', async () => {
    // e.g. settlement switched on late, or a record deleted by hand instead of set to retry.
    setup(ownerRow({ paygOverage: payg({ admittedMonths: [admitted(M)] }) }));
    const summary = await runPaygSettlement(new Date('2026-11-02T12:00:00.000Z'));
    expect(store.row.paygSettlements[M]).toMatchObject({ status: 'held', heldReason: 'inputs_unavailable' });
    expect(summary.outcomes).toMatchObject({ held: 1 });
    expect(mockStripe.invoices.create.mock.calls.every(([params]) => params.metadata?.month !== M)).toBe(true);
    const [subject, body] = (emailService.sendOncallAlert as jest.Mock).mock.calls.find(([s]) => String(s).includes(M))!;
    expect(subject).toContain('inputs_unavailable');
    expect(body).toContain('No invoice was created and nothing was collected');
  });

  it('a retry is only acted on while the record still says retry, and is not re-run afterwards', async () => {
    await heldOnVoid();
    store.row = { ...store.row, paygSettlements: { [M]: { ...store.row.paygSettlements[M], status: 'retry' } } };
    await runPaygSettlement(new Date('2026-10-04T12:00:00.000Z'));
    mockStripe.invoices.create.mockClear();
    const again = await runPaygSettlement(new Date('2026-10-05T12:00:00.000Z'));
    expect(again.outcomes).toEqual({});
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
  });
});

describe('ENG-668 webhooks — two failed months paid at once (rv4 MINOR 1)', () => {
  async function twoFailedMonths() {
    setup();
    await settlePaygOverageMonth(OWNER, M, DAY2);
    const sep = mockStripeState.invoices.get(settlement()!.invoiceId!)!;
    await handleInvoicePaymentFailed(sep);
    store.row = { ...store.row, paygOverage: { ...store.row.paygOverage, admittedMonths: [admitted('2026-11'), admitted(NEXT)] } };
    spend(130, 130, NEXT);
    await settlePaygOverageMonth(OWNER, NEXT, new Date('2026-11-02T12:00:00.000Z'));
    const oct = mockStripeState.invoices.get(store.row.paygSettlements[NEXT].invoiceId)!;
    await handleInvoicePaymentFailed(oct);
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
    return { sep, oct };
  }

  it('concurrent paid webhooks for both months: both paid AND the suspension is lifted', async () => {
    const { sep, oct } = await twoFailedMonths();
    await Promise.all([
      handleInvoicePaymentSucceeded({ ...sep, status: 'paid' }),
      handleInvoicePaymentSucceeded({ ...oct, status: 'paid' }),
    ]);
    expect(store.row.paygSettlements[M].status).toBe('paid');
    expect(store.row.paygSettlements[NEXT].status).toBe('paid');
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('records overage payments under their own payment-history types, once per invoice', async () => {
    const { sep } = await twoFailedMonths();
    const { paymentHistoryDb } = jest.requireMock('../services/paymentHistoryDb');
    await handleInvoicePaymentSucceeded({ ...sep, status: 'paid', amount_paid: 4500 });
    const types = (paymentHistoryDb.record as jest.Mock).mock.calls.map(([row]) => row.eventType);
    expect(types).toEqual(['payg_overage_payment_failed', 'payg_overage_payment_failed', 'payg_overage_payment_succeeded']);
    expect(types).not.toContain('payment_failed');
    const paidCall = (paymentHistoryDb.record as jest.Mock).mock.calls[2];
    expect(paidCall[0]).toMatchObject({ amount: 4500, stripeInvoiceId: sep.id, metadata: { purchaseType: 'payg_overage', month: M } });
    expect(paidCall[1]).toEqual({ dedupKey: `payg_overage_payment_succeeded:${sep.id}` });
  });
});

describe('ENG-668 settlement — orphan drafts and more than one live invoice (rv4)', () => {
  const HOUR_AGO = Math.floor(Date.parse('2026-10-03T10:00:00.000Z') / 1000);
  function orphanDraft(id: string, created: number) {
    mockStripeState.invoices.set(id, {
      id, object: 'invoice', customer: 'cus_card', status: 'draft', total: 0, created,
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
      hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, lines: { data: [] },
    });
  }

  it('an empty draft left by a run that died (keys expired) is deleted, not adopted; one invoice results', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-03T12:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      setup();
      orphanDraft('in_orphan', HOUR_AGO - 1);
      expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('invoiced');
      expect(mockStripe.invoices.del).toHaveBeenCalledWith('in_orphan');
      expect(mockStripeState.invoices.has('in_orphan')).toBe(false);
      const live = [...mockStripeState.invoices.values()].filter((i) => i.status !== 'void');
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ status: 'open', total: 4500 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a fresh empty draft (a run in flight) is never deleted', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-03T12:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      setup();
      orphanDraft('in_inflight', Math.floor(Date.parse('2026-10-03T11:59:30.000Z') / 1000));
      await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'));
      expect(mockStripe.invoices.del).not.toHaveBeenCalled();
      expect(settlement()?.invoiceId).toBe('in_inflight'); // adopted, filled, finalized
    } finally {
      jest.useRealTimers();
    }
  });

  it('two live invoices for the month: held with both ids, nothing created or finalized, one alert', async () => {
    setup();
    for (const id of ['in_a', 'in_b']) {
      mockStripeState.invoices.set(id, {
        id, object: 'invoice', customer: 'cus_card', status: 'open', total: 4500, created: HOUR_AGO,
        metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
        hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, lines: { data: [{ amount: 4500, metadata: {} }] },
      });
    }
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(settlement()).toMatchObject({ status: 'held', heldReason: 'multiple_invoices', conflictingInvoiceIds: ['in_a', 'in_b'] });
    expect(settlement()?.invoiceId).toBeUndefined();
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
    expect(mockStripe.invoices.finalizeInvoice).not.toHaveBeenCalled();
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    const [, body] = (emailService.sendOncallAlert as jest.Mock).mock.calls[0];
    expect(body).toContain('Stripe holds 2 live invoices for this month (in_a, in_b)');
  });
});

// ── rvE2E: the whole invoice lifecycle through the REAL webhook controller ─────────────────────────────
import { handleWebhook } from '../controllers/stripeController';
import { handleChargeDisputeClosed } from '../services/stripeService';
import { runPaygSettlement as runSweep } from '../services/paygSettlementService';

const DAY3 = new Date('2026-10-03T12:00:00.000Z');
const flushAll = () => new Promise((resolve) => setImmediate(resolve));
function webhookRes() {
  const r = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}
/** Deliver one Stripe event through the webhook controller (signature check stubbed). */
async function deliver(type: string, object: unknown) {
  jest.spyOn(stripeService, 'constructWebhookEvent').mockReturnValue({ id: `evt_${type}_${Math.random()}`, type, data: { object } } as never);
  const r = webhookRes();
  await handleWebhook({ headers: { 'stripe-signature': 'sig' }, body: Buffer.from('{}') } as never, r as never);
  await flushAll();
  return r;
}
async function issueSeptember() {
  setup();
  expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('invoiced');
  return { ...mockStripeState.invoices.get('in_1')!, amount_paid: 0, amount_due: 4500, currency: 'usd', subscription: null };
}
const gateBlock = (row: { paygOverage: PaygOverageSettings }) => evaluatePaygAdmission({
  decision: { usageMode: 'paused', admissionAllowed: false, reason: 'hard_threshold_reached' },
  switchOn: true,
  tier: { allowed: true, markupBps: 15_000 },
  account: { ...row.paygOverage, poolHighWater: { month: NEXT, thresholdMicroUsd: 100 * USD } },
  hasPaymentMethod: true,
  subscriptionStatus: 'active',
  costUsedMicroUsd: 110 * USD,
  overageThresholdMicroUsd: 100 * USD,
  month: NEXT,
}).block;

describe('ENG-668 lifecycle — a failed overage invoice voided or marked uncollectible (rvE2E M1)', () => {
  it('V1: voided after failing — the month is written off and PAYG resumes; one on-call alert', async () => {
    const invoice = await issueSeptember();
    await deliver('invoice.payment_failed', { ...invoice, attempt_count: 1 });
    expect(settlement()).toMatchObject({ status: 'failed', hostedInvoiceUrl: 'https://invoice.stripe.com/i/1' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
    (emailService.sendOncallAlert as jest.Mock).mockClear();

    mockStripeState.invoices.get('in_1')!.status = 'void';
    const r = await deliver('invoice.voided', { ...invoice, status: 'void' });
    await deliver('invoice.voided', { ...invoice, status: 'void' }); // Stripe redelivers
    expect(r.json).toHaveBeenCalledWith({ received: true });
    await runSweep(DAY3);

    expect(settlement()).toMatchObject({ status: 'written_off', writtenOffReason: 'invoice_voided', invoiceId: 'in_1' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
    expect(gateBlock(store.row as { paygOverage: PaygOverageSettings })).toBeNull();
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect((emailService.sendOncallAlert as jest.Mock).mock.calls[0][0]).toContain('voided');
  });

  it('V2: the held-runbook path — a held invoice that then fails and is voided as the runbook says — resumes PAYG too', async () => {
    setup();
    mockStripeState.invoices.set('in_x', {
      id: 'in_x', object: 'invoice', customer: 'cus_card', status: 'open', total: 4000, created: 1,
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
      hosted_invoice_url: 'https://invoice.stripe.com/i/x', lines: { data: [{ amount: 4500, metadata: {} }] },
    });
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    const runbook = (emailService.sendOncallAlert as jest.Mock).mock.calls[0][1] as string;
    expect(runbook).toContain('void it in Stripe: that writes the month off');
    const inx = { ...mockStripeState.invoices.get('in_x')!, amount_due: 4000, currency: 'usd' };
    await deliver('invoice.payment_failed', inx);
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_x' });
    await deliver('invoice.voided', { ...inx, status: 'void' });
    await runSweep(DAY3);
    expect(settlement()).toMatchObject({ status: 'written_off' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('a void never lifts a dispute hold, nor a payment-failure hold while another month is still unpaid', async () => {
    const invoice = await issueSeptember();
    store.row = {
      ...store.row,
      paygOverage: { ...store.row.paygOverage, suspended: { reason: 'payment_failed', at: 'x', invoiceId: 'in_aug' } },
      paygSettlements: { ...store.row.paygSettlements, '2026-08': { status: 'failed', invoiceId: 'in_aug' } },
    };
    await deliver('invoice.voided', { ...invoice, status: 'void' });
    expect(settlement()).toMatchObject({ status: 'written_off' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_aug' });

    const second = await issueSeptember();
    store.row = { ...store.row, paygOverage: { ...store.row.paygOverage, suspended: { reason: 'dispute', at: 'x', invoiceId: 'in_old' } } };
    await deliver('invoice.voided', { ...second, status: 'void' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
  });

  it('V3: marked uncollectible keeps the month failed and suspended (still owed); paying it later lifts', async () => {
    const invoice = await issueSeptember();
    await deliver('invoice.payment_failed', invoice);
    await deliver('invoice.marked_uncollectible', { ...invoice, status: 'uncollectible' });
    expect(settlement()).toMatchObject({ status: 'failed' });
    expect(settlement()?.uncollectibleAt).toEqual(expect.any(String));
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
    await deliver('invoice.paid', { ...invoice, status: 'paid', amount_paid: 4500 });
    expect(settlement()).toMatchObject({ status: 'paid' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('marked uncollectible straight from invoiced: becomes failed + suspended, one failure email', async () => {
    const invoice = await issueSeptember();
    await deliver('invoice.marked_uncollectible', { ...invoice, status: 'uncollectible' });
    expect(settlement()).toMatchObject({ status: 'failed' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_1' });
    expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
  });

  it('V4: Smart Retries — three failures then paid: one failure email, suspended throughout, lifted on paid', async () => {
    const invoice = await issueSeptember();
    for (const attempt of [1, 2, 3]) {
      await deliver('invoice.payment_failed', { ...invoice, attempt_count: attempt });
      expect(gateBlock(store.row as { paygOverage: PaygOverageSettings })).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'payment_failed' });
    }
    expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
    await deliver('invoice.payment_succeeded', { ...invoice, status: 'paid', amount_paid: 4500, attempt_count: 4 });
    await deliver('invoice.paid', { ...invoice, status: 'paid', amount_paid: 4500, attempt_count: 4 });
    expect(settlement()).toMatchObject({ status: 'paid' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('a subscription invoice voided / marked uncollectible is left alone', async () => {
    setup();
    await deliver('invoice.voided', { id: 'in_sub', customer: 'cus_row', status: 'void', metadata: {} });
    await deliver('invoice.marked_uncollectible', { id: 'in_sub', customer: 'cus_row', status: 'uncollectible', metadata: {} });
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});

describe('ENG-668 lifecycle — emails, refunds, payment confirmation (rvE2E MINOR 1/2/3 + 3DS)', () => {
  it('R1: the paid webhook landing before the run marks the month invoiced: ONE invoice email, month paid', async () => {
    setup();
    const realFinalize = mockStripe.invoices.finalizeInvoice.getMockImplementation()!;
    mockStripe.invoices.finalizeInvoice.mockImplementationOnce(async (...args: Parameters<typeof realFinalize>) => {
      const finalized = await realFinalize(...args);
      await handleInvoicePaymentSucceeded({ ...finalized, status: 'paid', amount_paid: 4500 });
      return finalized;
    });
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('raced');
    expect(settlement()).toMatchObject({ status: 'paid', emailedAt: expect.any(String) });
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
    // A redelivered paid webhook sends nothing more.
    await handleInvoicePaymentSucceeded({ ...mockStripeState.invoices.get('in_1')!, status: 'paid', amount_paid: 4500 });
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it('the run dies after finalizing and Stripe collects before the next run: the paid webhook sends the one invoice email', async () => {
    setup();
    mockStripeState.loseResponse.add('invoices.finalize');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    expect(emailService.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
    await deliver('invoice.paid', { ...mockStripeState.invoices.get('in_1')!, status: 'paid', amount_paid: 4500, currency: 'usd' });
    expect(settlement()).toMatchObject({ status: 'paid', emailedAt: expect.any(String) });
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(await settlePaygOverageMonth(OWNER, M, DAY3)).toBe('already_recorded');
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it('R2 / rv5 MINOR 4: one history row PER REFUND with that refund\'s own amount — two partials sum to what was refunded; a redelivery adds none', async () => {
    const invoice = await issueSeptember();
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid', amount_paid: 4500 });
    const { paymentHistoryDb } = jest.requireMock('../services/paymentHistoryDb');
    const written: Array<{ key: string; amount: number }> = [];
    (paymentHistoryDb.record as jest.Mock).mockImplementation(async (row: { amount: number }, opts?: { dedupKey?: string }) => {
      if (opts?.dedupKey && written.some((w) => w.key === opts.dedupKey)) return { written: false };
      if (opts?.dedupKey) written.push({ key: opts.dedupKey, amount: row.amount });
      return { written: true };
    });
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: clone(mockStripeState.invoices.get('in_1')) }] });
    const charge = { id: 'ch_1', customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: 'pi_1', metadata: {}, amount_refunded: 1200, refunded: false };
    // $12 refunded, then $8 more: Stripe reports the charge's cumulative amount (1200, then 2000).
    mockStripeState.refunds.set('ch_1', [{ id: 're_a', amount: 1200, status: 'succeeded' }]);
    await deliver('charge.refunded', charge);
    await deliver('charge.refunded', charge); // at-least-once
    mockStripeState.refunds.set('ch_1', [{ id: 're_b', amount: 800, status: 'succeeded' }, { id: 're_a', amount: 1200, status: 'succeeded' }]);
    await deliver('charge.refunded', { ...charge, amount_refunded: 2000 });
    expect(written.filter((w) => w.key.startsWith('refund:'))).toEqual([
      { key: 'refund:re_a', amount: 1200 },
      { key: 'refund:re_b', amount: 800 },
    ]);
    expect(settlement()).toMatchObject({ refundedCents: 2000 });
    // The first event delivered late never lowers the recorded cumulative figure.
    await deliver('charge.refunded', charge);
    expect(settlement()).toMatchObject({ refundedCents: 2000 });
    // A failed refund returned nothing and is not recorded.
    mockStripeState.refunds.set('ch_1', [{ id: 're_c', amount: 500, status: 'failed' }, { id: 're_b', amount: 800, status: 'succeeded' }, { id: 're_a', amount: 1200, status: 'succeeded' }]);
    await deliver('charge.refunded', { ...charge, amount_refunded: 2000 });
    expect(written.map((w) => w.key)).not.toContain('refund:re_c');
  });

  it('R4: the invoice email states the percentage of the month\'s HIGHEST limit — the one the bill follows', async () => {
    // Admitted under a 200% ($200) cap, lowered to 25% at month end: billed $25 of a $200 highest limit.
    setup(ownerRow({ paygOverage: payg({ capPercentOfPool: 25, admittedMonths: [admitted(M, { capHighWaterMicroUsd: 200 * USD })] }) }));
    spend(125);
    await settlePaygOverageMonth(OWNER, M, DAY2);
    expect((emailService.sendPaygOverageInvoiceEmail as jest.Mock).mock.calls[0][0]).toMatchObject({ percentOfCap: 12 });
    expect(settlement()).toMatchObject({ overageCostMicroUsd: 25 * USD, percentOfCap: 12 });
  });

  it('payment_action_required (3-D Secure): one email with the invoice page, the month stays invoiced, nothing suspended', async () => {
    const invoice = await issueSeptember();
    await deliver('invoice.payment_action_required', { ...invoice, status: 'open' });
    await deliver('invoice.payment_action_required', { ...invoice, status: 'open' });
    expect(emailService.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledWith({
      to: 'owner@example.com', month: M, invoiceUrl: 'https://invoice.stripe.com/i/1',
    });
    expect(settlement()).toMatchObject({ status: 'invoiced', actionRequiredEmailedAt: expect.any(String) });
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('an invoice Stripe already collected when settlement adopts it ends `paid`, not `invoiced` (held, paid, retried)', async () => {
    setup();
    mockStripeState.invoices.set('in_p', {
      id: 'in_p', object: 'invoice', customer: 'cus_card', status: 'paid', total: 4500, created: 1,
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
      hosted_invoice_url: 'https://invoice.stripe.com/i/p', lines: { data: [{ amount: 4500, metadata: {} }] },
    });
    store.row = { ...store.row, paygSettlements: { [M]: { status: 'retry', idempotencyKey: KEY, createdAt: '2026-10-02T00:00:00.000Z',
      inputs: { credits: { purchasedMicroUsd: 0, adminGrantedMicroUsd: 0, migrationOffsetMicroUsd: 0 }, poolHighWater: { month: M, thresholdMicroUsd: 100 * USD } } } } };
    expect(await settlePaygOverageMonth(OWNER, M, DAY3)).toBe('paid');
    expect(settlement()).toMatchObject({ status: 'paid', invoiceId: 'in_p', paidAt: expect.any(String) });
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
  });
});

describe('ENG-668 lifecycle — disputes are announced and closed (rvE2E MINOR 4)', () => {
  const charge = { id: 'ch_1', customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: 'pi_1', metadata: {} };
  async function disputed() {
    const invoice = await issueSeptember();
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid', amount_paid: 4500 });
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ invoice: clone(mockStripeState.invoices.get('in_1')) }] });
    mockStripe.charges.retrieve.mockResolvedValue(charge);
    (emailService.sendOncallAlert as jest.Mock).mockClear();
    await deliver('charge.dispute.created', { id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd', reason: 'fraudulent', status: 'needs_response' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', invoiceId: 'in_1' });
  }

  it('a dispute that suspends PAYG pages on-call once', async () => {
    await disputed();
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect((emailService.sendOncallAlert as jest.Mock).mock.calls[0][0]).toContain('disputed');
  });

  it('won: the dispute hold is lifted and the outcome recorded', async () => {
    await disputed();
    await handleChargeDisputeClosed({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd', status: 'won' });
    expect(store.row.paygOverage.suspended).toBeUndefined();
    expect(settlement()).toMatchObject({ status: 'paid', disputes: { dp_1: { status: 'won', closedAt: expect.any(String) } } });
  });

  it('won while another month is unpaid: the hold becomes that month\'s payment failure, which paying it lifts', async () => {
    await disputed();
    store.row = { ...store.row, paygSettlements: { ...store.row.paygSettlements, '2026-08': { status: 'failed', invoiceId: 'in_aug' } } };
    await handleChargeDisputeClosed({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd', status: 'won' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_aug' });
  });

  it('lost: the month is written off, PAYG stays suspended, on-call is told', async () => {
    await disputed();
    (emailService.sendOncallAlert as jest.Mock).mockClear();
    await handleChargeDisputeClosed({ id: 'dp_1', charge: 'ch_1', amount: 4500, currency: 'usd', status: 'lost' });
    expect(settlement()).toMatchObject({ status: 'written_off', writtenOffReason: 'dispute_lost', disputes: { dp_1: { status: 'lost' } } });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', disputeId: 'dp_1', lost: true });
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect((emailService.sendOncallAlert as jest.Mock).mock.calls[0][0]).toContain('dispute lost');
  });
});

describe('ENG-668 settlement — drift tolerance and one alert per sweep (rvE2E)', () => {
  it('a projection a few cents behind the events (normal write lag) is billed from the events', async () => {
    setup();
    spend(130, 129.7); // 30 cents behind: within max(50c, 1%)
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('invoiced');
    expect(settlement()).toMatchObject({ amountCents: 4500, settledMicroUsd: 130 * USD, projectedMicroUsd: 129.7 * USD });
  });

  it('a real discrepancy (more than 1% and 50c) still holds', async () => {
    setup();
    spend(130, 127);
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(settlement()).toMatchObject({ heldReason: 'spend_drift' });
  });

  it('MINOR 7: a sweep that holds many months (settlement switched on late) sends ONE alert listing them', async () => {
    const owners = ['o-a', 'o-b', 'o-c'].map((userId) => ({
      ...ownerRow({ userId, paygOverage: payg({ admittedMonths: [admitted('2026-07'), admitted('2026-08')] }) }),
    }));
    setup(owners[0]);
    const rows = new Map(owners.map((row) => [row.userId, createUserRowFake(row)]));
    (userDb.scanWithFilter as jest.Mock).mockImplementation(async () => owners);
    (userDb.getUserByIdConsistent as jest.Mock).mockImplementation(async (id: string) => rows.get(id)!.read());
    (userDb.updateUser as jest.Mock).mockImplementation(async (id: string, fields: unknown, options: unknown) =>
      rows.get(id)!.updateUser(id, fields as Record<string, unknown>, options as never));
    const summary = await runSweep(DAY2);
    expect(summary.outcomes).toEqual({ held: 6 });
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    const [subject, body, context] = (emailService.sendOncallAlert as jest.Mock).mock.calls[0];
    expect(subject).toBe('PAYG settlement held 6 months this run');
    expect(body).toContain('o-c 2026-08 (inputs_unavailable)');
    expect(context).toMatchObject({ heldCount: 6 });
    // The next day's run holds nothing new: no alert at all.
    (emailService.sendOncallAlert as jest.Mock).mockClear();
    await runSweep(DAY3);
    expect(emailService.sendOncallAlert).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// rv5 review round: 3-D Secure, dispute bookkeeping, stale events, durable alerts, emails, re-pointed card
// ════════════════════════════════════════════════════════════════════════════════════════════════════
import { handleSetupIntentSucceeded } from '../services/stripeService';
import { PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS } from '../services/paygSettlement';
import * as settlementService from '../services/paygSettlementService';

describe('ENG-668 rv5 — the lifecycle round, hardened', () => {
  const { paymentHistoryDb } = jest.requireMock('../services/paymentHistoryDb');
  /** Charges by id, each paying one invoice (Basil: found through its PaymentIntent's invoice payment). */
  const charges = new Map<string, { paymentIntent: string; invoiceId: string }>();
  /** The status of each invoice's default PaymentIntent (what `invoice.payment_failed` is checked against). */
  const intentStatus = new Map<string, string>();
  const AUG = '2026-08';

  beforeEach(() => {
    charges.clear();
    intentStatus.clear();
    mockStripe.charges.retrieve.mockImplementation(async (id: string) => ({
      id, customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: charges.get(id)?.paymentIntent, metadata: {},
    }));
    mockStripe.invoicePayments.list.mockImplementation(async (params: { invoice?: string; payment?: { payment_intent: string } }) => {
      if (params.invoice) {
        const status = intentStatus.get(params.invoice);
        return { data: status ? [{ is_default: true, payment: { type: 'payment_intent', payment_intent: { id: `pi_${params.invoice}`, status } } }] : [] };
      }
      const paid = [...charges.values()].find((c) => c.paymentIntent === params.payment?.payment_intent);
      return { data: paid ? [{ invoice: clone(mockStripeState.invoices.get(paid.invoiceId)) }] : [] };
    });
  });

  /** September invoiced (in_1) and paid, with its charge `ch_1`. */
  async function paidSeptember() {
    const invoice = await issueSeptember();
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid', amount_paid: 4500 });
    charges.set('ch_1', { paymentIntent: 'pi_1', invoiceId: 'in_1' });
    return invoice;
  }
  /** August with its own overage invoice (`in_aug`, charge `ch_aug`), in `status`. */
  function addAugust(status: 'paid' | 'invoiced' | 'failed') {
    mockStripeState.invoices.set('in_aug', {
      id: 'in_aug', object: 'invoice', customer: 'cus_card', status: status === 'paid' ? 'paid' : 'open', total: 4500, created: 1,
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: AUG, idempotencyKey: `payg:${OWNER}:${AUG}` },
      hosted_invoice_url: 'https://invoice.stripe.com/i/aug', lines: { data: [{ amount: 4500, metadata: {} }] },
    });
    store.row = {
      ...store.row,
      paygSettlements: {
        ...store.row.paygSettlements,
        [AUG]: { status, invoiceId: 'in_aug', idempotencyKey: `payg:${OWNER}:${AUG}`, amountCents: 4500, percentOfCap: 60, createdAt: DAY2.toISOString(), updatedAt: DAY2.toISOString() },
      },
    };
    charges.set('ch_aug', { paymentIntent: 'pi_aug', invoiceId: 'in_aug' });
    return mockStripeState.invoices.get('in_aug')!;
  }
  const dispute = (id: string, chargeId: string, status?: string) => ({ id, charge: chargeId, amount: 4500, currency: 'usd', reason: 'fraudulent', ...(status ? { status } : {}) });

  // ── MAJOR 1: 3-D Secure ──────────────────────────────────────────────────────────────────────────────
  describe('3-D Secure: a payment waiting for the owner\'s confirmation is not a failure', () => {
    it.each([
      ['action_required, then payment_failed', ['invoice.payment_action_required', 'invoice.payment_failed']],
      ['payment_failed, then action_required', ['invoice.payment_failed', 'invoice.payment_action_required']],
    ])('%s (PaymentIntent requires_action): PAYG stays on, no failure email, one confirm email, month still invoiced', async (_order, events) => {
      const invoice = await issueSeptember();
      intentStatus.set('in_1', 'requires_action');
      for (const type of events) expect((await deliver(type, { ...invoice, status: 'open', attempt_count: 1 })).status).not.toHaveBeenCalled();
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(emailService.sendPaygOveragePaymentFailedEmail).not.toHaveBeenCalled();
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1); // the run's own, before any of this
      expect(emailService.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledTimes(1);
      expect(settlement()).toMatchObject({ status: 'invoiced', actionRequiredEmailedAt: expect.any(String) });
      expect((paymentHistoryDb.record as jest.Mock).mock.calls.map(([row]) => row.eventType)).not.toContain('payg_overage_payment_failed');
      // Checked against THIS invoice's own payment.
      expect(mockStripe.invoicePayments.list).toHaveBeenCalledWith({ invoice: 'in_1', limit: 10, expand: ['data.payment.payment_intent'] });
    });

    it('a PaymentIntent the list did not expand is retrieved before deciding', async () => {
      const invoice = await issueSeptember();
      mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ is_default: true, payment: { type: 'payment_intent', payment_intent: 'pi_x' } }] });
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_x', status: 'requires_action' });
      await deliver('invoice.payment_failed', { ...invoice, status: 'open' });
      expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_x');
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it.each(['requires_payment_method', undefined])('a decline or a failed authentication (PaymentIntent %p) still fails the month and holds PAYG', async (status) => {
      const invoice = await issueSeptember();
      if (status) intentStatus.set('in_1', status);
      await deliver('invoice.payment_failed', { ...invoice, status: 'open' });
      expect(settlement()).toMatchObject({ status: 'failed' });
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_1' });
      expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
    });

    it('the owner confirms but the bank then declines: the later failure does fail the month', async () => {
      const invoice = await issueSeptember();
      intentStatus.set('in_1', 'requires_action');
      await deliver('invoice.payment_failed', { ...invoice, status: 'open' });
      expect(store.row.paygOverage.suspended).toBeUndefined();
      intentStatus.set('in_1', 'requires_payment_method');
      await deliver('invoice.payment_failed', { ...invoice, status: 'open', attempt_count: 2 });
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
    });

    it('the PaymentIntent lookup failing errors the webhook (500, Stripe redelivers) — never guessed either way', async () => {
      const invoice = await issueSeptember();
      mockStripe.invoicePayments.list.mockRejectedValueOnce(new Error('stripe 503'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await deliver('invoice.payment_failed', { ...invoice, status: 'open' })).status).toHaveBeenCalledWith(500);
      errorLog.mockRestore();
      expect(settlement()).toMatchObject({ status: 'invoiced' });
      expect(store.row.paygOverage.suspended).toBeUndefined();
      await deliver('invoice.payment_failed', { ...invoice, status: 'open' }); // the redelivery: a decline
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
    });
  });

  // ── MAJOR 2 / MINOR 1 / MINOR 2 / MINOR 8: disputes ────────────────────────────────────────────────
  describe('disputes are tracked one by one', () => {
    it('closed (won) delivered BEFORE created: never suspended, the outcome kept, nobody paged', async () => {
      await paidSeptember();
      (emailService.sendOncallAlert as jest.Mock).mockClear();
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1', 'needs_response'));
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(settlement().disputes).toEqual({ dp_1: { at: expect.any(String), status: 'won', closedAt: expect.any(String) } });
      expect(emailService.sendOncallAlert).not.toHaveBeenCalled();
      expect((paymentHistoryDb.record as jest.Mock).mock.calls.map(([row]) => row.eventType)).not.toContain('dispute_opened');
    });

    it('created redelivered (or resent) after the dispute was won: not re-suspended, `won` kept, nobody paged — even if history would record it again', async () => {
      await paidSeptember();
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      expect(store.row.paygOverage.suspended).toBeUndefined();
      const closed = clone(settlement().disputes.dp_1);
      (emailService.sendOncallAlert as jest.Mock).mockClear();
      (paymentHistoryDb.record as jest.Mock).mockResolvedValue({ written: true }); // no help from the history dedupe
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(settlement().disputes.dp_1).toEqual(closed);
      expect(emailService.sendOncallAlert).not.toHaveBeenCalled();
    });

    it('a redelivered closed (lost) neither pages again nor re-imposes a hold someone removed', async () => {
      await paidSeptember();
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'lost'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', lost: true });
      store.row = { ...store.row, paygOverage: { ...store.row.paygOverage, suspended: undefined } }; // an operator clears it
      (emailService.sendOncallAlert as jest.Mock).mockClear();
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'lost'));
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(emailService.sendOncallAlert).not.toHaveBeenCalled();
    });

    it.each([
      ['the first', ['dp_s', 'dp_a']],
      ['the second', ['dp_a', 'dp_s']],
    ])('two disputes open on two months: winning %s keeps the hold; winning the other lifts it', async (_which, order) => {
      await paidSeptember();
      addAugust('paid');
      await deliver('charge.dispute.created', dispute('dp_s', 'ch_1'));
      await deliver('charge.dispute.created', dispute('dp_a', 'ch_aug'));
      const chargeOf = { dp_s: 'ch_1', dp_a: 'ch_aug' } as Record<string, string>;
      await deliver('charge.dispute.closed', dispute(order[0], chargeOf[order[0]], 'won'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
      await deliver('charge.dispute.closed', dispute(order[1], chargeOf[order[1]], 'won'));
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('two disputes on the same month: the hold lasts until both are closed', async () => {
      await paidSeptember();
      charges.set('ch_1b', { paymentIntent: 'pi_1', invoiceId: 'in_1' });
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      await deliver('charge.dispute.created', dispute('dp_2', 'ch_1b'));
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
      await deliver('charge.dispute.closed', dispute('dp_2', 'ch_1b', 'warning_closed'));
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('a lost dispute keeps the hold even when another dispute is won later — only a person lifts it', async () => {
      await paidSeptember();
      addAugust('paid');
      await deliver('charge.dispute.created', dispute('dp_s', 'ch_1'));
      await deliver('charge.dispute.created', dispute('dp_a', 'ch_aug'));
      await deliver('charge.dispute.closed', dispute('dp_s', 'ch_1', 'lost'));
      await deliver('charge.dispute.closed', dispute('dp_a', 'ch_aug', 'won'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', lost: true, disputeId: 'dp_s' });
      expect(settlement()).toMatchObject({ status: 'written_off', writtenOffReason: 'dispute_lost' });
    });

    it('the lift removes only a hold a RECORDED dispute set: a hand-set dispute hold, or one naming an unknown dispute, stays (rv5 MINOR 8)', async () => {
      for (const handSet of [{ reason: 'dispute', at: '2026-10-09T00:00:00.000Z', invoiceId: 'in_1' }, { reason: 'dispute', at: '2026-10-09T00:00:00.000Z', invoiceId: 'in_1', disputeId: 'dp_unknown' }]) {
        jest.clearAllMocks();
        await paidSeptember();
        await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
        store.row = { ...store.row, paygOverage: { ...store.row.paygOverage, suspended: handSet } };
        await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
        expect(store.row.paygOverage.suspended).toEqual(handSet);
      }
    });

    it('won while another month is failed: the hold goes to that month (paying it lifts), never removed', async () => {
      await paidSeptember();
      addAugust('failed');
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_aug' });
      await deliver('invoice.paid', { ...mockStripeState.invoices.get('in_aug')!, status: 'paid', amount_paid: 4500 });
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    /** Run `competitor` right after the n-th strongly consistent read of the row (the lift's is the 3rd). */
    function afterRead(n: number, competitor: () => Promise<unknown>) {
      let reads = 0;
      (userDb.getUserByIdConsistent as jest.Mock).mockImplementation(async () => {
        const snapshot = await store.read();
        reads += 1;
        if (reads === n) await competitor();
        return snapshot;
      });
    }

    it('a payment failure landing after the won-lift read keeps the account suspended — the lift is refused and re-reads (rv5 MINOR 2)', async () => {
      await paidSeptember();
      const aug = addAugust('invoiced');
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      // closed: 1 = loadSettlementFor, 2 = recording it closed, 3 = the lift's read.
      afterRead(3, () => settlementService.handlePaygOverageInvoicePaymentFailed({ ...aug, status: 'open' }));
      await settlementService.handlePaygOverageChargeDisputeClosed(dispute('dp_1', 'ch_1', 'won'), { id: 'ch_1' }, clone(mockStripeState.invoices.get('in_1')!));
      expect(store.row.paygSettlements[AUG].status).toBe('failed');
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_aug' });
    });

    it('a second dispute opened after the won-lift read keeps the account suspended', async () => {
      await paidSeptember();
      addAugust('paid');
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      afterRead(3, () => settlementService.handlePaygOverageChargeDisputed(dispute('dp_a', 'ch_aug'), { id: 'ch_aug' }, clone(mockStripeState.invoices.get('in_aug')!)));
      await settlementService.handlePaygOverageChargeDisputeClosed(dispute('dp_1', 'ch_1', 'won'), { id: 'ch_1' }, clone(mockStripeState.invoices.get('in_1')!));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', disputeId: 'dp_a' });
    });
  });

  // ── MINOR 3: a record that names no invoice yet ─────────────────────────────────────────────────────
  describe('a pending record with no invoice yet owns only an invoice its own run would adopt', () => {
    const pendingNoInvoice = () => setup(ownerRow({
      paygSettlements: { [M]: { status: 'pending', idempotencyKey: KEY, amountCents: 4500, percentOfCap: 60, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' } },
    }));
    const oldInvoice = (over: Record<string, unknown> = {}) => ({
      id: 'in_old', object: 'invoice', customer: 'cus_card', status: 'void', total: 4500, amount_due: 4500, currency: 'usd',
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY }, hosted_invoice_url: 'https://invoice.stripe.com/i/old', ...over,
    });

    it('a late invoice.voided for an OLD invoice of the month never writes off the new pending record', async () => {
      pendingNoInvoice();
      await deliver('invoice.voided', oldInvoice());
      expect(settlement()).toMatchObject({ status: 'pending' });
      expect(settlement()).not.toHaveProperty('invoiceId');
      expect(emailService.sendOncallAlert).not.toHaveBeenCalled();
    });

    it('an invoice whose metadata is not this record\'s key is ignored too (failed, paid)', async () => {
      pendingNoInvoice();
      const foreign = oldInvoice({ status: 'open', metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: 'payg:someone-else:2026-09' } });
      await deliver('invoice.payment_failed', foreign);
      await deliver('invoice.paid', { ...foreign, status: 'paid' });
      expect(settlement()).toMatchObject({ status: 'pending' });
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('the invoice THIS record\'s run created (its createdAt in the metadata) is recorded', async () => {
      pendingNoInvoice();
      const own = oldInvoice({ id: 'in_live', status: 'paid', amount_paid: 4500 });
      await deliver('invoice.paid', { ...own, metadata: { ...own.metadata, recordCreatedAt: '2026-10-05T00:00:00.000Z' } });
      expect(settlement()).toMatchObject({ status: 'paid', invoiceId: 'in_live' });
    });

    it('rv6 MINOR 1: a redelivered failure for the OLD invoice (payload still `open`, same key) never fails the new pending record', async () => {
      pendingNoInvoice();
      // An earlier record's invoice: same month key, its own record's createdAt (or none).
      const earlier = oldInvoice({ status: 'open', metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY, recordCreatedAt: '2026-10-02T12:00:00.000Z' } });
      await deliver('invoice.payment_failed', earlier);
      await deliver('invoice.payment_failed', oldInvoice({ status: 'open' })); // no record createdAt at all
      expect(settlement()).toMatchObject({ status: 'pending' });
      expect(settlement()).not.toHaveProperty('invoiceId');
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(emailService.sendPaygOveragePaymentFailedEmail).not.toHaveBeenCalled();
    });

    it('the run stamps the record\'s createdAt on the invoice it creates', async () => {
      setup();
      await settlePaygOverageMonth(OWNER, M, DAY2);
      expect(mockStripeState.invoices.get('in_1')!.metadata).toMatchObject({ idempotencyKey: KEY, recordCreatedAt: DAY2.toISOString() });
    });
  });

  // ── MINOR 6: held-month alerts are durable ──────────────────────────────────────────────────────────
  it('a held month\'s alert survives a sweep that dies before alerting: the next sweep sends it once, then clears it (rv5 MINOR 6)', async () => {
    setup();
    spend(130, 100); // drift: held
    // The process dies right after the hold is written, before any alert.
    await expect(settlePaygOverageMonth(OWNER, M, DAY2, async () => { throw new Error('process died'); })).rejects.toThrow('process died');
    expect(settlement()).toMatchObject({ status: 'held', heldReason: 'spend_drift', alertPending: expect.any(String) });
    expect(emailService.sendOncallAlert).not.toHaveBeenCalled();
    await runSweep(DAY3);
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    expect((emailService.sendOncallAlert as jest.Mock).mock.calls[0][0]).toBe(`PAYG settlement held for ${M}: spend_drift`);
    expect(settlement()).not.toHaveProperty('alertPending');
    await runSweep(DAY3);
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
  });

  it('an alert that fails to go out stays pending and is sent by the next sweep', async () => {
    setup();
    spend(130, 100);
    (emailService.sendOncallAlert as jest.Mock).mockRejectedValueOnce(new Error('smtp down'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await runSweep(DAY2);
    errorLog.mockRestore();
    expect(settlement()).toMatchObject({ status: 'held', alertPending: expect.any(String) });
    await runSweep(DAY3);
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(2);
    expect(settlement()).not.toHaveProperty('alertPending');
  });

  // ── NIT: the invoice email ──────────────────────────────────────────────────────────────────────────
  describe('the invoice email never contradicts what happened', () => {
    it('payment_failed lands before the run records the month invoiced: only the failure email, never "will charge your card"', async () => {
      setup();
      const realFinalize = mockStripe.invoices.finalizeInvoice.getMockImplementation()!;
      mockStripe.invoices.finalizeInvoice.mockImplementationOnce(async (...args: Parameters<typeof realFinalize>) => {
        const finalized = await realFinalize(...args);
        await handleInvoicePaymentFailed({ ...finalized, amount_due: 4500 });
        return finalized;
      });
      expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('raced');
      expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
    });

    it('payment_failed lands right AFTER the run records the month invoiced, before its email: still no "will charge your card" (the claim checks the state)', async () => {
      setup();
      let injected = false;
      (userDb.updateUser as jest.Mock).mockImplementation(async (id: string, fields: Record<string, unknown>, options: { pathSets?: Array<{ path: unknown[]; value: unknown }> } = {}) => {
        const result = await store.updateUser(id, fields, options as never);
        const markedInvoiced = (options.pathSets ?? []).some((set) => set.path.join('.') === `paygSettlements.${M}.status` && set.value === 'invoiced');
        if (markedInvoiced && !injected) {
          injected = true;
          await handleInvoicePaymentFailed({ ...mockStripeState.invoices.get('in_1')!, amount_due: 4500 });
        }
        return result;
      });
      expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('invoiced');
      expect(injected).toBe(true);
      expect(settlement()).toMatchObject({ status: 'failed' });
      expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
    });

    it('voided before the run records it: no invoice email for a written-off month', async () => {
      setup();
      const realFinalize = mockStripe.invoices.finalizeInvoice.getMockImplementation()!;
      mockStripe.invoices.finalizeInvoice.mockImplementationOnce(async (...args: Parameters<typeof realFinalize>) => {
        const finalized = await realFinalize(...args);
        await settlementService.handlePaygOverageInvoiceVoided({ ...finalized, status: 'void' });
        return finalized;
      });
      await settlePaygOverageMonth(OWNER, M, DAY2);
      expect(settlement()).toMatchObject({ status: 'written_off' });
      expect(emailService.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
    });

    it('collected before the run (paid webhook first) or already paid at adoption: the email says it has been paid', async () => {
      setup();
      const realFinalize = mockStripe.invoices.finalizeInvoice.getMockImplementation()!;
      mockStripe.invoices.finalizeInvoice.mockImplementationOnce(async (...args: Parameters<typeof realFinalize>) => {
        const finalized = await realFinalize(...args);
        await handleInvoicePaymentSucceeded({ ...finalized, status: 'paid', amount_paid: 4500 });
        return finalized;
      });
      await settlePaygOverageMonth(OWNER, M, DAY2);
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ paid: true }));

      jest.clearAllMocks();
      mockStripeState.invoices.clear();
      mockStripeState.keys.clear();
      setup();
      mockStripeState.invoices.set('in_p', {
        id: 'in_p', object: 'invoice', customer: 'cus_card', status: 'paid', total: 4500, created: 1,
        metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
        hosted_invoice_url: 'https://invoice.stripe.com/i/p', lines: { data: [{ amount: 4500, metadata: {} }] },
      });
      expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('paid');
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ paid: true }));
    });

    it('a held month whose invoice is paid later gets the paid wording', async () => {
      setup(ownerRow({
        paygSettlements: { [M]: { status: 'held', heldReason: 'invoice_mismatch', invoiceId: 'in_h', idempotencyKey: KEY, amountCents: 4500, percentOfCap: 60, createdAt: DAY2.toISOString(), updatedAt: DAY2.toISOString() } },
      }));
      await deliver('invoice.paid', {
        id: 'in_h', object: 'invoice', status: 'paid', amount_paid: 4800, currency: 'usd', hosted_invoice_url: 'https://invoice.stripe.com/i/h',
        metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
      });
      expect(settlement()).toMatchObject({ status: 'paid' });
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ paid: true }));
    });
  });

  // ── PINNED CARD: a newly saved card replaces the pin on an open overage invoice ─────────────────────
  describe('setup_intent.succeeded re-points an open overage invoice pinned to the old card', () => {
    const savedCard = (over: Record<string, unknown> = {}) => ({ id: 'seti_1', object: 'setup_intent', status: 'succeeded', customer: 'cus_card', payment_method: 'pm_new', metadata: {}, ...over });
    /** The customer's attached payment methods (`paymentMethods.list`), newest decided by `created`. */
    let cards: Array<{ id: string; type: string; created: number }>;
    beforeEach(() => {
      cards = [{ id: 'pm_card', type: 'card', created: 100 }, { id: 'pm_new', type: 'card', created: 200 }];
      (mockStripe as unknown as { paymentMethods: { list: jest.Mock } }).paymentMethods = {
        list: jest.fn(async ({ type }: { type?: string }) => ({ data: cards.filter((c) => !type || c.type === type) })),
      };
      mockStripe.invoices.list.mockReset().mockImplementation(async ({ customer, status }: { customer: string; status: string }) => ({
        data: [...mockStripeState.invoices.values()].filter((i) => i.customer === customer && i.status === status).map(clone),
      }));
    });
    const tagged = () => savedCard({ metadata: { userId: OWNER, purchaseType: 'zoma_payment_method' } });
    const readsTheRow = () => (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => (id === OWNER ? store.read() : undefined));

    it('a failed month\'s invoice pinned to pm_card now charges pm_new, the newest card (Stripe\'s next retry uses it)', async () => {
      const invoice = await issueSeptember(); // pinned: the customer had no invoice default
      expect(invoice.default_payment_method).toBe('pm_card');
      await deliver('invoice.payment_failed', { ...invoice, status: 'open' });
      readsTheRow();
      const r = await deliver('setup_intent.succeeded', tagged());
      expect(r.json).toHaveBeenCalledWith({ received: true });
      expect(mockStripe.invoices.update).toHaveBeenCalledWith('in_1', { default_payment_method: 'pm_new' }, { idempotencyKey: 'payg-repoint:in_1:pm_new' });
      expect(mockStripeState.invoices.get('in_1')!.default_payment_method).toBe('pm_new');
    });

    it('rv6 MINOR 3a: two cards saved, events delivered newer-first — the invoice ends on the NEWER card, never moved back', async () => {
      await issueSeptember();
      readsTheRow();
      cards = [{ id: 'pm_card', type: 'card', created: 50 }, { id: 'pm_A', type: 'card', created: 100 }, { id: 'pm_B', type: 'card', created: 200 }];
      await handleSetupIntentSucceeded(savedCard({ id: 'seti_B', payment_method: 'pm_B', metadata: { userId: OWNER } }));
      await handleSetupIntentSucceeded(savedCard({ id: 'seti_A', payment_method: 'pm_A', metadata: { userId: OWNER } }));
      expect(mockStripeState.invoices.get('in_1')!.default_payment_method).toBe('pm_B');
      expect(mockStripe.invoices.update).toHaveBeenCalledTimes(1);
    });

    it('rv6 MINOR 3b: a method that is not an attached card (detached since, or a bank account) is never pinned', async () => {
      await issueSeptember();
      readsTheRow();
      cards = [{ id: 'pm_card', type: 'card', created: 100 }, { id: 'pm_bank', type: 'us_bank_account', created: 300 }];
      await handleSetupIntentSucceeded(savedCard({ payment_method: 'pm_bank', metadata: { userId: OWNER } }));
      await handleSetupIntentSucceeded(savedCard({ payment_method: 'pm_gone', metadata: { userId: OWNER } }));
      expect(mockStripe.invoices.update).not.toHaveBeenCalled();
    });

    it('rv6 MINOR 3b: Stripe refusing one update is logged, the next invoice is still re-pointed, on-call is told once, and the webhook is acknowledged', async () => {
      await issueSeptember();
      mockStripeState.invoices.set('in_aug', { ...clone(mockStripeState.invoices.get('in_1')!), id: 'in_aug', status: 'open', metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: '2026-08', idempotencyKey: `payg:${OWNER}:2026-08` } });
      store.row = { ...store.row, paygSettlements: { ...store.row.paygSettlements, '2026-08': { status: 'failed', invoiceId: 'in_aug' } } };
      readsTheRow();
      mockStripe.invoices.update.mockRejectedValueOnce(Object.assign(new Error('The PaymentMethod pm_new does not belong to the Customer'), { type: 'StripeInvalidRequestError', statusCode: 400 }));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await deliver('setup_intent.succeeded', tagged());
      errorLog.mockRestore();
      expect(r.status).not.toHaveBeenCalled();
      expect(r.json).toHaveBeenCalledWith({ received: true });
      expect(mockStripe.invoices.update).toHaveBeenCalledTimes(2);
      expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
      expect((emailService.sendOncallAlert as jest.Mock).mock.calls[0][2]).toMatchObject({ 'Alert Class': 'payg-settlement-repoint' });
    });

    it('rv6 MINOR 4a: an untagged SetupIntent asks Stripe for the customer\'s open invoices (no table scan) and confirms each against its owner\'s record', async () => {
      const invoice = await issueSeptember();
      readsTheRow();
      await handleSetupIntentSucceeded(savedCard());
      expect(userDb.scanWithFilter).not.toHaveBeenCalledWith('stripe_customer_id = :cid', expect.anything());
      expect(mockStripe.invoices.list).toHaveBeenCalledWith({ customer: 'cus_card', status: 'open', limit: 100 });
      expect(mockStripe.invoices.update).toHaveBeenCalledTimes(1);
      expect(invoice.id).toBe('in_1');
      await handleSetupIntentSucceeded(savedCard()); // a redelivery: already pinned to pm_new
      expect(mockStripe.invoices.update).toHaveBeenCalledTimes(1);
    });

    it('an untagged card save for a customer with no open overage invoice: one list call, no row read, nothing else', async () => {
      setup();
      await handleSetupIntentSucceeded(savedCard({ customer: 'cus_nobody' }));
      expect(mockStripe.invoices.list).toHaveBeenCalledTimes(1);
      expect(userDb.getUserById).not.toHaveBeenCalled();
      expect(userDb.scanWithFilter).not.toHaveBeenCalled();
      expect(mockStripe.invoices.update).not.toHaveBeenCalled();
    });

    it('never touches: an account with no open overage invoice (no Stripe call), an unpinned invoice, another customer\'s card', async () => {
      setup();
      readsTheRow();
      await handleSetupIntentSucceeded(savedCard({ metadata: { userId: OWNER } }));
      expect(mockStripe.invoices.retrieve).not.toHaveBeenCalled();

      await issueSeptember();
      readsTheRow();
      await handleSetupIntentSucceeded(savedCard({ customer: 'cus_other', metadata: { userId: OWNER } }));
      mockStripeState.invoices.get('in_1')!.default_payment_method = undefined;
      await handleSetupIntentSucceeded(savedCard({ metadata: { userId: OWNER } }));
      expect(mockStripe.invoices.update).not.toHaveBeenCalled();
    });

    it('a failed lookup (row or Stripe list) is logged and acknowledged, as before this handler existed', async () => {
      setup();
      (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('throttled'));
      mockStripe.invoices.list.mockRejectedValue(new Error('stripe 503'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await deliver('setup_intent.succeeded', savedCard({ metadata: { userId: OWNER } }))).json).toHaveBeenCalledWith({ received: true });
      expect((await deliver('setup_intent.succeeded', savedCard())).json).toHaveBeenCalledWith({ received: true });
      errorLog.mockRestore();
      expect(mockStripe.invoices.retrieve).not.toHaveBeenCalled();
    });
  });

  // ── rv6 MINOR 2: a reported failure whose payment has gone through (or is processing) ────────────
  it.each(['succeeded', 'processing'])('rv6 MINOR 2: payment_failed while the PaymentIntent is %s (confirmed late / debit in flight): no failure email, no hold, month untouched', async (status) => {
    const invoice = await issueSeptember();
    intentStatus.set('in_1', status);
    await deliver('invoice.payment_failed', { ...invoice, status: 'open', attempt_count: 1 });
    expect(emailService.sendPaygOveragePaymentFailedEmail).not.toHaveBeenCalled();
    expect(store.row.paygOverage.suspended).toBeUndefined();
    expect(settlement()).toMatchObject({ status: 'invoiced' });
  });

  it.each(['canceled', 'requires_confirmation'])('a PaymentIntent %s with a reported failure is a failure', async (status) => {
    const invoice = await issueSeptember();
    intentStatus.set('in_1', status);
    await deliver('invoice.payment_failed', { ...invoice, status: 'open' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
  });

  // ── rv6 MINOR 5: a payment never confirmed ─────────────────────────────────────────────────────────
  describe('a payment left unconfirmed past the grace period is treated as unpaid', () => {
    const DAY = 24 * 60 * 60 * 1000;
    async function unconfirmed() {
      const invoice = await issueSeptember();
      intentStatus.set('in_1', 'requires_action');
      await deliver('invoice.payment_action_required', { ...invoice, status: 'open' });
      expect(settlement()).toMatchObject({ status: 'invoiced', actionRequiredAt: expect.any(String) });
      return { invoice, since: Date.parse(settlement().actionRequiredAt) };
    }

    it(`within ${PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS} days nothing happens; after, the sweep fails the month, holds PAYG (unconfirmed) and emails the invoice once`, async () => {
      const { since } = await unconfirmed();
      await runSweep(new Date(since + (PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS * DAY) - 60_000));
      expect(settlement().status).toBe('invoiced');
      expect(store.row.paygOverage.suspended).toBeUndefined();
      const later = new Date(since + PAYG_PAYMENT_CONFIRMATION_GRACE_DAYS * DAY);
      const summary = await runSweep(later);
      expect(summary.outcomes).toMatchObject({ payment_unconfirmed: 1 });
      expect(settlement()).toMatchObject({ status: 'failed', paymentUnconfirmedAt: later.toISOString() });
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_1', unconfirmed: true });
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).toHaveBeenCalledWith({ to: 'owner@example.com', month: M, invoiceUrl: 'https://invoice.stripe.com/i/1' });
      expect(emailService.sendPaygOveragePaymentFailedEmail).not.toHaveBeenCalled();
      // The 429 says what lifts it, with the invoice to confirm.
      expect(gateBlock(store.row as { paygOverage: PaygOverageSettings })).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'payment_unconfirmed' });
      // The next sweep does nothing more; confirming (paying) lifts the hold.
      await runSweep(new Date(later.getTime() + DAY));
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).toHaveBeenCalledTimes(1);
      await deliver('invoice.paid', { ...mockStripeState.invoices.get('in_1')!, status: 'paid', amount_paid: 4500 });
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('confirmed (or processing) by the time the sweep looks: left for its invoice.paid, never held', async () => {
      const { since } = await unconfirmed();
      intentStatus.set('in_1', 'succeeded');
      await runSweep(new Date(since + 8 * DAY));
      expect(settlement().status).toBe('invoiced');
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).not.toHaveBeenCalled();
    });

    it('the grace period starts at the FIRST report and is not moved by later ones; the payment_failed pair stamps it too', async () => {
      const invoice = await issueSeptember();
      intentStatus.set('in_1', 'requires_action');
      await deliver('invoice.payment_failed', { ...invoice, status: 'open' });
      const first = settlement().actionRequiredAt;
      expect(first).toEqual(expect.any(String));
      await new Promise((r) => setTimeout(r, 5));
      await deliver('invoice.payment_action_required', { ...invoice, status: 'open' });
      await deliver('invoice.payment_failed', { ...invoice, status: 'open', attempt_count: 2 });
      expect(settlement().actionRequiredAt).toBe(first);
    });
  });
});

describe('ENG-668 rv6 NIT — the overage invoice behind a charge', () => {
  it('looks at every invoice payment of the PaymentIntent (paid first), not just the first one listed', async () => {
    setup();
    const overage = { id: 'in_ov', object: 'invoice', status: 'paid', metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M } };
    mockStripe.invoicePayments.list.mockResolvedValue({
      data: [
        { status: 'canceled', invoice: { id: 'in_other', object: 'invoice', metadata: {} } },
        { status: 'paid', invoice: overage },
      ],
    });
    await expect(stripeService.findPaygOverageInvoiceForCharge({ id: 'ch_1', payment_intent: 'pi_1' })).resolves.toMatchObject({ id: 'in_ov' });
    expect(mockStripe.invoicePayments.list).toHaveBeenCalledWith({ payment: { type: 'payment_intent', payment_intent: 'pi_1' }, limit: 10, expand: ['data.invoice'] });
    mockStripe.invoicePayments.list.mockResolvedValue({ data: [{ status: 'paid', invoice: { id: 'in_sub', object: 'invoice', metadata: {} } }] });
    await expect(stripeService.findPaygOverageInvoiceForCharge({ id: 'ch_2', payment_intent: 'pi_2' })).resolves.toBeNull();
  });

  it('rv7 NIT: pages through invoice payments while Stripe says has_more (starting_after), and stops at a bound', async () => {
    setup();
    const overage = { id: 'in_ov', object: 'invoice', status: 'paid', metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M } };
    mockStripe.invoicePayments.list.mockReset()
      .mockResolvedValueOnce({ has_more: true, data: [{ id: 'inpay_1', status: 'canceled', invoice: { id: 'in_other', object: 'invoice', metadata: {} } }] })
      .mockResolvedValueOnce({ has_more: false, data: [{ id: 'inpay_2', status: 'paid', invoice: overage }] });
    await expect(stripeService.findPaygOverageInvoiceForCharge({ id: 'ch_1', payment_intent: 'pi_1' })).resolves.toMatchObject({ id: 'in_ov' });
    expect(mockStripe.invoicePayments.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ starting_after: 'inpay_1' }));

    let n = 0;
    mockStripe.invoicePayments.list.mockReset().mockImplementation(async () => ({ has_more: true, data: [{ id: `inpay_x${++n}`, status: 'paid', invoice: { id: `in_s${n}`, object: 'invoice', metadata: {} } }] }));
    await expect(stripeService.findPaygOverageInvoiceForCharge({ id: 'ch_3', payment_intent: 'pi_3' })).resolves.toBeNull();
    expect(mockStripe.invoicePayments.list).toHaveBeenCalledTimes(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// rv7 review round: the reviewer's cases, kept (probes flipped to the fixed behaviour)
// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('ENG-668 rv7 — review cases kept', () => {
  const { paymentHistoryDb } = jest.requireMock('../services/paymentHistoryDb');
  const charges = new Map<string, { paymentIntent: string; invoiceId: string }>();
  const intentStatus = new Map<string, string>();
  const AUG = '2026-08';
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    charges.clear();
    intentStatus.clear();
    mockStripe.charges.retrieve.mockImplementation(async (id: string) => ({
      id, customer: 'cus_card', amount: 4500, currency: 'usd', payment_intent: charges.get(id)?.paymentIntent, metadata: {},
    }));
    mockStripe.invoicePayments.list.mockImplementation(async (params: { invoice?: string; payment?: { payment_intent: string } }) => {
      if (params.invoice) {
        const status = intentStatus.get(params.invoice);
        return { data: status ? [{ is_default: true, payment: { type: 'payment_intent', payment_intent: { id: `pi_${params.invoice}`, status } } }] : [] };
      }
      const paid = [...charges.values()].find((c) => c.paymentIntent === params.payment?.payment_intent);
      return { data: paid ? [{ status: 'paid', invoice: clone(mockStripeState.invoices.get(paid.invoiceId)) }] : [] };
    });
  });
  const dispute = (id: string, chargeId: string, status?: string) => ({ id, charge: chargeId, amount: 4500, currency: 'usd', reason: 'fraudulent', ...(status ? { status } : {}) });

  /** September invoiced (in_1) and paid (ch_1); August failed on in_aug. */
  async function paidSeptemberFailedAugust() {
    const invoice = await issueSeptember();
    await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid', amount_paid: 4500 });
    charges.set('ch_1', { paymentIntent: 'pi_1', invoiceId: 'in_1' });
    mockStripeState.invoices.set('in_aug', {
      id: 'in_aug', object: 'invoice', customer: 'cus_card', status: 'open', total: 4500, created: 1,
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: AUG, idempotencyKey: `payg:${OWNER}:${AUG}` },
      hosted_invoice_url: 'https://invoice.stripe.com/i/aug', lines: { data: [{ amount: 4500, metadata: {} }] },
    });
    store.row = {
      ...store.row,
      paygSettlements: {
        ...store.row.paygSettlements,
        [AUG]: { status: 'invoiced', invoiceId: 'in_aug', idempotencyKey: `payg:${OWNER}:${AUG}`, amountCents: 4500, percentOfCap: 60, createdAt: DAY2.toISOString(), updatedAt: DAY2.toISOString(), hostedInvoiceUrl: 'https://invoice.stripe.com/i/aug' },
      },
    };
    return invoice;
  }

  // ── MAJOR 1 ───────────────────────────────────────────────────────────────────────────────────────
  describe('MAJOR 1: won-dispute hand-over', () => {
    it('hand-over: dispute won while August still failed => payment_failed hold on in_aug; paying August lifts it', async () => {
      await paidSeptemberFailedAugust();
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      await deliver('invoice.payment_failed', { ...mockStripeState.invoices.get('in_aug')!, amount_due: 4500 });
      expect(store.row.paygSettlements[AUG].status).toBe('failed');
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', paymentFailedAt: expect.any(String) });
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_aug' });
      await deliver('invoice.paid', { ...mockStripeState.invoices.get('in_aug')!, status: 'paid', amount_paid: 4500 });
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it.each([
      ['paid', { status: 'paid', paidAt: 'x' }],
      ['voided (written off)', { status: 'written_off', writtenOffReason: 'invoice_voided' }],
    ])('RACE: August %s between the lift\'s read and its write => the hold is REMOVED (never a stranded payment_failed hold)', async (_label, change) => {
      await paidSeptemberFailedAugust();
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      await deliver('invoice.payment_failed', { ...mockStripeState.invoices.get('in_aug')!, amount_due: 4500 });
      // The August paid webhook landed between the lift's read and its write. Its own lift saw a
      // dispute hold and did nothing (a dispute hold is never lifted by paying).
      const real = (userDb.updateUser as jest.Mock).getMockImplementation()!;
      let injected = false;
      (userDb.updateUser as jest.Mock).mockImplementation(async (id: string, attrs: unknown, opts: { pathSets?: Array<{ path: string[]; value: { reason?: string } }> }) => {
        const handOver = opts?.pathSets?.some((s) => s.path.join('.') === 'paygOverage.suspended' && s.value?.reason === 'payment_failed');
        if (handOver && !injected) {
          injected = true;
          store.row.paygSettlements[AUG] = { ...store.row.paygSettlements[AUG], ...change };
        }
        return real(id, attrs, opts);
      });
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      expect(injected).toBe(true);
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('rv7 NIT: the hold handed over to a month failed as UNCONFIRMED keeps `unconfirmed` (the 429 says "waiting to be confirmed")', async () => {
      await paidSeptemberFailedAugust();
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      store.row.paygSettlements[AUG] = { ...store.row.paygSettlements[AUG], status: 'failed', paymentUnconfirmedAt: 'x' };
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_aug', unconfirmed: true });
      expect(gateBlock(store.row as { paygOverage: PaygOverageSettings })).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'payment_unconfirmed' });
    });

    it('rv7 NIT: a hold handed over to a month that failed on a decline carries no `unconfirmed`', async () => {
      await paidSeptemberFailedAugust();
      await deliver('charge.dispute.created', dispute('dp_1', 'ch_1'));
      await deliver('invoice.payment_failed', { ...mockStripeState.invoices.get('in_aug')!, amount_due: 4500 });
      await deliver('charge.dispute.closed', dispute('dp_1', 'ch_1', 'won'));
      expect(store.row.paygOverage.suspended).not.toHaveProperty('unconfirmed');
    });
  });

  // ── MINOR 1 ───────────────────────────────────────────────────────────────────────────────────────
  describe('MINOR 1: record-owned invoices', () => {
    it('every new invoice and its item carry recordCreatedAt', async () => {
      await issueSeptember();
      expect(mockStripe.invoices.create.mock.calls[0][0].metadata).toMatchObject({ recordCreatedAt: DAY2.toISOString(), idempotencyKey: KEY });
      expect(mockStripeState.invoices.get('in_1')!.metadata.recordCreatedAt).toBe(DAY2.toISOString());
    });

    async function retriedWithOldOpenInvoice(stripCreatedAt: boolean) {
      const invoice = await issueSeptember();
      intentStatus.set('in_1', 'requires_payment_method');
      await deliver('invoice.payment_failed', { ...invoice, status: 'open' });
      expect(settlement().status).toBe('failed');
      if (stripCreatedAt) delete mockStripeState.invoices.get('in_1')!.metadata.recordCreatedAt; // created by earlier code
      // An operator sets retry, and a run re-creates the record but dies before invoicing (no invoiceId).
      const recreatedAt = DAY3.toISOString();
      store.row.paygSettlements[M] = { ...settlement(), status: 'pending', createdAt: recreatedAt, updatedAt: recreatedAt };
      delete store.row.paygSettlements[M].invoiceId;
      return mockStripeState.invoices.get('in_1')!;
    }

    it.each([false, true])('late events for the OLDER invoice (stripped createdAt=%p) never move the new record; the run then adopts it — no second invoice', async (strip) => {
      const old = await retriedWithOldOpenInvoice(strip);
      const before = clone(settlement());
      await deliver('invoice.payment_failed', { ...old, status: 'open' });
      await deliver('invoice.paid', { ...old, status: 'paid', amount_paid: 4500 });
      await deliver('invoice.voided', { ...old, status: 'void' });
      await deliver('invoice.marked_uncollectible', { ...old, status: 'uncollectible' });
      expect(settlement()).toEqual(before);
      const creates = mockStripe.invoices.create.mock.calls.length;
      expect(await settlePaygOverageMonth(OWNER, M, DAY3)).toBe('invoiced');
      expect(mockStripe.invoices.create.mock.calls.length).toBe(creates); // adopted, never re-created
      expect(settlement()).toMatchObject({ status: 'invoiced', invoiceId: 'in_1' });
      // From now on in_1's events are the record's.
      await deliver('invoice.paid', { ...old, status: 'paid', amount_paid: 4500 });
      expect(settlement().status).toBe('paid');
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('a paid older invoice adopted by the run is recorded paid (and lifts the hold), never invoiced again', async () => {
      const old = await retriedWithOldOpenInvoice(false);
      mockStripeState.invoices.get('in_1')!.status = 'paid';
      await deliver('invoice.paid', { ...old, status: 'paid', amount_paid: 4500 }); // ignored: not yet the record's
      expect(settlement().status).toBe('pending');
      expect(await settlePaygOverageMonth(OWNER, M, DAY3)).toBe('paid');
      expect(mockStripe.invoices.create).toHaveBeenCalledTimes(1);
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('the record\'s OWN new invoice (matching createdAt) is accepted while the record names none', async () => {
      const old = await retriedWithOldOpenInvoice(false);
      mockStripeState.invoices.get('in_1')!.status = 'void';
      // The run created in_new for this record but the id write was lost; Stripe pays it at once.
      const mine = { ...clone(old), id: 'in_new', status: 'paid' as const, metadata: { ...old.metadata, recordCreatedAt: DAY3.toISOString() } };
      await deliver('invoice.paid', { ...mine, amount_paid: 4500 });
      expect(settlement()).toMatchObject({ status: 'paid', invoiceId: 'in_new' });
    });
  });

  // ── MINOR 2 ───────────────────────────────────────────────────────────────────────────────────────
  describe('MINOR 2: PaymentIntent status mapping (stripe@18 PaymentIntent.Status, all 7 + none)', () => {
    it.each([
      ['requires_action', 'action_required'],
      ['succeeded', 'in_progress'],
      ['processing', 'in_progress'],
      ['requires_capture', 'in_progress'],
      ['requires_payment_method', 'declined'],
      ['canceled', 'declined'],
      ['requires_confirmation', 'declined'],
      [undefined, 'declined'],
    ])('%p => %p', async (status, expected) => {
      setup();
      if (status) intentStatus.set('in_x', status);
      await expect(stripeService.paygOverageInvoicePaymentState('in_x')).resolves.toBe(expected);
    });

    it('non-default payments are ignored when a default exists', async () => {
      setup();
      mockStripe.invoicePayments.list.mockResolvedValue({ data: [
        { is_default: false, payment: { payment_intent: { id: 'pi_old', status: 'requires_payment_method' } } },
        { is_default: true, payment: { payment_intent: { id: 'pi_new', status: 'requires_action' } } },
      ] });
      await expect(stripeService.paygOverageInvoicePaymentState('in_x')).resolves.toBe('action_required');
    });
  });

  // ── MINOR 3 / 4a ──────────────────────────────────────────────────────────────────────────────────
  describe('MINOR 3/4a: setup_intent.succeeded', () => {
    const savedCard = (over: Record<string, unknown> = {}) => ({ id: 'seti_1', object: 'setup_intent', status: 'succeeded', customer: 'cus_card', payment_method: 'pm_new', metadata: {}, ...over });
    let cards: Array<{ id: string; type: string; created: number }>;
    beforeEach(() => {
      cards = [{ id: 'pm_card', type: 'card', created: 100 }, { id: 'pm_new', type: 'card', created: 200 }];
      (mockStripe as unknown as { paymentMethods: { list: jest.Mock } }).paymentMethods = {
        list: jest.fn(async ({ type }: { type?: string }) => ({ data: cards.filter((c) => !type || c.type === type) })),
      };
      mockStripe.invoices.list.mockReset().mockImplementation(async ({ customer, status }: { customer: string; status: string }) => ({
        data: [...mockStripeState.invoices.values()].filter((i) => i.customer === customer && i.status === status).map(clone),
      }));
    });

    it('every update refused AND the alert itself failing: webhook still 200, exactly one alert attempt', async () => {
      await issueSeptember();
      mockStripe.invoices.update.mockRejectedValue(new Error('pm detached'));
      (emailService.sendOncallAlert as jest.Mock).mockRejectedValueOnce(new Error('ses down'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await deliver('setup_intent.succeeded', savedCard());
      errorLog.mockRestore();
      expect(r.status).not.toHaveBeenCalled();
      expect(r.json).toHaveBeenCalledWith({ received: true });
      expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
      mockStripe.invoices.update.mockReset();
    });

    it('non-PAYG customer, untagged: exactly ONE Stripe call (invoices.list), no row read, no paymentMethods.list; subscription open invoices ignored', async () => {
      setup();
      mockStripeState.invoices.set('in_sub', { id: 'in_sub', object: 'invoice', customer: 'cus_sub', status: 'open', metadata: {}, total: 4900, hosted_invoice_url: 'x', lines: { data: [] }, default_payment_method: 'pm_old' });
      const r = await deliver('setup_intent.succeeded', savedCard({ customer: 'cus_sub' }));
      expect(r.json).toHaveBeenCalledWith({ received: true });
      expect(mockStripe.invoices.list).toHaveBeenCalledTimes(1);
      expect((mockStripe as unknown as { paymentMethods: { list: jest.Mock } }).paymentMethods.list).not.toHaveBeenCalled();
      expect(userDb.getUserById).not.toHaveBeenCalled();
      expect(mockStripe.invoices.update).not.toHaveBeenCalled();
    });

    it('untagged: a Stripe rate-limit error on the list is logged and the webhook acknowledged (200)', async () => {
      setup();
      mockStripe.invoices.list.mockRejectedValue(Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError', statusCode: 429 }));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await deliver('setup_intent.succeeded', savedCard());
      errorLog.mockRestore();
      expect(r.status).not.toHaveBeenCalled();
      expect(r.json).toHaveBeenCalledWith({ received: true });
    });

    it('untagged: an open overage invoice whose owner\'s record is PAID (stale) or names another invoice is never re-pointed', async () => {
      await issueSeptember();
      store.row.paygSettlements[M] = { ...settlement(), status: 'paid' };
      await handleSetupIntentSucceeded(savedCard());
      store.row.paygSettlements[M] = { ...settlement(), status: 'failed', invoiceId: 'in_other' };
      await handleSetupIntentSucceeded(savedCard());
      expect(mockStripe.invoices.update).not.toHaveBeenCalled();
    });

    it('tagged with ANOTHER user id: never re-points this owner\'s invoice (metadata.billingUserId check)', async () => {
      await issueSeptember();
      const victimRow = clone(store.row);
      (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => (id === 'attacker' ? { ...victimRow, userId: 'attacker' } : store.read()));
      await handleSetupIntentSucceeded(savedCard({ metadata: { userId: 'attacker' } }));
      expect(mockStripe.invoices.update).not.toHaveBeenCalled();
    });
  });

  // ── MINOR 4b–d ────────────────────────────────────────────────────────────────────────────────────
  describe('MINOR 4b-d: copy', () => {
    it('lost dispute and unconfirmed 429 copy; member sees "owner can resolve"; owner gets invoice except under dispute', async () => {
      const { buildUsageBlockCopy: buildUsageBlock } = jest.requireActual('../utils/usageBlockCopy') as Record<string, (...a: unknown[]) => unknown>;
      const { withOwnerOpenInvoice } = jest.requireActual('../services/paygSettlement') as { withOwnerOpenInvoice: (...a: unknown[]) => Record<string, unknown> };
      const settlements = { [M]: { status: 'failed', hostedInvoiceUrl: 'https://invoice.stripe.com/i/1' } };
      for (const why of ['dispute', 'dispute_lost']) {
        expect(withOwnerOpenInvoice({ reason: 'payg_suspended', paygSuspendedReason: why }, true, settlements)).toEqual({ reason: 'payg_suspended', paygSuspendedReason: why });
        expect(withOwnerOpenInvoice({ reason: 'payg_suspended', paygSuspendedReason: why }, false, settlements)).toEqual({ reason: 'payg_suspended', paygSuspendedReason: why, paygOwnerResolves: true });
      }
      for (const why of ['payment_failed', 'payment_unconfirmed']) {
        expect(withOwnerOpenInvoice({ reason: 'payg_suspended', paygSuspendedReason: why }, true, settlements)).toMatchObject({ openInvoiceUrl: 'https://invoice.stripe.com/i/1' });
        expect(withOwnerOpenInvoice({ reason: 'payg_suspended', paygSuspendedReason: why }, false, settlements)).not.toHaveProperty('openInvoiceUrl');
      }
      const copy = (b: Record<string, unknown>) => (buildUsageBlock as unknown as (i: unknown) => Record<string, string>)({ month: null, paygBlock: b });
      const lost = copy({ reason: 'payg_suspended', paygSuspendedReason: 'dispute_lost' });
      expect(lost.message).toBe('AI usage is paused: extra usage is on hold following a dispute about a recent payment. Please contact us to resume it.');
      const unc = copy({ reason: 'payg_suspended', paygSuspendedReason: 'payment_unconfirmed', openInvoiceUrl: 'https://x' });
      expect(unc.message).toContain('still waiting to be confirmed');
      expect(unc.openInvoiceUrl).toBe('https://x');
      const member = copy({ reason: 'payg_suspended', paygSuspendedReason: 'payment_failed', paygOwnerResolves: true });
      expect(member.message).toBe("AI usage is paused: extra usage is on hold because a recent payment didn't go through. Your organization owner can resolve this.");
      const dated = (buildUsageBlock as unknown as (i: unknown) => Record<string, string>)({ month: '2026-10', paygBlock: { reason: 'payg_suspended', paygSuspendedReason: 'dispute', paygOwnerResolves: true } });
      expect(dated.message).toMatch(/Your organization owner can resolve this\.$/);
      expect(dated.body).toContain('under review with your bank');
    });
  });

  // ── MINOR 5 ───────────────────────────────────────────────────────────────────────────────────────
  describe('MINOR 5: unconfirmed payments', () => {
    async function unconfirmed() {
      const invoice = await issueSeptember();
      intentStatus.set('in_1', 'requires_action');
      await deliver('invoice.payment_action_required', { ...invoice, status: 'open' });
      return { invoice, since: Date.parse(settlement().actionRequiredAt) };
    }

    it('switch OFF: the sweep never expires an unconfirmed payment (documented behaviour)', async () => {
      const { since } = await unconfirmed();
      (paygSettlementSwitch.isEnabled as jest.Mock).mockResolvedValue(false);
      await runSweep(new Date(since + 30 * DAY));
      expect(settlement().status).toBe('invoiced');
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('rv7 MINOR: invoice voided in Stripe (PI canceled) before its webhook: the sweep writes the month off like invoice.voided — no hold, no "confirm" email', async () => {
      const { invoice, since } = await unconfirmed();
      mockStripeState.invoices.get('in_1')!.status = 'void';
      intentStatus.set('in_1', 'canceled');
      await runSweep(new Date(since + 8 * DAY));
      expect(settlement()).toMatchObject({ status: 'written_off', writtenOffReason: 'invoice_voided' });
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).not.toHaveBeenCalled();
      expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1); // the void alert, once
      await deliver('invoice.voided', { ...invoice, status: 'void' }); // the late webhook changes nothing more
      expect(settlement().status).toBe('written_off');
      expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    });

    it('rv7 MINOR: invoice paid outside the normal charge before its webhook: the sweep records it paid — no hold, no "confirm" email', async () => {
      const { since } = await unconfirmed();
      mockStripeState.invoices.get('in_1')!.status = 'paid';
      intentStatus.set('in_1', 'canceled');
      await runSweep(new Date(since + 8 * DAY));
      expect(settlement()).toMatchObject({ status: 'paid', paidAt: expect.any(String) });
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).not.toHaveBeenCalled();
    });

    it('rv7 MINOR: invoice marked uncollectible before its webhook: the sweep handles it like invoice.marked_uncollectible (failed, held, failure email) — never the "confirm" email', async () => {
      const { since } = await unconfirmed();
      mockStripeState.invoices.get('in_1')!.status = 'uncollectible' as never;
      await runSweep(new Date(since + 8 * DAY));
      expect(settlement()).toMatchObject({ status: 'failed', uncollectibleAt: expect.any(String) });
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_1' });
      expect(store.row.paygOverage.suspended).not.toHaveProperty('unconfirmed');
      expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).not.toHaveBeenCalled();
    });

    it('rv7 MINOR: an invoice deleted or unknown to Stripe is left alone (logged)', async () => {
      const { since } = await unconfirmed();
      mockStripeState.invoices.delete('in_1');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await runSweep(new Date(since + 8 * DAY));
      warn.mockRestore();
      expect(settlement().status).toBe('invoiced');
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('unconfirmed under a dispute hold: the dispute hold stays (paymentFailedAt stamped); dispute won hands over to the failed month', async () => {
      const { since } = await unconfirmed();
      // September paid? No: put a dispute on an August paid charge instead.
      mockStripeState.invoices.set('in_aug', {
        id: 'in_aug', object: 'invoice', customer: 'cus_card', status: 'paid', total: 4500, created: 1,
        metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: AUG, idempotencyKey: `payg:${OWNER}:${AUG}` },
        hosted_invoice_url: 'https://invoice.stripe.com/i/aug', lines: { data: [{ amount: 4500, metadata: {} }] },
      });
      store.row.paygSettlements[AUG] = { status: 'paid', invoiceId: 'in_aug', idempotencyKey: `payg:${OWNER}:${AUG}`, amountCents: 4500, createdAt: DAY2.toISOString() };
      charges.set('ch_aug', { paymentIntent: 'pi_aug', invoiceId: 'in_aug' });
      await deliver('charge.dispute.created', dispute('dp_a', 'ch_aug'));
      await runSweep(new Date(since + 8 * DAY));
      expect(settlement().status).toBe('failed');
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', paymentFailedAt: expect.any(String) });
      await deliver('charge.dispute.closed', dispute('dp_a', 'ch_aug', 'won'));
      expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_1' });
      await deliver('invoice.paid', { ...mockStripeState.invoices.get('in_1')!, status: 'paid', amount_paid: 4500 });
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('sweep vs invoice.paid race: paid lands between the sweep\'s Stripe check and its write => no hold, no email', async () => {
      const { invoice, since } = await unconfirmed();
      const real = mockStripe.invoicePayments.list.getMockImplementation()!;
      mockStripe.invoicePayments.list.mockImplementationOnce(async (p: unknown) => {
        const res = await real(p as never);
        await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid', amount_paid: 4500 });
        return res;
      });
      await runSweep(new Date(since + 8 * DAY));
      expect(settlement().status).toBe('paid');
      expect(store.row.paygOverage.suspended).toBeUndefined();
      expect(emailService.sendPaygOveragePaymentUnconfirmedEmail).not.toHaveBeenCalled();
    });

    it('the paid webhook landing AFTER the transition but BEFORE the hold write => hold never written', async () => {
      const { invoice, since } = await unconfirmed();
      const real = (userDb.updateUser as jest.Mock).getMockImplementation()!;
      let done = false;
      (userDb.updateUser as jest.Mock).mockImplementation(async (id: string, attrs: unknown, opts: { pathSets?: Array<{ path: string[]; value: { reason?: string } }> }) => {
        const hold = opts?.pathSets?.some((s) => s.path.join('.') === 'paygOverage.suspended' && s.value?.reason === 'payment_failed');
        if (hold && !done) {
          done = true;
          await handleInvoicePaymentSucceeded({ ...invoice, status: 'paid', amount_paid: 4500 });
        }
        return real(id, attrs, opts);
      });
      await runSweep(new Date(since + 8 * DAY));
      expect(done).toBe(true);
      expect(settlement().status).toBe('paid');
      expect(store.row.paygOverage.suspended).toBeUndefined();
    });

    it('the gate 429 for an unconfirmed hold; GET-style reason; owner gets the invoice link', async () => {
      const { since } = await unconfirmed();
      await runSweep(new Date(since + 8 * DAY));
      expect(gateBlock(store.row as { paygOverage: PaygOverageSettings })).toEqual({ reason: 'payg_suspended', paygSuspendedReason: 'payment_unconfirmed' });
      const { withOwnerOpenInvoice } = jest.requireActual('../services/paygSettlement') as { withOwnerOpenInvoice: (...a: unknown[]) => Record<string, unknown> };
      expect(withOwnerOpenInvoice({ reason: 'payg_suspended', paygSuspendedReason: 'payment_unconfirmed' }, true, store.row.paygSettlements))
        .toMatchObject({ openInvoiceUrl: 'https://invoice.stripe.com/i/1' });
    });

    it('a sweep Stripe error for one owner\'s unconfirmed month is counted, never stops the sweep, and the next sweep retries', async () => {
      const { since } = await unconfirmed();
      mockStripe.invoicePayments.list.mockRejectedValueOnce(new Error('stripe 503'));
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const s1 = await runSweep(new Date(since + 8 * DAY));
      errorLog.mockRestore();
      expect(s1.failed).toBe(1);
      expect(settlement().status).toBe('invoiced');
      const s2 = await runSweep(new Date(since + 9 * DAY));
      expect(s2.outcomes).toMatchObject({ payment_unconfirmed: 1 });
    });
  });
});
