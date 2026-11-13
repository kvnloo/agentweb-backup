/**
 * ENG-2783: the REAL forward-lead handler and the REAL hot-lead call gates together. The handler creates the lead on the in-memory CRM
 * (the stand-in for db.createLead also fires the real create hook, dispatchLeadCreated, as db.createLead does), and the real orchestrator,
 * LeadCallStore and gates decide. A submission with a valid consent for the submitted phone places a call; without it, call.skipped no_call_consent.
 * What stays unproven: the real db.createLead / DynamoDB put (see crm tests) and the AI-built form.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));
jest.mock('../services/metaAccountCredentials', () => ({ getMetaAccountCredentials: jest.fn() }));
jest.mock('../services/dripSequenceDb', () => ({ dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() } }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
jest.mock('../services/roadmapDelivery', () => ({ sendRoadmapDeliveryEmail: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { updateEmailDraftForLead: jest.fn(), getCrmSenders: jest.fn() } }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'e' }) } }));
jest.mock('../services/webhookService', () => ({ webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() } }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() } }));

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { dispatchLeadCreated } from '../services/orgLeadNotificationService';
import { buildCallConsentNotice } from '../services/voice/callConsent';
import { eventsOf, flush, installWorld, LIST, recordOf, skipReason, world } from './helpers/hotLeadCallE2eWorld';
import type { FakeLead } from './helpers/hotLeadCallFakeCrm';

installWorld();

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const TEXT = buildCallConsentNotice('Acme Plumbing LLC');
let seq = 0;

beforeEach(() => {
  seq = 0;
  // installWorld's jest.resetAllMocks() cleared the module mocks above; restore the ones the handler awaits.
  jest.requireMock('../services/roadmapDelivery').sendRoadmapDeliveryEmail.mockResolvedValue(false);
  jest.requireMock('../services/dripSequenceDb').dripSequenceDb.getSequencesByAutoEnrollList.mockResolvedValue([]);
  jest.requireMock('../services/externalCrmSyncService').externalCrmSyncService.autoSyncLead.mockResolvedValue(undefined);
  jest.requireMock('../services/leadListAlertService').leadListAlertService.notifyLeadListOwnerIfConfigured.mockResolvedValue(undefined);
  jest.requireMock('../services/resendService').resendService.sendSystemEmail.mockResolvedValue({ id: 'e' });
  world.crm.lists.set(LIST, { ...world.crm.lists.get(LIST), publicAccessEnabled: true });
  const crmDb = world.crm.crmDb as unknown as Record<string, unknown>;
  crmDb.getLeadByEmail = async () => null;
  crmDb.updateLead = async () => undefined;
  // The stand-in for db.createLead: stores the row exactly as given (including `system`), then fires the create hook like db.createLead does.
  crmDb.createLead = async (listId: string, data: Record<string, unknown>, origin: 'form_fill') => {
    const lead: FakeLead = { ...data, listId, leadId: `lead_${++seq}`, createdAt: new Date().toISOString(), engagements: [] };
    world.crm.addLead(lead, { consent: false });
    void dispatchLeadCreated(listId, lead.leadId, origin);
    return lead;
  };
});

const post = (body: Record<string, unknown>) => request(app).post('/api/webhooks/forward-lead')
  .set('X-Forwarded-For', '93.184.216.34').set('User-Agent', 'Mozilla/5.0 test')
  .send({ listId: LIST, email: 'jane@example.com', firstName: 'Jane', phone: '(212) 555-0142', ...body });

describe('forward-lead -> real call gates', () => {
  it('a valid callConsent for the submitted phone: the lead is created with it and the call is placed', async () => {
    const res = await post({ callConsent: { granted: true, text: TEXT, version: 'v1' } });
    await flush();
    expect(res.status).toBe(201);
    expect(world.crm.lead(LIST, 'lead_1').system?.callConsent).toMatchObject({ granted: true, phoneDigits: '12125550142', source: 'form' });
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(recordOf('lead_1')).toBeDefined();
  });

  it('no callConsent: the lead is created, call.skipped no_call_consent, nothing dialed', async () => {
    const res = await post({});
    await flush();
    expect(res.status).toBe(201);
    expect(eventsOf('lead_1')).toEqual(['call.skipped']);
    expect(skipReason('lead_1')).toEqual({ reason: 'no_call_consent' });
    expect(world.provider.placedCalls).toEqual([]);
  });

  it('an unticked box (granted: false) is the same as no consent', async () => {
    await post({ callConsent: { granted: false, text: TEXT, version: 'v1' } });
    await flush();
    expect(skipReason('lead_1')).toEqual({ reason: 'no_call_consent' });
    expect(world.provider.placedCalls).toEqual([]);
  });
});
