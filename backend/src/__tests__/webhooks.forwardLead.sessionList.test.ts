/**
 * ENG-2311 — forward-lead must cause NO lead side effects for a session list, and must be
 * byte-identical for every other list.
 *
 * A session list receives one row per visitor session (thousands per list). Each of the
 * effects below would fan out per visit: CRM pushes, drip enrolment, an auto-drafted/sent
 * email to a synthetic address, owner alerts, Meta CAPI conversions, the roadmap email.
 *
 * The decision is taken from the list row the DB returned. The request body is public and
 * CORS-open, so a body that CLAIMS to be a session list (or to suppress effects) must change
 * nothing.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { leadListAlertService } from '../services/leadListAlertService';
import { agentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';
import { sendRoadmapDeliveryEmail } from '../services/roadmapDelivery';

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
  agentModeService: {
    updateEmailDraftForLead: jest.fn().mockResolvedValue({ skipped: true, reason: 'test' }),
    getCrmSenders: jest.fn(),
  },
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'email_1' }) },
}));
jest.mock('../services/roadmapDelivery', () => ({ sendRoadmapDeliveryEmail: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(), verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(), generateEventId: jest.fn(),
  },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() },
}));
// The Slack notification hook reads the list through the REAL service below db; keep it inert.
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn().mockResolvedValue(undefined) }));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const BASE_LIST = {
  userId: 'user_123', name: 'L', publicAccessEnabled: true,
  autoDraftEnabled: true, autoSendEnabled: true,
};
const listRow = (listId: string, listType?: string) => ({ ...BASE_LIST, listId, ...(listType ? { listType } : {}) });

const BODY = {
  email: 's-abcdef12@sessions.go.dramabreak.ai',
  source: 'lp',
  customFields: { stage: '2' },
  pixelId: 'px1', metaAccountId: 'ma1', eventId: 'ev1',
};

async function post(listId: string, extra: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/webhooks/forward-lead').send({ listId, ...BODY, ...extra });
  await flush();
  return res;
}

function expectNoSideEffects() {
  expect(externalCrmSyncService.autoSyncLead).not.toHaveBeenCalled();
  expect(dripSequenceDb.getSequencesByAutoEnrollList).not.toHaveBeenCalled();
  expect(agentModeService.updateEmailDraftForLead).not.toHaveBeenCalled();
  expect(leadListAlertService.notifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();
  expect(sendRoadmapDeliveryEmail).not.toHaveBeenCalled();
  expect(metaService.sendCapiLeadEvent).not.toHaveBeenCalled();
  expect(getMetaAccountCredentials).not.toHaveBeenCalled();
}

describe('forward-lead side-effect gating (ENG-2311)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(metaService, 'sendCapiLeadEvent').mockResolvedValue({ success: true } as any);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => ({ leadId: 'lead_1', listId: 'x', email: d.email, customFields: d.customFields }));
    (crmDb.updateLead as jest.Mock).mockResolvedValue({});
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' });
  });

  it('session list: row is still created (201, same body shape) but NOTHING fires', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(listRow('S1', 'session'));
    const res = await post('S1');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, message: 'Lead forwarded successfully', event: 'lead.created', leadId: 'lead_1', listId: 'S1' });
    expect(crmDb.createLead).toHaveBeenCalledTimes(1);
    expect((crmDb.createLead as jest.Mock).mock.calls[0][1].suppressSideEffects).toBe(true);
    expectNoSideEffects();
  });

  it('session list, EXISTING row (update path): still updates, nothing fires', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(listRow('S1', 'session'));
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({ leadId: 'lead_9', listId: 'S1', email: BODY.email, customFields: { stage: '1' } });
    const res = await post('S1');

    expect(res.status).toBe(200);
    expect(res.body.event).toBe('lead.updated');
    expect(crmDb.updateLead).toHaveBeenCalledTimes(1);
    expectNoSideEffects();
  });

  it.each([[undefined], ['sales'], ['customers']])(
    'listType %p: every side effect still fires and createLead input carries no suppress flag',
    async (listType) => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValue(listRow('L1', listType as string | undefined));
      const res = await post('L1');

      expect(res.status).toBe(201);
      expect('suppressSideEffects' in (crmDb.createLead as jest.Mock).mock.calls[0][1]).toBe(false);
      expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalledTimes(2); // hubspot + attio
      expect(dripSequenceDb.getSequencesByAutoEnrollList).toHaveBeenCalledTimes(1);
      expect(agentModeService.updateEmailDraftForLead).toHaveBeenCalledTimes(1);
      expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledTimes(1);
      expect(sendRoadmapDeliveryEmail).toHaveBeenCalledTimes(1);
      expect(metaService.sendCapiLeadEvent).toHaveBeenCalledTimes(1);
    },
  );

  it('a request body claiming to be a session list / to suppress effects changes nothing on a sales list', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(listRow('L1', 'sales'));
    await post('L1', { listType: 'session', suppressSideEffects: true, customFields: { stage: '2', listType: 'session' } });

    expect('suppressSideEffects' in (crmDb.createLead as jest.Mock).mock.calls[0][1]).toBe(false);
    expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalledTimes(2);
    expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledTimes(1);
  });
});
