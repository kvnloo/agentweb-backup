/**
 * ENG-668 PR-1/PR-2 — every conditional write on the billing owner's AW-Users row that pay-as-you-go money
 * depends on, against REAL DynamoDB semantics.
 *
 * Opt-in: runs only when DYNAMODB_LOCAL_ENDPOINT points at a DynamoDB Local (e.g.
 *   docker run -d --rm --name ddb -p 127.0.0.1:8124:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory
 *   DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8124 npx jest src/__tests__/paygOverage.dynamodbLocal.test.ts
 *   docker stop ddb
 * ), otherwise the suite is skipped, so CI never needs a database. It creates (and drops) its own AW-Users
 * table with the real key schema (`email` HASH) and the one index the code queries (`UserIdIndex`, `userId`
 * HASH), plus AW-PaymentHistory for the admin credit-grant transaction.
 *
 * Real here: `userDb` (db.ts) and every production function that writes the row — the turn gate
 * (`checkTokenUsage(..., TURN_ADMISSION)` -> `resolveLlmUsagePoolDecision`: pool high-water mark and the
 * month's admission record), the credit ledger rollover (`grantMonthlyLlmUsageCredit` incl. the admin
 * TransactWriteItems, `recordLlmUsageDebit`), the settings service behind GET/PUT /api/subscription/payg
 * (`updatePaygOverage`, `getPaygOverageView`), month-end settlement (`settlePaygOverageMonth`,
 * `runPaygSettlement`) and the invoice / dispute / refund webhook handlers. No expression is re-typed
 * here: each test drives the production function and reads the row back with a strongly consistent get.
 * Races are made deterministic by running a competing production call at an exact point — just before a
 * given write (`beforeWrite`) or just after the owner's row was read (`afterRead`) — so the loser's
 * condition is evaluated by DynamoDB against the winner's write.
 *
 * Mocked (not DynamoDB): Stripe (`stripeService`), the tier config, the AW-Settings switches, the
 * spend-ledger basis / spend events / projection, payment history, email.
 *
 * Limits: DynamoDB Local is not the service. It evaluates condition and update expressions with the
 * service's grammar and errors (unused names, overlapping paths, invalid document paths), but its GSIs
 * update synchronously (production's UserIdIndex is eventually consistent, and `updateUser` resolves the
 * row's key through it) and it has no throttling or cross-region behaviour.
 *
 * The last block compares the in-memory fake the unit suites use (helpers/userRowFake.ts) with DynamoDB
 * on the expression forms the PAYG code emits; every difference found is pinned there.
 */
// src/__mocks__/aws-sdk.ts stubs aws-sdk for every test; this suite needs the real SDK.
jest.unmock('aws-sdk');

// A module (not a global script), so its top-level names cannot collide with other test files under tsc.
export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(),
  getSubscriptionTypeConfig: jest.fn(),
  getTierConfig: jest.fn(),
  DEFAULT_PAGES: [],
}));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
jest.mock('../services/spendEnforcementBasis', () => ({ resolveEnforcementCostBasisMicroUsd: jest.fn() }));
jest.mock('../services/stripeService', () => ({
  PAYG_OVERAGE_PURCHASE_TYPE: 'payg_overage',
  stripeService: {
    resolveUserPaymentMethod: jest.fn(),
    findLiveCustomerIdForUser: jest.fn(),
    issuePaygOverageInvoice: jest.fn(),
    paygOverageInvoicePaymentState: jest.fn(),
    listChargeRefunds: jest.fn(),
    retrievePaygOverageInvoice: jest.fn(),
  },
}));
jest.mock('../services/spendEventDb', () => ({
  ...jest.requireActual('../services/spendEventDb'),
  listSpendEvents: jest.fn(),
}));
jest.mock('../services/spendProjectionDb', () => ({ getProjection: jest.fn() }));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: jest.fn() } }));
jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn(),
    sendPaygOverageInvoiceEmail: jest.fn(),
    sendPaygOveragePaymentFailedEmail: jest.fn(),
    sendPaygOveragePaymentActionRequiredEmail: jest.fn(),
    sendPaygOveragePaymentUnconfirmedEmail: jest.fn(),
  },
}));

import type { UpdateUserOptions } from './helpers/userRowFake';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USERS = 'AW-Users';
const PAYMENT_HISTORY = 'AW-PaymentHistory';
const USD = 1_000_000;

suite('PAYG conditional writes against DynamoDB Local', () => {
  let AWS: Json;
  let ddb: Json;
  let userDb: Json;
  let gate: typeof import('../services/tokenUsageService');
  let resolver: typeof import('../services/llmUsagePolicyResolverService');
  let credits: typeof import('../services/llmUsageCreditService');
  let settings: typeof import('../services/paygOverageService');
  let settlement: typeof import('../services/paygSettlementService');
  let mocks: {
    tierName: jest.Mock; tierConfig: jest.Mock; getSetting: jest.Mock; spendBasis: jest.Mock;
    stripe: {
      resolveUserPaymentMethod: jest.Mock; findLiveCustomerIdForUser: jest.Mock; issuePaygOverageInvoice: jest.Mock;
      paygOverageInvoicePaymentState: jest.Mock; listChargeRefunds: jest.Mock; retrievePaygOverageInvoice: jest.Mock;
    };
    listSpendEvents: jest.Mock; getProjection: jest.Mock; paymentHistory: jest.Mock;
    email: {
      sendOncallAlert: jest.Mock; sendPaygOverageInvoiceEmail: jest.Mock; sendPaygOveragePaymentFailedEmail: jest.Mock;
      sendPaygOveragePaymentActionRequiredEmail: jest.Mock; sendPaygOveragePaymentUnconfirmedEmail: jest.Mock;
    };
  };

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'local';
    process.env.AWS_SECRET_ACCESS_KEY = 'local';
    process.env.AWS_REGION = 'us-west-2';
    AWS = require('aws-sdk');
    AWS.config.update({ region: 'us-west-2', endpoint: ENDPOINT, accessKeyId: 'local', secretAccessKey: 'local' });
    const raw = new AWS.DynamoDB();
    const dropIfExists = async (TableName: string) => { try { await raw.deleteTable({ TableName }).promise(); } catch { /* absent */ } };
    await dropIfExists(USERS); await dropIfExists(PAYMENT_HISTORY);
    await raw.createTable({
      TableName: USERS, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'email', AttributeType: 'S' }, { AttributeName: 'userId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{ IndexName: 'UserIdIndex', KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } }],
    }).promise();
    await raw.createTable({
      TableName: PAYMENT_HISTORY, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }, { AttributeName: 'timestamp', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'timestamp', KeyType: 'RANGE' }],
    }).promise();
    ddb = new AWS.DynamoDB.DocumentClient();
    ({ userDb } = require('../services/db'));
    gate = require('../services/tokenUsageService');
    resolver = require('../services/llmUsagePolicyResolverService');
    credits = require('../services/llmUsageCreditService');
    settings = require('../services/paygOverageService');
    settlement = require('../services/paygSettlementService');
    const sub = require('../services/subscriptionService');
    const { stripeService } = require('../services/stripeService');
    const { emailService } = require('../services/emailService');
    mocks = {
      tierName: sub.getUserSubscriptionType,
      tierConfig: sub.getSubscriptionTypeConfig,
      getSetting: require('../services/settingsService').settingsService.getSetting,
      spendBasis: require('../services/spendEnforcementBasis').resolveEnforcementCostBasisMicroUsd,
      stripe: stripeService,
      listSpendEvents: require('../services/spendEventDb').listSpendEvents,
      getProjection: require('../services/spendProjectionDb').getProjection,
      paymentHistory: require('../services/paymentHistoryDb').paymentHistoryDb.record,
      email: emailService,
    };
  }, 60_000);

  afterAll(async () => {
    if (!AWS) return;
    const raw = new AWS.DynamoDB();
    await raw.deleteTable({ TableName: USERS }).promise().catch(() => undefined);
    await raw.deleteTable({ TableName: PAYMENT_HISTORY }).promise().catch(() => undefined);
  });

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
  /** A $100 hard pool tier offering PAYG at 1.5x unless overridden. */
  const tier = (over: { hardUsd?: number; markupBps?: number | null; allowed?: boolean } = {}) => ({
    name: 'Pro', allowedPages: [], allowedSkills: [],
    llmUsagePolicy: {
      version: 'pro-2026-10', enforcementState: 'hard_only',
      optimizationCostThresholdMicroUsd: 50 * USD, hardCostThresholdMicroUsd: (over.hardUsd ?? 100) * USD,
      optimizedModelIds: ['gpt-5-chat-2'], optimizedDefaultModel: 'gpt-5-chat-2',
    },
    paygOverage: { allowed: over.allowed ?? true, ...(over.markupBps === null ? {} : { markupBps: over.markupBps ?? 15_000 }) },
  });
  const useTier = (over: Parameters<typeof tier>[0] = {}) => mocks.tierConfig.mockResolvedValue(tier(over));
  /** Month-to-date spend on the ledger basis (or the legacy counter). */
  const useSpend = (usd: number, basis: 'spend_ledger' | 'legacy' = 'spend_ledger') =>
    mocks.spendBasis.mockResolvedValue({ rawCostUsedMicroUsd: usd * USD, basis, projectionMissing: false, stale: false });

  let seq = 0;
  /** A fresh owner (own userId and email) per test, so tests never share a row. */
  const newOwner = () => {
    seq += 1;
    return { userId: `owner-${seq}-${Date.now()}`, email: `owner-${seq}-${Date.now()}@example.com` };
  };
  const put = (item: Record<string, unknown>) => ddb.put({ TableName: USERS, Item: item }).promise();
  /** The stored row, strongly consistent. */
  const row = async (email: string): Promise<Json> =>
    (await ddb.get({ TableName: USERS, Key: { email }, ConsistentRead: true }).promise()).Item;
  /** Change the row directly — what an operator (or a test's "meanwhile") does, not production code. */
  const patch = (email: string, UpdateExpression: string, names: Record<string, string>, values?: Record<string, unknown>) =>
    ddb.update({
      TableName: USERS, Key: { email }, UpdateExpression, ExpressionAttributeNames: names,
      ...(values ? { ExpressionAttributeValues: values } : {}),
    }).promise();

  /**
   * Runs `competitor` immediately before the n-th `userDb.updateUser` call from now (1 = the next), after
   * the caller already read the row and built its condition — so DynamoDB evaluates that condition against
   * the competitor's write. The competitor itself runs against the real, unwrapped `updateUser`.
   */
  function beforeWrite(n: number, competitor: () => Promise<unknown>) {
    const real = userDb.updateUser.bind(userDb);
    let calls = 0;
    const spy = jest.spyOn(userDb, 'updateUser').mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      if (calls === n) {
        spy.mockRestore();
        await competitor();
      }
      return real(...args);
    });
    return spy;
  }
  /** Runs `competitor` right after the next `getUserByIdConsistent` read, then hands back that (now stale) read. */
  function afterConsistentRead(competitor: () => Promise<unknown>) {
    const real = userDb.getUserByIdConsistent.bind(userDb);
    const spy = jest.spyOn(userDb, 'getUserByIdConsistent').mockImplementation(async (...args: unknown[]) => {
      spy.mockRestore();
      const snapshot = await real(...args);
      await competitor();
      return snapshot;
    });
  }
  /** Same, for the GSI read `getUserById` (the credit ledger reads the row through it). */
  function afterIndexedRead(competitor: () => Promise<unknown>) {
    const real = userDb.getUserById.bind(userDb);
    const spy = jest.spyOn(userDb, 'getUserById').mockImplementation(async (...args: unknown[]) => {
      spy.mockRestore();
      const snapshot = await real(...args);
      await competitor();
      return snapshot;
    });
  }
  /** Counts row writes made through `userDb.updateUser` while `fn` runs. */
  async function writesDuring(fn: () => Promise<unknown>): Promise<number> {
    const spy = jest.spyOn(userDb, 'updateUser');
    try {
      await fn();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(() => {
    mocks.tierName.mockResolvedValue('Pro');
    useTier();
    mocks.getSetting.mockResolvedValue({ settingValue: 'true' });
    useSpend(0);
    mocks.stripe.resolveUserPaymentMethod.mockResolvedValue({
      hasPaymentMethod: true, customerId: 'cus_card', fallbackPaymentMethodId: 'pm_card', card: { brand: 'visa', last4: '4242' }, isZoma: false,
    });
    mocks.stripe.findLiveCustomerIdForUser.mockResolvedValue('cus_row');
    mocks.stripe.issuePaygOverageInvoice.mockReset();
    // A failed attempt is a decline unless a test says the bank awaits the owner's confirmation.
    mocks.stripe.paygOverageInvoicePaymentState.mockReset().mockResolvedValue('declined');
    mocks.stripe.listChargeRefunds.mockReset().mockResolvedValue([]);
    // Stripe still has the invoice open unless a test says otherwise.
    mocks.stripe.retrievePaygOverageInvoice.mockReset().mockImplementation(async (id: string) => ({ id, status: 'open', metadata: {} }));
    mocks.paymentHistory.mockResolvedValue({ written: true });
    mocks.email.sendOncallAlert.mockResolvedValue(undefined);
    mocks.email.sendPaygOverageInvoiceEmail.mockResolvedValue('sent');
    mocks.email.sendPaygOveragePaymentFailedEmail.mockResolvedValue('sent');
  });
  afterEach(() => jest.restoreAllMocks());

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 1. The turn gate: pool high-water mark and the month's admission record
  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('turn gate (checkTokenUsage with TURN_ADMISSION)', () => {
    let CUR: string;
    let PREV: string;
    beforeAll(() => {
      CUR = credits.getCurrentUsageMonth();
      const now = new Date();
      PREV = credits.getCurrentUsageMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    });
    const optedIn = (ids: { userId: string; email: string }, payg: Record<string, unknown> = {}) => put({
      ...ids, subscription_status: 'active', has_payment_method: true, stripe_customer_id: 'cus_row',
      paygOverage: { enabled: true, capPercentOfPool: 50, updatedBy: ids.userId, updatedAt: '2026-01-01T00:00:00.000Z', version: 1, ...payg },
    });
    const admit = (userId: string) => gate.checkTokenUsage(userId, gate.TURN_ADMISSION);
    const entry = (over: Record<string, unknown> = {}) => ({
      month: CUR, capHighWaterMicroUsd: 50 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 15_000, spendBasis: 'spend_ledger', ...over,
    });

    it('first admission of a month: the mark and the admission record are written (attribute_not_exists); a repeat writes nothing', async () => {
      const o = newOwner();
      await optedIn(o);
      useSpend(120);
      const status = await admit(o.userId);
      expect(status).toMatchObject({ allowed: true, usageMode: 'full_choice', overage: { active: true, percentOfCap: 40 } });
      const after = await row(o.email);
      expect(after.paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 100 * USD });
      expect(after.paygOverage.admittedMonths).toEqual([entry()]);
      expect(after.paygOverage.poolHighWaterClosed).toBeUndefined(); // nothing to roll over

      expect(await writesDuring(() => admit(o.userId))).toBe(0);
      expect((await row(o.email)).paygOverage).toEqual(after.paygOverage);
    });

    it('a later admission merges into the month (highest cap and pool, lowest markup, mixed basis) — conditional on the list it read (`= :expected`, maps inside a list, incl. a NULL member)', async () => {
      const o = newOwner();
      const older = { month: PREV, capHighWaterMicroUsd: 25 * USD, tierPoolHighWaterMicroUsd: 80 * USD, markupBps: null, spendBasis: 'legacy' };
      await optedIn(o, {
        capPercentOfPool: 100,
        poolHighWater: { month: CUR, thresholdMicroUsd: 100 * USD },
        admittedMonths: [entry(), older],
      });
      useTier({ markupBps: 12_000 });
      useSpend(130, 'legacy');
      expect((await admit(o.userId)).allowed).toBe(true);
      expect((await row(o.email)).paygOverage.admittedMonths).toEqual([
        entry({ capHighWaterMicroUsd: 100 * USD, markupBps: 12_000, spendBasis: 'mixed' }),
        older,
      ]);

      // A higher markup and a lower cap change nothing: no write at all.
      useTier({ markupBps: 20_000 });
      await patch(o.email, 'SET #p.#c = :c', { '#p': 'paygOverage', '#c': 'capPercentOfPool' }, { ':c': 25 });
      useSpend(110, 'legacy');
      expect(await writesDuring(() => admit(o.userId))).toBe(0);
    });

    it('conflict: a competing admission lands between the read and the write — ours is refused (never overwrites theirs) and the check still admits', async () => {
      const o = newOwner();
      await optedIn(o, { poolHighWater: { month: CUR, thresholdMicroUsd: 100 * USD }, admittedMonths: [entry()] });
      // Ours: the cap was raised to 100% (seen by this check). Theirs: a cheaper tier markup.
      await patch(o.email, 'SET #p.#c = :c', { '#p': 'paygOverage', '#c': 'capPercentOfPool' }, { ':c': 100 });
      useSpend(120);
      beforeWrite(1, async () => {
        useTier({ markupBps: 11_000 });
        await admit(o.userId);
      });
      const status = await admit(o.userId);
      expect(status.allowed).toBe(true); // a lost race never fails the check
      expect((await row(o.email)).paygOverage.admittedMonths).toEqual([
        entry({ capHighWaterMicroUsd: 100 * USD, markupBps: 11_000 }), // the competitor saw the raised cap too
      ]);

      // Same race on the month's FIRST admission (attribute_not_exists branch).
      const p = newOwner();
      await optedIn(p, { poolHighWater: { month: CUR, thresholdMicroUsd: 100 * USD } });
      useTier();
      beforeWrite(1, async () => {
        useTier({ markupBps: 11_000 });
        await admit(p.userId);
        useTier();
      });
      await admit(p.userId);
      expect((await row(p.email)).paygOverage.admittedMonths).toEqual([entry({ markupBps: 11_000 })]);
      // The loser's figures are applied by the next admission (here: nothing to raise — 15000 > 11000).
      expect(await writesDuring(() => admit(p.userId))).toBe(0);
    });

    it('pool high-water: raised only when today\'s pool is higher (`< :hwThreshold`); a lower pool writes nothing and is measured against the mark', async () => {
      const o = newOwner();
      await optedIn(o, { poolHighWater: { month: CUR, thresholdMicroUsd: 100 * USD }, admittedMonths: [entry()] });
      useTier({ hardUsd: 150 });
      useSpend(160);
      await admit(o.userId);
      const raised = await row(o.email);
      expect(raised.paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 150 * USD });
      expect(raised.paygOverage.admittedMonths[0]).toMatchObject({ capHighWaterMicroUsd: 75 * USD, tierPoolHighWaterMicroUsd: 150 * USD });

      // Downgrade to $80: no write, and overage is still measured above the $150 mark (160 - 150 = 10 of a 75 cap).
      useTier({ hardUsd: 80 });
      let status: Json;
      expect(await writesDuring(async () => { status = await admit(o.userId); })).toBe(0);
      expect(status.overage).toEqual({ active: true, percentOfCap: 13 });
      expect((await row(o.email)).paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 150 * USD });
    });

    it('pool high-water conflict: a higher mark written meanwhile wins; ours is refused and the check measures against theirs', async () => {
      const o = newOwner();
      await optedIn(o, { poolHighWater: { month: CUR, thresholdMicroUsd: 100 * USD }, admittedMonths: [entry()] });
      useTier({ hardUsd: 150 });
      useSpend(160);
      beforeWrite(1, async () => {
        useTier({ hardUsd: 200 });
        useSpend(210);
        await admit(o.userId); // another instance, on a moment-later bigger plan
        useTier({ hardUsd: 150 });
        useSpend(160);
      });
      const status = await admit(o.userId);
      expect((await row(o.email)).paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 200 * USD }); // never lowered
      // The check re-read the mark and measured against $200: $160 spent is inside that pool, not overage.
      expect(status.overage).toEqual({ active: false, percentOfCap: 0 });
    });

    it('month rollover: the first mark of a month moves last month\'s to `poolHighWaterClosed`, conditional on the exact mark read', async () => {
      const o = newOwner();
      await optedIn(o, { poolHighWater: { month: PREV, thresholdMicroUsd: 120 * USD } });
      useSpend(130);
      await admit(o.userId);
      const after = await row(o.email);
      expect(after.paygOverage.poolHighWaterClosed).toEqual({ month: PREV, thresholdMicroUsd: 120 * USD });
      expect(after.paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 100 * USD });
    });

    it('rollover conflict: another instance rolled it over first — ours is refused and the closed copy is written once, unchanged', async () => {
      const o = newOwner();
      await optedIn(o, { poolHighWater: { month: PREV, thresholdMicroUsd: 120 * USD } });
      useSpend(130);
      beforeWrite(1, () => admit(o.userId));
      await admit(o.userId);
      const after = await row(o.email);
      expect(after.paygOverage.poolHighWaterClosed).toEqual({ month: PREV, thresholdMicroUsd: 120 * USD });
      expect(after.paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 100 * USD });
      expect(after.paygOverage.admittedMonths).toEqual([entry()]);
    });

    it('rollover conflict: last month\'s mark raised in its last instant — ours is refused, nothing is rolled over yet (known follow-up), the next check rolls over the higher mark', async () => {
      const o = newOwner();
      await optedIn(o, { poolHighWater: { month: PREV, thresholdMicroUsd: 120 * USD } });
      useSpend(130);
      beforeWrite(1, () => patch(o.email, 'SET #p.#hw = :hw', { '#p': 'paygOverage', '#hw': 'poolHighWater' }, { ':hw': { month: PREV, thresholdMicroUsd: 130 * USD } }));
      await admit(o.userId);
      const raced = await row(o.email);
      expect(raced.paygOverage.poolHighWater).toEqual({ month: PREV, thresholdMicroUsd: 130 * USD });
      expect(raced.paygOverage.poolHighWaterClosed).toBeUndefined();

      await admit(o.userId);
      const after = await row(o.email);
      expect(after.paygOverage.poolHighWaterClosed).toEqual({ month: PREV, thresholdMicroUsd: 130 * USD });
      expect(after.paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 100 * USD });
    });

    it('a read-only usage check (gate 2, settings view) decides the same and writes nothing', async () => {
      const o = newOwner();
      await optedIn(o, { poolHighWater: { month: PREV, thresholdMicroUsd: 120 * USD } });
      useSpend(130);
      let usage: Json;
      expect(await writesDuring(async () => { usage = await resolver.getEffectiveLlmUsagePolicy(o.userId); })).toBe(0);
      expect(usage.mode.reason).toBe('payg_overage');
      expect((await row(o.email)).paygOverage).not.toHaveProperty('admittedMonths');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 2. Credit ledger rollover: `llmUsageCreditsClosed`, PAYG accounts only
  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('credit ledger rollover (llmUsageCreditsClosed)', () => {
    const SEP = '2026-09';
    const OCT_2 = new Date('2026-10-02T10:00:00.000Z');
    const septemberLedger = {
      month: SEP, version: 4, totalPurchasedMicroUsd: 20 * USD, totalPurchasedReversedMicroUsd: 0,
      totalAdminGrantedMicroUsd: 5 * USD, totalMigrationOffsetMicroUsd: 0,
      grantIds: ['topup-1', 'admin-1'], grants: [{ id: 'topup-1', source: 'purchase', amountMicroUsd: 20 * USD, grantedAt: '2026-09-03T00:00:00.000Z' }],
      reversalIds: [], reversals: [],
      debits: [{ id: 'meter:w1', workId: 'w1', amountMicroUsd: 1000, debitedAt: '2026-09-04T00:00:00.000Z' }], debitIds: ['meter:w1'], totalDebitedMicroUsd: 1000,
    };
    const { debits: _debits, debitIds: _debitIds, ...septemberClosed } = septemberLedger;
    const owner = async (payg: boolean) => {
      const o = newOwner();
      await put({
        ...o, llmUsageCredits: septemberLedger,
        ...(payg ? { paygOverage: { enabled: false, capPercentOfPool: 50, updatedBy: o.userId, updatedAt: '2026-01-01T00:00:00.000Z', version: 2 } } : {}),
      });
      return o;
    };

    it.each([
      ['purchase grant', (userId: string) => credits.grantMonthlyLlmUsageCredit({ billingUserId: userId, grantId: 'topup-oct', source: 'purchase', amountMicroUsd: 10 * USD, now: OCT_2 })],
      ['seat/admin grant (TransactWriteItems with the audit row)', (userId: string) => credits.grantMonthlyLlmUsageCredit({ billingUserId: userId, grantId: 'admin-oct', source: 'admin', amountMicroUsd: 10 * USD, now: OCT_2, grantedBy: 'admin-1', reason: 'seat credit' })],
      ['debit', (userId: string) => credits.recordLlmUsageDebit({ billingUserId: userId, workId: 'w-oct', amountMicroUsd: 5000, now: OCT_2 })],
    ])('%s: the first write of a new month keeps September as llmUsageCreditsClosed (no per-debit list) — only for a PAYG account', async (_label, write) => {
      const payg = await owner(true);
      await write(payg.userId);
      const after = await row(payg.email);
      expect(after.llmUsageCredits.month).toBe('2026-10');
      expect(after.llmUsageCreditsClosed).toEqual(septemberClosed);

      const plain = await owner(false);
      await write(plain.userId);
      const plainAfter = await row(plain.email);
      expect(plainAfter.llmUsageCredits.month).toBe('2026-10');
      expect(plainAfter).not.toHaveProperty('llmUsageCreditsClosed');
    });

    it('a second write in the same month leaves the closed copy alone', async () => {
      const o = await owner(true);
      await credits.recordLlmUsageDebit({ billingUserId: o.userId, workId: 'w-a', amountMicroUsd: 5000, now: OCT_2 });
      await credits.recordLlmUsageDebit({ billingUserId: o.userId, workId: 'w-b', amountMicroUsd: 7000, now: OCT_2 });
      const after = await row(o.email);
      expect(after.llmUsageCreditsClosed).toEqual(septemberClosed);
      expect(after.llmUsageCredits.debitIds).toEqual(['meter:w-a', 'meter:w-b']);
    });

    it('conflict (version condition): a rollover written meanwhile wins; ours retries on the new month and never overwrites the closed copy', async () => {
      const o = await owner(true);
      afterIndexedRead(() => credits.grantMonthlyLlmUsageCredit({ billingUserId: o.userId, grantId: 'topup-race', source: 'purchase', amountMicroUsd: 3 * USD, now: OCT_2 }));
      const ours = await credits.grantMonthlyLlmUsageCredit({ billingUserId: o.userId, grantId: 'topup-oct', source: 'purchase', amountMicroUsd: 10 * USD, now: OCT_2 });
      expect(ours.granted).toBe(true);
      const after = await row(o.email);
      expect(after.llmUsageCredits.grantIds).toEqual(['topup-race', 'topup-oct']);
      expect(after.llmUsageCredits.totalPurchasedMicroUsd).toBe(13 * USD);
      expect(after.llmUsageCreditsClosed).toEqual(septemberClosed);
    });

    it('conflict in the admin transaction: DynamoDB cancels it (TransactionCanceledException / ConditionalCheckFailed), the grant retries and lands once with one audit row', async () => {
      const o = await owner(true);
      afterIndexedRead(() => credits.recordLlmUsageDebit({ billingUserId: o.userId, workId: 'w-race', amountMicroUsd: 5000, now: OCT_2 }));
      const ours = await credits.grantMonthlyLlmUsageCredit({ billingUserId: o.userId, grantId: 'admin-oct', source: 'admin', amountMicroUsd: 10 * USD, now: OCT_2, grantedBy: 'admin-1' });
      expect(ours.granted).toBe(true);
      const after = await row(o.email);
      expect(after.llmUsageCredits).toMatchObject({ month: '2026-10', grantIds: ['admin-oct'], debitIds: ['meter:w-race'], totalAdminGrantedMicroUsd: 10 * USD });
      expect(after.llmUsageCreditsClosed).toEqual(septemberClosed);
      const audit = await ddb.query({
        TableName: PAYMENT_HISTORY, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': o.userId }, ConsistentRead: true,
      }).promise();
      expect(audit.Items).toHaveLength(1);
      expect(audit.Items[0]).toMatchObject({ eventType: 'admin_credit_grant', amount: 1000, metadata: { grantId: 'admin-oct' } });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 3. Settings: GET/PUT /api/subscription/payg (paygOverageService)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('settings PUT (updatePaygOverage) and the payment-method repair', () => {
    let CUR: string;
    let PREV: string;
    beforeAll(() => {
      CUR = credits.getCurrentUsageMonth();
      const now = new Date();
      PREV = credits.getCurrentUsageMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    });
    const owner = async (payg?: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const o = newOwner();
      await put({
        ...o, subscription_status: 'active', has_payment_method: true, stripe_customer_id: 'cus_row', ...extra,
        ...(payg ? { paygOverage: { capPercentOfPool: 50, updatedBy: o.userId, updatedAt: '2026-01-01T00:00:00.000Z', ...payg } } : {}),
      });
      return o;
    };
    const putSettings = (userId: string, body: { enabled: unknown; capPercentOfPool?: unknown }) =>
      settings.updatePaygOverage({ userId, actorId: userId, isDelegated: false, ...body, capPercentOfPool: body.capPercentOfPool });
    const conflict = expect.objectContaining({ status: 409, code: 'payg_conflict' });

    it('first opt-in creates the record (attribute_not_exists) with the month\'s baseline and mark; a concurrent create loses with 409', async () => {
      const o = await owner(undefined, { has_payment_method: false });
      useSpend(120); // $20 over the $100 pool already
      const view = await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      expect(view).toMatchObject({ enabled: true, capPercentOfPool: 50, hasPaymentMethod: true });
      const after = await row(o.email);
      expect(after.has_payment_method).toBe(true);
      expect(after.paygOverage).toMatchObject({
        enabled: true, capPercentOfPool: 50, version: 1,
        optIn: { month: CUR, overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD },
        poolHighWater: { month: CUR, thresholdMicroUsd: 100 * USD },
      });

      const p = await owner();
      beforeWrite(1, () => putSettings(p.userId, { enabled: true, capPercentOfPool: 25 }));
      await expect(putSettings(p.userId, { enabled: true, capPercentOfPool: 100 })).rejects.toEqual(conflict);
      expect((await row(p.email)).paygOverage).toMatchObject({ capPercentOfPool: 25, version: 1 });
    });

    it('every change is conditional on the version read (`#payg.#version = :expectedVersion`); a concurrent change makes it 409', async () => {
      const o = await owner({ enabled: true, capPercentOfPool: 100, version: 4, suspended: { reason: 'payment_failed', at: '2026-10-05T00:00:00.000Z', invoiceId: 'in_1' } });
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      const after = await row(o.email);
      expect(after.paygOverage).toMatchObject({ capPercentOfPool: 50, version: 5 });
      expect(after.paygOverage.suspended).toEqual({ reason: 'payment_failed', at: '2026-10-05T00:00:00.000Z', invoiceId: 'in_1' }); // field-by-field: kept

      beforeWrite(1, () => putSettings(o.userId, { enabled: false }));
      await expect(putSettings(o.userId, { enabled: true, capPercentOfPool: 25 })).rejects.toEqual(conflict);
      expect((await row(o.email)).paygOverage).toMatchObject({ enabled: false, capPercentOfPool: 50, version: 6 });
    });

    it('a record written before `version` existed is updated only while it still has none', async () => {
      const o = await owner({ enabled: true });
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 25 });
      expect((await row(o.email)).paygOverage).toMatchObject({ capPercentOfPool: 25, version: 1 });

      const p = await owner({ enabled: true });
      beforeWrite(1, () => putSettings(p.userId, { enabled: false }));
      await expect(putSettings(p.userId, { enabled: true, capPercentOfPool: 25 })).rejects.toEqual(conflict);
    });

    it('opt-in baseline: taken on the month\'s FIRST off -> on only; re-enabling in the same month keeps it', async () => {
      const o = await owner({ enabled: false, version: 1 });
      useSpend(120);
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      const first = (await row(o.email)).paygOverage.optIn;
      expect(first).toEqual({ month: CUR, overageBaselineMicroUsd: 20 * USD, poolAtOptInMicroUsd: 100 * USD });

      await putSettings(o.userId, { enabled: false });
      useSpend(140);
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      const after = await row(o.email);
      expect(after.paygOverage.optIn).toEqual(first);
      expect(after.paygOverage.version).toBe(4);
    });

    it('no new baseline once PAYG admitted anything this month (an opt-in carried over from an earlier month)', async () => {
      const o = await owner({
        enabled: false, version: 2,
        optIn: { month: PREV, overageBaselineMicroUsd: 7 * USD, poolAtOptInMicroUsd: 100 * USD },
        admittedMonths: [{ month: CUR, capHighWaterMicroUsd: 50 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 15_000, spendBasis: 'spend_ledger' }],
      });
      useSpend(130);
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      const after = await row(o.email);
      expect(after.paygOverage.optIn).toEqual({ month: PREV, overageBaselineMicroUsd: 7 * USD, poolAtOptInMicroUsd: 100 * USD });
      expect(after.paygOverage).not.toHaveProperty('optInClosed');
    });

    it('first opt-in of a new month rolls last month\'s opt-in and mark to the closed copies (exact-mark condition)', async () => {
      const o = await owner({
        enabled: false, version: 3,
        optIn: { month: PREV, overageBaselineMicroUsd: 7 * USD, poolAtOptInMicroUsd: 90 * USD },
        poolHighWater: { month: PREV, thresholdMicroUsd: 90 * USD },
      });
      useSpend(110);
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      const after = (await row(o.email)).paygOverage;
      expect(after.optInClosed).toEqual({ month: PREV, overageBaselineMicroUsd: 7 * USD, poolAtOptInMicroUsd: 90 * USD });
      expect(after.poolHighWaterClosed).toEqual({ month: PREV, thresholdMicroUsd: 90 * USD });
      expect(after.optIn).toEqual({ month: CUR, overageBaselineMicroUsd: 10 * USD, poolAtOptInMicroUsd: 100 * USD });
      expect(after.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 100 * USD });
    });

    it('rollover vs the gate: a gate that rolled the mark to the same value meanwhile is accepted; one that raised it above ours is a 409', async () => {
      const base = {
        enabled: true, version: 3, poolHighWater: { month: PREV, thresholdMicroUsd: 90 * USD },
        optIn: { month: PREV, overageBaselineMicroUsd: 0, poolAtOptInMicroUsd: 90 * USD },
      };
      useSpend(110);
      // (a) The gate's first check of the month rolled {PREV, 90} -> {CUR, 100}: the second disjunct holds.
      const o = await owner({ ...base, enabled: false });
      beforeWrite(1, () => patch(o.email, 'SET #p.#hw = :hw, #p.#c = :c', { '#p': 'paygOverage', '#hw': 'poolHighWater', '#c': 'poolHighWaterClosed' }, {
        ':hw': { month: CUR, thresholdMicroUsd: 100 * USD }, ':c': { month: PREV, thresholdMicroUsd: 90 * USD },
      }));
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      expect((await row(o.email)).paygOverage).toMatchObject({
        version: 4, poolHighWater: { month: CUR, thresholdMicroUsd: 100 * USD }, poolHighWaterClosed: { month: PREV, thresholdMicroUsd: 90 * USD },
      });
      // (b) The gate raised this month's mark above the opt-in's: the opt-in would lower it — refused.
      const p = await owner({ ...base, enabled: false });
      beforeWrite(1, () => patch(p.email, 'SET #p.#hw = :hw', { '#p': 'paygOverage', '#hw': 'poolHighWater' }, { ':hw': { month: CUR, thresholdMicroUsd: 150 * USD } }));
      await expect(putSettings(p.userId, { enabled: true, capPercentOfPool: 50 })).rejects.toEqual(conflict);
      expect((await row(p.email)).paygOverage).toMatchObject({ enabled: false, version: 3, poolHighWater: { month: CUR, thresholdMicroUsd: 150 * USD } });
    });

    it('same-month opt-in pins the mark at the opt-in pool, never below a mark the gate raised meanwhile', async () => {
      const o = await owner({ enabled: false, version: 1, poolHighWater: { month: CUR, thresholdMicroUsd: 80 * USD } });
      useSpend(90);
      await putSettings(o.userId, { enabled: true, capPercentOfPool: 50 });
      expect((await row(o.email)).paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 100 * USD });

      const p = await owner({ enabled: false, version: 1, poolHighWater: { month: CUR, thresholdMicroUsd: 80 * USD } });
      beforeWrite(1, () => patch(p.email, 'SET #p.#hw.#t = :t', { '#p': 'paygOverage', '#hw': 'poolHighWater', '#t': 'thresholdMicroUsd' }, { ':t': 120 * USD }));
      await expect(putSettings(p.userId, { enabled: true, capPercentOfPool: 50 })).rejects.toEqual(conflict);
      expect((await row(p.email)).paygOverage.poolHighWater).toEqual({ month: CUR, thresholdMicroUsd: 120 * USD });
    });

    it('has_payment_method repair on the settings read: written (unconditionally) only when Stripe confirms a card', async () => {
      settings.resetLivePaymentMethodChecksForTests();
      const o = await owner({ enabled: true, version: 1 }, { has_payment_method: false });
      mocks.stripe.resolveUserPaymentMethod.mockResolvedValueOnce({ hasPaymentMethod: false, customerId: 'cus_row', fallbackPaymentMethodId: null, card: null, isZoma: false });
      expect(await writesDuring(() => settings.getPaygOverageView(o.userId))).toBe(0);
      expect((await row(o.email)).has_payment_method).toBe(false);

      settings.resetLivePaymentMethodChecksForTests();
      const view = await settings.getPaygOverageView(o.userId);
      expect(view.hasPaymentMethod).toBe(true);
      expect((await row(o.email)).has_payment_method).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 4. Month-end settlement and the invoice webhooks
  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('settlement (paygSettlementService)', () => {
    const M = '2026-09';
    const NEXT = '2026-10';
    const DAY2 = new Date('2026-10-02T12:00:00.000Z');
    const admitted = (month: string) => ({
      month, capHighWaterMicroUsd: 50 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 15_000, spendBasis: 'spend_ledger',
    });
    const owner = async (extra: Record<string, unknown> = {}, payg: Record<string, unknown> = {}) => {
      const o = newOwner();
      await put({
        ...o, subscription_status: 'active', has_payment_method: true, stripe_customer_id: 'cus_row',
        paygOverage: {
          enabled: true, capPercentOfPool: 50, version: 3, updatedBy: o.userId, updatedAt: '2026-08-01T00:00:00.000Z',
          poolHighWater: { month: NEXT, thresholdMicroUsd: 100 * USD }, poolHighWaterClosed: { month: M, thresholdMicroUsd: 100 * USD },
          admittedMonths: [admitted(NEXT), admitted(M)], ...payg,
        },
        ...extra,
      });
      return o;
    };
    /** September: $130 settled, projection agrees -> $30 overage x 1.5 = $45.00. */
    const spend = (settledUsd = 130, projectedUsd: number | null = settledUsd) => {
      mocks.listSpendEvents.mockResolvedValue([{
        billingUserId: 'x', eventId: 'e1', occurredAt: `${M}-15T10:00:00.000Z`, billingMonth: M, actingUserId: 'x',
        provider: 'openai', operation: 'chat', unit: 'call', quantity: 1, costMicroUsd: settledUsd * USD, costSource: 'measured', lifecycle: 'settled',
      }]);
      mocks.getProjection.mockResolvedValue(projectedUsd === null ? null : { billingUserId: 'x', billingMonth: M, settledMicroUsd: projectedUsd * USD, computedAt: DAY2.toISOString() });
    };
    let invoiceSeq = 0;
    /** Stripe issues (and the code records) one invoice. */
    const stripeIssues = () => mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
      const id = input.invoiceId ?? `in_${++invoiceSeq}`;
      await input.recordInvoiceId(id);
      return { outcome: 'issued', invoice: { id, hosted_invoice_url: `https://invoice.example/${id}` } };
    });
    const record = async (email: string, month = M) => (await row(email)).paygSettlements?.[month];
    const invoiceEvent = (o: { userId: string }, id: string, month = M) => ({
      id, metadata: { purchaseType: 'payg_overage', billingUserId: o.userId, month, idempotencyKey: `payg:${o.userId}:${month}` },
      amount_paid: 4500, amount_due: 4500, currency: 'usd', hosted_invoice_url: `https://invoice.example/${id}`,
    });
    const setStatus = (email: string, month: string, status: string) =>
      patch(email, 'SET #s.#m.#st = :st', { '#s': 'paygSettlements', '#m': month, '#st': 'status' }, { ':st': status });

    beforeEach(() => spend());

    it('first record ever (`attribute_not_exists(#settlements)`): pending -> invoice id recorded -> invoiced, amount and inputs frozen', async () => {
      const o = await owner();
      stripeIssues();
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('invoiced');
      const r = await record(o.email);
      expect(r).toMatchObject({
        status: 'invoiced', amountCents: 4500, overageCostMicroUsd: 30 * USD, billedMicroUsd: 45 * USD, markupBps: 15_000, percentOfCap: 60,
        idempotencyKey: `payg:${o.userId}:${M}`, createdAt: DAY2.toISOString(), settledMicroUsd: 130 * USD, projectedMicroUsd: 130 * USD,
        inputs: { credits: expect.any(Object), poolHighWater: { month: M, thresholdMicroUsd: 100 * USD } },
      });
      expect(r.invoiceId).toMatch(/^in_/);
      expect(mocks.stripe.issuePaygOverageInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4500, idempotencyKey: `payg:${o.userId}:${M}:${DAY2.toISOString()}` }));
      expect(mocks.email.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('already_recorded');
    });

    it('the pending lock: of two sweeps that both read "no record", only one writes `pending` and charges; the other is `raced`', async () => {
      const o = await owner();
      stripeIssues();
      let theirs: string | undefined;
      beforeWrite(1, async () => { theirs = await settlement.settlePaygOverageMonth(o.userId, M, new Date('2026-10-02T12:00:01.000Z')); });
      const ours = await settlement.settlePaygOverageMonth(o.userId, M, DAY2);
      expect([theirs, ours]).toEqual(['invoiced', 'raced']);
      expect(mocks.stripe.issuePaygOverageInvoice).toHaveBeenCalledTimes(1);
      expect((await record(o.email)).createdAt).toBe('2026-10-02T12:00:01.000Z'); // the winner's record
    });

    it('the pending lock with other months on the row (`attribute_not_exists(#settlements.#month)`) prunes months past the window in the same write', async () => {
      const o = await owner({
        paygSettlements: {
          '2025-08': { status: 'paid', idempotencyKey: 'old', amountCents: 100, createdAt: '2025-09-02T12:00:00.000Z' },
          '2026-08': { status: 'nothing_to_bill', idempotencyKey: 'aug', amountCents: 0, createdAt: '2026-09-02T12:00:00.000Z' },
        },
      });
      stripeIssues();
      let theirs: string | undefined;
      beforeWrite(1, async () => { theirs = await settlement.settlePaygOverageMonth(o.userId, M, DAY2); });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('raced');
      expect(theirs).toBe('invoiced');
      const settlements = (await row(o.email)).paygSettlements;
      expect(Object.keys(settlements).sort()).toEqual(['2026-08', M]);
    });

    it('two concurrent daily sweeps (runPaygSettlement): exactly one invoices and emails the owner', async () => {
      const o = await owner();
      stripeIssues();
      // The real scan finds every owner earlier tests left in the table too; only this owner is asserted.
      const [a, b] = await Promise.all([settlement.runPaygSettlement(DAY2), settlement.runPaygSettlement(DAY2)]);
      expect([...a.errors, ...b.errors].filter((e) => e.billingUserId === o.userId)).toEqual([]);
      expect((await record(o.email)).status).toBe('invoiced');
      const sent = mocks.email.sendPaygOverageInvoiceEmail.mock.calls.filter(([arg]: Json[]) => arg.to === o.email);
      expect(sent).toHaveLength(1);
    });

    it('webhooks: invoiced -> paid (`status IN (...)`); a redelivery and a late failure for a paid invoice change nothing', async () => {
      const o = await owner();
      stripeIssues();
      await settlement.settlePaygOverageMonth(o.userId, M, DAY2);
      const id = (await record(o.email)).invoiceId;
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, id));
      const paid = await record(o.email);
      expect(paid).toMatchObject({ status: 'paid', invoiceId: id });
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, id));
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, id));
      expect(await record(o.email)).toEqual(paid);
      expect((await row(o.email)).paygOverage).not.toHaveProperty('suspended');
    });

    it('held for no Stripe customer (pending -> held, one alert); a rerun does nothing', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockResolvedValue({ outcome: 'no_customer' });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('held');
      expect(await record(o.email)).toMatchObject({ status: 'held', heldReason: 'no_stripe_customer', amountCents: 4500 });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('already_recorded');
      expect(mocks.email.sendOncallAlert).toHaveBeenCalledTimes(1);
    });

    it('held `multiple_invoices`: SET heldReason + conflictingInvoiceIds and REMOVE invoiceId in one conditional write', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
        await input.recordInvoiceId('in_seen_first');
        return { outcome: 'multiple', invoiceIds: ['in_a', 'in_b'] };
      });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('held');
      const r = await record(o.email);
      expect(r).toMatchObject({ status: 'held', heldReason: 'multiple_invoices', conflictingInvoiceIds: ['in_a', 'in_b'] });
      expect(r).not.toHaveProperty('invoiceId');
    });

    it('held with the invoice set aside (`uncollectedInvoice`, invoiceId removed): its later webhooks are ignored', async () => {
      const o = await owner({ paygSettlements: { [M]: {
        status: 'pending', idempotencyKey: 'k', amountCents: 4500, percentOfCap: 60, createdAt: DAY2.toISOString(), updatedAt: DAY2.toISOString(), invoiceId: 'in_voided',
      } } });
      mocks.stripe.issuePaygOverageInvoice.mockResolvedValue({ outcome: 'mismatch', invoiceId: 'in_voided', reason: 'void' });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('held');
      const held = await record(o.email);
      expect(held).toMatchObject({ status: 'held', heldReason: 'invoice_mismatch', uncollectedInvoice: { invoiceId: 'in_voided', reason: 'void' } });
      expect(held).not.toHaveProperty('invoiceId');
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_voided'));
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_voided'));
      expect(await record(o.email)).toEqual(held);
      expect((await row(o.email)).paygOverage).not.toHaveProperty('suspended');
    });

    it('held over a finalized invoice at another total keeps its id; that invoice\'s paid webhook moves held -> paid', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
        await input.recordInvoiceId('in_discounted');
        return { outcome: 'mismatch', invoiceId: 'in_discounted', reason: 'total_differs' };
      });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('held');
      expect(await record(o.email)).toMatchObject({ status: 'held', invoiceId: 'in_discounted' });
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_discounted'));
      expect(await record(o.email)).toMatchObject({ status: 'paid', invoiceId: 'in_discounted' });
    });

    it('conflict: a paid webhook moves the month while settlement is holding it — the hold is refused (`raced`), no alert', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async () => {
        // The invoice this record's own run created (rv6 MINOR 1: its metadata names the record's createdAt).
        const ev = invoiceEvent(o, 'in_paid_meanwhile');
        await settlement.handlePaygOverageInvoicePaid({ ...ev, metadata: { ...ev.metadata, recordCreatedAt: DAY2.toISOString() } });
        return { outcome: 'no_customer' };
      });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('raced');
      expect(await record(o.email)).toMatchObject({ status: 'paid', invoiceId: 'in_paid_meanwhile' });
      expect(mocks.email.sendOncallAlert).not.toHaveBeenCalled();
    });

    it('frozen inputs + retry: a held month set to `retry` by hand is re-measured from its frozen inputs months later (`#status = :retry`)', async () => {
      const o = await owner();
      spend(130, 100); // drift: held, inputs frozen
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('held');
      const held = await record(o.email);
      expect(held).toMatchObject({ status: 'held', heldReason: 'spend_drift', inputs: { poolHighWater: { month: M, thresholdMicroUsd: 100 * USD } } });

      // Months later the row no longer holds September's mark at all; the record's frozen copy is what counts.
      await patch(o.email, 'REMOVE #p.#c', { '#p': 'paygOverage', '#c': 'poolHighWaterClosed' });
      await setStatus(o.email, M, 'retry');
      spend(130);
      stripeIssues();
      const DEC2 = new Date('2026-12-02T12:00:00.000Z');
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DEC2)).toBe('invoiced');
      const r = await record(o.email);
      expect(r).toMatchObject({ status: 'invoiced', amountCents: 4500, inputs: held.inputs, retriedAt: DEC2.toISOString(), createdAt: DEC2.toISOString() });
      expect(r).not.toHaveProperty('heldReason');
    });

    it('retry conflict: of two sweeps re-measuring the same `retry` month only one re-creates it', async () => {
      const o = await owner();
      spend(130, 100);
      await settlement.settlePaygOverageMonth(o.userId, M, DAY2);
      await setStatus(o.email, M, 'retry');
      spend(130);
      stripeIssues();
      let theirs: string | undefined;
      beforeWrite(1, async () => { theirs = await settlement.settlePaygOverageMonth(o.userId, M, DAY2); });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('raced');
      expect(theirs).toBe('invoiced');
      expect(mocks.stripe.issuePaygOverageInvoice).toHaveBeenCalledTimes(1);
    });

    it('a month older than the one that just closed with no frozen inputs is held `inputs_unavailable`', async () => {
      const o = await owner();
      expect(await settlement.settlePaygOverageMonth(o.userId, M, new Date('2026-11-02T12:00:00.000Z'))).toBe('held');
      expect(await record(o.email)).toMatchObject({ status: 'held', heldReason: 'inputs_unavailable' });
      expect(await record(o.email)).not.toHaveProperty('inputs');
    });

    // ── suspension: set (failed + invoice id) and lift (consistent read after own write, `= :seen`) ──────
    const failedMonths = async (months: string[]) => {
      const o = await owner({
        paygSettlements: Object.fromEntries(months.map((m) => [m, {
          status: 'invoiced', idempotencyKey: `k-${m}`, amountCents: 4500, createdAt: DAY2.toISOString(), updatedAt: DAY2.toISOString(), invoiceId: `in_${m}`,
        }])),
      });
      return o;
    };

    it('a failed charge marks the month failed and suspends PAYG — the suspend write is conditional on THAT invoice being failed', async () => {
      const o = await failedMonths([M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      const after = await row(o.email);
      expect(after.paygSettlements[M]).toMatchObject({ status: 'failed', invoiceId: `in_${M}` });
      expect(after.paygOverage.suspended).toEqual({ reason: 'payment_failed', at: expect.any(String), invoiceId: `in_${M}` });
      expect(mocks.email.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
      expect(mocks.paymentHistory).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'payg_overage_payment_failed' }), { dedupKey: `payg_overage_payment_failed:in_${M}` });
    });

    it('conflict: the payment lands between the failure\'s `failed` write and its suspend write — no suspension', async () => {
      const o = await failedMonths([M]);
      beforeWrite(2, () => settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, `in_${M}`)));
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      const after = await row(o.email);
      expect(after.paygSettlements[M].status).toBe('paid');
      expect(after.paygOverage).not.toHaveProperty('suspended');
    });

    it('a second month failing re-stamps the suspension; a redelivered failure changes nothing; a dispute is never downgraded', async () => {
      const o = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_2026-08', '2026-08'));
      const first = (await row(o.email)).paygOverage.suspended;
      await new Promise((r) => setTimeout(r, 5));
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      const second = (await row(o.email)).paygOverage.suspended;
      expect(second).toMatchObject({ reason: 'payment_failed', invoiceId: `in_${M}` });
      expect(second.at > first.at).toBe(true);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      expect((await row(o.email)).paygOverage.suspended).toEqual(second);

      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_1', amount: 4500, currency: 'usd', reason: 'fraudulent' }, { id: 'ch_1' }, invoiceEvent(o, 'in_2026-08', '2026-08'));
      const disputed = (await row(o.email)).paygOverage.suspended;
      expect(disputed).toMatchObject({ reason: 'dispute', invoiceId: 'in_2026-08' });
      expect((await record(o.email, '2026-08')).disputes).toEqual({ dp_1: { at: expect.any(String) } });
      // A second dispute re-stamps the dispute hold in the same write that records it open (rv5 MINOR 1/2:
      // a won-dispute lift that read the row before it is refused).
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_2' }, { id: 'ch_2' }, invoiceEvent(o, `in_${M}`));
      const restamped = (await row(o.email)).paygOverage.suspended;
      expect(restamped).toMatchObject({ reason: 'dispute', disputeId: 'dp_2', invoiceId: `in_${M}` });
      // Paying everything never lifts a dispute.
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_2026-08', '2026-08'));
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, `in_${M}`));
      expect((await row(o.email)).paygOverage.suspended).toEqual(restamped);
    });

    it('lift: paying one of two failed months keeps the suspension; paying the last lifts it', async () => {
      const o = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_2026-08', '2026-08'));
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_2026-08', '2026-08'));
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, `in_${M}`));
      expect((await row(o.email)).paygOverage).not.toHaveProperty('suspended');
    });

    it('lift: two failed months paid at the same time — at least one webhook sees both paid; the suspension is lifted (the other remove is refused)', async () => {
      const o = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_2026-08', '2026-08'));
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      await Promise.all([
        settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_2026-08', '2026-08')),
        settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, `in_${M}`)),
      ]);
      const after = await row(o.email);
      expect([after.paygSettlements['2026-08'].status, after.paygSettlements[M].status]).toEqual(['paid', 'paid']);
      expect(after.paygOverage).not.toHaveProperty('suspended');
    });

    it('lift conflict (`#payg.#suspended = :seen`, a map): a month failing after the lift\'s read re-stamps the suspension and the lift is refused', async () => {
      const o = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_2026-08', '2026-08'));
      // Write 1 = the paid transition; write 2 = the invoice-email claim (`emailedAt`); write 3 = the lift's
      // REMOVE, after its consistent read saw nothing failed.
      beforeWrite(3, () => settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`)));
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_2026-08', '2026-08'));
      const after = await row(o.email);
      expect(after.paygSettlements['2026-08'].status).toBe('paid');
      expect(after.paygSettlements[M].status).toBe('failed');
      expect(after.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: `in_${M}` });
    });

    it('lift reads AFTER its own paid write: a failure that lands before that read keeps the suspension', async () => {
      const o = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_2026-08', '2026-08'));
      // The failure lands after the paid write but before the lift's read (payment history sits between them).
      mocks.paymentHistory.mockImplementationOnce(async () => {
        await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
        return { written: true };
      });
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_2026-08', '2026-08'));
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: `in_${M}` });
    });

    it('refund: refundedCents recorded on the month (conditional on the record existing); PAYG not resumed', async () => {
      const o = await failedMonths([M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      await settlement.handlePaygOverageChargeRefunded({ id: 'ch_1', amount_refunded: 1200, refunded: false, currency: 'usd' }, invoiceEvent(o, `in_${M}`));
      const after = await row(o.email);
      expect(after.paygSettlements[M].refundedCents).toBe(1200);
      expect(after.paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });
    });

    it('a failure webhook for a row whose PAYG record was removed: the month is marked failed, nothing is suspended, and nothing throws', async () => {
      const o = await failedMonths([M]);
      await patch(o.email, 'REMOVE #p', { '#p': 'paygOverage' });
      await expect(settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`))).resolves.toBeUndefined();
      const after = await row(o.email);
      expect(after.paygSettlements[M].status).toBe('failed');
      expect(after).not.toHaveProperty('paygOverage');
    });

    // ── rvE2E round: the invoice lifecycle, email once, drift tolerance, the owner's invoice link ──────
    it('invoice voided after failing: failed -> written_off (`status IN`), the suspension lifted (map `= :seen`); a redelivery changes nothing', async () => {
      const o = await failedMonths([M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      await settlement.handlePaygOverageInvoiceVoided(invoiceEvent(o, `in_${M}`));
      const after = await row(o.email);
      expect(after.paygSettlements[M]).toMatchObject({ status: 'written_off', writtenOffReason: 'invoice_voided', invoiceId: `in_${M}` });
      expect(after.paygOverage).not.toHaveProperty('suspended');
      expect(mocks.email.sendOncallAlert).toHaveBeenCalledTimes(1);
      await settlement.handlePaygOverageInvoiceVoided(invoiceEvent(o, `in_${M}`));
      expect(mocks.email.sendOncallAlert).toHaveBeenCalledTimes(1);
    });

    it('voiding one of two failed months keeps the suspension; a dispute hold is never lifted by a void', async () => {
      const o = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_2026-08', '2026-08'));
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      await settlement.handlePaygOverageInvoiceVoided(invoiceEvent(o, `in_${M}`));
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'payment_failed' });

      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_v', amount: 4500, currency: 'usd' }, { id: 'ch_v' }, invoiceEvent(o, 'in_2026-08', '2026-08'));
      await settlement.handlePaygOverageInvoiceVoided(invoiceEvent(o, 'in_2026-08', '2026-08'));
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'dispute' });
    });

    it('marked uncollectible from invoiced: failed + suspended + uncollectibleAt; a later payment lifts it', async () => {
      const o = await failedMonths([M]);
      await settlement.handlePaygOverageInvoiceMarkedUncollectible(invoiceEvent(o, `in_${M}`));
      let after = await row(o.email);
      expect(after.paygSettlements[M]).toMatchObject({ status: 'failed', uncollectibleAt: expect.any(String), hostedInvoiceUrl: `https://invoice.example/in_${M}` });
      expect(after.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: `in_${M}` });
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, `in_${M}`));
      after = await row(o.email);
      expect(after.paygSettlements[M].status).toBe('paid');
      expect(after.paygOverage).not.toHaveProperty('suspended');
    });

    it('payment action required: the once-only flag (`attribute_not_exists` on a nested path + invoice id) lets exactly one email out', async () => {
      const o = await failedMonths([M]);
      await Promise.all([
        settlement.handlePaygOverageInvoicePaymentActionRequired(invoiceEvent(o, `in_${M}`)),
        settlement.handlePaygOverageInvoicePaymentActionRequired(invoiceEvent(o, `in_${M}`)),
      ]);
      expect(mocks.email.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledTimes(1);
      const after = await row(o.email);
      expect(after.paygSettlements[M]).toMatchObject({ status: 'invoiced', actionRequiredEmailedAt: expect.any(String) });
      expect(after.paygOverage).not.toHaveProperty('suspended');
      // Another month's invoice id never claims this month's flag.
      await settlement.handlePaygOverageInvoicePaymentActionRequired({ ...invoiceEvent(o, 'in_other'), id: 'in_other' });
      expect(mocks.email.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledTimes(1);
    });

    it('invoice email once: the paid webhook lands before the run\'s `invoiced` write — the month ends paid, ONE email (`emailedAt`)', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
        const id = `in_race_${++invoiceSeq}`;
        await input.recordInvoiceId(id);
        await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, id));
        return { outcome: 'issued', invoice: { id, status: 'open', hosted_invoice_url: `https://invoice.example/${id}` } };
      });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('raced');
      expect(await record(o.email)).toMatchObject({ status: 'paid', emailedAt: expect.any(String) });
      expect(mocks.email.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
    });

    it('an invoice Stripe already collected when the run adopts it is recorded paid (not invoiced)', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
        await input.recordInvoiceId('in_paid');
        return { outcome: 'issued', invoice: { id: 'in_paid', status: 'paid', hosted_invoice_url: 'https://invoice.example/in_paid' } };
      });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('paid');
      expect(await record(o.email)).toMatchObject({ status: 'paid', invoiceId: 'in_paid', paidAt: expect.any(String), emailedAt: expect.any(String) });
    });

    it('drift tolerance: a projection 30c behind is billed; $3 behind (over 1% and 50c) is held', async () => {
      const ok = await owner();
      stripeIssues();
      spend(130, 129.7);
      expect(await settlement.settlePaygOverageMonth(ok.userId, M, DAY2)).toBe('invoiced');
      expect(await record(ok.email)).toMatchObject({ amountCents: 4500, projectedMicroUsd: 129.7 * USD });
      const bad = await owner();
      spend(130, 127);
      expect(await settlement.settlePaygOverageMonth(bad.userId, M, DAY2)).toBe('held');
      expect(await record(bad.email)).toMatchObject({ status: 'held', heldReason: 'spend_drift' });
    });

    it('refund rows carry a dedupe key per refund and that refund\'s own amount', async () => {
      const o = await failedMonths([M]);
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, `in_${M}`));
      mocks.stripe.listChargeRefunds.mockResolvedValue([{ id: 're_r', amount: 1200, status: 'succeeded' }]);
      await settlement.handlePaygOverageChargeRefunded({ id: 'ch_r', amount_refunded: 1200, refunded: false, currency: 'usd' }, invoiceEvent(o, `in_${M}`));
      expect(mocks.paymentHistory).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'refund', amount: 1200 }), { dedupKey: 'refund:re_r' });
    });

    it('dispute closed: won lifts the dispute hold (map `= :seen`); won with another failed month hands the hold to it; lost writes off and keeps it', async () => {
      const won = await failedMonths([M]);
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(won, `in_${M}`));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_w', amount: 4500, currency: 'usd' }, { id: 'ch_w' }, invoiceEvent(won, `in_${M}`));
      expect(mocks.email.sendOncallAlert).toHaveBeenCalledTimes(1); // the dispute pages on-call
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_w', status: 'won' }, { id: 'ch_w' }, invoiceEvent(won, `in_${M}`));
      let after = await row(won.email);
      expect(after.paygOverage).not.toHaveProperty('suspended');
      expect(after.paygSettlements[M]).toMatchObject({ status: 'paid', disputes: { dp_w: { status: 'won', closedAt: expect.any(String) } } });

      const mixed = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(mixed, 'in_2026-08', '2026-08'));
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(mixed, `in_${M}`));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_m' }, { id: 'ch_m' }, invoiceEvent(mixed, `in_${M}`));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_m', status: 'won' }, { id: 'ch_m' }, invoiceEvent(mixed, `in_${M}`));
      expect((await row(mixed.email)).paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_2026-08' });

      const lost = await failedMonths([M]);
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(lost, `in_${M}`));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_l' }, { id: 'ch_l' }, invoiceEvent(lost, `in_${M}`));
      mocks.email.sendOncallAlert.mockClear();
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_l', status: 'lost' }, { id: 'ch_l' }, invoiceEvent(lost, `in_${M}`));
      after = await row(lost.email);
      expect(after.paygSettlements[M]).toMatchObject({ status: 'written_off', writtenOffReason: 'dispute_lost' });
      expect(after.paygOverage.suspended).toMatchObject({ reason: 'dispute' });
      expect(mocks.email.sendOncallAlert).toHaveBeenCalledTimes(1);
    });

    it('rv7 REVIEW: August paid between the won-dispute lift\'s read and its hand-over write => DynamoDB refuses the hand-over; the hold is removed', async () => {
      const mixed = await failedMonths(['2026-08', M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(mixed, 'in_2026-08', '2026-08'));
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(mixed, `in_${M}`));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_r' }, { id: 'ch_r' }, invoiceEvent(mixed, `in_${M}`));
      // call 1 = recordDisputeClosed, call 2 = the lift's hand-over write
      beforeWrite(2, () => settlement.handlePaygOverageInvoicePaid(invoiceEvent(mixed, 'in_2026-08', '2026-08')));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_r', status: 'won' }, { id: 'ch_r' }, invoiceEvent(mixed, `in_${M}`));
      const after = await row(mixed.email);
      expect(after.paygSettlements['2026-08'].status).toBe('paid');
      expect(after.paygOverage).not.toHaveProperty('suspended');
    });

    it('the owner\'s invoice link: GET /payg and the turn gate\'s 429 read the failed month\'s hosted page from the row', async () => {
      const o = await failedMonths([M]);
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, `in_${M}`));
      expect((await row(o.email)).paygSettlements[M].hostedInvoiceUrl).toBe(`https://invoice.example/in_${M}`);
      // `https://invoice.example/...` is an https page: it is the one offered.
      const { paygOpenInvoiceUrl } = await import('../services/paygSettlement');
      expect(paygOpenInvoiceUrl((await row(o.email)).paygSettlements)).toBe(`https://invoice.example/in_${M}`);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 4b. rv5 review round — the reviewer's failing probes, kept as permanent tests on real DynamoDB
  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('rv5 lifecycle (3-D Secure, disputes one by one, stale events, refunds per refund, emails, durable alerts)', () => {
    const M = '2026-09';
    const NEXT = '2026-10';
    const AUG = '2026-08';
    const DAY2 = new Date('2026-10-02T12:00:00.000Z');
    const admitted = (month: string) => ({
      month, capHighWaterMicroUsd: 50 * USD, tierPoolHighWaterMicroUsd: 100 * USD, markupBps: 15_000, spendBasis: 'spend_ledger',
    });
    const owner = async (extra: Record<string, unknown> = {}, payg: Record<string, unknown> = {}) => {
      const o = newOwner();
      await put({
        ...o, subscription_status: 'active', has_payment_method: true, stripe_customer_id: 'cus_row',
        paygOverage: {
          enabled: true, capPercentOfPool: 50, version: 3, updatedBy: o.userId, updatedAt: '2026-08-01T00:00:00.000Z',
          poolHighWater: { month: NEXT, thresholdMicroUsd: 100 * USD }, poolHighWaterClosed: { month: M, thresholdMicroUsd: 100 * USD },
          admittedMonths: [admitted(NEXT), admitted(M)], ...payg,
        },
        ...extra,
      });
      return o;
    };
    const spend = (settledUsd = 130, projectedUsd: number | null = settledUsd, month = M) => {
      mocks.listSpendEvents.mockResolvedValue([{
        billingUserId: 'x', eventId: 'e1', occurredAt: `${month}-15T10:00:00.000Z`, billingMonth: month, actingUserId: 'x',
        provider: 'openai', operation: 'chat', unit: 'call', quantity: 1, costMicroUsd: settledUsd * USD, costSource: 'measured', lifecycle: 'settled',
      }]);
      mocks.getProjection.mockResolvedValue(projectedUsd === null ? null : { billingUserId: 'x', billingMonth: month, settledMicroUsd: projectedUsd * USD, computedAt: DAY2.toISOString() });
    };
    const record = async (email: string, month = M) => (await row(email)).paygSettlements?.[month];
    const invoiceEvent = (o: { userId: string }, id: string, month = M) => ({
      id, metadata: { purchaseType: 'payg_overage', billingUserId: o.userId, month, idempotencyKey: `payg:${o.userId}:${month}` },
      amount_paid: 4500, amount_due: 4500, currency: 'usd', hosted_invoice_url: `https://invoice.example/${id}`,
    });
    const settle = (status: string, over: Record<string, unknown> = {}) => ({
      status, idempotencyKey: 'k', amountCents: 4500, percentOfCap: 60, createdAt: DAY2.toISOString(), updatedAt: DAY2.toISOString(), ...over,
    });
    const withMonths = (months: Record<string, Record<string, unknown>>, payg: Record<string, unknown> = {}) =>
      owner({ paygSettlements: months }, payg);
    /** Runs `competitor` right after the n-th strongly consistent read from now, then hands back that (now stale) read. */
    function afterNthConsistentRead(n: number, competitor: () => Promise<unknown>) {
      const real = userDb.getUserByIdConsistent.bind(userDb);
      let reads = 0;
      const spy = jest.spyOn(userDb, 'getUserByIdConsistent').mockImplementation(async (...args: unknown[]) => {
        reads += 1;
        const snapshot = await real(...args);
        if (reads === n) {
          spy.mockRestore();
          await competitor();
        }
        return snapshot;
      });
    }

    beforeEach(() => spend());

    // MAJOR 1
    it('3-D Secure: the pair Stripe sends (action_required, then payment_failed with the PaymentIntent requires_action) keeps PAYG on, as the email promises', async () => {
      const o = await withMonths({ [M]: settle('invoiced', { invoiceId: 'in_3ds' }) });
      mocks.stripe.paygOverageInvoicePaymentState.mockResolvedValue('action_required');
      const ev = { ...invoiceEvent(o, 'in_3ds'), status: 'open', attempt_count: 1 };
      await settlement.handlePaygOverageInvoicePaymentActionRequired(ev);
      await settlement.handlePaygOverageInvoicePaymentFailed(ev);
      expect(mocks.stripe.paygOverageInvoicePaymentState).toHaveBeenCalledWith('in_3ds');
      expect(mocks.email.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledTimes(1);
      expect(mocks.email.sendPaygOveragePaymentFailedEmail).not.toHaveBeenCalled();
      const after = await row(o.email);
      expect(after.paygOverage).not.toHaveProperty('suspended');
      expect(after.paygSettlements[M].status).toBe('invoiced');
      // ...and a genuine decline afterwards still fails it.
      mocks.stripe.paygOverageInvoicePaymentState.mockResolvedValue('declined');
      await settlement.handlePaygOverageInvoicePaymentFailed(ev);
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_3ds' });
    });

    // MAJOR 2
    it('dispute.closed (won) delivered BEFORE dispute.created: PAYG never ends suspended, `won` kept', async () => {
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_ro' }) });
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_ro', status: 'won' }, { id: 'ch_ro' }, invoiceEvent(o, 'in_ro'));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_ro', amount: 4500, currency: 'usd' }, { id: 'ch_ro' }, invoiceEvent(o, 'in_ro'));
      const after = await row(o.email);
      expect(after.paygOverage).not.toHaveProperty('suspended');
      expect(after.paygSettlements[M].disputes.dp_ro).toMatchObject({ status: 'won', closedAt: expect.any(String) });
    });

    it('dispute.created redelivered after the dispute was won: not re-suspended and nobody paged', async () => {
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_rd' }) });
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_rd' }, { id: 'ch_rd' }, invoiceEvent(o, 'in_rd'));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_rd', status: 'won' }, { id: 'ch_rd' }, invoiceEvent(o, 'in_rd'));
      expect((await row(o.email)).paygOverage).not.toHaveProperty('suspended');
      mocks.email.sendOncallAlert.mockClear();
      mocks.paymentHistory.mockResolvedValueOnce({ written: false }); // the history dedupe sees the redelivery
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_rd' }, { id: 'ch_rd' }, invoiceEvent(o, 'in_rd'));
      const after = await row(o.email);
      expect(mocks.email.sendOncallAlert).not.toHaveBeenCalled();
      expect(after.paygOverage).not.toHaveProperty('suspended');
      expect(after.paygSettlements[M].disputes.dp_rd.status).toBe('won');
    });

    // MINOR 1
    it('disputes open on two months: winning the FIRST keeps the hold while the second is open; winning the second lifts it', async () => {
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_d1' }), [AUG]: settle('paid', { invoiceId: 'in_d2' }) });
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_a' }, { id: 'ch_a' }, invoiceEvent(o, 'in_d1'));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_b' }, { id: 'ch_b' }, invoiceEvent(o, 'in_d2', AUG));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_a', status: 'won' }, { id: 'ch_a' }, invoiceEvent(o, 'in_d1'));
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'dispute' });
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_b', status: 'won' }, { id: 'ch_b' }, invoiceEvent(o, 'in_d2', AUG));
      expect((await row(o.email)).paygOverage).not.toHaveProperty('suspended');
    });

    // MINOR 2 — DynamoDB decides: the lift's `#payg.#suspended = :seen` against the failure's `paymentFailedAt` stamp
    it('a payment failure lands after the won-lift\'s read: the lift is refused, re-reads, and the account stays suspended for the failed month', async () => {
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_w' }), [AUG]: settle('invoiced', { invoiceId: 'in_f' }) });
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_w' }, { id: 'ch_w' }, invoiceEvent(o, 'in_w'));
      // closed: read 1 = loadSettlementFor, 2 = recording it closed, 3 = the lift's read; the failure lands after 3.
      afterNthConsistentRead(3, () => settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_f', AUG)));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_w', status: 'won' }, { id: 'ch_w' }, invoiceEvent(o, 'in_w'));
      const after = await row(o.email);
      expect(after.paygSettlements[AUG].status).toBe('failed');
      expect(after.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_f' });
    });

    it('a second dispute opens after the won-lift\'s read: the lift is refused (the hold was re-stamped with it) and PAYG stays held', async () => {
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_x1' }), [AUG]: settle('paid', { invoiceId: 'in_x2' }) });
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_x1' }, { id: 'ch_x1' }, invoiceEvent(o, 'in_x1'));
      afterNthConsistentRead(3, () => settlement.handlePaygOverageChargeDisputed({ id: 'dp_x2' }, { id: 'ch_x2' }, invoiceEvent(o, 'in_x2', AUG)));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_x1', status: 'won' }, { id: 'ch_x1' }, invoiceEvent(o, 'in_x1'));
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'dispute', disputeId: 'dp_x2' });
    });

    it('a lost dispute: written off and held as lost in one write; a won dispute elsewhere never lifts it', async () => {
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_l1' }), [AUG]: settle('paid', { invoiceId: 'in_l2' }) });
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_l1' }, { id: 'ch_l1' }, invoiceEvent(o, 'in_l1'));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_l2' }, { id: 'ch_l2' }, invoiceEvent(o, 'in_l2', AUG));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_l1', status: 'lost' }, { id: 'ch_l1' }, invoiceEvent(o, 'in_l1'));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_l2', status: 'won' }, { id: 'ch_l2' }, invoiceEvent(o, 'in_l2', AUG));
      const after = await row(o.email);
      expect(after.paygOverage.suspended).toMatchObject({ reason: 'dispute', lost: true, disputeId: 'dp_l1' });
      expect(after.paygSettlements[M]).toMatchObject({ status: 'written_off', writtenOffReason: 'dispute_lost', disputes: { dp_l1: { status: 'lost' } } });
    });

    // MINOR 3
    it('month re-issued after `retry` (pending, new invoice not recorded yet): a late invoice.voided for the OLD invoice does not write it off', async () => {
      const o = await withMonths({ [M]: settle('pending', { idempotencyKey: 'payg:k', createdAt: '2026-10-05T00:00:00.000Z' }) });
      await settlement.handlePaygOverageInvoiceVoided({ ...invoiceEvent(o, 'in_old_voided'), status: 'void' });
      expect((await record(o.email)).status).toBe('pending');
      await settlement.handlePaygOverageInvoiceVoided(invoiceEvent(o, 'in_old_other_key')); // metadata key is not the record's
      expect((await record(o.email)).status).toBe('pending');
    });

    // MINOR 4 — against the REAL payment-history table
    it('two partial refunds ($12, then $8 more; Stripe reports 1200 then 2000) — history rows sum to the real $20; redeliveries add none', async () => {
      const actual = jest.requireActual('../services/paymentHistoryDb').paymentHistoryDb;
      mocks.paymentHistory.mockImplementation((r: Json, opts: Json) => actual.record(r, opts));
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_pr' }) });
      const id = `ch_pr_${o.userId}`;
      const first = { id: `re_a_${o.userId}`, amount: 1200, status: 'succeeded' };
      const second = { id: `re_b_${o.userId}`, amount: 800, status: 'succeeded' };
      mocks.stripe.listChargeRefunds.mockResolvedValue([first]);
      await settlement.handlePaygOverageChargeRefunded({ id, amount_refunded: 1200, refunded: false, currency: 'usd' }, invoiceEvent(o, 'in_pr'));
      await settlement.handlePaygOverageChargeRefunded({ id, amount_refunded: 1200, refunded: false, currency: 'usd' }, invoiceEvent(o, 'in_pr'));
      mocks.stripe.listChargeRefunds.mockResolvedValue([second, first]);
      await Promise.all([
        settlement.handlePaygOverageChargeRefunded({ id, amount_refunded: 2000, refunded: false, currency: 'usd' }, invoiceEvent(o, 'in_pr')),
        settlement.handlePaygOverageChargeRefunded({ id, amount_refunded: 2000, refunded: false, currency: 'usd' }, invoiceEvent(o, 'in_pr')),
      ]);
      // The first event, delivered late, never lowers the cumulative figure (`#refunded < :refunded`).
      await settlement.handlePaygOverageChargeRefunded({ id, amount_refunded: 1200, refunded: false, currency: 'usd' }, invoiceEvent(o, 'in_pr'));
      const rows = (await ddb.query({ TableName: PAYMENT_HISTORY, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': o.userId } }).promise()).Items
        .filter((r: Json) => r.eventType === 'refund');
      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum: number, r: Json) => sum + r.amount, 0)).toBe(2000);
      expect((await record(o.email)).refundedCents).toBe(2000);
    });

    // NIT — emails when a webhook beats the run's `invoiced` write
    it('payment_failed lands before the run\'s invoiced write: the owner never gets "will charge your card" after "payment failed"', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
        await input.recordInvoiceId('in_pf');
        await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_pf'));
        return { outcome: 'issued', invoice: { id: 'in_pf', status: 'open', hosted_invoice_url: 'https://invoice.example/in_pf' } };
      });
      await settlement.settlePaygOverageMonth(o.userId, M, DAY2);
      expect(mocks.email.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledTimes(1);
      expect(mocks.email.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
    });

    it('invoice voided before the run\'s invoiced write: no invoice email for a written-off month', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
        await input.recordInvoiceId('in_vv');
        await settlement.handlePaygOverageInvoiceVoided(invoiceEvent(o, 'in_vv'));
        return { outcome: 'issued', invoice: { id: 'in_vv', status: 'open', hosted_invoice_url: 'https://invoice.example/in_vv' } };
      });
      await settlement.settlePaygOverageMonth(o.userId, M, DAY2);
      expect(await record(o.email)).toMatchObject({ status: 'written_off' });
      expect(mocks.email.sendPaygOverageInvoiceEmail).not.toHaveBeenCalled();
    });

    it('invoice email claim (`#status = :status` on the nested record): the paid webhook first sends the paid wording, once', async () => {
      const o = await owner();
      mocks.stripe.issuePaygOverageInvoice.mockImplementation(async (input: Json) => {
        await input.recordInvoiceId('in_pp');
        await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_pp'));
        return { outcome: 'issued', invoice: { id: 'in_pp', status: 'open', hosted_invoice_url: 'https://invoice.example/in_pp' } };
      });
      expect(await settlement.settlePaygOverageMonth(o.userId, M, DAY2)).toBe('raced');
      expect(mocks.email.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
      expect(mocks.email.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ paid: true }));
    });

    // MINOR 6
    it('durable alerts: the hold and `alertPending` land in one write; a sweep that died before alerting is caught up by the next, then cleared', async () => {
      const FM = '2031-05';
      const o = await owner({}, {
        poolHighWater: { month: '2031-06', thresholdMicroUsd: 100 * USD }, poolHighWaterClosed: { month: FM, thresholdMicroUsd: 100 * USD },
        admittedMonths: [admitted(FM)],
      });
      spend(130, 100, FM); // $30 drift: held
      const now = new Date('2031-06-02T12:00:00.000Z');
      await expect(settlement.settlePaygOverageMonth(o.userId, FM, now, async () => { throw new Error('process died'); })).rejects.toThrow('process died');
      expect(await record(o.email, FM)).toMatchObject({ status: 'held', alertPending: expect.any(String) });
      mocks.email.sendOncallAlert.mockClear();
      await settlement.runPaygSettlement(now);
      const alerted = mocks.email.sendOncallAlert.mock.calls.filter(([, body]: [string, string]) => String(body).includes(o.userId));
      expect(alerted).toHaveLength(1);
      expect(await record(o.email, FM)).not.toHaveProperty('alertPending');
      mocks.email.sendOncallAlert.mockClear();
      await settlement.runPaygSettlement(now);
      expect(mocks.email.sendOncallAlert.mock.calls.filter(([, body]: [string, string]) => String(body).includes(o.userId))).toHaveLength(0);
    });

    // ── rv6 review round ────────────────────────────────────────────────────────────────────────────
    // MAJOR 1: the won-dispute lift hands the hold to a failed month only while THAT month is still failed.
    it.each([
      ['paid', (o: { userId: string }) => settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_f', AUG)), 'paid'],
      ['voided', (o: { userId: string }) => settlement.handlePaygOverageInvoiceVoided(invoiceEvent(o, 'in_f', AUG)), 'written_off'],
    ] as const)('rv6 MAJOR 1: the won-lift read a failed month that is %s before the lift writes — PAYG ends unsuspended, never held for a settled month', async (_what, settleIt, statusAfter) => {
      const o = await withMonths({ [M]: settle('paid', { invoiceId: 'in_w' }), [AUG]: settle('invoiced', { invoiceId: 'in_f' }) });
      await settlement.handlePaygOverageInvoicePaymentFailed(invoiceEvent(o, 'in_f', AUG));
      await settlement.handlePaygOverageChargeDisputed({ id: 'dp_w' }, { id: 'ch_w' }, invoiceEvent(o, 'in_w'));
      expect((await row(o.email)).paygOverage.suspended).toMatchObject({ reason: 'dispute', disputeId: 'dp_w' });
      // closed: read 1 = loadSettlementFor, 2 = recording it closed, 3 = the lift's read; AUG settles right after 3.
      afterNthConsistentRead(3, () => settleIt(o));
      await settlement.handlePaygOverageChargeDisputeClosed({ id: 'dp_w', status: 'won' }, { id: 'ch_w' }, invoiceEvent(o, 'in_w'));
      const after = await row(o.email);
      expect(after.paygSettlements[AUG].status).toBe(statusAfter);
      expect(after.paygOverage).not.toHaveProperty('suspended');
    });

    // MINOR 1: the key is the same for every record of the month; the record's createdAt is not.
    it('rv6 MINOR 1: retry re-created the month (pending, no invoice yet): a late payment_failed for the OLD invoice (payload `open`, same key) does not fail the new record', async () => {
      const o = await owner();
      const realKey = `payg:${o.userId}:${M}`;
      await patch(o.email, 'SET #s = :s', { '#s': 'paygSettlements' }, { ':s': { [M]: settle('pending', { idempotencyKey: realKey, createdAt: '2026-10-05T00:00:00.000Z' }) } });
      const old = invoiceEvent(o, 'in_old');
      await settlement.handlePaygOverageInvoicePaymentFailed({ ...old, status: 'open', metadata: { ...old.metadata, recordCreatedAt: DAY2.toISOString() } });
      await settlement.handlePaygOverageInvoicePaymentFailed({ ...old, status: 'open' });
      const rec = await record(o.email);
      expect(rec.status).toBe('pending');
      expect(rec.invoiceId).toBeUndefined();
      expect((await row(o.email)).paygOverage.suspended).toBeUndefined();
      // The record's own invoice is still recognised.
      await settlement.handlePaygOverageInvoicePaymentFailed({ ...invoiceEvent(o, 'in_new'), status: 'open', metadata: { ...old.metadata, recordCreatedAt: '2026-10-05T00:00:00.000Z' } });
      expect(await record(o.email)).toMatchObject({ status: 'failed', invoiceId: 'in_new' });
    });

    // rv7 MINOR: the expiry settles an invoice Stripe already voided / paid the way their webhooks would.
    it.each([
      ['void', 'written_off'],
      ['paid', 'paid'],
    ] as const)('rv7: overdue unconfirmed month whose invoice is already %s in Stripe -> %s, never held or emailed "confirm"', async (stripeStatus, statusAfter) => {
      const FM = stripeStatus === 'void' ? '2031-09' : '2031-10';
      const o = await owner({
        paygSettlements: { [FM]: settle('invoiced', { invoiceId: `in_${stripeStatus}`, actionRequiredAt: '2031-01-01T00:00:00.000Z' }) },
      }, { admittedMonths: [] });
      mocks.stripe.retrievePaygOverageInvoice.mockImplementation(async (id: string) => ({ ...invoiceEvent(o, id, FM), status: stripeStatus }));
      await settlement.runPaygSettlement(new Date('2031-11-02T12:00:00.000Z'));
      const after = await row(o.email);
      expect(after.paygSettlements[FM].status).toBe(statusAfter);
      expect(after.paygOverage).not.toHaveProperty('suspended');
      expect(mocks.email.sendPaygOveragePaymentUnconfirmedEmail.mock.calls.filter(([input]: [Json]) => input.to === o.email)).toHaveLength(0);
    });

    // MINOR 5: the grace-period stamp (nested `IN` + `attribute_not_exists`) and the expiry's writes.
    it('rv6 MINOR 5: action required stamps `actionRequiredAt` once; 7 days on, the sweep fails the month, holds PAYG (unconfirmed) and emails once', async () => {
      const FM = '2031-07';
      const o = await owner({
        paygSettlements: { [FM]: settle('invoiced', { invoiceId: 'in_unc', hostedInvoiceUrl: 'https://invoice.example/in_unc' }) },
      }, { admittedMonths: [] });
      mocks.stripe.paygOverageInvoicePaymentState.mockResolvedValue('action_required');
      mocks.stripe.retrievePaygOverageInvoice.mockImplementation(async (id: string) => ({ ...invoiceEvent(o, id, FM), status: 'open' }));
      await settlement.handlePaygOverageInvoicePaymentActionRequired(invoiceEvent(o, 'in_unc', FM));
      const first = (await record(o.email, FM)).actionRequiredAt;
      expect(first).toEqual(expect.any(String));
      await settlement.handlePaygOverageInvoicePaymentFailed({ ...invoiceEvent(o, 'in_unc', FM), status: 'open' });
      expect((await record(o.email, FM)).actionRequiredAt).toBe(first);
      const since = Date.parse(first);
      await settlement.runPaygSettlement(new Date(since + 6 * 24 * 60 * 60 * 1000));
      expect((await record(o.email, FM)).status).toBe('invoiced');
      const due = new Date(since + 7 * 24 * 60 * 60 * 1000);
      await settlement.runPaygSettlement(due);
      await settlement.runPaygSettlement(due); // a second sweep the same day changes nothing
      const after = await row(o.email);
      expect(after.paygSettlements[FM]).toMatchObject({ status: 'failed', paymentUnconfirmedAt: due.toISOString() });
      expect(after.paygOverage.suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_unc', unconfirmed: true });
      // (The sweep scans the whole table: count only this owner's email.)
      expect(mocks.email.sendPaygOveragePaymentUnconfirmedEmail.mock.calls.filter(([input]: [Json]) => input.to === o.email)).toHaveLength(1);
      await settlement.handlePaygOverageInvoicePaid(invoiceEvent(o, 'in_unc', FM));
      expect((await row(o.email)).paygOverage).not.toHaveProperty('suspended');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  // 5. The unit suites' in-memory fake vs DynamoDB, on the expression forms the PAYG code emits
  // ════════════════════════════════════════════════════════════════════════════════════════════════════
  describe('helpers/userRowFake fidelity', () => {
    let fake: typeof import('./helpers/userRowFake');
    const probeRow = {
      email: 'probe@example.com', userId: 'probe',
      paygOverage: {
        enabled: true,
        suspended: { reason: 'payment_failed', at: '2026-10-05T00:00:00.000Z', invoiceId: 'in_1' },
        admittedMonths: [
          { month: '2026-10', capHighWaterMicroUsd: 50, tierPoolHighWaterMicroUsd: 100, markupBps: 15_000, spendBasis: 'spend_ledger' },
          { month: '2026-09', capHighWaterMicroUsd: 25, tierPoolHighWaterMicroUsd: 80, markupBps: null, spendBasis: 'legacy' },
        ],
      },
      paygSettlements: { '2026-09': { status: 'failed', invoiceId: 'in_1' } },
    };
    beforeAll(async () => {
      fake = require('./helpers/userRowFake');
      await put(probeRow);
    });
    /** Whether DynamoDB holds `expression` on the probe row: a harmless conditional SET succeeds or is refused. */
    const real = async (expression: string, allNames: Record<string, string>, allValues?: Record<string, unknown>) => {
      // DynamoDB refuses unused placeholders: pass only the ones this expression uses.
      const used = <T>(map: Record<string, T>) =>
        Object.fromEntries(Object.entries(map).filter(([key]) => new RegExp(`${key}(?![A-Za-z0-9_])`).test(expression)));
      const names = used(allNames);
      const values = used(allValues ?? {});
      try {
        await ddb.update({
          TableName: USERS, Key: { email: probeRow.email }, UpdateExpression: 'SET #probeHits = :one', ConditionExpression: expression,
          ExpressionAttributeNames: { '#probeHits': 'probeHits', ...names }, ExpressionAttributeValues: { ':one': 1, ...(values ?? {}) },
        }).promise();
        return true;
      } catch (error: unknown) {
        if ((error as { code?: string }).code === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    };
    const both = async (expression: string, names: Record<string, string>, values?: Record<string, unknown>) => ({
      real: await real(expression, names, values),
      fake: fake.evaluateCondition(expression, probeRow, names, values ?? {}),
    });
    const N = { '#payg': 'paygOverage', '#suspended': 'suspended', '#admitted': 'admittedMonths', '#reason': 'reason', '#hw': 'poolHighWater', '#month': 'month' };

    it('map equality ignores key order; list equality is order- and member-exact (a NULL member included) — fake agrees', async () => {
      const [october, september] = probeRow.paygOverage.admittedMonths;
      const reorder = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).reverse());
      expect(await both('#payg.#suspended = :seen', N, { ':seen': reorder(probeRow.paygOverage.suspended) })).toEqual({ real: true, fake: true });
      expect(await both('#payg.#suspended = :seen', N, { ':seen': { reason: 'payment_failed', invoiceId: 'in_1' } })).toEqual({ real: false, fake: false });
      expect(await both('#payg.#admitted = :expected', N, { ':expected': [reorder(october), reorder(september)] })).toEqual({ real: true, fake: true });
      expect(await both('#payg.#admitted = :expected', N, { ':expected': [september, october] })).toEqual({ real: false, fake: false });
      const { markupBps: _dropped, ...withoutNull } = september;
      expect(await both('#payg.#admitted = :expected', N, { ':expected': [october, withoutNull] })).toEqual({ real: false, fake: false });
    });

    it('`IN` with a single value, and `=` across types — fake agrees', async () => {
      const S = { '#s': 'paygSettlements', '#m': '2026-09', '#st': 'status' };
      expect(await both('#s.#m.#st IN (:a)', S, { ':a': 'failed' })).toEqual({ real: true, fake: true });
      expect(await both('#s.#m.#st IN (:a, :b)', S, { ':a': 'pending', ':b': 'invoiced' })).toEqual({ real: false, fake: false });
      expect(await both('#payg.#enabled = :t', { ...N, '#enabled': 'enabled' }, { ':t': 'true' })).toEqual({ real: false, fake: false });
    });

    it('FINDING: `<>` on a MISSING attribute is TRUE in DynamoDB but false in the fake', async () => {
      // Every PAYG condition guards `<>` with attribute_not_exists(...) OR, so production writes behave the
      // same either way on well-formed rows; a malformed one (a mark with no month, a suspension with no
      // reason) is where the fake would mislead a unit test.
      expect(await both('#payg.#hw.#month <> :m', N, { ':m': '2026-10' })).toEqual({ real: true, fake: false });
      expect(await both('#payg.#suspended.#nope <> :d', { ...N, '#nope': 'nope' }, { ':d': 'dispute' })).toEqual({ real: true, fake: false });
      // `=`, `<`, `<=` on a missing attribute are false in both.
      expect(await both('#payg.#hw.#month = :m', N, { ':m': '2026-10' })).toEqual({ real: false, fake: false });
      expect(await both('#payg.#hw.#t <= :t', { ...N, '#t': 't' }, { ':t': 5 })).toEqual({ real: false, fake: false });
    });

    it('FINDING: REMOVE below a missing parent is a ValidationException in DynamoDB; the fake silently does nothing', async () => {
      const removeBelowMissing = { pathRemoves: [{ path: ['paygOverage', 'poolHighWater', 'month'] }] };
      await expect(userDb.updateUser('probe', {}, removeBelowMissing)).rejects.toMatchObject({ code: 'ValidationException' });
      const store = fake.createUserRowFake(probeRow);
      await expect(store.updateUser('probe', {}, removeBelowMissing)).resolves.toBeDefined();
      // SET below a missing parent: both refuse (ValidationException); a false condition is reported first by both.
      const setBelowMissing = { pathSets: [{ path: ['paygOverage', 'poolHighWater', 'month'], value: 'x' }] };
      await expect(userDb.updateUser('probe', {}, setBelowMissing)).rejects.toMatchObject({ code: 'ValidationException' });
      await expect(store.updateUser('probe', {}, setBelowMissing)).rejects.toMatchObject({ code: 'ValidationException' });
      const refused = { ...setBelowMissing, condition: { expression: 'attribute_exists(#hw)', names: { '#hw': 'nope' } } };
      await expect(userDb.updateUser('probe', {}, refused)).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
      await expect(store.updateUser('probe', {}, refused)).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    });

    it('FINDING: DynamoDB rejects unused expression names/values and overlapping paths; the fake accepts all three', async () => {
      const store = fake.createUserRowFake(probeRow);
      const cases: UpdateUserOptions[] = [
        { pathSets: [{ path: ['probeA'], value: 1 }], condition: { expression: 'attribute_exists(#payg)', names: { '#payg': 'paygOverage', '#unused': 'x' } } },
        { pathSets: [{ path: ['probeA'], value: 1 }], condition: { expression: 'attribute_exists(#payg)', names: { '#payg': 'paygOverage' }, values: { ':unused': 1 } } },
        { pathSets: [{ path: ['paygOverage', 'enabled'], value: false }], pathRemoves: [{ path: ['paygOverage', 'enabled'] }] },
      ];
      for (const options of cases) {
        await expect(userDb.updateUser('probe', {}, options)).rejects.toMatchObject({ code: 'ValidationException' });
        await expect(store.updateUser('probe', {}, options)).resolves.toBeDefined();
      }
    });
  });
});
