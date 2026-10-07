/**
 * ENG-2320 — what forward-lead's existing-lead merge hands to crmDb.updateLead.
 *
 * The merge used to send the whole merged customFields map, which updateLead wrote as one
 * overwrite and which therefore erased every key a concurrent repeat submission had just stored.
 * It now sends ONLY the keys this submission adds or changes, flagged `customFieldsKeyMerge`.
 * Everything that decides `changed` / `isUpdated` / `matchQualityBackfilled` is untouched and is
 * pinned byte-for-byte by webhooks.forwardLead.mergeEquivalence.test.ts; this file pins the call.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';

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

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);
const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

const OLD = '2020-01-01T00:00:00.000Z';
const existing = {
  leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', firstName: 'Ann',
  customFields: { source: 'hero-form', forwardedAt: OLD, a: 1, nested: { x: 1, y: 2 } },
};
const post = (body: any) => request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'a@b.com', ...body });
const write = () => (crmDb.updateLead as jest.Mock).mock.calls[0];

describe('forward-lead existing-lead merge — what is written (ENG-2320)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_123', userId: 'user_123', name: 'L', publicAccessEnabled: true });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
  });

  it('sends only the keys it adds, flagged for per-key writes — not the stored ones, and not an unchanged source', async () => {
    const res = await post({ customFields: { q1: 'yes' } }); // no source named => 'api' is synthesized and must NOT be written
    await flush();
    expect(res.body.event).toBe('lead.updated');
    const [listId, leadId, updates] = write();
    expect([listId, leadId]).toEqual(['list_123', 'lead_1']);
    expect(updates.customFieldsKeyMerge).toBe(true);
    expect(updates.customFields).toEqual({ q1: 'yes' });
  });

  it('sends a changed value but not the keys whose value is unchanged', async () => {
    await post({ source: 'hero-form', customFields: { a: 2, nested: { x: 1, y: 2 } } });
    await flush();
    expect(write()[2].customFields).toEqual({ a: 2 });
  });

  it('keeps the old change rule: a nested object whose key ORDER differs counts as changed and is rewritten', async () => {
    await post({ source: 'hero-form', customFields: { nested: { y: 2, x: 1 } } });
    await flush();
    expect(write()[2].customFields).toEqual({ nested: { y: 2, x: 1 } });
  });

  it('a named source that differs is written; the same named source is not', async () => {
    await post({ source: 'step2' });
    await flush();
    expect(write()[2].customFields).toEqual({ source: 'step2' });
    jest.clearAllMocks();
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing);
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_123', userId: 'user_123', name: 'L', publicAccessEnabled: true });
    const res = await post({ source: 'hero-form', customFields: { a: 1 } });
    await flush();
    expect(res.body.event).toBe('lead.unchanged');
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('carries no customFields at all (and no flag) when only a standard field changed', async () => {
    await post({ source: 'hero-form', lastName: 'Lee' });
    await flush();
    const updates = write()[2];
    expect(updates).toEqual({ lastName: 'Lee' });
  });

  it('a stored lead with no customFields gets the whole incoming set, source included', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123', email: 'a@b.com' });
    await post({ customFields: { q: 1 } });
    await flush();
    expect(write()[2].customFields).toEqual({ q: 1, source: 'api' });
  });

  it('the adopt path (a createLead that lost the race) writes the same per-key patch', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockRejectedValue(Object.assign(new Error('dup'), { duplicateEmail: true, existingLead: existing }));
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({ ...existing, customFields: { ...existing.customFields, winnerLate: 'kept' } });
    const res = await post({ source: 'hero-form', customFields: { q2: 'new' } });
    await flush();
    expect(res.status).toBe(200);
    expect(crmDb.getLeadById).toHaveBeenCalledWith('list_123', 'lead_1', { consistentRead: true });
    const updates = write()[2];
    expect(updates.customFieldsKeyMerge).toBe(true);
    // the winner's late key is not in the patch: it is never touched, so it survives
    expect(updates.customFields).toEqual({ q2: 'new' });
  });

  it('the match-quality / attribution fields still ride the same call, unchanged', async () => {
    await post({
      attribution: { timestamp: '2026-01-01T00:00:00.000Z', utm: { source: 'g', medium: 'cpc' } }, fbp: 'fb.1',
    });
    await flush();
    const updates = write()[2];
    expect(updates.lastTouch.utm.source).toBe('g');
    expect(updates.firstTouch.utm.source).toBe('g');
    expect(updates.utmSource).toBe('g');
    expect(updates.metaFbp).toBe('fb.1');
  });
});
