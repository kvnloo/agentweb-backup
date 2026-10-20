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
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
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
    create: jest.fn(async (params: any, opts: any) => mockIdempotent('invoices.create', opts?.idempotencyKey, () => {
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
    retrieve: jest.fn(async (id: string) => clone(mockStripeState.invoices.get(id))),
    search: jest.fn(async ({ query }: { query: string }) => {
      const key = /metadata\['idempotencyKey'\]:'([^']+)'/.exec(query)?.[1];
      return { data: [...mockStripeState.invoices.values()].filter((i) => i.metadata.idempotencyKey === key).map(clone) };
    }),
    finalizeInvoice: jest.fn(async (id: string, params: any, opts: any) => mockIdempotent('invoices.finalize', opts?.idempotencyKey, () => {
      const invoice = mockStripeState.invoices.get(id)!;
      invoice.status = 'open';
      invoice.auto_advance = params?.auto_advance;
      return clone(invoice);
    })),
    list: jest.fn(),
  },
  invoiceItems: {
    create: jest.fn(async (params: any, opts: any) => mockIdempotent('invoiceItems.create', opts?.idempotencyKey, () => {
      const invoice = mockStripeState.invoices.get(params.invoice)!;
      invoice.lines.data.push({ amount: params.amount, metadata: { ...params.metadata } });
      invoice.total += params.amount;
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
import { evaluatePaygAdmission, type PaygOverageSettings } from '../services/paygOverage';
import { SPEND_LEDGER_ENFORCEMENT_ENV } from '../services/spendEnforcementBasis';
import { createUserRowFake } from './helpers/userRowFake';

const USD = 1_000_000;
const OWNER = 'owner-1';
const M = '2026-09';
const NEXT = '2026-10';
const DAY2 = new Date('2026-10-02T12:00:00.000Z');
const KEY = `payg:${OWNER}:${M}`;

const policy = {
  version: 'pro-2026-09',
  enforcementState: 'hard_only' as const,
  optimizationCostThresholdMicroUsd: 50 * USD,
  hardCostThresholdMicroUsd: 100 * USD,
  optimizedModelIds: ['gpt-5-chat-2'],
  optimizedDefaultModel: 'gpt-5-chat-2',
};

const payg = (over: Partial<PaygOverageSettings> = {}): PaygOverageSettings => ({
  enabled: true,
  capPercentOfPool: 50,
  // The gate already rolled the mark over on day 1; September's mark is the closed copy.
  poolHighWater: { month: NEXT, thresholdMicroUsd: 100 * USD },
  poolHighWaterClosed: { month: M, thresholdMicroUsd: 100 * USD },
  admittedMonths: [NEXT, M],
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

const spend = (settledUsd: number, projectedUsd: number | null = settledUsd) => {
  (listSpendEvents as jest.Mock).mockResolvedValue([
    {
      billingUserId: OWNER, eventId: 'e1', occurredAt: `${M}-15T10:00:00.000Z`, billingMonth: M,
      actingUserId: OWNER, provider: 'openai', operation: 'chat', unit: 'call', quantity: 1,
      costMicroUsd: settledUsd * USD, costSource: 'measured', lifecycle: 'settled',
    },
    // A reservation never counts as spend.
    {
      billingUserId: OWNER, eventId: 'e2', occurredAt: `${M}-20T10:00:00.000Z`, billingMonth: M,
      actingUserId: OWNER, provider: 'openai', operation: 'chat', unit: 'call', quantity: 1,
      costMicroUsd: 7 * USD, costSource: 'measured', lifecycle: 'reserved',
    },
  ]);
  (getProjection as jest.Mock).mockResolvedValue(
    projectedUsd === null ? null : { billingUserId: OWNER, billingMonth: M, settledMicroUsd: projectedUsd * USD, computedAt: DAY2.toISOString() },
  );
};

let store: ReturnType<typeof createUserRowFake>;
const settlement = () => store.row.paygSettlements?.[M];

function setup(row: Record<string, unknown> = ownerRow(), opts: { markupBps?: number | null; switchOn?: boolean } = {}) {
  store = createUserRowFake(row);
  (userDb.getUserByIdConsistent as jest.Mock).mockImplementation(store.read);
  (userDb.getUserById as jest.Mock).mockImplementation(store.read);
  (userDb.updateUser as jest.Mock).mockImplementation(store.updateUser);
  (userDb.scanWithFilter as jest.Mock).mockImplementation(async () => [store.row]);
  (paygSettlementSwitch.isEnabled as jest.Mock).mockResolvedValue(opts.switchOn ?? true);
  const markupBps = 'markupBps' in opts ? opts.markupBps : 15_000;
  (getSubscriptionTypeConfig as jest.Mock).mockResolvedValue({
    name: 'Pro', allowedPages: [], allowedSkills: [], llmUsagePolicy: policy,
    paygOverage: { allowed: true, ...(markupBps === null ? {} : { markupBps }) },
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
    expect(opts).toEqual({ idempotencyKey: `${KEY}:invoice` });
    expect(params).toMatchObject({
      customer: 'cus_card',
      default_payment_method: 'pm_card',
      collection_method: 'charge_automatically',
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      metadata: { purchaseType: 'payg_overage', billingUserId: OWNER, month: M, idempotencyKey: KEY },
    });
    expect(mockStripe.invoiceItems.create.mock.calls[0][0]).toMatchObject({ invoice: 'in_1', amount: 4500, currency: 'usd' });
    expect(mockStripe.invoiceItems.create.mock.calls[0][1]).toEqual({ idempotencyKey: `${KEY}:item` });
    expect(mockStripe.invoices.finalizeInvoice).toHaveBeenCalledWith('in_1', { auto_advance: true }, { idempotencyKey: `${KEY}:finalize` });
    expect(mockStripeState.invoices.get('in_1')).toMatchObject({ status: 'open', total: 4500 });

    // One owner email: a percentage of the cap and the Stripe invoice link — never an amount.
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith({
      to: 'owner@example.com', month: M, percentOfCap: 60, invoiceUrl: 'https://invoice.stripe.com/i/1',
    });
  });

  it('never bills past the cap, and rounds every step down', async () => {
    // $171.234567 settled: $71.23 overage, capped at $50. $50 x 1.3333 = $66.665 -> 6666 cents.
    setup(ownerRow(), { markupBps: 13_333 });
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
    setup(ownerRow({ paygOverage: payg({ enabled: false, admittedMonths: [NEXT] }) }));
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

  it('a tier with no markup is held (never billed at cost by default)', async () => {
    setup(ownerRow(), { markupBps: null });
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
    const keys = mockStripe.invoices.create.mock.calls.map(([, opts]) => opts.idempotencyKey);
    expect(keys).toEqual([`${KEY}:invoice`, `${KEY}:invoice`]);
    expect(mockStripeState.invoices.size).toBe(1);
    expect(mockStripeState.invoices.get('in_1')).toMatchObject({ status: 'open', total: 4500 });
    expect(settlement()).toMatchObject({ status: 'invoiced', invoiceId: 'in_1', amountCents: 4500 });
    expect(mockStripe.invoices.search).not.toHaveBeenCalled();
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

  it('a pending older than 24h with no invoice id searches Stripe by metadata before creating', async () => {
    setup();
    mockStripeState.loseResponse.add('invoices.create');
    await expect(settlePaygOverageMonth(OWNER, M, DAY2)).rejects.toThrow('socket hang up');
    // A day later Stripe has forgotten the key: replaying it would create a SECOND invoice.
    mockStripeState.keys.clear();

    expect(await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'))).toBe('invoiced');
    expect(mockStripe.invoices.search).toHaveBeenCalledWith({ query: `metadata['idempotencyKey']:'${KEY}'`, limit: 10 });
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
    expect(userDb.scanWithFilter).toHaveBeenCalledWith('contains(paygOverage.admittedMonths, :month)', { ':month': M });
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
