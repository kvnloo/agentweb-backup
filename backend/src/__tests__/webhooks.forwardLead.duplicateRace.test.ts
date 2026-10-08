/**
 * forward-lead: a createLead that LOSES a duplicate-email race adopts the existing row.
 *
 * getLeadByEmail (eventually-consistent GSI) can miss a row that createLead's own pre-check
 * then finds. That used to throw into the outer catch: 500 + an api.lead_failed owner alert,
 * and the visitor's data was dropped. Invariants: 200, the incoming data is merged into the
 * carried row, no failure alert, and the existing lead's capture time is preserved.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';
import { dispatchLeadCreated } from '../services/orgLeadNotificationService';
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
  webhookService: {
    initialize: jest.fn(), verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(), generateEventId: jest.fn(),
  },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};


const dupErr = (existingLead: any) =>
  Object.assign(new Error(`Lead with email "${existingLead.email}" already exists in this list`), {
    duplicateEmail: true, existingLead,
  });

describe('forward-lead — lost duplicate-email race', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list_123', userId: 'user_123', name: 'Test List',
      publicAccessEnabled: true, autoDraftEnabled: false,
    });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123', email: 'race@example.com' });
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    // default: the consistent re-read agrees with the carried snapshot
    (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
  });

  const existing = {
    leadId: 'lead_winner', listId: 'list_123', email: 'race@example.com', firstName: 'Ann',
    customFields: { source: 'lp-a', forwardedAt: '2020-01-01T00:00:00.000Z', q1: 'old' },
  };

  it('returns 200, merges incoming customFields into the carried row, keeps its forwardedAt, no failure alert', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(dupErr(existing));

    const res = await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123', email: 'race@example.com', lastName: 'Lee', q2: 'new', source: 'lp-b',
    });
    await flush();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, event: 'lead.updated', leadId: 'lead_winner' });
    expect(crmDb.updateLead).toHaveBeenCalledTimes(1);
    const [listId, leadId, updates] = (crmDb.updateLead as jest.Mock).mock.calls[0];
    expect([listId, leadId]).toEqual(['list_123', 'lead_winner']);
    expect(updates.lastName).toBe('Lee');
    // ENG-2320: customFields reaches updateLead as a per-key PATCH (only what this submission
    // adds/changes), so the carried row's q1 and forwardedAt are never rewritten at all.
    expect(updates.customFieldsKeyMerge).toBe(true);
    expect(updates.customFields).toEqual({ q2: 'new', source: 'lp-b' });
    expect(leadListAlertService.notifyLeadListOwnerIfConfigured).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'api.lead_failed', expect.anything(), expect.anything(),
    );
    // a repeat submission notifies like any other repeat
    expect(dispatchLeadCreated).toHaveBeenCalledWith('list_123', 'lead_winner', 'form_fill', expect.any(Object));
  });

  it('merges into the CONSISTENT re-read of the winner, so keys it wrote after the GSI snapshot survive', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(dupErr(existing));
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      ...existing, customFields: { ...existing.customFields, winnerLate: 'kept' },
    });

    const res = await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123', email: 'race@example.com', q2: 'new',
    });
    await flush();

    expect(res.status).toBe(200);
    expect(crmDb.getLeadById).toHaveBeenCalledWith('list_123', 'lead_winner', { consistentRead: true });
    // ENG-2320: the winner's late key is not in the patch because it is never written, so it survives.
    expect((crmDb.updateLead as jest.Mock).mock.calls[0][2].customFields).toEqual({ q2: 'new' });
  });

  it('falls back to the carried row when the consistent read returns nothing', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(dupErr(existing));
    const res = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'race@example.com', q2: 'new' });
    await flush();
    expect(res.status).toBe(200);
    expect((crmDb.updateLead as jest.Mock).mock.calls[0][2].customFields).toEqual({ q2: 'new' });
  });

  it('a repeat that carries nothing new is a 200 unchanged with no write', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(dupErr(existing));
    const res = await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123', email: 'race@example.com', firstName: 'Ann', q1: 'old',
    });
    await flush();
    expect(res.status).toBe(200);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a duplicate-looking error WITHOUT the typed marker still fails as before (500 + alert)', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(new Error('Lead with email "x" already exists in this list'));
    const res = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'race@example.com' });
    expect(res.status).toBe(500);
    expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'api.lead_failed', expect.anything(), expect.anything(),
    );
  });

  it('other paths unchanged: no race -> 201 create; getLeadByEmail hit -> merge, createLead never called', async () => {
    const created = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'new@example.com' });
    expect(created.status).toBe(201);
    expect((crmDb.createLead as jest.Mock).mock.calls[0][1].customFields.forwardedAt).toEqual(expect.any(String));

    (crmDb.createLead as jest.Mock).mockClear();
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing);
    const merged = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'race@example.com', q2: 'new' });
    await flush();
    expect(merged.status).toBe(200);
    expect(crmDb.createLead).not.toHaveBeenCalled();
    // forwardedAt is never rewritten: it is absent from the per-key patch (ENG-2320)
    expect((crmDb.updateLead as jest.Mock).mock.calls[0][2].customFields).toEqual({ q2: 'new' });
  });
});

describe('forward-lead — ENG-2321 exactly-once create wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123', email: 'race@example.com' });
    (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
  });
  const list = (extra: any = {}) => (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
    listId: 'list_123', userId: 'user_123', name: 'Test List', publicAccessEnabled: true, autoDraftEnabled: false, ...extra,
  });
  const createArg = () => (crmDb.createLead as jest.Mock).mock.calls[0][1];

  it('an email lead on an ordinary list asks createLead for the exactly-once create', async () => {
    list();
    await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'race@example.com' });
    expect(createArg().emailUniqueCreate).toBe(true);
  });

  it('a phone-only lead does not (its create path is unchanged)', async () => {
    list();
    await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', phone: '+14155550142' });
    expect(crmDb.createLead).toHaveBeenCalled();
    expect(createArg()).not.toHaveProperty('emailUniqueCreate');
  });

  it('a session list (no valid identity -> fallback create) does not either', async () => {
    list({ listType: 'session' });
    await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'race@example.com' });
    expect(createArg()).not.toHaveProperty('emailUniqueCreate');
  });

  it('a lost race (typed duplicate from the transaction) is a repeat: one create attempt, merge, no new-lead side effects', async () => {
    list();
    const winner = { leadId: 'lead_1700000000000_abcdef012345', listId: 'list_123', email: 'race@example.com', customFields: { forwardedAt: '2020-01-01T00:00:00.000Z' } };
    (crmDb.createLead as jest.Mock).mockRejectedValue(dupErr(winner));
    (crmDb.getLeadById as jest.Mock).mockResolvedValue(winner);
    const res = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'race@example.com', q: 1 });
    await flush();
    expect(res.status).toBe(200);
    expect(res.body.event).toBe('lead.updated');
    expect(crmDb.createLead).toHaveBeenCalledTimes(1);
    expect(crmDb.getLeadById).toHaveBeenCalledWith('list_123', winner.leadId, { consistentRead: true });
  });
});

