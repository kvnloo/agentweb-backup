/**
 * ENG-2312 — forward-lead on a SESSION list with a valid session identity bypasses the
 * eventually-consistent email-index read and targets one deterministic row.
 *
 * Asserts the wiring only (the DB shapes and atomicity are pinned/proved elsewhere): which
 * crmDb calls are made, with which ids and flags, and that the decision to use this path is
 * taken from the list row from the DB — never from the request body.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { sessionLeadId } from '../utils/sessionList';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
    mergeSessionLeadEvent: jest.fn(),
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
jest.mock('../services/roadmapDelivery', () => ({ sendRoadmapDeliveryEmail: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/webhookService', () => ({
  webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() } }));
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn().mockResolvedValue(undefined) }));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

const SID = 'abcd1234-ef56-7890';
const START = Date.now() - 60_000;
const SESSION_EMAIL = `s-${SID}@sessions.go.dramabreak.ai`;
const list = (listType?: string) => ({
  listId: 'L1', userId: 'u1', name: 'Sessions', publicAccessEnabled: true, ...(listType ? { listType } : {}),
});
const expectedId = sessionLeadId('L1', { sessionId: SID, sessionStartMs: START });
const body = (extra: Record<string, any> = {}) => ({
  listId: 'L1', email: SESSION_EMAIL, source: 'lp',
  customFields: { sessionId: SID, dwellSec: 5, eventCount: 1 }, sessionStartMs: START, ...extra,
});
const post = async (b: any) => { const r = await request(app).post('/api/webhooks/forward-lead').send(b); await flush(); return r; };
const created = () => (crmDb.createLead as jest.Mock).mock.calls[0][1];
const leadAlreadyExists = () => Object.assign(new Error('Lead already exists for this deterministic key'), { leadAlreadyExists: true });

describe('forward-lead session upsert (ENG-2312)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(list('session'));
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => ({ ...d, listId: 'L1' }));
    (crmDb.mergeSessionLeadEvent as jest.Mock).mockResolvedValue({ exists: true, changed: true, guardApplied: true });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', connected_accounts: [] });
  });

  it('creator: no email-index read; conditional create on the deterministic id; 201 lead.created', async () => {
    const res = await post(body());

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, message: 'Lead forwarded successfully', event: 'lead.created', leadId: expectedId, listId: 'L1' });
    expect(crmDb.getLeadByEmail).not.toHaveBeenCalled();
    expect(crmDb.createLead).toHaveBeenCalledTimes(1);
    expect(created()).toMatchObject({ leadId: expectedId, failIfExists: true, skipEmailDuplicateCheck: true, suppressSideEffects: true, email: SESSION_EMAIL });
    expect(created().customFields.forwardedAt).toEqual(expect.any(String));
    expect(crmDb.mergeSessionLeadEvent).not.toHaveBeenCalled();
  });

  it('sessionStartMs does not leak into customFields as passthrough junk', async () => {
    await post(body());
    expect(created().customFields).not.toHaveProperty('sessionStartMs');
    expect(created().customFields.sessionId).toBe(SID); // sessionId is still stored, as today
  });

  it('loser: createLead says leadAlreadyExists => atomic merge, never updateLead; 200 lead.updated', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(leadAlreadyExists());
    const res = await post(body({ customFields: { sessionId: SID, dwellSec: 9, eventCount: 3, journey: 'a>b' } }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event: 'lead.updated', leadId: expectedId });
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(crmDb.getLeadByEmail).not.toHaveBeenCalled();
    const [listId, leadId, plan] = (crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls[0];
    expect([listId, leadId]).toEqual(['L1', expectedId]);
    expect(plan.monotonic).toEqual([expect.objectContaining({ counterKey: 'eventCount', counter: 3 })]);
    expect(plan.customFields).toMatchObject({ dwellSec: 9, sessionId: SID });
    expect(JSON.stringify(plan)).not.toContain('forwardedAt');
  });

  it('loser with nothing new reports lead.unchanged (200)', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(leadAlreadyExists());
    (crmDb.mergeSessionLeadEvent as jest.Mock).mockResolvedValue({ exists: true, changed: false, guardApplied: true });
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(res.body.event).toBe('lead.unchanged');
  });

  it('a counter sent as a numeric string is stored/compared as a number', async () => {
    await post(body({ customFields: { sessionId: SID, eventCount: '4' } }));
    expect(created().customFields.eventCount).toBe(4);
  });

  it('a clickCount sent as a numeric string is coerced too (CLICKS group guard)', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(leadAlreadyExists());
    await post(body({ customFields: { sessionId: SID, eventCount: '4', clickCount: '2', clickLog: ['a'] } }));
    const [, , plan] = (crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls[0];
    expect(plan.monotonic).toEqual([
      expect.objectContaining({ counterKey: 'eventCount', counter: 4 }),
      expect.objectContaining({ counterKey: 'clickCount', counter: 2 }),
    ]);
  });

  it('row deleted between the failed create and the merge: retries the create once', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValueOnce(leadAlreadyExists());
    (crmDb.mergeSessionLeadEvent as jest.Mock).mockResolvedValue({ exists: false, changed: false, guardApplied: null });
    const res = await post(body());
    expect(crmDb.createLead).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(201);
  });

  it('a non-race createLead failure still surfaces as 500 (not swallowed as a "loser")', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await post(body());
    expect(res.status).toBe(500);
    expect(crmDb.mergeSessionLeadEvent).not.toHaveBeenCalled();
  });

  describe('falls back to the UNCHANGED legacy path', () => {
    const legacyUsed = () => {
      expect(crmDb.getLeadByEmail).toHaveBeenCalledTimes(1);
      expect(crmDb.mergeSessionLeadEvent).not.toHaveBeenCalled();
      expect('leadId' in created()).toBe(false);
      expect('skipEmailDuplicateCheck' in created()).toBe(false);
    };

    it('when sessionStartMs is missing (legacy LP)', async () => {
      await post(body({ sessionStartMs: undefined }));
      legacyUsed();
    });
    it.each([
      ['older than 48h', Date.now() - 49 * 3600e3],
      ['more than 5 minutes ahead', Date.now() + 10 * 60e3],
      ['not an integer', 1.5],
    ])('when sessionStartMs is %s', async (_n, bad) => {
      await post(body({ sessionStartMs: bad }));
      legacyUsed();
    });
    it('when the session id is malformed', async () => {
      await post(body({ customFields: { sessionId: 'x' } }));
      legacyUsed();
    });
  });

  describe('gated on the list row from the DB, never the body', () => {
    it.each([[undefined], ['sales'], ['customers']])(
      'listType %p: a body carrying a perfect session identity (and a lying listType) uses the legacy path',
      async (listType) => {
        (crmDb.getLeadListById as jest.Mock).mockResolvedValue(list(listType as string | undefined));
        await post(body({ listType: 'session', customFields: { sessionId: SID, listType: 'session' } }));

        expect(crmDb.getLeadByEmail).toHaveBeenCalledTimes(1);
        expect(crmDb.mergeSessionLeadEvent).not.toHaveBeenCalled();
        expect('leadId' in created()).toBe(false);
        expect('failIfExists' in created()).toBe(false);
        expect('skipEmailDuplicateCheck' in created()).toBe(false);
      },
    );
  });
});
