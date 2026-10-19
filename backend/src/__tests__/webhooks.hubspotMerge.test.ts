/**
 * ENG-2465 — the shared HubSpot webhook (/api/webhooks/hubspot) handles contact.merge:
 * the event is carried in the durable job payload and, when processed, re-points the
 * stored contact id on the lists connected to THAT portal only.
 */
import request from 'supertest';
import express from 'express';
import webhookRouter, { processHubspotWebhookJob } from '../routes/webhooks';
import { crmDb } from '../services/db';
import { getUserIdByHubSpotPortalId } from '../services/connectedAccountsDb';
import { enqueueJob, markJobComplete } from '../services/asyncJobQueue';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadByHubSpotContactId: jest.fn(),
    updateLead: jest.fn(),
    getLeadByEmail: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/connectedAccountsDb', () => ({
  getUserIdByHubSpotPortalId: jest.fn(),
  getAccountsByAttioWorkspaceId: jest.fn(),
}));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(),
  markJobComplete: jest.fn().mockResolvedValue(undefined),
  markJobFailed: jest.fn().mockResolvedValue(undefined),
  registerProcessor: jest.fn(),
  startHeartbeat: jest.fn(() => () => undefined),
}));
jest.mock('../services/hubspotService', () => ({ HubSpotService: { create: jest.fn().mockResolvedValue({}) } }));
jest.mock('../config/integrations', () => ({ getHubSpotClientSecretForAppId: jest.fn().mockResolvedValue('s') }));
jest.mock('../services/metaAccountCredentials', () => ({ getMetaAccountCredentials: jest.fn() }));
jest.mock('../services/dripSequenceDb', () => ({ dripSequenceDb: {} }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: { getConfig: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/roadmapDelivery', () => ({ sendRoadmapDeliveryEmail: jest.fn() }));
jest.mock('../services/webhookService', () => ({ webhookService: { initialize: jest.fn() } }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn() }));

const PORTAL = 245815183;
const mergeEvent = { subscriptionType: 'contact.merge', portalId: PORTAL, appId: 1, objectId: 200, primaryObjectId: 200, mergedObjectIds: [101], newObjectId: 200 };
const listFor = (listId: string, accountId?: string) => ({ listId, externalCrmSyncConfigs: accountId ? { hubspot: { accountId } } : {} });
const holder = (id: string) => ({ leadId: 'lead-1', syncMetadata: { hubspot_contact_id: id, syncStatus: 'synced' } });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  (getUserIdByHubSpotPortalId as jest.Mock).mockResolvedValue('user-1');
  (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('processHubspotWebhookJob — contact.merge', () => {
  const payload = { changesByObjectId: {}, merges: [{ portalId: PORTAL, survivorId: '200', mergedIds: ['101'] }] };

  it('re-points the stored id on lists connected to this portal, and ONLY those', async () => {
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([
      listFor('L-this', String(PORTAL)), listFor('L-other-portal', '999'), listFor('L-unconnected'),
    ]);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValueOnce(holder('101')).mockResolvedValue(null);

    await processHubspotWebhookJob(payload as any);

    // one lookup per matching lead plus the one that finds nothing, and only on the portal's own list
    expect((crmDb.getLeadByHubSpotContactId as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['L-this', 'L-this']);
    expect(crmDb.getLeadByHubSpotContactId).toHaveBeenCalledWith('L-this', '101');
    expect(crmDb.updateLead).toHaveBeenCalledTimes(1);
    expect(crmDb.updateLead).toHaveBeenCalledWith('L-this', 'lead-1', { syncMetadata: { hubspot_contact_id: '200', syncStatus: 'synced' } });
  });

  it('does nothing when no user owns the portal', async () => {
    (getUserIdByHubSpotPortalId as jest.Mock).mockResolvedValue(null);
    await processHubspotWebhookJob(payload as any);
    expect(crmDb.getLeadListsByUserId).not.toHaveBeenCalled();
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a merge that fails makes the JOB fail, so the durable queue retries it', async () => {
    (crmDb.getLeadListsByUserId as jest.Mock).mockRejectedValue(new Error('dynamo down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(processHubspotWebhookJob(payload as any)).rejects.toThrow(/could not be re-pointed/);
  });

  it('a throttled lookup inside a list also fails the job, but the rest of the delivery is still applied first', async () => {
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([listFor('L-this', String(PORTAL))]);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockRejectedValue(new Error('throttled'));
    const withChange = { ...payload, changesByObjectId: { '5': { portalId: PORTAL, properties: {}, isCreation: false, isDeleted: false, isDealChange: false } } };
    await expect(processHubspotWebhookJob(withChange as any)).rejects.toThrow(/could not be re-pointed/);
    expect(getUserIdByHubSpotPortalId).toHaveBeenCalledTimes(2);   // once for the merge, once for the contact change
  });

  it('a successful merge does not fail the job', async () => {
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([listFor('L-this', String(PORTAL))]);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValueOnce(holder('101')).mockResolvedValue(null);
    await expect(processHubspotWebhookJob(payload as any)).resolves.toBeUndefined();
  });

  it('a job queued before merges existed (no `merges` field) still processes', async () => {
    await expect(processHubspotWebhookJob({ changesByObjectId: {} } as any)).resolves.toBeUndefined();
    expect(crmDb.getLeadListsByUserId).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/hubspot — contact.merge', () => {
  const app = express();
  app.use('/api/webhooks/hubspot', express.raw({ type: '*/*' }));
  app.use('/api/webhooks', webhookRouter);
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

  it('carries the merge in the durable job payload, and the processed job re-points the id', async () => {
    (enqueueJob as jest.Mock).mockResolvedValue('enqueued');
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([listFor('L-this', String(PORTAL))]);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValueOnce(holder('101')).mockResolvedValue(null);

    await request(app).post('/api/webhooks/hubspot').set('content-type', 'application/json').send(JSON.stringify([mergeEvent]));
    await flush();

    const queued = (enqueueJob as jest.Mock).mock.calls[0][2];
    expect(queued.merges).toEqual([{ survivorId: '200', mergedIds: ['101'], portalId: PORTAL }]);
    expect(queued.changesByObjectId).toEqual({});     // a merge event is not also treated as a contact change
    expect(crmDb.updateLead).toHaveBeenCalledWith('L-this', 'lead-1', expect.objectContaining({ syncMetadata: expect.objectContaining({ hubspot_contact_id: '200' }) }));
    expect(markJobComplete).toHaveBeenCalled();
  });

  it('a delivery with no merge keeps the old payload shape (no `merges` key)', async () => {
    (enqueueJob as jest.Mock).mockResolvedValue('enqueued');
    (getUserIdByHubSpotPortalId as jest.Mock).mockResolvedValue(null);

    await request(app).post('/api/webhooks/hubspot').set('content-type', 'application/json')
      .send(JSON.stringify([{ subscriptionType: 'contact.deletion', portalId: PORTAL, appId: 1, objectId: 5 }]));
    await flush();

    const queued = (enqueueJob as jest.Mock).mock.calls[0][2];
    expect('merges' in queued).toBe(false);
    expect(Object.keys(queued.changesByObjectId)).toEqual(['5']);
  });
});
