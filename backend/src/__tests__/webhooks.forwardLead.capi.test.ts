/**
 * ENG-449 — server-side Meta Conversions API (CAPI) send from the forward-lead webhook.
 *
 * pixelId/metaAccountId/eventId are baked into the generated app/api/capture/route.ts
 * (buildCaptureRoute) and forwarded here. This is the one place the CAPI send can safely
 * happen — it needs a Meta access token, which must never enter a generated customer repo.
 *
 * Must never affect the lead-save response: CAPI fires fire-and-forget, AFTER the response
 * is already sent, so a missing field or a Meta-side failure is invisible to the caller.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { metaService } from '../services/metaService';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/metaAccountCredentials', () => ({
  getMetaAccountCredentials: jest.fn(),
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() },
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() },
}));
jest.mock('../services/leadCaptureFailureService', () => ({
  recordLeadCaptureFailure: jest.fn(),
}));
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

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('ENG-449 — forward-lead CAPI send', () => {
  const mockLeadList = {
    listId: 'list_123',
    userId: 'user_123',
    name: 'Test List',
    publicAccessEnabled: true,
    autoDraftEnabled: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockLeadList);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123', email: 'test@example.com' });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
  });

  it('does not attempt CAPI when pixelId/eventId are missing — lead save is unaffected', async () => {
    const sendSpy = jest.spyOn(metaService, 'sendCapiLeadEvent');

    const response = await request(app)
      .post('/api/webhooks/forward-lead')
      .send({ listId: 'list_123', email: 'test@example.com' });

    await flushAsyncWork();

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('attempts CAPI when pixelId + metaAccountId + eventId are all present', async () => {
    const sendSpy = jest.spyOn(metaService, 'sendCapiLeadEvent').mockResolvedValue({ success: true, fbtraceId: 'trace1' });

    const response = await request(app)
      .post('/api/webhooks/forward-lead')
      .send({
        listId: 'list_123',
        email: 'test@example.com',
        pixelId: '1430870751246428',
        metaAccountId: 'acc1',
        eventId: 'evt_client_abc',
      });

    await flushAsyncWork();

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(
      '1430870751246428',
      'tok',
      expect.objectContaining({ eventId: 'evt_client_abc', email: 'test@example.com' }),
    );
  });

  it('CAPI throwing does not affect the already-sent lead-save response', async () => {
    (getMetaAccountCredentials as jest.Mock).mockRejectedValue(new Error('token expired'));

    const response = await request(app)
      .post('/api/webhooks/forward-lead')
      .send({
        listId: 'list_123',
        email: 'test@example.com',
        pixelId: '1430870751246428',
        metaAccountId: 'acc1',
        eventId: 'evt_client_abc',
      });

    await flushAsyncWork();

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
  });

  it('sendCapiLeadEvent returning failure does not affect the response (log-only)', async () => {
    jest.spyOn(metaService, 'sendCapiLeadEvent').mockResolvedValue({ success: false, error: 'Invalid parameter' });

    const response = await request(app)
      .post('/api/webhooks/forward-lead')
      .send({
        listId: 'list_123',
        email: 'test@example.com',
        pixelId: '1430870751246428',
        metaAccountId: 'acc1',
        eventId: 'evt_client_abc',
      });

    await flushAsyncWork();

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
  });

  it('the CAPI event_id matches the client-sent eventId (AC2 dedup assertion)', async () => {
    const sendSpy = jest.spyOn(metaService, 'sendCapiLeadEvent').mockResolvedValue({ success: true });

    await request(app)
      .post('/api/webhooks/forward-lead')
      .send({
        listId: 'list_123',
        email: 'test@example.com',
        firstName: 'Jane',
        pixelId: '1430870751246428',
        metaAccountId: 'acc1',
        eventId: 'evt_dedup_check_1',
      });

    await flushAsyncWork();

    const call = sendSpy.mock.calls[0];
    expect(call[2].eventId).toBe('evt_dedup_check_1');
  });
});
