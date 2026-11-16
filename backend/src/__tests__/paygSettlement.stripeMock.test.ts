/**
 * ENG-668 PR-2 — every Stripe call pay-as-you-go settlement makes, against Stripe's own `stripe-mock`.
 *
 * Opt-in: runs only when STRIPE_API_BASE points at a stripe-mock whose bundled OpenAPI spec matches the
 * pinned API version (`STRIPE_API_VERSION`, 2025-05-28.basil, is exactly what stripe-mock v0.195.0 bundles):
 *   docker run -d --rm --name smock -p 127.0.0.1:12111:12111 stripe/stripe-mock:v0.195.0
 *   STRIPE_API_BASE=http://127.0.0.1:12111 npx jest src/__tests__/paygSettlement.stripeMock.test.ts
 *   docker stop smock
 * Otherwise the suite is skipped, so CI never needs it. No Stripe account, key or network: the key is a
 * dummy and `createStripeClient` refuses STRIPE_API_BASE under NODE_ENV=production.
 *
 * Real here: the `stripe` SDK (18.x, its request encoding, retries, webhook signature check) and every
 * Stripe-calling path in stripeService / paygSettlementService / the webhook controller that the PR adds
 * or changes. Every request goes through a recording proxy to stripe-mock, which validates it against
 * Stripe's OpenAPI definition for this version (an unknown parameter or a wrong type is a 400) and answers
 * with Stripe's fixture objects. Shape assertions read the RAW stripe-mock answer.
 *
 * What it proves: each request the code sends is one Stripe accepts (path, method, params, expansions,
 * idempotency keys, API version), and every field the code reads exists, with that type, in this API
 * version's objects. What it cannot prove: Stripe's BEHAVIOUR. stripe-mock is stateless — a created
 * invoice has the fixture's one line and total 1000, metadata is not echoed back, search does not
 * filter, a deleted draft still retrieves, idempotency keys are not replayed, discounts never apply, and
 * no webhook is ever sent. Where a branch depends on state, the proxy applies a small, named `steer` to
 * the answer AFTER stripe-mock validated the request (e.g. "a fresh draft has no lines", "search found
 * two live invoices"); steers only set values on fields the raw answer already has, or repeat an element
 * of a list it returned. `failWith` answers a validated request with a Stripe error instead (a lookup
 * outage). Behaviour across calls (search-before-create, key replay, races) is the unit suite's
 * (paygSettlementService.test.ts) and the DynamoDB Local suite's (paygOverage.dynamodbLocal.test.ts).
 *
 * Mocked: DynamoDB (an evaluated row fake), payment history, email, the CRM mirror, the settlement switch.
 */
jest.unmock('stripe');

import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

const UPSTREAM = process.env.STRIPE_API_BASE;
const suite = UPSTREAM ? describe : describe.skip;

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
  getTierConfig: jest.fn(() => undefined),
  DEFAULT_PAGES: [],
}));
jest.mock('../services/spendProjectionDb', () => ({ getProjection: jest.fn() }));
jest.mock('../services/paygOverageService', () => ({ paygSettlementSwitch: { isEnabled: jest.fn(async () => true) } }));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { record: jest.fn(async () => ({ written: true })) } }));
jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn(async () => undefined),
    sendPaygOverageInvoiceEmail: jest.fn(async () => 'sent'),
    sendPaygOveragePaymentFailedEmail: jest.fn(async () => 'sent'),
    sendPaygOveragePaymentActionRequiredEmail: jest.fn(async () => 'sent'),
  },
}));
jest.mock('../services/crmAutoSyncService', () => ({ syncUserUpdateToLeadList: jest.fn() }));
// The webhook controller's CRM mirror (fire-and-forget): observed, never run.
jest.mock('../services/crmSignalHooks', () => ({ onStripeSubscriptionEvent: jest.fn(async () => undefined) }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stripe_mock_suite';

import { userDb } from '../services/db';
import { paymentHistoryDb } from '../services/paymentHistoryDb';
import { emailService } from '../services/emailService';
import { onStripeSubscriptionEvent } from '../services/crmSignalHooks';
import { createStripeClient, STRIPE_API_VERSION } from '../services/stripeClientFactory';
import { handleWebhook } from '../controllers/stripeController';
import {
  handleChargeDisputeClosed,
  handleChargeDisputeCreated,
  handleChargeRefunded,
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  resyncAllSubscriptionAmounts,
  stripeService,
  PAYG_OVERAGE_PURCHASE_TYPE,
} from '../services/stripeService';
import { settlePaygOverageMonth } from '../services/paygSettlementService';
import { paygOpenInvoiceUrl } from '../services/paygSettlement';
import { createUserRowFake } from './helpers/userRowFake';

// ── recording proxy in front of stripe-mock ──────────────────────────────────────────────────────────
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Rec {
  method: string;
  path: string;
  query: URLSearchParams;
  body: URLSearchParams;
  idempotencyKey?: string;
  stripeVersion?: string;
  status: number;
  /** stripe-mock's answer, untouched. */
  raw: Json;
}
type Steer = (rec: Omit<Rec, 'raw'>, json: Json) => Json | void;
/** Replaces stripe-mock's (validated) answer with an error response; undefined passes it through. */
type Failure = (rec: Omit<Rec, 'raw'>) => { status: number; body: Json } | undefined;

let server: http.Server;
let recs: Rec[] = [];
let steers: Steer[] = [];
let failures: Failure[] = [];
/** Every request of the run; written to STRIPE_MOCK_REQUEST_LOG (if set) for the report. */
const allRecs: Array<{ test: string; method: string; path: string; params: Record<string, string>; idempotencyKey?: string; status: number }> = [];

function startProxy(upstream: URL): Promise<string> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const up = http.request(
        { host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host } },
        (upRes) => {
          const out: Buffer[] = [];
          upRes.on('data', (c) => out.push(c));
          upRes.on('end', () => {
            const text = Buffer.concat(out).toString('utf8');
            const url = new URL(req.url || '/', 'http://x');
            const base: Omit<Rec, 'raw'> = {
              method: req.method || '',
              path: url.pathname,
              query: url.searchParams,
              body: new URLSearchParams(bodyText),
              idempotencyKey: req.headers['idempotency-key'] as string | undefined,
              stripeVersion: req.headers['stripe-version'] as string | undefined,
              status: upRes.statusCode || 0,
            };
            let json: Json;
            try { json = JSON.parse(text); } catch { json = text; }
            recs.push({ ...base, raw: JSON.parse(JSON.stringify(json)) });
            allRecs.push({
              test: expect.getState().currentTestName || '', method: base.method, path: base.path,
              params: { ...Object.fromEntries(base.query.entries()), ...Object.fromEntries(base.body.entries()) },
              idempotencyKey: base.idempotencyKey, status: base.status,
            });
            if (base.status < 300) for (const steer of steers) json = steer(base, json) ?? json;
            const failed = base.status < 300 ? failures.map((f) => f(base)).find(Boolean) : undefined;
            if (failed) json = failed.body;
            const payload = typeof json === 'string' ? json : JSON.stringify(json);
            const headers: http.OutgoingHttpHeaders = { ...upRes.headers, 'content-length': String(Buffer.byteLength(payload)) };
            delete headers['transfer-encoding'];
            // A forced failure is final: the SDK honours Stripe-Should-Retry, so it does not back off and retry.
            if (failed) headers['stripe-should-retry'] = 'false';
            res.writeHead(failed ? failed.status : upRes.statusCode || 500, headers);
            res.end(payload);
          });
        },
      );
      up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
      up.end(bodyText);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const calls = (method: string, path: RegExp) => recs.filter((r) => r.method === method && path.test(r.path));
const one = (method: string, path: RegExp): Rec => {
  const found = calls(method, path);
  expect(found).toHaveLength(1);
  return found[0];
};
/** Form/query params as a plain object, SDK bracket notation kept (`metadata[month]`, `expand[0]`). */
const params = (p: URLSearchParams) => Object.fromEntries([...p.entries()]);

// Steers: applied to stripe-mock's answer only after it validated the request.
const onPath = (method: string, path: RegExp, fn: (json: Json, rec: Omit<Rec, 'raw'>) => void): Steer =>
  (rec, json) => { if (rec.method === method && path.test(rec.path)) fn(json, rec); return json; };
const formMetadata = (body: URLSearchParams) => Object.fromEntries(
  [...body.entries()].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]),
);
/** Stripe keeps the metadata an invoice was created with; stripe-mock does not echo objects. */
const steerCreatedInvoiceIsFreshDraft = onPath('POST', /^\/v1\/invoices$/, (json, rec) => {
  json.metadata = formMetadata(rec.body);
  json.lines.data = [];
  json.total = 0;
});
/** After our one item, Stripe's draft total is the item amount (or `total` when a discount applies). */
const steerDraftTotal = (total: number, metadata?: Record<string, string>) =>
  onPath('GET', /^\/v1\/invoices\/in_[^/]+$/, (json) => { json.total = total; if (metadata) json.metadata = metadata; });
const steerFinalized = (metadata: Record<string, string>) =>
  onPath('POST', /^\/v1\/invoices\/[^/]+\/finalize$/, (json) => { json.status = 'open'; json.metadata = metadata; });
/** Search found exactly these invoices: each is stripe-mock's own search hit with the given fields set. */
const steerSearchFinds = (...found: Array<Record<string, unknown>>) =>
  onPath('GET', /^\/v1\/invoices\/search$/, (json) => {
    expect(json.data.length).toBeGreaterThan(0);
    const hit = json.data[0];
    json.data = found.map((fields) => ({ ...JSON.parse(JSON.stringify(hit)), metadata: { ...META }, ...fields }));
  });
/** A Stripe API error (what an outage looks like to the SDK) for a request stripe-mock accepted. */
const failWith = (method: string, path: RegExp, status = 500): Failure => (rec) =>
  (rec.method === method && path.test(rec.path)
    ? { status, body: { error: { type: 'api_error', message: 'stripe-mock suite: forced failure' } } }
    : undefined);
const nowSeconds = () => Math.floor(Date.now() / 1000);

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const OWNER = 'owner-1';
const M = '2026-09';
const KEY = `payg:${OWNER}:${M}`;
const AMOUNT = 2345;
const META = { purchaseType: PAYG_OVERAGE_PURCHASE_TYPE, billingUserId: OWNER, month: M, idempotencyKey: KEY, recordCreatedAt: '2026-10-02T12:00:00.000Z' } as const;
const QUERY = `metadata['purchaseType']:'payg_overage' AND metadata['billingUserId']:'${OWNER}' AND metadata['month']:'${M}'`;

const issueInput = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: `${KEY}:2026-10-02T12:00:00.000Z`,
  customerId: 'cus_card',
  fallbackPaymentMethodId: 'pm_card',
  amountCents: AMOUNT,
  description: 'AgentWeb pay-as-you-go usage, September 2026',
  lineDescription: 'Pay-as-you-go usage over your plan, September 2026',
  metadata: { ...META },
  invoiceId: null,
  recordInvoiceId: jest.fn(async () => undefined),
  ...over,
});

const settlementRecord = (over: Record<string, unknown> = {}) => ({
  status: 'pending',
  idempotencyKey: KEY,
  overageCostMicroUsd: 15_630_000,
  billedMicroUsd: 23_450_000,
  amountCents: AMOUNT,
  markupBps: 15_000,
  percentOfCap: 47,
  settledMicroUsd: 115_630_000,
  projectedMicroUsd: 115_630_000,
  createdAt: '2026-10-02T12:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
  ...over,
});
const ownerRow = (record: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  userId: OWNER,
  email: 'owner@example.com',
  stripe_customer_id: 'cus_row',
  subscription_status: 'active',
  subscription_amount: 4900,
  paygOverage: { enabled: true, capPercentOfPool: 50, admittedMonths: [], updatedBy: OWNER, updatedAt: '2026-08-01T00:00:00.000Z', version: 3 },
  paygSettlements: { [M]: record },
  ...over,
});
let store: ReturnType<typeof createUserRowFake>;
function useRow(row: Record<string, unknown>) {
  store = createUserRowFake(row);
  (userDb.getUserByIdConsistent as jest.Mock).mockImplementation(store.read);
  (userDb.getUserById as jest.Mock).mockImplementation(store.read);
  (userDb.updateUser as jest.Mock).mockImplementation(store.updateUser);
}

/** Field present (possibly null) with one of the given JS types. */
function expectField(obj: Json, path: string, ...types: Array<'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'>) {
  const segs = path.split('.');
  let node: Json = obj;
  for (const seg of segs.slice(0, -1)) node = node?.[seg];
  const last = segs[segs.length - 1];
  expect(node && typeof node === 'object' && last in node).toBe(true);
  const v = node[last];
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (!types.includes(t as never)) throw new Error(`${path}: expected ${types.join('|')}, got ${t}`);
}

suite('PAYG settlement Stripe calls against stripe-mock (API ' + STRIPE_API_VERSION + ')', () => {
  beforeAll(async () => {
    const proxy = await startProxy(new URL(UPSTREAM!));
    process.env.STRIPE_API_BASE = proxy; // read once, when stripeService first builds its client
  });
  afterAll(async () => {
    process.env.STRIPE_API_BASE = UPSTREAM;
    await new Promise((r) => server.close(r));
    if (process.env.STRIPE_MOCK_REQUEST_LOG) {
      fs.writeFileSync(process.env.STRIPE_MOCK_REQUEST_LOG, JSON.stringify(allRecs, null, 1));
    }
  });
  beforeEach(() => {
    recs = [];
    steers = [];
    failures = [];
    jest.clearAllMocks();
  });
  afterEach(() => {
    // Every request any test made was accepted by stripe-mock's validator.
    const rejected = recs.filter((r) => r.status >= 400).map((r) => `${r.method} ${r.path} -> ${r.status} ${JSON.stringify(r.raw?.error?.message)}`);
    expect(rejected).toEqual([]);
  });

  describe('harness', () => {
    it('stripe-mock rejects an unknown parameter (the validator is live) and the SDK sends the pinned version', async () => {
      const client = createStripeClient('sk_test_123');
      await expect(client.invoices.create({ customer: 'cus_1', not_a_param: 1 } as never)).rejects.toThrow(/additional properties/);
      const rec = one('POST', /^\/v1\/invoices$/);
      expect(rec.status).toBe(400);
      expect(rec.stripeVersion).toBe('2025-05-28.basil');
      recs = []; // expected rejection
    });
  });

  // ── 1. issuePaygOverageInvoice ───────────────────────────────────────────────────────────────────
  describe('stripeService.issuePaygOverageInvoice', () => {
    it('new month: search -> create draft -> add item -> retrieve -> finalize, every request accepted as sent', async () => {
      steers = [steerCreatedInvoiceIsFreshDraft, steerDraftTotal(AMOUNT, { ...META }), steerFinalized({ ...META })];
      const input = issueInput();
      const result = await stripeService.issuePaygOverageInvoice(input);

      expect(recs.map((r) => `${r.method} ${r.path.replace(/in_[A-Za-z0-9]+/, ':id')}`)).toEqual([
        'GET /v1/invoices/search',
        'POST /v1/invoices',
        'POST /v1/invoiceitems',
        'GET /v1/invoices/:id',
        'POST /v1/invoices/:id/finalize',
      ]);
      for (const r of recs) expect(r.stripeVersion).toBe('2025-05-28.basil');

      const search = one('GET', /^\/v1\/invoices\/search$/);
      expect(params(search.query)).toEqual({ query: QUERY, limit: '10' });
      expect(search.raw.object).toBe('search_result');
      expectField(search.raw, 'data', 'array');
      for (const inv of search.raw.data) {
        expectField(inv, 'metadata', 'object', 'null');
        expectField(inv, 'status', 'string', 'null');
        expectField(inv, 'id', 'string');
      }

      const create = one('POST', /^\/v1\/invoices$/);
      expect(params(create.body)).toEqual({
        customer: 'cus_card',
        collection_method: 'charge_automatically',
        auto_advance: 'false',
        pending_invoice_items_behavior: 'exclude',
        currency: 'usd',
        description: input.description,
        'metadata[purchaseType]': 'payg_overage',
        'metadata[billingUserId]': OWNER,
        'metadata[month]': M,
        'metadata[idempotencyKey]': KEY,
        'metadata[recordCreatedAt]': META.recordCreatedAt,
        default_payment_method: 'pm_card',
      });
      expect(create.idempotencyKey).toBe(`${input.idempotencyKey}:invoice`);
      const created = create.raw;
      expectField(created, 'id', 'string');
      expectField(created, 'status', 'string');
      expectField(created, 'total', 'number');
      expectField(created, 'customer', 'string');
      expectField(created, 'lines.data', 'array');
      expectField(created, 'metadata', 'object');
      expectField(created, 'hosted_invoice_url', 'string', 'null');
      expect(created.object).toBe('invoice');
      expect(input.recordInvoiceId).toHaveBeenCalledWith(created.id);

      const item = one('POST', /^\/v1\/invoiceitems$/);
      expect(params(item.body)).toEqual({
        customer: created.customer, // read off the created invoice
        invoice: created.id,
        amount: String(AMOUNT),
        currency: 'usd',
        description: input.lineDescription,
        'metadata[purchaseType]': 'payg_overage',
        'metadata[billingUserId]': OWNER,
        'metadata[month]': M,
        'metadata[idempotencyKey]': KEY,
        'metadata[recordCreatedAt]': META.recordCreatedAt,
      });
      expect(item.idempotencyKey).toBe(`${input.idempotencyKey}:item`);
      expect(item.raw).toMatchObject({ object: 'invoiceitem', invoice: created.id, amount: AMOUNT, currency: 'usd' });

      const retrieve = one('GET', /^\/v1\/invoices\/in_[^/]+$/);
      expect(retrieve.path).toBe(`/v1/invoices/${created.id}`);
      expect(params(retrieve.query)).toEqual({});
      expectField(retrieve.raw, 'total', 'number');
      expectField(retrieve.raw, 'status', 'string');

      const finalize = one('POST', /\/finalize$/);
      expect(finalize.path).toBe(`/v1/invoices/${created.id}/finalize`);
      expect(params(finalize.body)).toEqual({ auto_advance: 'true' });
      expect(finalize.idempotencyKey).toBe(`${input.idempotencyKey}:finalize`);
      expectField(finalize.raw, 'hosted_invoice_url', 'string', 'null');
      expectField(finalize.raw, 'id', 'string');

      expect(result.outcome).toBe('issued');
      if (result.outcome === 'issued') expect(result.invoice.id).toBe(finalize.raw.id);
    });

    it('a draft Stripe totals differently (discount) is deleted, never finalized; DELETE answers a deleted_invoice', async () => {
      steers = [steerCreatedInvoiceIsFreshDraft, steerDraftTotal(AMOUNT - 500)];
      const result = await stripeService.issuePaygOverageInvoice(issueInput());
      const del = one('DELETE', /^\/v1\/invoices\/in_[^/]+$/);
      expect(params(del.body)).toEqual({});
      expect(del.raw).toMatchObject({ object: 'invoice', deleted: true });
      expectField(del.raw, 'id', 'string');
      expect(calls('POST', /\/finalize$/)).toHaveLength(0);
      expect(result).toEqual({ outcome: 'mismatch', invoiceId: one('POST', /^\/v1\/invoices$/).raw.id, reason: 'draft_deleted' });
    });

    it('stripe-mock\'s own draft (1 line, total 1000) is not given a second item: retrieve skipped, total compared directly', async () => {
      const result = await stripeService.issuePaygOverageInvoice(issueInput({ amountCents: 1000 }));
      expect(calls('POST', /^\/v1\/invoiceitems$/)).toHaveLength(0);
      expect(one('POST', /^\/v1\/invoices$/).raw.lines.data.length).toBeGreaterThan(0);
      expect(result.outcome).toBe('issued');
    });

    it('no payment method id: the create carries no default_payment_method', async () => {
      steers = [steerCreatedInvoiceIsFreshDraft, steerDraftTotal(AMOUNT)];
      await stripeService.issuePaygOverageInvoice(issueInput({ fallbackPaymentMethodId: null }));
      expect(params(one('POST', /^\/v1\/invoices$/).body)).not.toHaveProperty('default_payment_method');
    });

    it('no customer and nothing found: searched, nothing created', async () => {
      const result = await stripeService.issuePaygOverageInvoice(issueInput({ customerId: null }));
      expect(result).toEqual({ outcome: 'no_customer' });
      expect(recs.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/invoices/search']);
    });

    it('search finds this month\'s open invoice: it is recorded and returned, nothing created', async () => {
      steers = [onPath('GET', /^\/v1\/invoices\/search$/, (json) => {
        expect(json.data.length).toBeGreaterThan(0);
        Object.assign(json.data[0], { metadata: { ...META }, status: 'open', total: AMOUNT });
      })];
      const input = issueInput();
      const result = await stripeService.issuePaygOverageInvoice(input);
      const found = one('GET', /^\/v1\/invoices\/search$/).raw.data[0];
      expect(input.recordInvoiceId).toHaveBeenCalledWith(found.id);
      expect(result).toMatchObject({ outcome: 'issued', invoice: { id: found.id } });
      expect(recs).toHaveLength(1);
    });

    it('a recorded invoice id is retrieved directly (no search); void -> mismatch', async () => {
      steers = [onPath('GET', /^\/v1\/invoices\/in_recorded$/, (json) => { json.status = 'void'; })];
      const result = await stripeService.issuePaygOverageInvoice(issueInput({ invoiceId: 'in_recorded' }));
      expect(recs.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/invoices/in_recorded']);
      expect(one('GET', /in_recorded/).raw.id).toBe('in_recorded');
      expect(result).toEqual({ outcome: 'mismatch', invoiceId: 'in_recorded', reason: 'void' });
    });

    it('a recorded open invoice at the expected total is issued as is', async () => {
      steers = [onPath('GET', /^\/v1\/invoices\/in_recorded$/, (json) => { json.status = 'open'; json.total = AMOUNT; })];
      const result = await stripeService.issuePaygOverageInvoice(issueInput({ invoiceId: 'in_recorded' }));
      expect(result).toMatchObject({ outcome: 'issued', invoice: { id: 'in_recorded' } });
    });

    it('search hits carry `created` and `lines.data`, the fields the orphan-draft test reads', async () => {
      await stripeService.issuePaygOverageInvoice(issueInput({ customerId: null }));
      const hits = one('GET', /^\/v1\/invoices\/search$/).raw.data;
      expect(hits.length).toBeGreaterThan(0);
      for (const inv of hits) {
        expectField(inv, 'created', 'number');
        expectField(inv, 'lines.data', 'array');
        expectField(inv, 'customer', 'string', 'object');
      }
    });

    it('an EMPTY draft over an hour old is an orphan: deleted (DELETE accepted), never adopted; a fresh invoice is issued', async () => {
      steers = [
        steerSearchFinds({ id: 'in_orphan', status: 'draft', lines: { object: 'list', data: [], has_more: false, url: '/v1/invoices/in_orphan/lines' }, created: nowSeconds() - 2 * 3600 }),
        steerCreatedInvoiceIsFreshDraft, steerDraftTotal(AMOUNT, { ...META }), steerFinalized({ ...META }),
      ];
      const input = issueInput();
      const result = await stripeService.issuePaygOverageInvoice(input);
      expect(recs.map((r) => `${r.method} ${r.path.replace(/in_(?!orphan)[A-Za-z0-9]+/, ':id')}`)).toEqual([
        'GET /v1/invoices/search',
        'DELETE /v1/invoices/in_orphan',
        'POST /v1/invoices',
        'POST /v1/invoiceitems',
        'GET /v1/invoices/:id',
        'POST /v1/invoices/:id/finalize',
      ]);
      const del = one('DELETE', /^\/v1\/invoices\/in_orphan$/);
      expect(params(del.body)).toEqual({});
      expect(del.raw).toMatchObject({ object: 'invoice', deleted: true, id: 'in_orphan' });
      const created = one('POST', /^\/v1\/invoices$/).raw;
      expect(input.recordInvoiceId).toHaveBeenCalledTimes(1);
      expect(input.recordInvoiceId).toHaveBeenCalledWith(created.id);
      expect(result.outcome).toBe('issued');
    });

    it('an empty draft under an hour old (a run still in flight) is adopted: recorded, given the item, finalized', async () => {
      steers = [
        steerSearchFinds({ id: 'in_recent', status: 'draft', lines: { object: 'list', data: [], has_more: false, url: '/v1/invoices/in_recent/lines' }, created: nowSeconds() - 60 }),
        steerDraftTotal(AMOUNT, { ...META }), steerFinalized({ ...META }),
      ];
      const input = issueInput();
      const result = await stripeService.issuePaygOverageInvoice(input);
      expect(recs.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /v1/invoices/search',
        'POST /v1/invoiceitems',
        'GET /v1/invoices/in_recent',
        'POST /v1/invoices/in_recent/finalize',
      ]);
      expect(input.recordInvoiceId).toHaveBeenCalledWith('in_recent');
      expect(one('POST', /^\/v1\/invoiceitems$/).body.get('invoice')).toBe('in_recent');
      expect(result.outcome).toBe('issued');
    });

    it('more than one live invoice for the month: nothing picked, created, deleted or recorded (`multiple`)', async () => {
      steers = [steerSearchFinds(
        { id: 'in_open', status: 'open', total: AMOUNT },
        { id: 'in_draft', status: 'draft', created: nowSeconds() - 2 * 3600 }, // has the fixture line: not empty, not an orphan
        { id: 'in_void', status: 'void' }, // collected nothing: ignored
      )];
      const input = issueInput();
      const result = await stripeService.issuePaygOverageInvoice(input);
      expect(one('GET', /^\/v1\/invoices\/search$/).raw.data[0].lines.data.length).toBeGreaterThan(0);
      expect(result).toEqual({ outcome: 'multiple', invoiceIds: ['in_open', 'in_draft'] });
      expect(recs.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/invoices/search']);
      expect(input.recordInvoiceId).not.toHaveBeenCalled();
    });

    it('an orphan next to one live invoice: the orphan is deleted and the live one adopted', async () => {
      steers = [steerSearchFinds(
        { id: 'in_orphan', status: 'draft', lines: { object: 'list', data: [], has_more: false, url: '/v1/invoices/in_orphan/lines' }, created: nowSeconds() - 2 * 3600 },
        { id: 'in_open', status: 'open', total: AMOUNT },
      )];
      const input = issueInput();
      const result = await stripeService.issuePaygOverageInvoice(input);
      expect(recs.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/invoices/search', 'DELETE /v1/invoices/in_orphan']);
      expect(input.recordInvoiceId).toHaveBeenCalledWith('in_open');
      expect(result).toMatchObject({ outcome: 'issued', invoice: { id: 'in_open' } });
    });
  });

  // ── 2. findPaygOverageInvoiceForCharge ───────────────────────────────────────────────────────────
  describe('stripeService.findPaygOverageInvoiceForCharge', () => {
    it('lists invoice payments by PaymentIntent (no `invoice` filter), expanded; data[].invoice is the invoice', async () => {
      const result = await stripeService.findPaygOverageInvoiceForCharge({ id: 'ch_1', payment_intent: 'pi_123' });
      const list = one('GET', /^\/v1\/invoice_payments$/);
      expect(params(list.query)).toEqual({
        'payment[type]': 'payment_intent',
        'payment[payment_intent]': 'pi_123',
        limit: '10',
        'expand[0]': 'data.invoice',
      });
      expect(list.raw.object).toBe('list');
      expect(list.raw.data.length).toBeGreaterThan(0);
      const payment = list.raw.data[0];
      expect(payment.object).toBe('invoice_payment');
      expectField(payment, 'invoice', 'object');
      expect(payment.invoice.object).toBe('invoice');
      expectField(payment.invoice, 'metadata', 'object', 'null');
      expectField(payment.invoice, 'id', 'string');
      expectField(payment, 'payment.type', 'string');
      // stripe-mock's fixture invoice carries no PAYG metadata: not ours.
      expect(result).toBeNull();
    });

    it('returns the expanded invoice when it is a PAYG overage invoice (PaymentIntent given as an object)', async () => {
      steers = [onPath('GET', /^\/v1\/invoice_payments$/, (json) => { json.data[0].invoice.metadata = { ...META }; })];
      const result = await stripeService.findPaygOverageInvoiceForCharge({ id: 'ch_1', payment_intent: { id: 'pi_obj' } });
      expect(one('GET', /^\/v1\/invoice_payments$/).query.get('payment[payment_intent]')).toBe('pi_obj');
      expect(result?.metadata).toEqual(META);
    });

    it('an unexpanded invoice id is followed with invoices.retrieve', async () => {
      steers = [
        onPath('GET', /^\/v1\/invoice_payments$/, (json) => { json.data[0].invoice = 'in_linked'; }),
        onPath('GET', /^\/v1\/invoices\/in_linked$/, (json) => { json.metadata = { ...META }; }),
      ];
      const result = await stripeService.findPaygOverageInvoiceForCharge({ payment_intent: 'pi_123' });
      expect(one('GET', /^\/v1\/invoices\/in_linked$/).raw.object).toBe('invoice');
      expect(result?.id).toBe('in_linked');
    });

    it('no invoice payment for the PaymentIntent -> null; no PaymentIntent -> no call', async () => {
      steers = [onPath('GET', /^\/v1\/invoice_payments$/, (json) => { json.data = []; })];
      expect(await stripeService.findPaygOverageInvoiceForCharge({ payment_intent: 'pi_none' })).toBeNull();
      expect(await stripeService.findPaygOverageInvoiceForCharge({ id: 'ch_x', payment_intent: null })).toBeNull();
      expect(recs).toHaveLength(1);
    });
  });

  // ── 3. customer / payment method resolution ──────────────────────────────────────────────────────
  describe('stripeService.resolveUserPaymentMethod / findLiveCustomerIdForUser', () => {
    it('reads customers, the expanded invoice default, payment methods and setup intents with accepted params', async () => {
      const resolved = await stripeService.resolveUserPaymentMethod({ stripe_customer_id: 'cus_row', email: 'owner@example.com' } as never, OWNER);

      expect(params(one('GET', /^\/v1\/customers$/).query)).toEqual({ email: 'owner@example.com', limit: '10' });
      const search = one('GET', /^\/v1\/customers\/search$/);
      expect(params(search.query)).toEqual({ query: `metadata['userId']:'${OWNER}'`, limit: '10' });
      for (const c of search.raw.data) { expectField(c, 'id', 'string'); expectField(c, 'metadata', 'object'); }

      const cust = one('GET', /^\/v1\/customers\/cus_row$/);
      expect(params(cust.query)).toEqual({ 'expand[0]': 'invoice_settings.default_payment_method' });
      // Expansion is recognised: stripe-mock answers the (fixture-null) default as an expanded payment_method.
      expectField(cust.raw, 'invoice_settings.default_payment_method', 'object');
      expect(cust.raw.invoice_settings.default_payment_method.object).toBe('payment_method');
      expectField(cust.raw, 'invoice_settings.default_payment_method.card.brand', 'string');
      expect(cust.raw.deleted).toBeUndefined(); // a live customer has no `deleted` (DeletedCustomer has it)

      const pms = one('GET', /^\/v1\/payment_methods$/);
      expect(params(pms.query)).toEqual({ customer: 'cus_row', limit: '100' });
      expect(pms.raw.data.length).toBeGreaterThan(0);
      for (const pm of pms.raw.data) {
        expectField(pm, 'id', 'string');
        expectField(pm, 'type', 'string');
        expectField(pm, 'created', 'number');
        expectField(pm, 'card.brand', 'string');
        expectField(pm, 'card.last4', 'string');
      }

      const sis = one('GET', /^\/v1\/setup_intents$/);
      expect(params(sis.query)).toEqual({ customer: 'cus_row', limit: '100' });
      for (const si of sis.raw.data) { expectField(si, 'status', 'string'); expectField(si, 'metadata', 'object', 'null'); }

      expect(resolved).toMatchObject({ hasPaymentMethod: true, customerId: 'cus_row', isZoma: false });
      // A method is offered for pinning only when the customer has no invoice default of its own
      // (an invoice's own default overrides the customer's on every retry).
      const customer = one('GET', /^\/v1\/customers\/cus_row$/).raw;
      expectField(customer, 'invoice_settings.default_payment_method', 'string', 'object', 'null');
      expectField(customer, 'default_source', 'string', 'object', 'null');
      const hasDefault = Boolean(customer.invoice_settings.default_payment_method || customer.default_source);
      expect(resolved.fallbackPaymentMethodId).toBe(hasDefault ? null : pms.raw.data[0].id);
      expect(resolved.card).toEqual({ brand: expect.any(String), last4: expect.any(String) });
    });

    it('findLiveCustomerIdForUser retrieves the row customer', async () => {
      expect(await stripeService.findLiveCustomerIdForUser({ stripe_customer_id: 'cus_row' } as never, OWNER)).toBe('cus_row');
      expect(params(one('GET', /^\/v1\/customers\/cus_row$/).query)).toEqual({});
    });
  });

  // ── 4. the rest of the diff: resync skips overage invoices ───────────────────────────────────────
  describe('resyncAllSubscriptionAmounts', () => {
    it('lists paid invoices with accepted params; every call it makes is accepted; fields read exist', async () => {
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([{ userId: OWNER, email: 'owner@example.com', stripe_customer_id: 'cus_row', subscription_amount: 4900 }]);
      (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);
      const summary = await resyncAllSubscriptionAmounts();
      const list = one('GET', /^\/v1\/invoices$/);
      expect(params(list.query)).toEqual({ customer: 'cus_row', status: 'paid', limit: '10' });
      for (const inv of list.raw.data) { expectField(inv, 'metadata', 'object', 'null'); expectField(inv, 'amount_paid', 'number'); }
      expect(summary.errors).toBe(0);
    });
  });

  // ── end to end: a pending month settled through stripe-mock ──────────────────────────────────────
  describe('settlePaygOverageMonth (pending record -> invoiced)', () => {
    it('resolves the card, issues and finalizes the invoice, records it', async () => {
      useRow(ownerRow(settlementRecord()));
      steers = [steerCreatedInvoiceIsFreshDraft, steerDraftTotal(AMOUNT, { ...META }), steerFinalized({ ...META })];
      const outcome = await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'));
      expect(outcome).toBe('invoiced');
      const created = one('POST', /^\/v1\/invoices$/);
      expect(created.body.get('customer')).toBe('cus_row');
      // Pinned only when the customer has no invoice default; otherwise Stripe charges the customer's
      // default — which follows the owner when they update their card.
      const customer = one('GET', /^\/v1\/customers\/cus_row$/).raw;
      const hasDefault = Boolean(customer.invoice_settings.default_payment_method || customer.default_source);
      expect(created.body.get('default_payment_method')).toBe(hasDefault ? null : one('GET', /^\/v1\/payment_methods$/).raw.data[0].id);
      expect(created.idempotencyKey).toBe(`${KEY}:2026-10-02T12:00:00.000Z:invoice`);
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ status: 'invoiced', invoiceId: created.raw.id });
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com', month: M }));
    });

    it('two live invoices in Stripe: the month is held `multiple_invoices` with their ids, nothing created, on-call told', async () => {
      useRow(ownerRow(settlementRecord()));
      steers = [steerSearchFinds({ id: 'in_a', status: 'open', total: AMOUNT }, { id: 'in_b', status: 'open', total: AMOUNT })];
      const outcome = await settlePaygOverageMonth(OWNER, M, new Date('2026-10-03T12:00:00.000Z'));
      expect(outcome).toBe('held');
      expect(calls('POST', /^\/v1\/invoices/)).toHaveLength(0);
      const record = (store.row.paygSettlements as Json)[M];
      expect(record).toMatchObject({ status: 'held', heldReason: 'multiple_invoices', conflictingInvoiceIds: ['in_a', 'in_b'] });
      expect(record.invoiceId).toBeUndefined();
      expect(emailService.sendOncallAlert).toHaveBeenCalledWith(
        expect.stringContaining('multiple_invoices'), expect.stringContaining('in_a, in_b'),
        expect.objectContaining({
          'Alert Class': 'payg-settlement-held',
          held: [expect.objectContaining({ heldReason: 'multiple_invoices', conflictingInvoiceIds: ['in_a', 'in_b'] })],
        }),
      );
    });
  });

  // ── 6. webhooks fed stripe-mock's own objects ────────────────────────────────────────────────────
  describe('webhook handlers with stripe-mock objects (API 2025-05-28.basil shapes)', () => {
    const client = () => createStripeClient('sk_test_123');

    it('invoice.paid / invoice.payment_succeeded: the overage branch reads id + metadata and marks the month paid', async () => {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      expectField(invoice, 'id', 'string');
      expectField(invoice, 'metadata', 'object');
      expectField(invoice, 'hosted_invoice_url', 'string', 'null');
      invoice.metadata = { ...META }; // what settlement created it with
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await handleInvoicePaymentSucceeded(invoice);
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ status: 'paid', invoiceId: 'in_overage' });
      expect(store.row.subscription_status).toBe('active');
      expect(store.row.subscription_amount).toBe(4900);
      // Recorded under the overage's own payment type (never `payment_succeeded`), from fields the object has.
      expectField(invoice, 'amount_paid', 'number');
      expectField(invoice, 'currency', 'string');
      expect(paymentHistoryDb.record).toHaveBeenCalledTimes(1);
      expect(paymentHistoryDb.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER, eventType: 'payg_overage_payment_succeeded', amount: invoice.amount_paid,
          currency: invoice.currency, status: 'paid', stripeInvoiceId: 'in_overage',
          metadata: { purchaseType: 'payg_overage', month: M },
        }),
        { dedupKey: 'payg_overage_payment_succeeded:in_overage' },
      );
    });

    it('invoice.payment_failed: marks the month failed and suspends PAYG', async () => {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      invoice.metadata = { ...META };
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await handleInvoicePaymentFailed(invoice);
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ status: 'failed' });
      expect((store.row.paygOverage as Json).suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_overage' });
      expect(emailService.sendPaygOveragePaymentFailedEmail).toHaveBeenCalledWith(expect.objectContaining({ invoiceUrl: invoice.hosted_invoice_url }));
      expectField(invoice, 'amount_due', 'number');
      expect(paymentHistoryDb.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'payg_overage_payment_failed', amount: invoice.amount_due, status: 'failed', stripeInvoiceId: 'in_overage' }),
        { dedupKey: 'payg_overage_payment_failed:in_overage' },
      );
    });

    it('a failed month then paid: the payment-failure suspension is lifted', async () => {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      invoice.metadata = { ...META };
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await handleInvoicePaymentFailed(invoice);
      expect((store.row.paygOverage as Json).suspended).toMatchObject({ reason: 'payment_failed' });
      await handleInvoicePaymentSucceeded(invoice);
      expect((store.row.paygSettlements as Json)[M].status).toBe('paid');
      expect((store.row.paygOverage as Json).suspended).toBeUndefined();
    });

    it('charge.refunded: charge fields read exist; the invoice is found through invoice payments', async () => {
      const charge: Json = await client().charges.retrieve('ch_overage');
      for (const f of ['id', 'currency']) expectField(charge, f, 'string');
      expectField(charge, 'amount_refunded', 'number');
      expectField(charge, 'refunded', 'boolean');
      expectField(charge, 'metadata', 'object');
      expectField(charge, 'payment_intent', 'string', 'object', 'null');
      expectField(charge, 'customer', 'string', 'object', 'null');
      expect('invoice' in charge).toBe(false); // removed in 2025-03-31.basil — the PR does not read it
      // An invoice charge always has a PaymentIntent; stripe-mock's fixture charge has none.
      Object.assign(charge, { payment_intent: 'pi_overage', amount_refunded: 1000, refunded: false });
      steers = [onPath('GET', /^\/v1\/invoice_payments$/, (json) => { Object.assign(json.data[0].invoice, { id: 'in_overage', metadata: { ...META } }); })];
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'paid', invoiceId: 'in_overage' })));
      await handleChargeRefunded(charge);
      expect(one('GET', /^\/v1\/invoice_payments$/).query.get('payment[payment_intent]')).toBe('pi_overage');
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ refundedCents: 1000 });
      // rv5 MINOR 4: one row per refund, with that refund's own amount (a charge no longer carries them).
      const listed = one('GET', /^\/v1\/refunds$/);
      expect(params(listed.query)).toEqual({ charge: charge.id, limit: '100' });
      expect(listed.raw.data.length).toBeGreaterThan(0);
      for (const refund of listed.raw.data) {
        expectField(refund, 'id', 'string');
        expectField(refund, 'amount', 'number');
        expectField(refund, 'status', 'string', 'null');
        expectField(refund, 'reason', 'string', 'null');
      }
      const refund = listed.raw.data[0];
      expect(paymentHistoryDb.record).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'refund', amount: refund.amount, stripeInvoiceId: 'in_overage',
        metadata: expect.objectContaining({ chargeId: charge.id, refundId: refund.id, fullRefund: false }),
      }), { dedupKey: `refund:${refund.id}` });
    });

    it('charge.dispute.created: dispute -> charges.retrieve -> invoice payments -> PAYG suspended (dispute)', async () => {
      const dispute: Json = await client().disputes.retrieve('dp_overage');
      for (const f of ['id', 'currency', 'reason']) expectField(dispute, f, 'string');
      expectField(dispute, 'amount', 'number');
      expectField(dispute, 'charge', 'string', 'object');
      steers = [
        onPath('GET', /^\/v1\/charges\/[^/]+$/, (json) => { json.payment_intent = 'pi_overage'; }),
        onPath('GET', /^\/v1\/invoice_payments$/, (json) => { Object.assign(json.data[0].invoice, { id: 'in_overage', metadata: { ...META } }); }),
      ];
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'paid', invoiceId: 'in_overage' })));
      await handleChargeDisputeCreated(dispute);
      const chargeGet = one('GET', /^\/v1\/charges\/[^/]+$/);
      expect(chargeGet.path).toBe(`/v1/charges/${dispute.charge}`);
      expectField(chargeGet.raw, 'payment_intent', 'string', 'object', 'null');
      expectField(chargeGet.raw, 'metadata', 'object');
      expect((store.row.paygOverage as Json).suspended).toMatchObject({ reason: 'dispute', invoiceId: 'in_overage' });
      expect((store.row.paygSettlements as Json)[M].disputes).toEqual({ [dispute.id]: { at: expect.any(String) } });
      expect((store.row.paygOverage as Json).suspended).toMatchObject({ disputeId: dispute.id });
      expect(paymentHistoryDb.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'dispute_opened', amount: dispute.amount, currency: dispute.currency, metadata: expect.objectContaining({ disputeReason: dispute.reason }) }),
        { dedupKey: `dispute:opened:${dispute.id}` },
      );
    });
  });
  // ── 7. the webhook controller, with a real signature over a stripe-mock invoice ─────────────────────
  describe('POST /api/stripe/webhook (stripeController.handleWebhook)', () => {
    const client = () => createStripeClient('sk_test_123');
    /** A signed delivery of `type` carrying `object`, verified by the real SDK in constructWebhookEvent. */
    async function deliver(type: string, object: Json) {
      const payload = JSON.stringify({ id: `evt_${type.replace(/\W/g, '_')}`, object: 'event', api_version: STRIPE_API_VERSION, type, data: { object } });
      const header = client().webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
      const res: Json = { statusCode: 200, body: undefined };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: Json) => { res.body = body; return res; };
      await handleWebhook({ headers: { 'stripe-signature': header }, body: Buffer.from(payload) } as never, res as never);
      await new Promise((r) => setImmediate(r)); // let the fire-and-forget CRM mirror run, if it was started
      return res;
    }

    it.each([
      ['invoice.paid', 'payg_overage_payment_succeeded', 'paid'],
      ['invoice.payment_succeeded', 'payg_overage_payment_succeeded', 'paid'],
      ['invoice.payment_failed', 'payg_overage_payment_failed', 'failed'],
    ])('%s for an overage invoice: settlement records it under its own type; no subscription payment row, no CRM mirror', async (type, eventType, status) => {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      invoice.metadata = { ...META };
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([store.row]);
      const res = await deliver(type, invoice);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect((store.row.paygSettlements as Json)[M].status).toBe(status);
      expect((paymentHistoryDb.record as jest.Mock).mock.calls.map(([row]) => row.eventType)).toEqual([eventType]);
      expect(userDb.scanWithFilter).not.toHaveBeenCalled(); // findUserByStripeCustomerId: neither the payment row nor the CRM mirror ran
      expect(onStripeSubscriptionEvent).not.toHaveBeenCalled();
    });

    it('a subscription invoice is still recorded as `payment_succeeded` and mirrored to the CRM', async () => {
      const invoice: Json = await client().invoices.retrieve('in_subscription');
      expect(invoice.metadata?.purchaseType).toBeUndefined();
      const customer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;
      useRow(ownerRow(settlementRecord(), { stripe_customer_id: customer }));
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([store.row]);
      const res = await deliver('invoice.payment_succeeded', invoice);
      expect(res.statusCode).toBe(200);
      expect((paymentHistoryDb.record as jest.Mock).mock.calls.map(([row]) => row.eventType)).toContain('payment_succeeded');
      expect(onStripeSubscriptionEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'invoice.payment_succeeded' }));
    });

    it('a bad signature is refused before anything runs', async () => {
      const res: Json = { statusCode: 200 };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: Json) => { res.body = body; return res; };
      await handleWebhook({ headers: { 'stripe-signature': 't=1,v1=deadbeef' }, body: Buffer.from('{}') } as never, res as never);
      expect(res.statusCode).toBe(400);
      expect(recs).toHaveLength(0);
    });
  });

  // ── 8. refund / dispute recognition when Stripe's lookup fails ──────────────────────────────────────
  describe('overage lookup failures (invoice payments unavailable)', () => {
    const client = () => createStripeClient('sk_test_123');

    it('charge.dispute.created: the lookup error is raised (webhook 500, Stripe redelivers); nothing suspended or recorded', async () => {
      const dispute: Json = await client().disputes.retrieve('dp_overage');
      steers = [onPath('GET', /^\/v1\/charges\/[^/]+$/, (json) => { json.payment_intent = 'pi_overage'; })];
      failures = [failWith('GET', /^\/v1\/invoice_payments$/)];
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'paid', invoiceId: 'in_overage' })));
      const before = JSON.stringify(store.row);
      await expect(handleChargeDisputeCreated(dispute)).rejects.toThrow(/could not check whether charge .* paid a pay-as-you-go invoice.*retry/);
      expect(calls('GET', /^\/v1\/invoice_payments$/)).toHaveLength(1); // final: no SDK retry, no fall-through
      expect(JSON.stringify(store.row)).toBe(before);
      expect(paymentHistoryDb.record).not.toHaveBeenCalled();

      // Through the controller the same failure answers 500, so Stripe redelivers the dispute.
      const payload = JSON.stringify({ id: 'evt_dispute', object: 'event', type: 'charge.dispute.created', data: { object: dispute } });
      const header = client().webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
      const res: Json = { statusCode: 200 };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: Json) => { res.body = body; return res; };
      await handleWebhook({ headers: { 'stripe-signature': header }, body: Buffer.from(payload) } as never, res as never);
      expect(res.statusCode).toBe(500);
    });

    it('charge.refunded: handled as before (no throw), and on-call is told the overage check failed', async () => {
      const charge: Json = await client().charges.retrieve('ch_overage');
      Object.assign(charge, { payment_intent: 'pi_overage', amount_refunded: 1000, refunded: false });
      failures = [failWith('GET', /^\/v1\/invoice_payments$/)];
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'paid', invoiceId: 'in_overage' })));
      (userDb.scanWithFilter as jest.Mock).mockResolvedValue([]);
      await expect(handleChargeRefunded(charge)).resolves.toBeUndefined();
      expect(calls('GET', /^\/v1\/invoice_payments$/)).toHaveLength(1);
      expect((store.row.paygSettlements as Json)[M].refundedCents).toBeUndefined();
      expect(emailService.sendOncallAlert).toHaveBeenCalledWith(
        expect.stringContaining('charge.refunded'), expect.stringContaining('record it on that month'),
        expect.objectContaining({ 'Alert Class': 'payg-settlement-lookup', chargeId: charge.id, event: 'charge.refunded' }),
      );
    });
  });

  // ── 9. the invoice lifecycle beyond paid/failed (rvE2E round), with stripe-mock objects ─────────────
  describe('invoice lifecycle events, signed and through the controller', () => {
    const client = () => createStripeClient('sk_test_123');
    async function deliverSigned(type: string, object: Json) {
      const payload = JSON.stringify({ id: `evt_${type.replace(/\W/g, '_')}`, object: 'event', api_version: STRIPE_API_VERSION, type, data: { object } });
      const header = client().webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
      const res: Json = { statusCode: 200, body: undefined };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: Json) => { res.body = body; return res; };
      await handleWebhook({ headers: { 'stripe-signature': header }, body: Buffer.from(payload) } as never, res as never);
      await new Promise((r) => setImmediate(r));
      return res;
    }
    async function overageInvoice(): Promise<Json> {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      expectField(invoice, 'hosted_invoice_url', 'string', 'null');
      expectField(invoice, 'status', 'string', 'null');
      invoice.metadata = { ...META };
      return invoice;
    }

    it('invoice.voided after a failure: the month is written off, the hold lifted, on-call told once; nothing else sent to Stripe', async () => {
      const invoice = await overageInvoice();
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await deliverSigned('invoice.payment_failed', invoice);
      expect((store.row.paygSettlements as Json)[M].status).toBe('failed');
      // stripe-mock's fixture has no hosted page (null): then nothing is recorded to point the owner at.
      expect((store.row.paygSettlements as Json)[M].hostedInvoiceUrl).toBe(invoice.hosted_invoice_url ?? undefined);
      recs = [];
      const res = await deliverSigned('invoice.voided', { ...invoice, status: 'void' });
      expect(res.statusCode).toBe(200);
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ status: 'written_off', writtenOffReason: 'invoice_voided', invoiceId: 'in_overage' });
      expect((store.row.paygOverage as Json).suspended).toBeUndefined();
      expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
      expect(recs).toEqual([]); // decided from the event alone
      expect(onStripeSubscriptionEvent).not.toHaveBeenCalled();
    });

    it('invoice.marked_uncollectible: failed + suspended + uncollectibleAt; a later invoice.paid lifts it', async () => {
      const invoice = await overageInvoice();
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await deliverSigned('invoice.marked_uncollectible', { ...invoice, status: 'uncollectible' });
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ status: 'failed', uncollectibleAt: expect.any(String) });
      expect((store.row.paygOverage as Json).suspended).toMatchObject({ reason: 'payment_failed', invoiceId: 'in_overage' });
      await deliverSigned('invoice.paid', { ...invoice, status: 'paid' });
      expect((store.row.paygSettlements as Json)[M].status).toBe('paid');
      expect((store.row.paygOverage as Json).suspended).toBeUndefined();
    });

    it('invoice.payment_action_required: one confirmation email with the hosted page; month stays invoiced, nothing suspended', async () => {
      const invoice = await overageInvoice();
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await deliverSigned('invoice.payment_action_required', invoice);
      await deliverSigned('invoice.payment_action_required', invoice);
      expect(emailService.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledWith({ to: 'owner@example.com', month: M, invoiceUrl: invoice.hosted_invoice_url });
      expect((store.row.paygSettlements as Json)[M].status).toBe('invoiced');
      expect((store.row.paygOverage as Json).suspended).toBeUndefined();
    });

    it('invoice.paid before the run recorded the invoice: the one invoice email goes out from the webhook, once', async () => {
      const invoice = await overageInvoice();
      useRow(ownerRow(settlementRecord({ status: 'pending', invoiceId: 'in_overage' })));
      await deliverSigned('invoice.paid', { ...invoice, status: 'paid' });
      await deliverSigned('invoice.payment_succeeded', { ...invoice, status: 'paid' });
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ status: 'paid', emailedAt: expect.any(String) });
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendPaygOverageInvoiceEmail).toHaveBeenCalledWith(expect.objectContaining({ month: M, invoiceUrl: invoice.hosted_invoice_url }));
    });

    it('the open invoice link is the failed invoice\'s own hosted_invoice_url (an https page in this API version, or none)', async () => {
      const invoice = await overageInvoice();
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await deliverSigned('invoice.payment_failed', invoice);
      const url = paygOpenInvoiceUrl(store.row.paygSettlements as never);
      if (typeof invoice.hosted_invoice_url === 'string' && invoice.hosted_invoice_url.startsWith('https://')) {
        expect(url).toBe(invoice.hosted_invoice_url);
      } else {
        expect(url).toBeUndefined();
      }
    });

    it.each([
      ['won', undefined, 'paid'],
      ['lost', { reason: 'dispute' }, 'written_off'],
    ])('charge.dispute.closed (%s): charges.retrieve -> invoice payments -> hold %s, month %s', async (status, holdAfter, monthAfter) => {
      const dispute: Json = await client().disputes.retrieve('dp_overage');
      expectField(dispute, 'status', 'string');
      steers = [
        onPath('GET', /^\/v1\/charges\/[^/]+$/, (json) => { json.payment_intent = 'pi_overage'; }),
        onPath('GET', /^\/v1\/invoice_payments$/, (json) => { Object.assign(json.data[0].invoice, { id: 'in_overage', metadata: { ...META } }); }),
      ];
      useRow(ownerRow(
        settlementRecord({ status: 'paid', invoiceId: 'in_overage', disputes: { [dispute.id]: { at: '2026-10-05T00:00:00.000Z' } } }),
        { paygOverage: { enabled: true, capPercentOfPool: 50, admittedMonths: [], updatedBy: OWNER, updatedAt: 'x', version: 3,
          suspended: { reason: 'dispute', at: '2026-10-05T00:00:00.000Z', invoiceId: 'in_overage', disputeId: dispute.id } } },
      ));
      await handleChargeDisputeClosed({ ...dispute, status });
      expect(one('GET', /^\/v1\/invoice_payments$/).query.get('payment[payment_intent]')).toBe('pi_overage');
      const after = store.row.paygOverage as Json;
      if (holdAfter) expect(after.suspended).toMatchObject(holdAfter);
      else expect(after.suspended).toBeUndefined();
      expect((store.row.paygSettlements as Json)[M]).toMatchObject({ status: monthAfter, disputes: { [dispute.id]: { at: '2026-10-05T00:00:00.000Z', status, closedAt: expect.any(String) } } });
      expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(status === 'lost' ? 1 : 0);
    });
  });

  // ── 10. rv5 round: the Stripe calls it adds ────────────────────────────────────────────────────────
  describe('rv5: 3-D Secure check, refunds list, re-pointing a pinned card', () => {
    const client = () => createStripeClient('sk_test_123');
    async function deliverSigned(type: string, object: Json) {
      const payload = JSON.stringify({ id: `evt_${type.replace(/\W/g, '_')}`, object: 'event', api_version: STRIPE_API_VERSION, type, data: { object } });
      const header = client().webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
      const res: Json = { statusCode: 200, body: undefined };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: Json) => { res.body = body; return res; };
      await handleWebhook({ headers: { 'stripe-signature': header }, body: Buffer.from(payload) } as never, res as never);
      await new Promise((r) => setImmediate(r));
      return res;
    }
    /** The invoice's default payment, with its PaymentIntent expanded, says `status`. */
    const steerIntentStatus = (status: string) =>
      onPath('GET', /^\/v1\/invoice_payments$/, (json) => { json.data[0].is_default = true; json.data[0].payment.payment_intent.status = status; });

    it('invoice.payment_failed: the invoice\'s default payment is read (invoice + expanded PaymentIntent); fields exist in this version', async () => {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      invoice.metadata = { ...META };
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      await handleInvoicePaymentFailed(invoice);
      const listed = one('GET', /^\/v1\/invoice_payments$/);
      expect(params(listed.query)).toEqual({ invoice: 'in_overage', limit: '10', 'expand[0]': 'data.payment.payment_intent' });
      const payment = listed.raw.data[0];
      expectField(payment, 'is_default', 'boolean');
      expectField(payment, 'payment.type', 'string');
      expectField(payment, 'payment.payment_intent', 'object');
      expectField(payment.payment.payment_intent, 'status', 'string');
      // stripe-mock's fixture PaymentIntent is `requires_payment_method`: a decline, so the month fails.
      expect(payment.payment.payment_intent.status).toBe('requires_payment_method');
      expect((store.row.paygSettlements as Json)[M].status).toBe('failed');
    });

    it('signed 3-D Secure pair (PaymentIntent requires_action): no suspension, no failure email, one confirm email', async () => {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      invoice.metadata = { ...META };
      steers = [steerIntentStatus('requires_action')];
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      expect((await deliverSigned('invoice.payment_action_required', invoice)).statusCode).toBe(200);
      expect((await deliverSigned('invoice.payment_failed', invoice)).statusCode).toBe(200);
      expect((store.row.paygOverage as Json).suspended).toBeUndefined();
      expect((store.row.paygSettlements as Json)[M].status).toBe('invoiced');
      expect(emailService.sendPaygOveragePaymentFailedEmail).not.toHaveBeenCalled();
      expect(emailService.sendPaygOveragePaymentActionRequiredEmail).toHaveBeenCalledTimes(1);
    });

    it('a PaymentIntent the list did not expand is retrieved (GET /v1/payment_intents/:id; `status` exists)', async () => {
      steers = [onPath('GET', /^\/v1\/invoice_payments$/, (json) => { json.data[0].payment.payment_intent = 'pi_overage'; })];
      await expect(stripeService.paygOverageInvoicePaymentState('in_overage')).resolves.toBe('declined');
      const retrieved = one('GET', /^\/v1\/payment_intents\/pi_overage$/);
      expectField(retrieved.raw, 'status', 'string');
    });

    it('the lookup failing raises (webhook 500, Stripe redelivers); the month is untouched', async () => {
      const invoice: Json = await client().invoices.retrieve('in_overage');
      invoice.metadata = { ...META };
      failures = [failWith('GET', /^\/v1\/invoice_payments$/)];
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'invoiced', invoiceId: 'in_overage' })));
      expect((await deliverSigned('invoice.payment_failed', invoice)).statusCode).toBe(500);
      expect((store.row.paygSettlements as Json)[M].status).toBe('invoiced');
      expect((store.row.paygOverage as Json).suspended).toBeUndefined();
    });

    it('setup_intent.succeeded (signed): an open overage invoice pinned to another card is pointed at the new one — POST /v1/invoices/:id accepted', async () => {
      const setupIntent: Json = await client().setupIntents.retrieve('seti_new');
      for (const f of ['customer', 'payment_method']) expectField(setupIntent, f, 'string', 'object', 'null');
      expectField(setupIntent, 'metadata', 'object');
      const invoice: Json = await client().invoices.retrieve('in_overage');
      expectField(invoice, 'default_payment_method', 'string', 'object', 'null');
      expectField(invoice, 'customer', 'string', 'object', 'null');
      Object.assign(setupIntent, { status: 'succeeded', customer: 'cus_card', payment_method: 'pm_new', metadata: { userId: OWNER } });
      steers = [
        onPath('GET', /^\/v1\/invoices\/in_overage$/, (json) => {
          Object.assign(json, { status: 'open', customer: 'cus_card', default_payment_method: 'pm_card', metadata: { ...META } });
        }),
        // The customer's newest attached card is the one just saved.
        onPath('GET', /^\/v1\/payment_methods$/, (json) => { Object.assign(json.data[0], { id: 'pm_new', created: nowSeconds() }); }),
      ];
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'failed', invoiceId: 'in_overage' })));
      const res = await deliverSigned('setup_intent.succeeded', setupIntent);
      expect(res.statusCode).toBe(200);
      const methods = one('GET', /^\/v1\/payment_methods$/);
      expect(params(methods.query)).toEqual({ customer: 'cus_card', type: 'card', limit: '100' });
      for (const pm of methods.raw.data) { expectField(pm, 'id', 'string'); expectField(pm, 'created', 'number'); expectField(pm, 'type', 'string'); }
      const updated = one('POST', /^\/v1\/invoices\/in_overage$/);
      expect(params(updated.body)).toEqual({ default_payment_method: 'pm_new' });
      expect(updated.idempotencyKey).toBe('payg-repoint:in_overage:pm_new');
      expect(onStripeSubscriptionEvent).not.toHaveBeenCalled(); // not mirrored to the CRM
    });

    it('setup_intent.succeeded with no user tag: GET /v1/invoices (customer, open) accepted; an overage one is confirmed against its owner\'s record (rv6 MINOR 4a)', async () => {
      const setupIntent: Json = await client().setupIntents.retrieve('seti_new');
      Object.assign(setupIntent, { status: 'succeeded', customer: 'cus_card', payment_method: 'pm_new', metadata: {} });
      steers = [
        onPath('GET', /^\/v1\/invoices$/, (json) => {
          expect(json.data.length).toBeGreaterThan(0);
          Object.assign(json.data[0], { id: 'in_overage', status: 'open', customer: 'cus_card', default_payment_method: 'pm_card', metadata: { ...META } });
        }),
        onPath('GET', /^\/v1\/payment_methods$/, (json) => { Object.assign(json.data[0], { id: 'pm_new', created: nowSeconds() }); }),
      ];
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'failed', invoiceId: 'in_overage' })));
      expect((await deliverSigned('setup_intent.succeeded', setupIntent)).statusCode).toBe(200);
      const listed = one('GET', /^\/v1\/invoices$/);
      expect(params(listed.query)).toEqual({ customer: 'cus_card', status: 'open', limit: '100' });
      for (const invoice of listed.raw.data) { expectField(invoice, 'metadata', 'object', 'null'); expectField(invoice, 'default_payment_method', 'string', 'object', 'null'); }
      expect(params(one('POST', /^\/v1\/invoices\/in_overage$/).body)).toEqual({ default_payment_method: 'pm_new' });
      expect(userDb.scanWithFilter).not.toHaveBeenCalled();
    });

    it('setup_intent.succeeded for an account with no open overage invoice: no Stripe call at all', async () => {
      const setupIntent: Json = await client().setupIntents.retrieve('seti_new');
      Object.assign(setupIntent, { status: 'succeeded', customer: 'cus_card', payment_method: 'pm_new', metadata: { userId: OWNER } });
      recs = [];
      useRow(ownerRow(settlementRecord({ status: 'paid', invoiceId: 'in_overage' })));
      expect((await deliverSigned('setup_intent.succeeded', setupIntent)).statusCode).toBe(200);
      expect(recs).toEqual([]);
    });
  });
});
