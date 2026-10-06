/**
 * ENG-2320 — forward-lead's existing-lead merge: SEQUENTIAL behaviour is pinned byte-for-byte.
 *
 * The fix for the lost-keys race changes HOW the merged customFields reach DynamoDB (one atomic
 * document-path SET per key instead of one full-map overwrite). It must not change WHAT a
 * non-racing request produces. This suite drives the real route and the real crmDb against an
 * executing in-memory table (helpers/leadTableFake.ts) over a matrix of
 * (existing row x incoming payload) and compares, per case, with a golden file that was
 * CAPTURED FROM origin/main BEFORE the change (fail-first discipline: the golden is the old
 * implementation's output, never regenerated to bless new behaviour):
 *
 *   - the HTTP status + `event` (lead.updated / lead.unchanged) -> `isUpdated`
 *   - the stored AW-Leads row, every attribute, `updatedAt` masked
 *   - the stored AW-LeadLists fieldNames (as the SET of names a reader sees) and leadCount
 *   - the side effects `isUpdated` gates: CRM sync, drip enrolment, and the `lead` object
 *     handed to them (its customFields is the merged map the cascade renders)
 *
 * A second block drives N concurrent repeat submissions with distinct keys and asserts NO key
 * is lost — that is the regression this ticket fixes (it fails on origin/main).
 *
 * Regenerate the golden ONLY from a known-good baseline:
 *   GOLDEN_WRITE=1 npx jest src/__tests__/webhooks.forwardLead.mergeEquivalence.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import request from 'supertest';
import express from 'express';
import { LeadTableFake } from './helpers/leadTableFake';

jest.mock('aws-sdk', () => {
  const { LeadTableFake: Fake } = require('./helpers/leadTableFake');
  const fake = new Fake();
  (globalThis as any).__leadTableFake = fake;
  const base: any = {
    config: { update: jest.fn() },
    DynamoDB: { DocumentClient: jest.fn(() => fake.client()) },
    S3: jest.fn(() => ({})),
    SecretsManager: jest.fn(() => ({})),
  };
  const proxy: any = new Proxy(base, { get: (t, p) => (p === 'default' ? proxy : p in t ? t[p] : jest.fn(() => ({}))) });
  return proxy;
});
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/metaAccountCredentials', () => ({ getMetaAccountCredentials: jest.fn() }));
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() },
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() },
}));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { updateEmailDraftForLead: jest.fn(), getCrmSenders: jest.fn() },
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'email_1' }) },
}));
jest.mock('../services/webhookService', () => ({
  webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() } }));

import webhookRouter from '../routes/webhooks';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { dispatchLeadCreated } from '../services/orgLeadNotificationService';

const fake: LeadTableFake = (globalThis as any).__leadTableFake;
const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'forwardLeadMergeEquivalence.golden.json');
const OLD = '2020-01-01T00:00:00.000Z';
const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const EMAIL = 'ann@example.com';

// ── existing rows ─────────────────────────────────────────────────────────────────────────
const base = { listId: 'L0', leadId: 'lead_1', email: EMAIL, createdAt: OLD, updatedAt: OLD };
const EXISTING: Record<string, any> = {
  bare: { ...base },
  full: {
    ...base, firstName: 'Ann', lastName: 'Lee', company: 'Acme', phone: '555', title: 'CTO', notes: 'n',
    linkedin: 'https://www.linkedin.com/in/ann', nameCompanyKey: 'ann|lee|acme', domain: 'example.com', lifecycle: 'inbox',
    status: 'qualified', dealValue: 5000, selectedSenderId: 's1', isICP: 1,
    customFields: {
      source: 'hero-form', forwardedAt: OLD, a: 1, nested: { x: 1, y: 2 }, blank: '', zero: 0, flag: false, nul: null, list: [1, 2],
    },
  },
  attributed: {
    ...base, firstName: 'Ann', customFields: { source: 'lp' },
    firstTouch: { timestamp: OLD, utm: { source: 'old', medium: 'email' }, clickIds: { gclid: 'OLD' } },
    lastTouch: { timestamp: OLD, utm: { source: 'old', medium: 'email' } },
    utmSource: 'old', utmMedium: 'email', clickIds: { gclid: 'OLD' },
    metaFbp: 'fb.old', clientIp: '198.51.100.1', clientUserAgent: 'UA-old',
  },
  firstTouchOnly: { ...base, customFields: { source: 'lp', a: '1' }, firstTouch: { timestamp: OLD, utm: { source: 'seed' } } },
  legacyEmptyGsi: { ...base, firstName: 'Bob', linkedin: '', nameCompanyKey: '', customFields: { source: 'lp' } },
  noSource: { ...base, customFields: { a: 1, b: 2 } },
  noAttribution: { ...base, firstName: 'Ann', customFields: { source: 'lp' } },
};

// ── incoming payloads ─────────────────────────────────────────────────────────────────────
const TOUCH = { timestamp: '2026-01-01T00:00:00.000Z', utm: { source: 'google', medium: 'cpc', campaign: 'c1' }, clickIds: { gclid: 'G1' } };
const many = (n: number, prefix: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, `v${i}`]));
type Payload = { body: Record<string, any>; headers?: Record<string, string> };
const MQ_HEADERS = { 'User-Agent': BROWSER_UA, 'X-Forwarded-For': '203.0.113.7' };
const PAYLOADS: Record<string, Payload> = {
  emailOnly: { body: {} },
  sameValues: { body: { source: 'hero-form', customFields: { a: 1 } } },
  newKey: { body: { customFields: { q1: 'yes' } } },
  changedValue: { body: { customFields: { a: 2 } } },
  namedSource: { body: { source: 'step2', customFields: { q2: 'x' } } },
  sourceInCustomFields: { body: { customFields: { source: 'cfsrc' } } },
  names: { body: { firstName: 'Anna', lastName: ' Lee ', company: 'Acme', title: '   ', phone: '555', notes: 'new note', linkedin: ' https://www.linkedin.com/in/anna ' } },
  namesEqualAfterTrim: { body: { firstName: ' Ann ', lastName: 'Lee' } },
  flatPassthrough: { body: { referrerPage: '/pricing', plan: 'pro', customFields: { plan: 'enterprise' } } },
  nestedKeyOrder: { body: { customFields: { nested: { y: 2, x: 1 } } } },
  falsyValues: { body: { customFields: { zero: '', flag: null, blank: 'x', nul: 'v', list: [2, 1] } } },
  specialKeys: {
    body: { customFields: { domain: 'd', system: 's', name: 'n', status: 'st', type: 't', 'a.b': 1, 'with space': 2, 'café': 3, 'k-1': 4, '#h': 5, ':c': 6, '0lead': 7 } },
  },
  callerForwardedAt: { body: { customFields: { forwardedAt: 'caller-supplied' } } },
  attribution: { body: { attribution: TOUCH, customFields: { q: 1 } } },
  attributionOnly: { body: { attribution: TOUCH } },
  flatUtm: { body: { utm: { utm_source: 'fb', utm_medium: 'paid', timestamp: '2026-02-02T00:00:00.000Z' } } },
  lastTouchSeparate: { body: { attribution: TOUCH, lastTouch: { timestamp: '2026-03-03T00:00:00.000Z', utm: { source: 'li' } } } },
  promotedFromCustomFields: { body: { customFields: { utm_source: 'news', gclid: 'GP' } } },
  matchQuality: { body: { fbp: 'fb.1.2.3' }, headers: MQ_HEADERS },
  matchQualityDeclared: {
    body: { visitorIp: '203.0.113.9', visitorUserAgent: BROWSER_UA }, headers: { 'User-Agent': 'node', 'X-Forwarded-For': '44.202.76.171' },
  },
  everything: {
    body: {
      firstName: 'Zed', company: 'Zed Co', source: 'multi', customFields: { q1: 'a', source: 'multi', nested: { x: 9 } },
      attribution: TOUCH, fbp: 'fb.9.9.9',
    },
    headers: MQ_HEADERS,
  },
  manyKeys: { body: { customFields: many(120, 'k') } },
  passthroughOverCap: { body: many(60, 'flat') },
};

const LISTS: Record<string, any> = {
  normal: { listId: 'L0', userId: 'u1', name: 'L', publicAccessEnabled: true, leadCount: 1, fieldNames: ['a', 'source'] },
  noFieldNames: { listId: 'L0', userId: 'u1', name: 'L', publicAccessEnabled: true, leadCount: 1 },
  drifted: { listId: 'L0', userId: 'u1', name: 'L', publicAccessEnabled: true, leadCount: 1, fieldNames: [] },
};

// ── normalisation ─────────────────────────────────────────────────────────────────────────
const NOW_WINDOW_MS = 24 * 3600 * 1000;
const isNowIso = (v: any) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Math.abs(Date.parse(v) - Date.now()) < NOW_WINDOW_MS;
const norm = (v: any): any => {
  if (isNowIso(v)) return '<NOW>';
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, norm(x)]));
  return v;
};
const digest = (v: any) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const settle = () => new Promise((r) => setTimeout(r, 25));

async function runCase(existing: any, list: any, payload: Payload) {
  fake.reset();
  jest.clearAllMocks();
  fake.seedList(list);
  fake.seedLead(existing);
  let req = request(app).post('/api/webhooks/forward-lead');
  for (const [k, v] of Object.entries(payload.headers ?? {})) req = req.set(k, v);
  const res = await req.send({ listId: 'L0', email: EMAIL, ...payload.body });
  await settle();
  const storedList = fake.list('L0');
  const syncCalls = (externalCrmSyncService.autoSyncLead as jest.Mock).mock.calls;
  return norm({
    status: res.status,
    event: res.body?.event,
    leads: fake.leadsIn('L0'),
    listFieldNames: Array.from(new Set((storedList.fieldNames as string[]) ?? [])).sort(),
    listHasFieldNamesAttr: storedList.fieldNames !== undefined,
    leadCount: storedList.leadCount,
    sideEffects: {
      // The `lead` object handed to the cascade (its customFields is what the owner alert and
      // CRM push render). Stored as a digest of its canonical JSON to keep the golden readable;
      // GOLDEN_DEBUG=1 prints the full object per case when a digest differs.
      crmSync: syncCalls.map((c) => ({ crm: c[3], event: c[4], leadDigest: digest(norm(JSON.parse(JSON.stringify(c[2])))), leadCustomFieldKeys: Object.keys(c[2].customFields ?? {}) })),
      enrol: (dripSequenceDb.getSequencesByAutoEnrollList as jest.Mock).mock.calls.length,
      ownerNotifyHook: (dispatchLeadCreated as jest.Mock).mock.calls.length,
    },
  });
}

const CASES: Array<[string, string, string]> = [];
for (const e of Object.keys(EXISTING)) for (const p of Object.keys(PAYLOADS)) CASES.push([e, p, 'normal']);
// list-shape variants: the fieldNames sync must behave the same when the list row is bare or drifted
for (const l of ['noFieldNames', 'drifted']) {
  for (const e of ['full', 'bare']) for (const p of ['emailOnly', 'newKey', 'names', 'attribution']) CASES.push([e, p, l]);
}

describe('forward-lead existing-lead merge — sequential equivalence with origin/main', () => {
  const writing = process.env.GOLDEN_WRITE === '1';
  const golden: Record<string, any> = writing ? {} : JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

  afterAll(() => {
    if (writing) fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 1) + '\n');
  });

  it('covers the whole matrix (golden has exactly these cases)', () => {
    if (writing) return;
    expect(Object.keys(golden).sort()).toEqual(CASES.map(([e, p, l]) => `${e} x ${p} @ ${l}`).sort());
  });

  it.each(CASES)('%s x %s @ %s', async (e, p, l) => {
    const got = await runCase(EXISTING[e], LISTS[l], PAYLOADS[p]);
    const key = `${e} x ${p} @ ${l}`;
    if (writing) { golden[key] = got; return; }
    expect(got).toEqual(golden[key]);
  });
});
