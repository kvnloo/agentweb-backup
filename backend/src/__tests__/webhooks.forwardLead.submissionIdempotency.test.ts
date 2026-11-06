/**
 * ENG-2837: forward-lead (and its /api/leads/public/:listId alias) is idempotent per
 * (listId, submission key).
 *
 * The Flatfee lander (AgentWebPro/lp-flatfee-enter-mexico-market-en-b4825dbb,
 * app/api/capture/route.ts + lib/conversion-dedup.ts) keeps ONE `submissionId` per form
 * in sessionStorage until a submission is accepted, posts it top-level, and its capture
 * route forwards `...body` here — so a retry after a lost response re-sends the SAME id,
 * which this handler stores as `customFields.submissionId`. Other callers may nest it
 * under `customFields.submissionId` or send `idempotencyKey`.
 *
 * Contract: a repeat of the same key returns the ORIGINAL success response (same leadId)
 * with exactly one lead write and no repeated notification / CAPI / CRM side effect.
 * Different keys are independent; no key means behaviour is unchanged.
 *
 * The claim runs against InMemoryDynamo, which executes the real ConditionExpression
 * strings, so the race test exercises the actual conditional write.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { PUBLIC_LEAD_ALIAS_PATH, publicLeadAlias } from '../routes/publicLeadAlias';
import { crmDb, userDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { metaService } from '../services/metaService';
import { dispatchLeadCreated } from '../services/orgLeadNotificationService';
import { __configureLeadSubmissionIdempotencyForTests } from '../services/leadSubmissionIdempotency';
import { InMemoryDynamo } from './helpers/inMemoryDynamo';

jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/metaAccountCredentials', () => ({
  getMetaAccountCredentials: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
}));
jest.mock('../services/metaService', () => ({
  metaService: { sendCapiLeadEvent: jest.fn().mockResolvedValue({ success: true }) },
}));
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() },
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
jest.mock('../services/roadmapDelivery', () => ({ sendRoadmapDeliveryEmail: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { updateEmailDraftForLead: jest.fn(), getCrmSenders: jest.fn() },
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'email_1' }) },
}));
jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(), verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(), generateEventId: jest.fn(),
  },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() },
}));

const CONFIGS = 'AW-Configs';
const DEV_CONFIGS = 'Dev-AW-Configs';

const app = express();
app.use(express.json());
app.post(PUBLIC_LEAD_ALIAS_PATH, publicLeadAlias);
app.use('/api/webhooks', webhookRouter);

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

let dynamo: InMemoryDynamo;
const claimItems = () => [...dynamo.items(CONFIGS), ...dynamo.items(DEV_CONFIGS)];

// What the Flatfee capture route sends: the page payload spread, plus listId/source etc.
const flatfee = (over: Record<string, unknown> = {}) => ({
  email: 'ana@example.com', firstName: 'Ana', lastName: 'Ruiz', company: 'Acme',
  processingConsent: 'true', leadType: 'consultation_inquiry',
  listId: 'list_1', source: 'landing-page', capturedAtMs: Date.now(),
  pixelId: 'px_1', metaAccountId: 'act_1', eventId: 'evt_1',
  submissionId: '6f1c2b1e-1111-4a6b-9c8d-000000000001',
  ...over,
});

const sideEffectCounts = () => ({
  createLead: (crmDb.createLead as jest.Mock).mock.calls.length,
  updateLead: (crmDb.updateLead as jest.Mock).mock.calls.length,
  dispatch: (dispatchLeadCreated as jest.Mock).mock.calls.length,
  capi: (metaService.sendCapiLeadEvent as jest.Mock).mock.calls.length,
  crmSync: (externalCrmSyncService.autoSyncLead as jest.Mock).mock.calls.length,
  alerts: (leadListAlertService.notifyLeadListOwnerIfConfigured as jest.Mock).mock.calls.length,
});

let leadSeq = 0;

beforeEach(() => {
  jest.clearAllMocks();
  leadSeq = 0;
  dynamo = new InMemoryDynamo({
    [CONFIGS]: { hash: 'userId', range: 'configId' },
    [DEV_CONFIGS]: { hash: 'userId', range: 'configId' },
  });
  __configureLeadSubmissionIdempotencyForTests({
    client: new (dynamo.documentClient as any)(),
    waitAttempts: 3,
    waitDelayMs: 5,
  });
  (crmDb.getLeadListById as jest.Mock).mockImplementation(async (listId: string) => ({
    listId, userId: 'user_1', name: 'Flatfee', publicAccessEnabled: true, autoDraftEnabled: false,
  }));
  (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
  (crmDb.createLead as jest.Mock).mockImplementation(async (listId: string, data: any) => ({
    ...data, listId, leadId: `lead_${++leadSeq}`,
  }));
  (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
  (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_1', connected_accounts: [] });
});

afterAll(() => __configureLeadSubmissionIdempotencyForTests({ client: null }));

describe('ENG-2837 forward-lead submission idempotency', () => {
  it('Flatfee shape: a repeated top-level submissionId replays the original response with no second write or side effect', async () => {
    const first = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    const afterFirst = sideEffectCounts();

    const second = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ success: true, leadId: 'lead_1', event: 'lead.created' });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(afterFirst).toMatchObject({ createLead: 1, capi: 1, crmSync: 2, alerts: 1 });
    expect(sideEffectCounts()).toEqual(afterFirst);
    // the key is still stored on the lead exactly as before (passthrough customFields)
    expect((crmDb.createLead as jest.Mock).mock.calls[0][1].customFields.submissionId)
      .toBe('6f1c2b1e-1111-4a6b-9c8d-000000000001');
  });

  it('a repeat that would have hit the existing-lead path still does not re-notify or re-sync', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({
      leadId: 'lead_old', listId: 'list_1', email: 'ana@example.com', firstName: 'Old',
      customFields: { source: 'landing-page' },
    });
    const first = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    const afterFirst = sideEffectCounts();
    const second = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();

    expect(first.body).toMatchObject({ success: true, leadId: 'lead_old' });
    expect(second.body).toEqual(first.body);
    expect(afterFirst.updateLead).toBe(1);
    expect(afterFirst.dispatch).toBe(1);
    expect(sideEffectCounts()).toEqual(afterFirst);
  });

  it('accepts the key nested as customFields.submissionId', async () => {
    const body = flatfee({ submissionId: undefined, customFields: { submissionId: 'nested-key-0001' } });
    const first = await request(app).post('/api/webhooks/forward-lead').send(body);
    await flush();
    const second = await request(app).post('/api/webhooks/forward-lead').send(body);
    await flush();
    expect(second.body).toEqual(first.body);
    expect(sideEffectCounts().createLead).toBe(1);
  });

  it('accepts a top-level idempotencyKey', async () => {
    const body = flatfee({ submissionId: undefined, idempotencyKey: 'idem-key-0001' });
    const first = await request(app).post('/api/webhooks/forward-lead').send(body);
    await flush();
    const second = await request(app).post('/api/webhooks/forward-lead').send(body);
    await flush();
    expect(second.body).toEqual(first.body);
    expect(sideEffectCounts()).toMatchObject({ createLead: 1, capi: 1 });
  });

  it('a malformed higher-priority key does not mask a valid submissionId: still dedupes', async () => {
    for (const bad of [12345, '   ', 'has spaces!', { nested: true }]) {
      jest.clearAllMocks();
      const body = flatfee({ idempotencyKey: bad, submissionId: `valid-under-${typeof bad}-${String(bad).length}` });
      const first = await request(app).post('/api/webhooks/forward-lead').send(body);
      await flush();
      const second = await request(app).post('/api/webhooks/forward-lead').send(body);
      await flush();
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(sideEffectCounts()).toMatchObject({ createLead: 1, capi: 1 });
    }
  });

  it('malformed top-level keys fall through to a valid customFields.submissionId', async () => {
    const body = flatfee({ idempotencyKey: '', submissionId: 987654321, customFields: { submissionId: 'nested-after-bad-0001' } });
    const first = await request(app).post('/api/webhooks/forward-lead').send(body);
    await flush();
    const second = await request(app).post('/api/webhooks/forward-lead').send(body);
    await flush();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(sideEffectCounts()).toMatchObject({ createLead: 1, capi: 1 });
  });

  it('the /api/leads/public/:listId alias is idempotent too', async () => {
    const body = flatfee({ listId: undefined });
    const first = await request(app).post('/api/leads/public/list_1').send(body);
    await flush();
    const second = await request(app).post('/api/leads/public/list_1').send(body);
    await flush();
    expect(first.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(sideEffectCounts().createLead).toBe(1);
  });

  it('different keys, and the same key on a different list, are independent', async () => {
    const a = await request(app).post('/api/webhooks/forward-lead').send(flatfee({ submissionId: 'key-a', email: 'a@example.com' }));
    const b = await request(app).post('/api/webhooks/forward-lead').send(flatfee({ submissionId: 'key-b', email: 'b@example.com' }));
    const c = await request(app).post('/api/webhooks/forward-lead').send(flatfee({ submissionId: 'key-a', email: 'a@example.com', listId: 'list_2' }));
    await flush();
    expect([a.body.leadId, b.body.leadId, c.body.leadId]).toEqual(['lead_1', 'lead_2', 'lead_3']);
    expect(sideEffectCounts().createLead).toBe(3);
  });

  it('no key: behaviour unchanged and nothing is written to the claim store', async () => {
    const body = flatfee({ submissionId: undefined });
    const first = await request(app).post('/api/webhooks/forward-lead').send(body);
    const second = await request(app).post('/api/webhooks/forward-lead').send(body);
    await flush();
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(sideEffectCounts().createLead).toBe(2);
    expect(claimItems()).toHaveLength(0);
  });

  it('concurrent duplicates: exactly one write, both callers get the same success and leadId', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (crmDb.createLead as jest.Mock).mockImplementation(async (listId: string, data: any) => {
      await gate;
      return { ...data, listId, leadId: `lead_${++leadSeq}` };
    });
    __configureLeadSubmissionIdempotencyForTests({ waitAttempts: 200, waitDelayMs: 5 });

    const p1 = request(app).post('/api/webhooks/forward-lead').send(flatfee()).then((r) => r);
    const p2 = request(app).post('/api/webhooks/forward-lead').send(flatfee()).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    await flush();

    expect(r1.body).toMatchObject({ success: true, leadId: 'lead_1' });
    expect(r2.body).toEqual(r1.body);
    expect(sideEffectCounts()).toMatchObject({ createLead: 1, capi: 1, crmSync: 2, alerts: 1 });
  });

  it('a failure BEFORE any lead write releases the claim, so the retry is processed', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    const failed = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(failed.status).toBe(500);
    expect(sideEffectCounts()).toMatchObject({ createLead: 0, dispatch: 0, capi: 0, crmSync: 0 });
    expect(claimItems()).toHaveLength(0);

    const retry = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ success: true, leadId: 'lead_1' });
    expect(sideEffectCounts()).toMatchObject({ createLead: 1, capi: 1, crmSync: 2 });
  });

  it('a failure AFTER a lead write may have started never releases the claim: retries get 409, no second write', async () => {
    // createLead can throw after its put landed; we cannot tell, so the key must stay taken.
    (crmDb.createLead as jest.Mock).mockRejectedValueOnce(new Error('timeout after write'));
    const failed = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(failed.status).toBe(500);

    const retry = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ success: false, retryable: true });
    // A claim stuck after a possible write never clears by itself: the 409 must say a
    // persistent 409 for this one submission needs operator reconciliation.
    expect(retry.body.message).toMatch(/persist/i);
    expect(retry.body.message).toMatch(/reconcil/i);
    expect(sideEffectCounts()).toMatchObject({ createLead: 1, dispatch: 0, capi: 0, crmSync: 0 });
    expect(claimItems()).toEqual([expect.objectContaining({ status: 'in_progress' })]);
  });

  it('claim-store outage fails CLOSED: 503 retryable, no lead write, no side effect', async () => {
    const outage = {
      put: () => ({ promise: () => Promise.reject(Object.assign(new Error('ServiceUnavailable'), { code: 'ServiceUnavailable' })) }),
      get: () => ({ promise: () => Promise.reject(new Error('ServiceUnavailable')) }),
      delete: () => ({ promise: () => Promise.reject(new Error('ServiceUnavailable')) }),
    };
    __configureLeadSubmissionIdempotencyForTests({ client: outage as any });
    const res = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.body).toMatchObject({ success: false, retryable: true });
    expect(sideEffectCounts()).toEqual({ createLead: 0, updateLead: 0, dispatch: 0, capi: 0, crmSync: 0, alerts: 0 });

    // store recovers: the same key is processed normally, exactly once
    __configureLeadSubmissionIdempotencyForTests({ client: new (dynamo.documentClient as any)() });
    const retry = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(retry.status).toBe(201);
    expect(sideEffectCounts()).toMatchObject({ createLead: 1, capi: 1 });
  });

  it.each([
    ['throws', () => Promise.reject(new Error('ServiceUnavailable'))],
    ['is rejected by its condition', () => Promise.reject(Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }))],
  ])('completion persistence that %s: 503 retryable, NO side effects, claim kept, retries never repeat the write', async (_label, failCompletion) => {
    const real = new (dynamo.documentClient as any)();
    const flaky = {
      get: (p: any) => real.get(p),
      delete: (p: any) => real.delete(p),
      put: (p: any) => (p.Item?.status === 'completed' ? { promise: failCompletion } : real.put(p)),
    };
    __configureLeadSubmissionIdempotencyForTests({ client: flaky as any });

    const res = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, retryable: true });
    expect(sideEffectCounts()).toEqual({ createLead: 1, updateLead: 0, dispatch: 0, capi: 0, crmSync: 0, alerts: 0 });
    // createLead was told not to notify at the write
    expect((crmDb.createLead as jest.Mock).mock.calls[0][1].deferCreatedNotification).toBe(true);

    __configureLeadSubmissionIdempotencyForTests({ client: real });
    const retry = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(retry.status).toBe(409);
    expect(sideEffectCounts()).toEqual({ createLead: 1, updateLead: 0, dispatch: 0, capi: 0, crmSync: 0, alerts: 0 });
  });

  it('every side effect fires only after the completed record is durable', async () => {
    const statusAtEffect: string[] = [];
    const snap = () => { statusAtEffect.push(claimItems().map((i) => i.status).join(',')); };
    (dispatchLeadCreated as jest.Mock).mockImplementation(async () => { snap(); });
    (metaService.sendCapiLeadEvent as jest.Mock).mockImplementation(async () => { snap(); return { success: true }; });
    (externalCrmSyncService.autoSyncLead as jest.Mock).mockImplementation(async () => { snap(); });

    const res = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(res.status).toBe(201);
    expect(sideEffectCounts()).toMatchObject({ dispatch: 1, capi: 1, crmSync: 2 });
    expect(statusAtEffect.length).toBeGreaterThanOrEqual(4);
    expect(statusAtEffect.every((s) => s === 'completed')).toBe(true);
  });

  it('unkeyed creates still notify at the write (createLead not told to defer)', async () => {
    await request(app).post('/api/webhooks/forward-lead').send(flatfee({ submissionId: undefined }));
    expect((crmDb.createLead as jest.Mock).mock.calls[0][1].deferCreatedNotification).toBeUndefined();
  });

  it('a duplicate arriving while the original is still in flight gets a retryable non-success, never a second write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (crmDb.createLead as jest.Mock).mockImplementation(async (listId: string, data: any) => {
      await gate;
      return { ...data, listId, leadId: `lead_${++leadSeq}` };
    });
    const p1 = request(app).post('/api/webhooks/forward-lead').send(flatfee()).then((r) => r);
    await new Promise((r) => setTimeout(r, 30));
    const dup = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ success: false, retryable: true });
    release();
    const r1 = await p1;
    await flush();
    expect(r1.status).toBe(201);
    expect(sideEffectCounts().createLead).toBe(1);

    // and once the original finished, the same retry now replays it
    const later = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    expect(later.body).toEqual(r1.body);
  });

  it('an OLD in-progress claim (owner died or stalled) is never taken over: 409, no write', async () => {
    const first = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    expect(first.status).toBe(201);
    // Rewind the stored claim to an hour-old in-flight state, as if the owner crashed or stalled.
    for (const item of claimItems()) {
      const table = dynamo.items(CONFIGS).includes(item) ? CONFIGS : DEV_CONFIGS;
      dynamo.seed(table, {
        userId: item.userId, configId: item.configId, status: 'in_progress',
        ownerToken: 'dead-owner', claimedAtMs: Date.now() - 60 * 60 * 1000,
      });
    }
    const before = sideEffectCounts();
    const retry = await request(app).post('/api/webhooks/forward-lead').send(flatfee());
    await flush();
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ success: false, retryable: true });
    expect(sideEffectCounts()).toEqual(before);
  });
});
