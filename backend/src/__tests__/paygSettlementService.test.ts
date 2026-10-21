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
    hasPaymentMethod: true, customerId: 'cus_card', paymentMethodId: 'pm_card', card: { brand: 'visa', last4: '4242' }, isZoma: false,
  });
  jest.spyOn(stripeService, 'findLiveCustomerIdForUser').mockResolvedValue('cus_row');
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  mockStripeState.invoices.clear();
  mockStripeState.keys.clear();
  mockStripeState.loseResponse.clear();
  mockStripeState.seq = 0;
  mockStripeState.discountCents = 0;
  process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = 'true';
  spend(130);
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
      to: 'owner@example.com', month: M, percentOfCap: 60, invoiceUrl: 'https://invoice.stripe.com/i/1',
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
      'Alert Class': 'payg-settlement-held', billingUserId: OWNER, month: M, heldReason: 'spend_drift',
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

  it('an owner the gate measured on the legacy counter is held, not billed on a basis it never saw', async () => {
    process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = 'legacy';
    setup();
    expect(await settlePaygOverageMonth(OWNER, M, DAY2)).toBe('held');
    expect(settlement()).toMatchObject({ heldReason: 'legacy_spend_basis' });
    expect(mockStripe.invoices.create).not.toHaveBeenCalled();
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
    expect(admission.block).toEqual({ reason: 'payg_suspended' });
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
      payment: { type: 'payment_intent', payment_intent: 'pi_1' }, limit: 1, expand: ['data.invoice'],
    });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute', invoiceId: 'in_1' });
    expect(settlement()).toMatchObject({ status: 'paid', dispute: { disputeId: 'dp_1' } });
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
    await handleChargeRefunded({ ...charge, amount_refunded: 4500, refunded: true });
    expect(settlement()).toMatchObject({ refundedCents: 4500, status: 'paid' });
    expect(store.row.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
    // Partial-then-full redelivery lands on the cumulative figure, not a sum.
    await handleChargeRefunded({ ...charge, amount_refunded: 4500, refunded: true });
    expect(settlement()).toMatchObject({ refundedCents: 4500 });
  });

  it('a refund on an unsuspended account does not create or lift anything', async () => {
    await paid();
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

describe('ENG-668 webhooks — with settlement switched off, refunds and disputes are exactly as before (review M6)', () => {
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

  it('switch off: a dispute on any charge makes no extra Stripe call and suspends nothing', async () => {
    setup(ownerRow(), { switchOn: false });
    mockStripe.charges.retrieve.mockResolvedValue({ ...subscriptionCharge, refunded: false, amount_refunded: 0 });
    await handleChargeDisputeCreated({ id: 'dp_sub', charge: 'ch_sub', amount: 4900, currency: 'usd' });
    expect(mockStripe.invoicePayments.list).not.toHaveBeenCalled();
    expect(store.row.paygOverage.suspended).toBeUndefined();
  });

  it('switch on but the lookup fails: the refund is still recorded and the webhook does not fail', async () => {
    setup();
    (userDb.scanWithFilter as jest.Mock).mockResolvedValue([store.row]);
    mockStripe.invoicePayments.list.mockRejectedValueOnce(new Error('stripe 500'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handleChargeRefunded(subscriptionCharge)).resolves.toBeUndefined();
    errorLog.mockRestore();
    expect(paymentHistoryDb.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'refund', amount: 4900 }));
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
    expect(store.row.paygOverage.suspended).toEqual({ reason: 'dispute', at: '2026-09-20T00:00:00.000Z', invoiceId: 'in_old' });
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
