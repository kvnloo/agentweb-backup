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
    getLeadByAttioRecordId: jest.fn().mockResolvedValue(null),
    getLeadByHubSpotContactId: jest.fn().mockResolvedValue(null),
    createLead: jest.fn().mockResolvedValue({ leadId: 'new-lead' }),
    updateLead: jest.fn(),
    deleteLead: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockUpdateSyncTimestamp = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    getConfig: jest.fn(),
    resolveAuthForList: jest.fn(),
    updateSyncTimestamp: (...a: any[]) => mockUpdateSyncTimestamp(...a),
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
const mockAttioSvcExtras = {
  loadAttributeTypes: jest.fn().mockResolvedValue(new Map([
    ['object:people:email_addresses', 'email_address'],
    ['object:people:phone_numbers', 'phone_number'],
  ])),
  getCompanyById: jest.fn().mockResolvedValue(null),
};
jest.mock('../services/attioService', () => ({
  AttioService: {
    fromToken: jest.fn().mockReturnValue({ getPersonValues: mockAttioGetPersonValues, ...mockAttioSvcExtras }),
    create: jest.fn().mockResolvedValue({ getPersonValues: mockAttioGetPersonValues, ...mockAttioSvcExtras }),
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
  // Mirrors DEFAULT_ATTIO_CONTACT_MAPPING (externalCrmSyncService.ts) — the
  // Attio webhook path is config-driven now (ENG-1380), so its tests need a
  // realistic mapping. HubSpot's webhook handler hardcodes its own field
  // list and never reads this, so it's safe to share across both providers.
  contactFieldMapping: [
    { agentwebField: 'email', crmProperty: 'email_addresses', direction: 'both', enabled: true },
    { agentwebField: 'firstName', crmProperty: 'first_name', direction: 'both', enabled: true },
    { agentwebField: 'lastName', crmProperty: 'last_name', direction: 'both', enabled: true },
    { agentwebField: 'phone', crmProperty: 'phone_numbers', direction: 'both', enabled: true },
    { agentwebField: 'title', crmProperty: 'job_title', direction: 'both', enabled: true },
    { agentwebField: 'company', crmProperty: 'company', direction: 'both', enabled: true },
    { agentwebField: 'linkedin', crmProperty: 'linkedin', direction: 'push', enabled: true },
  ],
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
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    mockHubSpotGetContactEmailById.mockResolvedValue(null);
    mockAttioGetPersonValues.mockResolvedValue({});
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

  // ENG-2082: a lead we pushed to HubSpot carries a hubspot_contact_id and, for a
  // phone-only capture, no address. This whole branch shipped with no coverage — reverting
  // the fix left the suite fully green, which is how the "both adopt it now" claim went
  // unchecked.
  it('resolves by hubspot_contact_id when the email lookup misses, and ADOPTS the address', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValue({
      leadId: 'lead-phone-only',
      listId: VALID_LIST_ID,
      phone: '2125559876',
      syncMetadata: { hubspot_contact_id: '12345' },
    });

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send([{
        subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '12345',
        propertyName: 'email', propertyValue: 'late@acme.com',
      }]);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.createLead).not.toHaveBeenCalled();
    expect(crmDb.updateLead).toHaveBeenCalledWith(
      VALID_LIST_ID, 'lead-phone-only',
      expect.objectContaining({ email: 'late@acme.com' }),
    );
  });

  // This test was vacuous as first written: it sent a `firstname` change, so no email
  // could be resolved and the handler `continue`d before reaching the adoption branch at
  // all. updateLead was never called and the assertion reduced to
  // `({}).email === undefined` — it passed with the guard deleted. The event has to carry
  // an address, and the lead has to be found with one already, or nothing is under test.
  it('does not overwrite an address the lead already has', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValue({
      leadId: 'lead-1', listId: VALID_LIST_ID, email: 'john@acme.com',
      syncMetadata: { hubspot_contact_id: '12345' },
    });

    await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      // Two properties for the same contact, so there is still something to write once
      // the address is dropped — with email alone the update is empty and correctly never
      // issued, which would make the assertion below vacuous again for a new reason.
      .send([
        { subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '12345',
          propertyName: 'firstname', propertyValue: 'Johnny' },
        { subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '12345',
          propertyName: 'email', propertyValue: 'different@acme.com' },
      ]);

    await new Promise(r => setTimeout(r, 50));
    // The branch must actually have been reached — without this the rest is vacuous.
    expect(crmDb.updateLead).toHaveBeenCalled();
    const updates = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
    expect(updates.firstName).toBe('Johnny');
    expect(updates.email).toBeUndefined();
  });

  // ─── contact.merge (ENG-2465) ─────────────────────────────────────────────────

  const mergeEvent = { subscriptionType: 'contact.merge', portalId: 99999, objectId: '200', primaryObjectId: 200, mergedObjectIds: [101], newObjectId: 200 };
  const holder = (id: string) => ({ leadId: 'lead-101', listId: VALID_LIST_ID, syncMetadata: { hubspot_contact_id: id, syncStatus: 'synced' } });
  const postEvents = async (events: any[]) => {
    await request(app).post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`).set('x-webhook-secret', VALID_SECRET).send(events);
    await new Promise(r => setTimeout(r, 80));
  };

  it('contact.merge re-points the lead holding the merged-away id at the survivor', async () => {
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValueOnce(holder('101')).mockResolvedValue(null);

    await postEvents([mergeEvent]);

    expect(crmDb.updateLead).toHaveBeenCalledWith(VALID_LIST_ID, 'lead-101', {
      syncMetadata: { hubspot_contact_id: '200', syncStatus: 'synced' },
    });
  });

  it('a deletion in the SAME delivery does not delete the re-pointed lead (merge is applied first); without the merge it does', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({ ...mockConfig('hubspot'), deleteOnPull: true });
    // the lead is findable by its id only until the merge rewrites it
    let storedId = '101';
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockImplementation(async (_l: string, id: string) => (id === storedId ? holder(storedId) : null));
    (crmDb.updateLead as jest.Mock).mockImplementation(async (_l: string, _id: string, u: any) => { storedId = u.syncMetadata.hubspot_contact_id; });

    await postEvents([mergeEvent, { subscriptionType: 'contact.deletion', portalId: 99999, objectId: '101' }]);
    expect(crmDb.deleteLead).not.toHaveBeenCalled();

    jest.clearAllMocks();
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockImplementation(async (_l: string, id: string) => (id === '101' ? holder('101') : null));
    await postEvents([{ subscriptionType: 'contact.deletion', portalId: 99999, objectId: '101' }]);
    expect(crmDb.deleteLead).toHaveBeenCalledWith(VALID_LIST_ID, 'lead-101');
  });

  it('a merge for an id no lead holds changes nothing', async () => {
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValue(null);
    await postEvents([mergeEvent]);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a throwing merge lookup does not stop a later event in the same delivery', async () => {
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockRejectedValue(new Error('throttled'));
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue({ leadId: 'lead-9', listId: VALID_LIST_ID });

    await postEvents([mergeEvent, { subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '9', propertyName: 'email', propertyValue: 'x@acme.com' }]);

    expect(crmDb.updateLead).toHaveBeenCalledWith(VALID_LIST_ID, 'lead-9', expect.objectContaining({ email: 'x@acme.com' }));
  });

  // A throw out of the deletion lookup does not just skip that contact: it escapes
  // handleHubSpotEvent into the fire-and-forget wrapper and abandons every remaining
  // objectId in the batch. HubSpot already has its 200, so nothing retries.
  it('an exhausted DELETION lookup does not abandon the rest of the batch', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue({
      ...mockConfig('hubspot'), deleteOnPull: true,
    });
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockImplementation(async (_l: string, id: string) => {
      if (String(id) === '111') {
        throw Object.assign(new Error('exhausted 20 pages'), { lookupExhausted: true });
      }
      return { leadId: 'lead-222', listId: VALID_LIST_ID, phone: '2125550000',
               syncMetadata: { hubspot_contact_id: '222' } };
    });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);

    await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send([
        { subscriptionType: 'contact.deletion', portalId: 99999, objectId: '111' },
        { subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '222',
          propertyName: 'email', propertyValue: 'survivor@acme.com' },
      ]);

    await new Promise(r => setTimeout(r, 80));
    // The lead we could not identify must NOT be deleted...
    expect(crmDb.deleteLead).not.toHaveBeenCalled();
    // ...and the event behind it must still have been processed.
    expect(crmDb.updateLead).toHaveBeenCalledWith(
      VALID_LIST_ID, 'lead-222',
      expect.objectContaining({ email: 'survivor@acme.com' }),
    );
  });

  it('refuses to create when the contact-id lookup was exhausted', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockRejectedValue(
      Object.assign(new Error('exhausted 20 pages'), { lookupExhausted: true }),
    );

    await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send([{
        subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '12345',
        propertyName: 'email', propertyValue: 'someone@acme.com',
      }]);

    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.createLead).not.toHaveBeenCalled();
  });

  // ENG-2322: the lookups said "absent" but createLead's email pre-check found the row (a
  // concurrent create won). That used to throw out of the loop and abandon the whole delivery.
  it('adopts the existing lead as an update when createLead loses a duplicate-email race, and still processes the next contact', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock)
      .mockRejectedValueOnce(Object.assign(
        new Error('Lead with email "raced@acme.com" already exists in this list'),
        { duplicateEmail: true, existingLead: { leadId: 'lead-won', email: 'raced@acme.com', firstName: 'Old' } },
      ))
      .mockResolvedValueOnce({ leadId: 'lead-second' });

    const res = await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send([
        { subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '111', propertyName: 'email', propertyValue: 'raced@acme.com' },
        { subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '111', propertyName: 'firstname', propertyValue: 'New' },
        { subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '222', propertyName: 'email', propertyValue: 'second@acme.com' },
      ]);

    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 80));
    expect(crmDb.updateLead).toHaveBeenCalledWith(
      VALID_LIST_ID, 'lead-won',
      expect.objectContaining({ firstName: 'New' }),
    );
    // The adopted lead already has the address: it is not rewritten.
    expect((crmDb.updateLead as jest.Mock).mock.calls[0][2].email).toBeUndefined();
    // The contact behind the race was not abandoned.
    expect(crmDb.createLead).toHaveBeenCalledTimes(2);
  });

  it('does not swallow a createLead failure that is not a duplicate-email race', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.getLeadByHubSpotContactId as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockRejectedValueOnce(new Error('dynamo down'));

    await request(app)
      .post(`/api/crm/hubspot/${VALID_LIST_ID}/webhook`)
      .set('x-webhook-secret', VALID_SECRET)
      .send([{ subscriptionType: 'contact.propertyChange', portalId: 99999, objectId: '111', propertyName: 'email', propertyValue: 'x@acme.com' }]);

    await new Promise(r => setTimeout(r, 50));
    expect(crmDb.updateLead).not.toHaveBeenCalled();
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
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(mockConfig('attio'));
    mockAttioGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'attio@company.com' }],
      name:            [{ first_name: 'Alice', last_name: 'Smith' }],
      job_title:       [{ value: 'CTO' }],
      phone_numbers:   [{ original_phone_number: '+44-20-1234' }],
      linkedin:        [],
    });
    const existingLead = { leadId: 'lead-3', email: 'attio@company.com', firstName: 'Alice' };
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
      expect.objectContaining({ firstName: 'Alice', lastName: 'Smith', title: 'CTO' })
    );
    // Live-caught gap: a webhook-driven update applied the data change but
    // never stamped lastPullSyncAt, so the CRM Sync dialog's "last pulled"
    // indicator looked permanently stale even though auto-pull was working.
    expect(mockUpdateSyncTimestamp).toHaveBeenCalledWith(expect.anything(), 'pull', true);
  });

  // CodeRabbit-flagged: without a per-event try/catch, a throw from
  // applyAttioPersonEvent aborted the loop AND skipped updateSyncTimestamp
  // entirely (the throw propagates past it) — a failed delivery left
  // lastPullSyncAt/lastSyncStatus silently stale with zero indication
  // anything went wrong, reintroducing the exact invisible-failure problem
  // the stamp exists to prevent.
  it('stamps lastPullSyncAt with success:false when applying the Attio event throws', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(mockConfig('attio'));
    mockAttioGetPersonValues.mockResolvedValue({
      email_addresses: [{ email_address: 'attio@company.com' }],
      name: [{ first_name: 'Alice', last_name: 'Smith' }],
    });
    const existingLead = { leadId: 'lead-3', email: 'attio@company.com', firstName: 'Alice' };
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existingLead);
    (crmDb.updateLead as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB throttled'));

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
    expect(mockUpdateSyncTimestamp).toHaveBeenCalledWith(expect.anything(), 'pull', false);
  });

  // CodeRabbit-flagged: the per-event try/catch above only covers
  // applyAttioPersonEvent failures — a throw from auth/service resolution
  // (e.g. a bad or expired manual token) happens BEFORE the loop even
  // starts, and previously skipped updateSyncTimestamp entirely too.
  it('stamps lastPullSyncAt with success:false when Attio auth/service resolution throws', async () => {
    (externalCrmSyncService.getConfig as jest.Mock).mockResolvedValue(mockConfig('attio'));
    (externalCrmSyncService.resolveAuthForList as jest.Mock).mockRejectedValueOnce(new Error('token decryption failed'));

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
    expect(mockUpdateSyncTimestamp).toHaveBeenCalledWith(expect.anything(), 'pull', false);
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
