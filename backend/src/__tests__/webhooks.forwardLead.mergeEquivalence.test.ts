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
import { CASES, EMAIL, EXISTING, LISTS, PAYLOADS, Payload, norm } from './helpers/forwardLeadMergeMatrix';

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
