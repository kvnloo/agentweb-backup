import request from 'supertest';
import express from 'express';

// Mock AWS to prevent real DynamoDB connections
jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    getLeadByAttioRecordId: jest.fn(),
    deleteLead: jest.fn(),
    updateLead: jest.fn(),
  },
}));

jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    getConfig: jest.fn(),
    resolveAuthForList: jest.fn(),
  },
}));

const mockHubSpotGetContactEmailById = jest.fn();
jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    fromToken: jest.fn().mockReturnValue({ getContactEmailById: mockHubSpotGetContactEmailById }),
    create: jest.fn().mockResolvedValue({ getContactEmailById: mockHubSpotGetContactEmailById }),
  },
}));

const mockAttioGetPersonValues = jest.fn();
const mockAttioResolveObjectSlug = jest.fn();
const mockAttioLoadAttributeTypes = jest.fn().mockResolvedValue(new Map());
const mockAttioGetDealById = jest.fn().mockResolvedValue(null);
jest.mock('../services/attioService', () => ({
  AttioService: {
    fromToken: jest.fn().mockReturnValue({
      getPersonValues: mockAttioGetPersonValues,
      resolveObjectSlug: mockAttioResolveObjectSlug,
      loadAttributeTypes: mockAttioLoadAttributeTypes,
      getDealById: mockAttioGetDealById,
    }),
    create: jest.fn().mockResolvedValue({
      getPersonValues: mockAttioGetPersonValues,
      resolveObjectSlug: mockAttioResolveObjectSlug,
      loadAttributeTypes: mockAttioLoadAttributeTypes,
      getDealById: mockAttioGetDealById,
    }),
  },
}));

import crmWebhookRouter from '../routes/crmWebhook';
import { crmDb } from '../services/db';
import { externalCrmSyncService } from '../services/externalCrmSyncService';

const app = express();
app.use(express.json());
app.use('/api/crm', crmWebhookRouter);

const VALID_LIST_ID = 'list-abc123';
const VALID_SECRET = 'secret-xyz789';
const VALID_USER_ID = 'user-001';

const mockList = { listId: VALID_LIST_ID, userId: VALID_USER_ID, name: 'Test List' };
const mockConfig = (provider: string) => ({
  provider,
  listId: VALID_LIST_ID,
  userId: VALID_USER_ID,
  webhookSecret: VALID_SECRET,
  deleteOnPull: false,
  autoSyncEnabled: false,
  contactFieldMapping: [],
  dealFieldMapping: [],
  customFieldMapping: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

describe('CRM Webhook Endpoint — POST /api/crm/:provider/:listId/webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(mockConfig('hubspot'));
    (externalCrmSyncService.resolveAuthForList as jest.Mock).mockResolvedValue({ type: 'token', apiKey: 'api-key-123' });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.getLeadByAttioRecordId as jest.Mock).mockResolvedValue(null);
    (crmDb.deleteLead as jest.Mock).mockResolvedValue(undefined);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    mockHubSpotGetContactEmailById.mockResolvedValue(null);
    mockAttioGetPersonValues.mockResolvedValue({});
    mockAttioResolveObjectSlug.mockResolvedValue('');
    mockAttioLoadAttributeTypes.mockResolvedValue(new Map());
    mockAttioGetDealById.mockResolvedValue(null);
  });

  // ─── Invalid inputs ───────────────────────────────────────────────────────────

  it('returns 400 for unsupported provider', async () => {
    const res = await request(app)
      .post(`/api/crm/salesforce/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported provider/i);
  });

  it('returns 200 silently for unknown listId', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/crm/hubspot/nonexistent-list/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('returns 200 silently for wrong secret', async () => {
    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', 'wrong-secret')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('returns 200 silently when no config found', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  // ─── Boundary cases ───────────────────────────────────────────────────────────

  it('handles Attio X-Hook-Secret handshake by echoing the header', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(mockConfig('attio'));
    const hookSecret = 'attio-handshake-token-abc';
    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .set('x-hook-secret', hookSecret)
      .send({});
    expect(res.status).toBe(200);
    expect(res.headers['x-hook-secret']).toBe(hookSecret);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('stores unknown HubSpot properties in customFields', async () => {
    const existingLead = {
      leadId: 'lead-1',
      email: 'john@acme.com',
      firstName: 'John',
      customFields: { existing_field: 'value' },
    };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

    const events = [
      {
        subscriptionType: 'contact.propertyChange',
        portalId: 99999,
        objectId: '12345',
        propertyName: 'my_custom_crm_field',
        propertyValue: 'custom_value',
      },
      {
        subscriptionType: 'contact.propertyChange',
        portalId: 99999,
        objectId: '12345',
        propertyName: 'email',
        propertyValue: 'john@acme.com',
      },
    ];

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(events);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50)); // allow fire-and-forget
    expect(crmDb.updateLead).toHaveBeenCalledWith(
      VALID_LIST_ID,
      'lead-1',
      expect.objectContaining({
        customFields: expect.objectContaining({ my_custom_crm_field: 'custom_value' }),
      })
    );
  });

  // ─── Happy paths ──────────────────────────────────────────────────────────────

  it('updates lead standard fields on HubSpot contact.propertyChange', async () => {
    const existingLead = {
      leadId: 'lead-1',
      email: 'jane@corp.com',
      firstName: 'Jane',
      lastName: 'Old',
      phone: '',
      company: '',
      title: '',
    };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

    const events = [
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '55555', propertyName: 'email',     propertyValue: 'jane@corp.com' },
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '55555', propertyName: 'lastname',  propertyValue: 'NewLastName' },
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '55555', propertyName: 'phone',     propertyValue: '+1-555-9999' },
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '55555', propertyName: 'jobtitle',  propertyValue: 'VP Engineering' },
    ];

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(events);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.updateLead).toHaveBeenCalledWith(
      VALID_LIST_ID,
      'lead-1',
      expect.objectContaining({
        lastName: 'NewLastName',
        phone: '+1-555-9999',
        title: 'VP Engineering',
      })
    );
  });

  it('fetches email from HubSpot API when not in event payload', async () => {
    mockHubSpotGetContactEmailById.mockResolvedValue('fetched@email.com');
    const existingLead = { leadId: 'lead-2', email: 'fetched@email.com', firstName: 'Bob' };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

    const events = [
      { subscriptionType: 'contact.propertyChange', portalId: 22222, objectId: '99999', propertyName: 'phone', propertyValue: '123-456-7890' },
    ];

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(events);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(mockHubSpotGetContactEmailById).toHaveBeenCalledWith('99999');
    expect(crmDb.updateLead).toHaveBeenCalledWith(VALID_LIST_ID, 'lead-2', expect.objectContaining({ phone: '123-456-7890' }));
  });

  it('calls getPersonValues and updates lead on Attio record.updated', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('attio'),
      // job_title is a plain text Attio attribute; extractAttioValue returns entry.value
      contactFieldMapping: [
        { crmProperty: 'job_title', agentwebField: 'title', enabled: true, direction: 'both' },
      ],
    });
    mockAttioGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'attio@company.com' }],
      job_title:       [{ value: 'CTO' }],
    });
    const existingLead = { leadId: 'lead-3', email: 'attio@company.com' };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

    const event = {
      event_type: 'record.updated',
      workspace_id: 'ws-abc',
      data: {
        object: { slug: 'people' },
        record: { id: { record_id: 'rec-xyz' } },
      },
    };

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(event);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(mockAttioGetPersonValues).toHaveBeenCalledWith('rec-xyz');
    expect(crmDb.updateLead).toHaveBeenCalledWith(
      VALID_LIST_ID,
      'lead-3',
      expect.objectContaining({ title: 'CTO' })
    );
  });

  it('skips Attio event for non-people objects (e.g. companies)', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(mockConfig('attio'));

    const event = {
      event_type: 'record.updated',
      workspace_id: 'ws-abc',
      data: {
        object: { slug: 'companies' },
        record: { id: { record_id: 'comp-xyz' } },
      },
    };

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(event);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(mockAttioGetPersonValues).not.toHaveBeenCalled();
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('does not call updateLead when HubSpot event has no matching lead', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    mockHubSpotGetContactEmailById.mockResolvedValue('nobody@unknown.com');

    const events = [
      { subscriptionType: 'contact.propertyChange', portalId: 33333, objectId: '77777', propertyName: 'email', propertyValue: 'nobody@unknown.com' },
    ];

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(events);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  // ─── webhookEnabled flag ──────────────────────────────────────────────────────

  it('ignores events when webhookEnabled is false', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('hubspot'),
      webhookEnabled: false,
    });
    const existingLead = { leadId: 'lead-1', email: 'test@corp.com' };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

    const events = [
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '55555', propertyName: 'email', propertyValue: 'test@corp.com' },
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '55555', propertyName: 'phone', propertyValue: '+1-555-0001' },
    ];

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(events);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  // ─── Attio flat payload format (UUID object_id resolution) ──────────────────

  it('processes flat Attio payload: resolves UUID via resolveObjectSlug → people', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('attio'),
      contactFieldMapping: [
        { crmProperty: 'job_title', agentwebField: 'title', enabled: true, direction: 'both' },
      ],
    });
    mockAttioResolveObjectSlug.mockResolvedValue('people');
    mockAttioGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'flat@company.com' }],
      job_title:       [{ value: 'Engineer' }],
    });
    const existingLead = { leadId: 'lead-flat', email: 'flat@company.com' };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

    // Flat format: id.object_id is a UUID, no data.object.slug field
    const event = {
      event_type: 'record.updated',
      id: { object_id: 'uuid-people-123', record_id: 'rec-flat-xyz' },
    };

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(event);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(mockAttioResolveObjectSlug).toHaveBeenCalledWith('uuid-people-123');
    expect(mockAttioGetPersonValues).toHaveBeenCalledWith('rec-flat-xyz');
    expect(crmDb.updateLead).toHaveBeenCalledWith(VALID_LIST_ID, 'lead-flat', expect.objectContaining({ title: 'Engineer' }));
  });

  it('skips flat Attio payload when UUID resolves to non-people/deals object', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(mockConfig('attio'));
    mockAttioResolveObjectSlug.mockResolvedValue('companies');

    const event = {
      event_type: 'record.updated',
      id: { object_id: 'uuid-companies-999', record_id: 'rec-comp-abc' },
    };

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(event);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(mockAttioResolveObjectSlug).toHaveBeenCalledWith('uuid-companies-999');
    expect(mockAttioGetPersonValues).not.toHaveBeenCalled();
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  // ─── Attio record.deleted ────────────────────────────────────────────────────

  it('deletes lead by stored Attio record ID when deleteOnPull is true', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('attio'),
      deleteOnPull: true,
    });
    const existingLead = { leadId: 'lead-del-1', email: 'deleted@company.com' };
    (crmDb.getLeadByAttioRecordId as jest.Mock).mockResolvedValue(existingLead);

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send({
        event_type: 'record.deleted',
        data: {
          object: { slug: 'people' },
          record: { id: { record_id: 'rec-deleted-123' } },
        },
      });

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.getLeadByAttioRecordId).toHaveBeenCalledWith(VALID_LIST_ID, 'rec-deleted-123');
    expect(crmDb.deleteLead).toHaveBeenCalledWith(VALID_LIST_ID, 'lead-del-1');
    expect(mockAttioGetPersonValues).not.toHaveBeenCalled();
  });

  it('does not delete lead when deleteOnPull is false for Attio record.deleted', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('attio'),
      deleteOnPull: false,
    });

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send({
        event_type: 'record.deleted',
        data: {
          object: { slug: 'people' },
          record: { id: { record_id: 'rec-deleted-456' } },
        },
      });

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.getLeadByAttioRecordId).not.toHaveBeenCalled();
    expect(crmDb.deleteLead).not.toHaveBeenCalled();
  });

  it('skips deletion silently when no matching lead found for Attio record.deleted', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('attio'),
      deleteOnPull: true,
    });
    (crmDb.getLeadByAttioRecordId as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send({
        event_type: 'record.deleted',
        data: {
          object: { slug: 'people' },
          record: { id: { record_id: 'rec-unknown-789' } },
        },
      });

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.getLeadByAttioRecordId).toHaveBeenCalledWith(VALID_LIST_ID, 'rec-unknown-789');
    expect(crmDb.deleteLead).not.toHaveBeenCalled();
  });

  it('does not delete lead for Attio deals record.deleted', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('attio'),
      deleteOnPull: true,
    });

    const res = await request(app)
      .post(`/api/crm/attio/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send({
        event_type: 'record.deleted',
        data: {
          object: { slug: 'deals' },
          record: { id: { record_id: 'deal-deleted-111' } },
        },
      });

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.getLeadByAttioRecordId).not.toHaveBeenCalled();
    expect(crmDb.deleteLead).not.toHaveBeenCalled();
  });

  it('processes events normally when webhookEnabled is true', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('hubspot'),
      webhookEnabled: true,
    });
    const existingLead = { leadId: 'lead-2', email: 'alice@corp.com' };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);

    const events = [
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '66666', propertyName: 'email', propertyValue: 'alice@corp.com' },
      { subscriptionType: 'contact.propertyChange', portalId: 11111, objectId: '66666', propertyName: 'company', propertyValue: 'Corp Inc' },
    ];

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send(events);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.updateLead).toHaveBeenCalledWith(
      VALID_LIST_ID, 'lead-2', expect.objectContaining({ company: 'Corp Inc' })
    );
  });
});
