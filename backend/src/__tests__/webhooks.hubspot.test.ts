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
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: (...a: any[]) => mockGetLeadListsByUserId(...a),
    getLeadByEmail: (...a: any[]) => mockGetLeadByEmail(...a),
    updateLead: (...a: any[]) => mockUpdateLead(...a),
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
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: jest.fn().mockResolvedValue({
      getContactById: (...a: any[]) => mockGetContactById(...a),
      getContactEmailById: (...a: any[]) => mockGetContactEmailById(...a),
    }),
  },
}));

const CLIENT_SECRET = 'test-client-secret';
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientSecret: CLIENT_SECRET }),
  getAttioConfig: jest.fn(),
}));

// ─── App setup ───────────────────────────────────────────────────────────────

import webhookRouter from '../routes/webhooks';

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSignature(body: any): string {
  return crypto.createHash('sha256').update(CLIENT_SECRET + JSON.stringify(body)).digest('hex');
}

const PORTAL_ID = 12345;
const USER_ID = 'user-abc';
const LIST_ID = 'list-xyz';

const mockLead = { leadId: 'lead-1', email: 'alice@example.com', firstName: 'Alice', customFields: {} };
const mockList = { listId: LIST_ID, userId: USER_ID };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/hubspot — HubSpot shared OAuth webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserIdByHubSpotPortalId.mockResolvedValue(USER_ID);
    mockGetLeadListsByUserId.mockResolvedValue([mockList]);
    mockGetLeadByEmail.mockResolvedValue(mockLead);
    mockUpdateLead.mockResolvedValue(undefined);
    mockGetContactById.mockResolvedValue({});
    mockGetContactEmailById.mockResolvedValue(null);
    // Default: webhookEnabled not set (treated as true)
    mockGetSyncConfig.mockResolvedValue(null);
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

    await new Promise(r => setTimeout(r, 50));
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  it('skips event when portalId has no matching user', async () => {
    mockGetUserIdByHubSpotPortalId.mockResolvedValue(null);
    const body = [{ subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '1', propertyName: 'email', propertyValue: 'x@y.com' }];
    await request(app)
      .post('/api/webhooks/hubspot')
      .set('x-hubspot-signature', makeSignature(body))
      .send(body);

    await new Promise(r => setTimeout(r, 50));
    expect(mockUpdateLead).not.toHaveBeenCalled();
  });

  // ── Boundary cases ──────────────────────────────────────────────────────────

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

    await new Promise(r => setTimeout(r, 50));
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

    await new Promise(r => setTimeout(r, 50));
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

    await new Promise(r => setTimeout(r, 50));
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

    await new Promise(r => setTimeout(r, 50));
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

    await new Promise(r => setTimeout(r, 50));
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1',
      expect.objectContaining({
        syncMetadata: expect.objectContaining({ crmRemoved: true }),
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

    await new Promise(r => setTimeout(r, 50));
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

    await new Promise(r => setTimeout(r, 50));
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

    await new Promise(r => setTimeout(r, 50));
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

    await new Promise(r => setTimeout(r, 50));
    expect(mockUpdateLead).toHaveBeenCalledWith(
      LIST_ID, 'lead-1', expect.objectContaining({ company: 'NewCorp' })
    );
  });
});
