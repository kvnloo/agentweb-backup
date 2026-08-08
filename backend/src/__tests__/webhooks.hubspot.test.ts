/**
 * Tests for the shared HubSpot OAuth webhook handler
 * POST /api/webhooks/hubspot
 *
 * Covers:
 *  - Fire-and-forget (immediate 200 response)
 *  - Signature verification (accept / reject)
 *  - contact.creation: fetches full contact via getContactById
 *  - contact.propertyChange: maps standard + custom fields
 *  - contact.deletion: marks lead as crmRemoved
 *  - portalId → userId routing (skip unknown portals)
 */

import request from 'supertest';
import express from 'express';
import * as crypto from 'crypto';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../services/webhookService', () => ({
  webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn().mockResolvedValue(false), createEvent: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() } }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/emmaEmailService', () => ({ emmaEmailService: { isEmmaRelatedEvent: jest.fn().mockReturnValue(false) } }));
jest.mock('../utils/leadContactStatus', () => ({ isDoNotContact: jest.fn().mockReturnValue(false) }));

const mockGetLeadListsByUserId = jest.fn();
const mockGetLeadByEmail = jest.fn();
const mockUpdateLead = jest.fn();
const mockCreateLead = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: (...a: any[]) => mockGetLeadListsByUserId(...a),
    getLeadByEmail: (...a: any[]) => mockGetLeadByEmail(...a),
    updateLead: (...a: any[]) => mockUpdateLead(...a),
    createLead: (...a: any[]) => mockCreateLead(...a),
    getLeadListById: jest.fn(),
  },
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() },
  tempEmailDb: { getTempEmail: jest.fn() },
}));

const mockGetUserIdByHubSpotPortalId = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getUserIdByHubSpotPortalId: (...a: any[]) => mockGetUserIdByHubSpotPortalId(...a),
}));

const mockGetSyncConfig = jest.fn();
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    getConfig: (...a: any[]) => mockGetSyncConfig(...a),
  },
}));

const mockGetContactById = jest.fn();
const mockGetContactEmailById = jest.fn();
const mockGetContactEmailsByIds = jest.fn();
const mockGetDealContactAssociations = jest.fn();
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: jest.fn().mockResolvedValue({
      getContactById: (...a: any[]) => mockGetContactById(...a),
      getContactEmailById: (...a: any[]) => mockGetContactEmailById(...a),
      getContactEmailsByIds: (...a: any[]) => mockGetContactEmailsByIds(...a),
      getDealContactAssociations: (...a: any[]) => mockGetDealContactAssociations(...a),
    }),
  },
}));

// asyncJobQueue (ENG-524 fast-follow): defaults to 'enqueued' so every existing test
// below exercises the same inline-processing path it always did — the queue is a
// crash-safety net, not a behavior change to the common case. Without this explicit
// mock the real module would attempt a genuine (doomed-to-fail-open) AWS call on
// every test; queue-specific behavior gets its own describe block further down.
const mockEnqueueJob = jest.fn();
const mockMarkJobComplete = jest.fn();
const mockMarkJobFailed = jest.fn();
const mockRegisterProcessor = jest.fn();
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: (...a: any[]) => mockEnqueueJob(...a),
  markJobComplete: (...a: any[]) => mockMarkJobComplete(...a),
  markJobFailed: (...a: any[]) => mockMarkJobFailed(...a),
  registerProcessor: (...a: any[]) => mockRegisterProcessor(...a),
}));

const CLIENT_SECRET = 'test-client-secret';
const MANAGED_APP_ID = 42057552;
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientSecret: CLIENT_SECRET }),
  // Mirrors the real resolver: secret for our managed app (or no appId), null otherwise.
  getHubSpotClientSecretForAppId: jest.fn(async (appId?: string | number | null) => {
    if (appId === undefined || appId === null || appId === '') return CLIENT_SECRET;
    return String(appId) === String(MANAGED_APP_ID) ? CLIENT_SECRET : null;
  }),
  getAttioConfig: jest.fn(),
}));

// ─── App setup ───────────────────────────────────────────────────────────────

import webhookRouter from '../routes/webhooks';

const app = express();
app.use('/api/webhooks/hubspot', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSignature(body: any): string {
  return crypto.createHash('sha256').update(CLIENT_SECRET + JSON.stringify(body)).digest('hex');
}

/** Drains the microtask queue so fire-and-forget async handlers complete before assertions. */
function flushPromises(): Promise<void> {
  return new Promise(setImmediate as unknown as (resolve: () => void) => void);
}

const PORTAL_ID = 12345;
const USER_ID = 'user-abc';
const LIST_ID = 'list-xyz';

const mockLead = { leadId: 'lead-1', email: 'alice@example.com', firstName: 'Alice', customFields: {} };
const mockList = {
  listId: LIST_ID,
  userId: USER_ID,
  // Portal ID scoping: only process this list for events from portal 12345
  externalCrmSyncConfigs: { hubspot: { accountId: String(PORTAL_ID) } },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/hubspot — HubSpot shared OAuth webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIdByHubSpotPortalId.mockResolvedValue(USER_ID);
    mockGetLeadListsByUserId.mockResolvedValue([mockList]);
    mockGetLeadByEmail.mockResolvedValue(mockLead);
    mockUpdateLead.mockResolvedValue(undefined);
    mockCreateLead.mockResolvedValue(undefined);
    mockGetContactById.mockResolvedValue({});
    mockGetContactEmailById.mockResolvedValue(null);
    mockGetDealContactAssociations.mockResolvedValue([]);
    // Default: webhookEnabled not set (treated as true)
    mockGetSyncConfig.mockResolvedValue(null);
    mockEnqueueJob.mockResolvedValue('enqueued');
    mockMarkJobComplete.mockResolvedValue(undefined);
    mockMarkJobFailed.mockResolvedValue(undefined);
  });

  // ── Invalid inputs ──────────────────────────────────────────────────────────

  it('returns 200 immediately (fire-and-forget) even before processing', async () => {
    const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '1' }];
    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('ignores request when signature is present but invalid', async () => {
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '1', propertyName: 'phone', propertyValue: '999' }];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', 'bad-signature')
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('ignores events from an app we do not manage (appId mismatch) even with an otherwise-valid signature', async () => {
    // Signature is valid under OUR secret, but the event is from a different app.
    // We must not process events from apps we don't manage.
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, appId: 99999999, objectId: '1', propertyName: 'firstname', propertyValue: 'Mallory' }];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('processes events from the managed app (appId match) with a valid signature', async () => {
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, appId: MANAGED_APP_ID, objectId: '1', propertyName: 'firstname', propertyValue: 'Alice2' },
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, appId: MANAGED_APP_ID, objectId: '1', propertyName: 'email', propertyValue: 'alice@example.com' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalled();
  });

  it('recovers a contact.propertyChange when email resolution fails once then succeeds (retry)', async () => {
    // firstname-only change → no email in payload → must resolve via API.
    // First call throws a transient error, retry (fresh token) succeeds.
    mockGetContactEmailById
      .mockRejectedValueOnce({ response: { status: 400 }, message: 'transient' })
      .mockResolvedValueOnce('alice@example.com');
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '1', propertyName: 'firstname', propertyValue: 'Alice2' }];
    await request(app).post('/api/webhooks/hubspot').send(body);

    await flushPromises();
    await flushPromises();
    expect(mockGetContactEmailById).toHaveBeenCalledTimes(2);
    expect(mockUpdateLead).toHaveBeenCalled();
  });

  it('skips (does not throw) when email resolution fails on both attempts', async () => {
    mockGetContactEmailById.mockRejectedValue({ response: { status: 400 }, message: 'down' });
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '1', propertyName: 'firstname', propertyValue: 'Alice2' }];
    await request(app).post('/api/webhooks/hubspot').send(body);

    await flushPromises();
    await flushPromises();
    expect(mockGetContactEmailById).toHaveBeenCalledTimes(2);
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('creates a lead on contact.creation when the contact is not yet in the list', async () => {
    mockGetLeadByEmail.mockResolvedValue(null); // not in list yet
    mockGetContactById.mockResolvedValue({ email: 'new@example.com', firstname: 'New', lastname: 'Person' });
    const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '777' }];
    await request(app).post('/api/webhooks/hubspot').send(body);

    await flushPromises();
    await flushPromises();
    expect(mockCreateLead).toHaveBeenCalled();
    const [listId, fields] = mockCreateLead.mock.calls[0];
    expect(listId).toBe(LIST_ID);
    expect(fields.email).toBe('new@example.com');
    expect(fields.firstName).toBe('New');
    expect(fields.syncMetadata).toEqual({ hubspot_contact_id: '777' });
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('does NOT create a lead on contact.propertyChange for a contact not in the list', async () => {
    mockGetLeadByEmail.mockResolvedValue(null);
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '888', propertyName: 'email', propertyValue: 'stranger@example.com' }];
    await request(app).post('/api/webhooks/hubspot').send(body);

    await flushPromises();
    await flushPromises();
    expect(mockCreateLead).not.toHaveBeenCalled();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('skips event when portalId has no matching user', async () => {
    mockGetUserIdByHubSpotPortalId.mockResolvedValue(null);
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '1', propertyName: 'email', propertyValue: 'x@y.com' }];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('discards all events when OAuth token is unavailable (expired or revoked)', async () => {
    // Simulate HubSpotService.create throwing — expired token, revoked refresh, etc.
    const { HubSpotService } = require('../services/hubspotService');
    HubSpotService.create.mockRejectedValueOnce(new Error('Token refresh failed'));

    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '1', propertyName: 'email', propertyValue: 'alice@example.com' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('discards all events when OAuth token is unavailable (expired or revoked)', async () => {
    // Simulate HubSpotService.create throwing — expired token, revoked refresh, etc.
    const { HubSpotService } = require('../services/hubspotService');
    HubSpotService.create.mockRejectedValueOnce(new Error('Token refresh failed'));

    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '1', propertyName: 'email', propertyValue: 'alice@example.com' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  // ── Boundary cases ──────────────────────────────────────────────────────────

  it('rejects unsigned request in production (NODE_ENV=production)', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const body = [{ subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '1', propertyName: 'phone', propertyValue: '555' }];
      await request(app).post('/api/webhooks/hubspot').send(body);
      await flushPromises();
      expect(mockUpdateLead).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('accepts request without signature header (dev/test mode)', async () => {
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '2', propertyName: 'email', propertyValue: 'alice@example.com' }];
    const res = await request(app).post('/api/webhooks/hubspot').send(body);
    expect(res.status).toBe(200);
  });

  it('skips unknown event types without errors', async () => {
    const body = [{ subscriptionType: 'deal.creation', portalId: PORTAL_ID, objectId: '5' }];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  // ── Happy paths ─────────────────────────────────────────────────────────────

  it('contact.creation: fetches full contact via getContactById and updates lead', async () => {
    mockGetContactById.mockResolvedValue({
      email: 'alice@example.com',
      firstname: 'Alice',
      lastname: 'New',
      jobtitle: 'CTO',
      company: 'Acme',
    });

    const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '10' }];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockGetContactById).toHaveBeenCalledWith('10');
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID,
      'lead-1',
      expect.objectContaining({ lastName: 'New', title: 'CTO', company: 'Acme' })
    );
  });

  it('contact.propertyChange: updates standard field on matching lead', async () => {
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '20', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '20', propertyName: 'phone', propertyValue: '+1-555-1234' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ phone: '+1-555-1234' })
    );
  });

  it('contact.propertyChange: stores unknown property in customFields', async () => {
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '30', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '30', propertyName: 'my_custom_crm_field', propertyValue: 'custom_val' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1',
      expect.objectContaining({
        customFields: expect.objectContaining({ my_custom_crm_field: 'custom_val' }),
      })
    );
  });

  it('contact.deletion: marks lead as crmRemoved', async () => {
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '40', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.deletion', portalId: PORTAL_ID, objectId: '40' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1',
      expect.objectContaining({
        syncMetadata: expect.objectContaining({ crmRemovedAt: expect.any(String) }),
      })
    );
  });

  it('fetches email via getContactEmailById when not in payload', async () => {
    mockGetContactEmailById.mockResolvedValue('alice@example.com');
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '50', propertyName: 'phone', propertyValue: '555-9999' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockGetContactEmailById).toHaveBeenCalledWith('50');
    expect(mockUpdateLead).toHaveBeenCalledWith(LIST_ID, 'lead-1', expect.objectContaining({ phone: '555-9999' }));
  });

  // ── webhookEnabled flag ─────────────────────────────────────────────────────

  it('skips list update when webhookEnabled is false', async () => {
    mockGetSyncConfig.mockResolvedValue({ webhookEnabled: false });
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '60', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '60', propertyName: 'phone', propertyValue: '999-0000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('processes update normally when webhookEnabled is true', async () => {
    mockGetSyncConfig.mockResolvedValue({ webhookEnabled: true });
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '70', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '70', propertyName: 'jobtitle', propertyValue: 'Director' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ title: 'Director' })
    );
  });

  it('processes update when no sync config found (defaults to enabled)', async () => {
    mockGetSyncConfig.mockResolvedValue(null);
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '80', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '80', propertyName: 'company', propertyValue: 'NewCorp' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ company: 'NewCorp' })
    );
  });

  // ── Portal ID scoping ────────────────────────────────────────────────────────

  it('only updates lists linked to the event portal — ignores lists on other portals', async () => {
    const OTHER_PORTAL = 99999;
    const listForOtherPortal = {
      listId: 'list-other',
      userId: USER_ID,
      externalCrmSyncConfigs: { hubspot: { accountId: String(OTHER_PORTAL) } },
    };

    mockGetLeadListsByUserId.mockResolvedValue([mockList, listForOtherPortal]);

    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '90', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '90', propertyName: 'company', propertyValue: 'Acme' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    // Only the list linked to PORTAL_ID (LIST_ID) is updated — not list-other
    expect(mockUpdateLead).toHaveBeenCalledTimes(1);
    expect(mockUpdateLead).toHaveBeenCalledWith(LIST_ID, 'lead-1', expect.any(Object));
  });

  it('skips contact event entirely when no lists are linked to that portal', async () => {
    // All lists belong to a different portal
    mockGetLeadListsByUserId.mockResolvedValue([
      { listId: 'list-other', userId: USER_ID, externalCrmSyncConfigs: { hubspot: { accountId: '99999' } } },
    ]);

    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '91', propertyName: 'email', propertyValue: 'alice@example.com' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  // ── contact.deletion: crmRemovedAt ──────────────────────────────────────────

  it('contact.deletion: sets crmRemovedAt as ISO timestamp (not crmRemoved boolean)', async () => {
    const body = [
      { subscriptionType: 'contact.propertyChange', portalId: PORTAL_ID, objectId: '95', propertyName: 'email', propertyValue: 'alice@example.com' },
      { subscriptionType: 'contact.deletion', portalId: PORTAL_ID, objectId: '95' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    const call = mockUpdateLead.mock.calls[0];
    const syncMetadata = call[2]?.syncMetadata;
    expect(syncMetadata?.crmRemovedAt).toBeDefined();
    expect(new Date(syncMetadata.crmRemovedAt).toISOString()).toBe(syncMetadata.crmRemovedAt);
    expect(syncMetadata?.crmRemoved).toBeUndefined();
  });

  // ── Signature: raw bytes (item 17) ──────────────────────────────────────────

  it('accepts signature computed from raw body bytes, not re-serialized JSON', async () => {
    // Simulate exactly what HubSpot sends: a compact JSON string with a specific byte layout.
    // The route verifies SHA-256(clientSecret + rawBody.toString('utf8')) against the header.
    // If the test re-serialized via JSON.stringify(obj) and key order differed, the sig would mismatch.
    const rawJson = '[{"subscriptionType":"contact.creation","portalId":12345,"objectId":"42"}]';
    const sig = crypto.createHash('sha256').update(CLIENT_SECRET + rawJson).digest('hex');

    // Send the raw JSON string (not a JS object) so supertest does not re-serialize it.
    // express.raw() captures this as a Buffer whose .toString('utf8') equals rawJson exactly.
    await request(app)
      .post('/api/webhooks/hubspot')
      .type('application/json')
      .set('x-hubspot-signature', sig)
      .send(rawJson);

    await flushPromises();
    // Route accepted the request and attempted portal lookup (not rejected as bad signature)
    expect(mockGetUserIdByHubSpotPortalId).toHaveBeenCalledWith(12345);
  });

  it('rejects signature computed from re-serialized JSON when byte layout differs', async () => {
    // Raw payload has extra whitespace — re-serializing with JSON.stringify produces different bytes.
    const rawJsonWithWhitespace = '[{ "subscriptionType": "contact.creation", "portalId": 12345, "objectId": "42" }]';
    const correctSig = crypto.createHash('sha256').update(CLIENT_SECRET + rawJsonWithWhitespace).digest('hex');

    // Compute wrong sig as the old makeSignature(obj) pattern would: JSON.stringify of a parsed obj
    const parsedObj = JSON.parse(rawJsonWithWhitespace);
    const wrongSig = crypto.createHash('sha256').update(CLIENT_SECRET + JSON.stringify(parsedObj)).digest('hex');

    // Sanity: the two signatures differ when byte layout differs
    expect(correctSig).not.toBe(wrongSig);

    // Wrong sig → rejected
    await request(app)
      .post('/api/webhooks/hubspot')
      .type('application/json')
      .set('x-hubspot-signature', wrongSig)
      .send(rawJsonWithWhitespace);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  describe('async job queue integration (ENG-524 fast-follow, Greptile P1)', () => {
    it('enqueues before processing, with a hash of the raw body as the dedupe key', async () => {
      const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '1' }];
      const expectedDedupeKey = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

      await request(app)
        .post('/api/webhooks/hubspot')
        .set('x-hubspot-signature', makeSignature(body))
        .send(body);
      await flushPromises();

      expect(mockEnqueueJob).toHaveBeenCalledWith(
        'hubspot_webhook',
        expectedDedupeKey,
        expect.objectContaining({ changesByObjectId: expect.objectContaining({ '1': expect.objectContaining({ isCreation: true }) }) }),
        { claimImmediately: true },
      );
    });

    it('marks the job complete after successful inline processing when it was actually enqueued', async () => {
      const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '1' }];
      const expectedDedupeKey = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

      await request(app)
        .post('/api/webhooks/hubspot')
        .set('x-hubspot-signature', makeSignature(body))
        .send(body);
      await flushPromises();

      expect(mockMarkJobComplete).toHaveBeenCalledWith('hubspot_webhook', expectedDedupeKey);
    });

    it('skips processing entirely when enqueueJob reports a duplicate', async () => {
      mockEnqueueJob.mockResolvedValue('duplicate');
      const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '1' }];

      await request(app)
        .post('/api/webhooks/hubspot')
        .set('x-hubspot-signature', makeSignature(body))
        .send(body);
      await flushPromises();

      expect(mockCreateLead).not.toHaveBeenCalled();
      expect(mockMarkJobComplete).not.toHaveBeenCalled();
    });

    it('still processes inline when enqueueJob reports "unavailable" (queue/table not provisioned yet)', async () => {
      mockEnqueueJob.mockResolvedValue('unavailable');
      const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '1' }];
      mockGetLeadByEmail.mockResolvedValue(null);
      mockGetContactById.mockResolvedValue({ email: 'new@example.com' });

      await request(app)
        .post('/api/webhooks/hubspot')
        .set('x-hubspot-signature', makeSignature(body))
        .send(body);
      await flushPromises();

      expect(mockCreateLead).toHaveBeenCalled();
      // No durable record was ever created for this delivery, so there's nothing to
      // mark complete — matches the exact fire-and-forget behavior from before the
      // queue existed.
      expect(mockMarkJobComplete).not.toHaveBeenCalled();
    });

    it('marks the job failed (for the poller to retry) when processing throws and the job was enqueued', async () => {
      const body = [{ subscriptionType: 'contact.creation', portalId: PORTAL_ID, objectId: '1' }];
      const expectedDedupeKey = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
      // Needs a resolvable email so processing gets past the "no email" early-continue
      // and actually reaches (and throws from) getLeadListsByUserId below.
      mockGetContactById.mockResolvedValue({ email: 'alice@example.com' });
      mockGetLeadListsByUserId.mockRejectedValue(new Error('dynamo down'));

      await request(app)
        .post('/api/webhooks/hubspot')
        .set('x-hubspot-signature', makeSignature(body))
        .send(body);
      await flushPromises();

      expect(mockMarkJobFailed).toHaveBeenCalledWith('hubspot_webhook', expectedDedupeKey, expect.any(Error));
    });
  });
});

describe('POST /api/webhooks/hubspot — deal.propertyChange', () => {
  const DEAL_ID = 'deal-999';
  const CONTACT_ID = 'contact-555';

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIdByHubSpotPortalId.mockResolvedValue(USER_ID);
    mockGetLeadListsByUserId.mockResolvedValue([mockList]);
    mockGetLeadByEmail.mockResolvedValue(mockLead);
    mockUpdateLead.mockResolvedValue(undefined);
    mockGetDealContactAssociations.mockResolvedValue([CONTACT_ID]);
    mockGetContactEmailsByIds.mockResolvedValue(new Map([[CONTACT_ID, 'alice@example.com']]));
    mockGetContactEmailById.mockResolvedValue('alice@example.com');
    mockGetContactById.mockResolvedValue({});
    // Deal handler requires non-null syncConfig (checks !syncConfig) for processing
    mockGetSyncConfig.mockResolvedValue({ webhookEnabled: true });
    mockEnqueueJob.mockResolvedValue('enqueued');
    mockMarkJobComplete.mockResolvedValue(undefined);
    mockMarkJobFailed.mockResolvedValue(undefined);
  });

  it('deal.propertyChange: syncs amount → dealValue to the associated contact lead', async () => {
    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '50000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockGetDealContactAssociations).toHaveBeenCalledWith(DEAL_ID);
    expect(mockGetContactEmailsByIds).toHaveBeenCalledWith([CONTACT_ID]);
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ dealValue: '50000' })
    );
  });

  it('deal.propertyChange: syncs dealstage → status using raw stage id when no stageMap', async () => {
    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'dealstage', propertyValue: 'appointmentscheduled' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ status: 'appointmentscheduled' })
    );
  });

  it('deal.propertyChange: maps dealstage using hubspotDealStageMap when configured', async () => {
    mockGetSyncConfig.mockResolvedValue({
      webhookEnabled: true,
      hubspotDealStageMap: { Qualified: 'appointmentscheduled' },
    });

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'dealstage', propertyValue: 'appointmentscheduled' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ status: 'Qualified' })
    );
  });

  it('deal.propertyChange: syncs deal_currency_code → dealCurrency', async () => {
    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'deal_currency_code', propertyValue: 'EUR' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ dealCurrency: 'EUR' })
    );
  });

  it('deal.propertyChange: syncs to all contacts when deal has multiple associations', async () => {
    const CONTACT_ID_2 = 'contact-556';
    const mockLead2 = { leadId: 'lead-2', email: 'bob@example.com', customFields: {} };
    mockGetDealContactAssociations.mockResolvedValue([CONTACT_ID, CONTACT_ID_2]);
    mockGetContactEmailsByIds.mockResolvedValue(new Map([
      [CONTACT_ID, 'alice@example.com'],
      [CONTACT_ID_2, 'bob@example.com'],
    ]));
    mockGetLeadByEmail
      .mockResolvedValueOnce(mockLead)
      .mockResolvedValueOnce(mockLead2);

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '75000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledTimes(2);
    expect(mockUpdateLead).toHaveBeenCalledWith(LIST_ID, 'lead-1', expect.objectContaining({ dealValue: '75000' }));
    expect(mockUpdateLead).toHaveBeenCalledWith(LIST_ID, 'lead-2', expect.objectContaining({ dealValue: '75000' }));
  });

  it('deal.propertyChange: skips when deal has no contact association', async () => {
    mockGetDealContactAssociations.mockResolvedValue([]);

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '1000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('deal.propertyChange: skips when contact email cannot be resolved', async () => {
    mockGetContactEmailsByIds.mockResolvedValue(new Map());

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '1000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('deal.propertyChange: skips list when syncConfig is null (no config = no deal sync)', async () => {
    mockGetSyncConfig.mockResolvedValue(null);

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '1000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('deal.propertyChange: skips list when webhookEnabled is false', async () => {
    mockGetSyncConfig.mockResolvedValue({ webhookEnabled: false });

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '1000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('deal.propertyChange: skips when lead not found in list', async () => {
    mockGetLeadByEmail.mockResolvedValue(null);

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '1000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('deal.propertyChange: only updates lists linked to that portal', async () => {
    const otherList = {
      listId: 'list-other',
      userId: USER_ID,
      externalCrmSyncConfigs: { hubspot: { accountId: '99999' } },
    };
    mockGetLeadListsByUserId.mockResolvedValue([mockList, otherList]);

    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'amount', propertyValue: '2000' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).toHaveBeenCalledTimes(1);
    expect(mockUpdateLead).toHaveBeenCalledWith(LIST_ID, 'lead-1', expect.any(Object));
  });

  it('deal.propertyChange: does not call updateLead when no mapped deal properties change', async () => {
    // The event property is not amount/dealstage/deal_currency_code
    const body = [
      { subscriptionType: 'deal.propertyChange', portalId: PORTAL_ID, objectId: DEAL_ID, propertyName: 'dealname', propertyValue: 'New Name' },
    ];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await flushPromises();
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });
});
