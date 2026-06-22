/**
 * Unit tests for HubSpotService
 * Covers: create() factory, token caching, contacts CRUD, new methods (upsertContact,
 * createDeal, updateDeal, associateContactToDeal, ensureDealProperty, testConnection)
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';
import { getAccountsByUserId, getAccountById, updateAccountTokens } from '../services/connectedAccountsDb';

const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosPatch = axios.patch as jest.Mock;
const mockAxiosDelete = axios.delete as jest.Mock;
const mockAxiosPut = axios.put as jest.Mock;
const mockGetAccountsByUserId = getAccountsByUserId as jest.MockedFunction<typeof getAccountsByUserId>;
const mockGetAccountById = getAccountById as jest.MockedFunction<typeof getAccountById>;

const VALID_EXPIRES_AT = Date.now() + 3600 * 1000;

const MOCK_ACCOUNT = {
  platform: 'hubspot' as const,
  account_id: '12345',
  account_name: 'mycompany.hubspot.com',
  config: {
    account_type: 'oauth' as const,
    access_token: 'valid-token',
    refresh_token: 'refresh-token',
    token_expires_at: VALID_EXPIRES_AT,
    hub_id: 12345,
    hub_domain: 'mycompany.hubspot.com',
  },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  userId: 'user-1',
};

const MOCK_HS_CONTACT = {
  id: 'hs-contact-1',
  properties: {
    email: 'john@acme.com',
    firstname: 'John',
    lastname: 'Doe',
    phone: '+1234567890',
    jobtitle: 'CTO',
    company: 'Acme Corp',
    hs_linkedin_url: 'https://linkedin.com/in/johndoe',
    lastmodifieddate: '2024-01-15T10:00:00Z',
  },
};

const MOCK_HS_DEAL = {
  id: 'hs-deal-1',
  properties: {
    dealname: 'John Doe - Deal',
    amount: '5000',
    dealstage: 'appointmentscheduled',
  },
};

// ─── create() factory and token caching ──────────────────────────────────────

describe('HubSpotService — create() factory and token caching', () => {
  it('create() resolves token via DB lookup (one read)', async () => {
    mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT]);
    await HubSpotService.create('user-1');
    expect(mockGetAccountsByUserId).toHaveBeenCalledTimes(1);
  });

  it('create() exposes portalId from config.hub_id', async () => {
    mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT]);
    const svc = await HubSpotService.create('user-1');
    expect(svc.portalId).toBe('12345');
  });

  it('create() falls back to account_id for portalId when hub_id absent', async () => {
    const noHubId = { ...MOCK_ACCOUNT, config: { ...MOCK_ACCOUNT.config, hub_id: undefined } };
    mockGetAccountsByUserId.mockResolvedValue([noHubId]);
    const svc = await HubSpotService.create('user-1');
    expect(svc.portalId).toBe('12345');
  });

  it('fromToken() has no portalId', () => {
    const svc = HubSpotService.fromToken('direct-api-key');
    expect(svc.portalId).toBeUndefined();
  });

  it('service methods use cached token without extra DB reads after create()', async () => {
    mockGetAccountsByUserId.mockResolvedValue([MOCK_ACCOUNT]);
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });

    const svc = await HubSpotService.create('user-1');
    mockGetAccountsByUserId.mockClear();

    await svc.listContacts();
    await svc.listContacts();
    await svc.listContacts();

    // No further DB reads — token is cached on the instance
    expect(mockGetAccountsByUserId).not.toHaveBeenCalled();
  });

  it('fromToken() skips DB lookup entirely', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });

    const svc = HubSpotService.fromToken('direct-api-key');
    await svc.listContacts();

    expect(mockGetAccountsByUserId).not.toHaveBeenCalled();
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer direct-api-key' }) })
    );
  });

  it('create() refreshes token when expiring soon', async () => {
    const expiringSoonAccount = {
      ...MOCK_ACCOUNT,
      config: {
        ...MOCK_ACCOUNT.config,
        token_expires_at: Date.now() + 30 * 1000, // 30s — within 60s buffer
      },
    };
    mockGetAccountsByUserId.mockResolvedValue([expiringSoonAccount]);
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'refreshed-token', refresh_token: 'new-refresh', expires_in: 3600 },
    });
    (updateAccountTokens as jest.Mock).mockResolvedValue(undefined);

    await HubSpotService.create('user-1');

    // Should have called HubSpot token endpoint during factory
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('oauth/v1/token'),
      expect.any(String),
      expect.any(Object)
    );
  });
});

// ─── testConnection ────────────────────────────────────────────────────────────

describe('HubSpotService — testConnection', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    svc = HubSpotService.fromToken('test-token');
  });

  it('returns valid:true when API responds successfully', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    const result = await svc.testConnection();
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns valid:false with error message on API failure', async () => {
    mockAxiosGet.mockRejectedValue({ response: { data: { message: 'Invalid token' } } });
    const result = await svc.testConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid token');
  });
});

// ─── listContacts ─────────────────────────────────────────────────────────────

describe('HubSpotService — listContacts', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('returns mapped contacts array from HubSpot', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { results: [MOCK_HS_CONTACT], paging: { next: { after: 'cursor-100' } } },
    });

    const result = await svc.listContacts();
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }) })
    );
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({
      contactId: 'hs-contact-1',
      email: 'john@acme.com',
      firstName: 'John',
      lastName: 'Doe',
      company: 'Acme Corp',
    });
    expect(result.nextCursor).toBe('cursor-100');
  });

  it('passes after cursor for pagination', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    await svc.listContacts('some-cursor');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('after=some-cursor'),
      expect.any(Object)
    );
  });

  it('returns empty array when no contacts', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    const result = await svc.listContacts();
    expect(result.contacts).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });
});

// ─── findContactByEmail ────────────────────────────────────────────────────────

describe('HubSpotService — findContactByEmail', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('returns contact when found by email', async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [MOCK_HS_CONTACT] } });
    const contact = await svc.findContactByEmail('john@acme.com');
    expect(contact).not.toBeNull();
    expect(contact?.email).toBe('john@acme.com');
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts/search'),
      expect.objectContaining({ filterGroups: expect.any(Array) }),
      expect.any(Object)
    );
  });

  it('returns null when contact not found', async () => {
    mockAxiosPost.mockResolvedValue({ data: { results: [] } });
    const contact = await svc.findContactByEmail('nobody@nowhere.com');
    expect(contact).toBeNull();
  });
});

// ─── upsertContact ─────────────────────────────────────────────────────────────

describe('HubSpotService — upsertContact', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('creates contact and returns isNew:true when not found', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [] } })           // search → not found
      .mockResolvedValueOnce({ data: MOCK_HS_CONTACT });           // create

    const result = await svc.upsertContact({ email: 'john@acme.com', firstName: 'John', lastName: 'Doe' });
    expect(result.isNew).toBe(true);
    expect(result.contactId).toBe('hs-contact-1');
  });

  it('updates contact and returns isNew:false when found by email', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [MOCK_HS_CONTACT] } }); // search → found
    mockAxiosPatch.mockResolvedValueOnce({ data: MOCK_HS_CONTACT });               // update

    const result = await svc.upsertContact({ email: 'john@acme.com', firstName: 'John' });
    expect(result.isNew).toBe(false);
    expect(result.contactId).toBe('hs-contact-1');
    expect(mockAxiosPatch).toHaveBeenCalledWith(
      expect.stringContaining('hs-contact-1'),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('merges customFields into properties on create', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [] } })
      .mockResolvedValueOnce({ data: MOCK_HS_CONTACT });

    await svc.upsertContact({ email: 'john@acme.com', customFields: { custom_score: '90' } });

    expect(mockAxiosPost).toHaveBeenLastCalledWith(
      expect.stringContaining('crm/v3/objects/contacts'),
      expect.objectContaining({ properties: expect.objectContaining({ custom_score: '90' }) }),
      expect.any(Object)
    );
  });
});

// ─── createContact ─────────────────────────────────────────────────────────────

describe('HubSpotService — createContact', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('creates contact and returns mapped result', async () => {
    mockAxiosPost.mockResolvedValue({ data: MOCK_HS_CONTACT });
    const contact = await svc.createContact({
      email: 'john@acme.com',
      firstName: 'John',
      lastName: 'Doe',
      company: 'Acme Corp',
      phone: '+1234567890',
      jobTitle: 'CTO',
      linkedinUrl: 'https://linkedin.com/in/johndoe',
    });
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts'),
      expect.objectContaining({
        properties: expect.objectContaining({
          email: 'john@acme.com',
          firstname: 'John',
          lastname: 'Doe',
          company: 'Acme Corp',
        }),
      }),
      expect.any(Object)
    );
    expect(contact.contactId).toBe('hs-contact-1');
  });

  it('throws on API error', async () => {
    mockAxiosPost.mockRejectedValue(new Error('API error'));
    await expect(svc.createContact({ email: 'x@x.com' })).rejects.toThrow('API error');
  });
});

// ─── updateContact ─────────────────────────────────────────────────────────────

describe('HubSpotService — updateContact', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('patches contact by id', async () => {
    mockAxiosPatch.mockResolvedValue({ data: MOCK_HS_CONTACT });
    const contact = await svc.updateContact('hs-contact-1', { jobTitle: 'CEO' });
    expect(mockAxiosPatch).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts/hs-contact-1'),
      expect.objectContaining({ properties: expect.objectContaining({ jobtitle: 'CEO' }) }),
      expect.any(Object)
    );
    expect(contact.contactId).toBe('hs-contact-1');
  });
});

// ─── deleteContact ─────────────────────────────────────────────────────────────

describe('HubSpotService — deleteContact', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('calls delete on correct contact endpoint', async () => {
    mockAxiosDelete.mockResolvedValue({ data: {} });
    await svc.deleteContact('hs-contact-1');
    expect(mockAxiosDelete).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts/hs-contact-1'),
      expect.any(Object)
    );
  });
});

// ─── createDeal ────────────────────────────────────────────────────────────────

describe('HubSpotService — createDeal', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('posts to deals endpoint and returns deal id', async () => {
    mockAxiosPost.mockResolvedValue({ data: MOCK_HS_DEAL });
    const dealId = await svc.createDeal({ dealname: 'Test Deal', amount: '5000' });
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/deals'),
      expect.objectContaining({ properties: expect.objectContaining({ dealname: 'Test Deal' }) }),
      expect.any(Object)
    );
    expect(dealId).toBe('hs-deal-1');
  });
});

// ─── updateDeal ────────────────────────────────────────────────────────────────

describe('HubSpotService — updateDeal', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('patches deal by id', async () => {
    mockAxiosPatch.mockResolvedValue({ data: MOCK_HS_DEAL });
    await svc.updateDeal('hs-deal-1', { amount: '9000' });
    expect(mockAxiosPatch).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/deals/hs-deal-1'),
      expect.objectContaining({ properties: expect.objectContaining({ amount: '9000' }) }),
      expect.any(Object)
    );
  });
});

// ─── associateContactToDeal ────────────────────────────────────────────────────

describe('HubSpotService — associateContactToDeal', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('calls v4 associations default endpoint', async () => {
    mockAxiosPut.mockResolvedValue({ data: {} });
    await svc.associateContactToDeal('hs-contact-1', 'hs-deal-1');
    expect(mockAxiosPut).toHaveBeenCalledWith(
      expect.stringContaining('crm/v4/objects/contacts/hs-contact-1/associations/default/deals/hs-deal-1'),
      undefined,
      expect.any(Object)
    );
  });
});

// ─── ensureDealProperty ────────────────────────────────────────────────────────

describe('HubSpotService — ensureDealProperty', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('returns existing property name when it exists (no create)', async () => {
    mockAxiosGet.mockResolvedValue({ data: { name: 'custom_score' } });
    const name = await svc.ensureDealProperty('custom_score', 'Custom Score');
    expect(name).toBe('custom_score');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('creates property when 404 and returns slug', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    mockAxiosPost.mockResolvedValue({ data: { name: 'custom_score' } });
    const name = await svc.ensureDealProperty('Custom Score!', 'Custom Score');
    expect(name).toBe('custom_score');
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/properties/deals'),
      expect.objectContaining({ name: 'custom_score' }),
      expect.any(Object)
    );
  });

  it('sanitises property name to lowercase alphanumeric+underscore', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    mockAxiosPost.mockResolvedValue({ data: { name: 'my_custom_field' } });
    const name = await svc.ensureDealProperty('My Custom Field!', 'My Custom Field');
    expect(name).toBe('my_custom_field');
  });

  it('caches an ensured deal property so a repeat call skips the GET', async () => {
    mockAxiosGet.mockResolvedValue({ data: { name: 'custom_score' } });
    await svc.ensureDealProperty('custom_score', 'Custom Score');
    await svc.ensureDealProperty('custom_score', 'Custom Score');
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });
});

// ─── getDealPipelineStages ────────────────────────────────────────────────────

describe('HubSpotService — getDealPipelineStages', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('returns non-archived stages from the requested pipeline', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        stages: [
          { id: 'appointmentscheduled', label: 'Appointment Scheduled', displayOrder: 0, metadata: { probability: '0.2' } },
          { id: 'archived_stage', label: 'Archived', displayOrder: 1, archived: true },
        ],
      },
    });

    const stages = await svc.getDealPipelineStages('default');
    expect(stages).toEqual([
      expect.objectContaining({
        id: 'appointmentscheduled',
        label: 'Appointment Scheduled',
        displayOrder: 0,
      }),
    ]);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/pipelines/deals/default'),
      expect.any(Object)
    );
  });
});

// ─── createDealStage ──────────────────────────────────────────────────────────

describe('HubSpotService — createDealStage', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('creates a stage on the requested pipeline', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        id: 'qualified',
        label: 'Qualified',
        displayOrder: 3,
        metadata: { probability: 0.5 },
      },
    });

    const stage = await svc.createDealStage('default', {
      stageId: 'qualified',
      label: 'Qualified',
      displayOrder: 3,
      probability: 0.53,
    });

    expect(stage).toEqual(expect.objectContaining({
      id: 'qualified',
      label: 'Qualified',
      displayOrder: 3,
    }));
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/pipelines/deals/default/stages'),
      expect.objectContaining({
        stageId: 'qualified',
        label: 'Qualified',
        displayOrder: 3,
        metadata: { probability: 0.5 },
      }),
      expect.any(Object)
    );
  });
});

// ─── ensureContactProperty ────────────────────────────────────────────────────

describe('HubSpotService — ensureContactProperty', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('returns existing property name when it exists', async () => {
    mockAxiosGet.mockResolvedValue({ data: { name: 'existing_prop' } });
    const name = await svc.ensureContactProperty('existing_prop', 'Existing Prop');
    expect(name).toBe('existing_prop');
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('creates property when 404', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    mockAxiosPost.mockResolvedValue({ data: { name: 'new_prop' } });
    const name = await svc.ensureContactProperty('new_prop', 'New Prop');
    expect(name).toBe('new_prop');
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/properties/contacts'),
      expect.objectContaining({ name: 'new_prop' }),
      expect.any(Object)
    );
  });

  it('caches the result and does not GET the same property twice on one instance', async () => {
    mockAxiosGet.mockResolvedValue({ data: { name: 'cached_prop' } });
    await svc.ensureContactProperty('cached_prop', 'Cached Prop');
    await svc.ensureContactProperty('cached_prop', 'Cached Prop');
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('does not re-create a 404 property on the second call (cached after create)', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    mockAxiosPost.mockResolvedValue({ data: { name: 'made_prop' } });
    await svc.ensureContactProperty('made_prop', 'Made Prop');
    await svc.ensureContactProperty('made_prop', 'Made Prop');
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it('does not share the property cache across instances', async () => {
    mockAxiosGet.mockResolvedValue({ data: { name: 'shared_prop' } });
    await svc.ensureContactProperty('shared_prop', 'Shared Prop');
    const svc2 = HubSpotService.fromToken('valid-token');
    await svc2.ensureContactProperty('shared_prop', 'Shared Prop');
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });
});

// ─── listContactsPage ─────────────────────────────────────────────────────────

describe('HubSpotService — listContactsPage', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('fetches contacts with specified properties and returns raw results', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { results: [MOCK_HS_CONTACT], paging: { next: { after: 'next-cursor' } } },
    });
    const result = await svc.listContactsPage(['email', 'firstname']);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('properties=email%2Cfirstname'),
      expect.any(Object)
    );
    expect(result.results).toHaveLength(1);
    expect(result.nextCursor).toBe('next-cursor');
  });

  it('appends after cursor when provided', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    await svc.listContactsPage(['email'], 'cursor-xyz');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('after=cursor-xyz'),
      expect.any(Object)
    );
  });
});

// ─── getContactDealAssociations ────────────────────────────────────────────────

describe('HubSpotService — getContactDealAssociations', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('returns array of deal ids from associations', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { results: [{ id: 'deal-1' }, { id: 'deal-2' }] },
    });
    const ids = await svc.getContactDealAssociations('hs-contact-1');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('contacts/hs-contact-1/associations/deals'),
      expect.any(Object)
    );
    expect(ids).toEqual(['deal-1', 'deal-2']);
  });

  it('returns empty array when no deals associated', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    const ids = await svc.getContactDealAssociations('hs-contact-1');
    expect(ids).toEqual([]);
  });
});

// ─── getDealContactAssociations ───────────────────────────────────────────────

describe('HubSpotService — getDealContactAssociations', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); jest.clearAllMocks(); });

  it('returns all contact ids from a single page', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { results: [{ id: 'c-1' }, { id: 'c-2' }] },
    });
    const ids = await svc.getDealContactAssociations('deal-99');
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('deals/deal-99/associations/contacts'),
      expect.any(Object)
    );
    expect(ids).toEqual(['c-1', 'c-2']);
  });

  it('follows pagination cursor to return all contacts across multiple pages', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({
        data: { results: [{ id: 'c-1' }], paging: { next: { after: 'cursor-abc' } } },
      })
      .mockResolvedValueOnce({
        data: { results: [{ id: 'c-2' }, { id: 'c-3' }] },
      });
    const ids = await svc.getDealContactAssociations('deal-99');
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    expect(mockAxiosGet).toHaveBeenNthCalledWith(2,
      expect.stringContaining('deals/deal-99/associations/contacts'),
      expect.objectContaining({ params: { after: 'cursor-abc' } })
    );
    expect(ids).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('returns empty array when deal has no contact associations', async () => {
    mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    const ids = await svc.getDealContactAssociations('deal-99');
    expect(ids).toEqual([]);
  });

  it('stops at MAX_PAGES (20) when cursor never terminates', async () => {
    // Every page returns a cursor — simulates an infinite loop without the cap.
    mockAxiosGet.mockResolvedValue({
      data: { results: [{ id: 'c-1' }], paging: { next: { after: 'cursor-infinite' } } },
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const ids = await svc.getDealContactAssociations('deal-99');

    expect(mockAxiosGet).toHaveBeenCalledTimes(20);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('20-page cap'));
    expect(ids).toHaveLength(20); // 1 result per page × 20 pages
    warnSpy.mockRestore();
  });
});

// ─── getDeal ──────────────────────────────────────────────────────────────────

describe('HubSpotService — getDeal', () => {
  let svc: HubSpotService;
  beforeEach(() => { svc = HubSpotService.fromToken('valid-token'); });

  it('fetches deal by id with specified properties', async () => {
    mockAxiosGet.mockResolvedValue({ data: MOCK_HS_DEAL });
    const deal = await svc.getDeal('hs-deal-1', ['amount', 'dealstage']);
    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/deals/hs-deal-1'),
      expect.any(Object)
    );
    expect(deal).toEqual(MOCK_HS_DEAL);
  });

  it('returns null on 404', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    const deal = await svc.getDeal('bad-id', ['amount']);
    expect(deal).toBeNull();
  });
});

// ─── getContactById ───────────────────────────────────────────────────────────

describe('HubSpotService — getContactById', () => {
  let svc: HubSpotService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('test-token');
  });

  it('fetches standard fields when no propertyNames provided', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        id: 'contact-1',
        properties: {
          email: 'jane@corp.com',
          firstname: 'Jane',
          lastname: 'Smith',
          phone: '+1-555-0001',
          jobtitle: 'Engineer',
          company: 'Corp Inc',
          hs_linkedin_url: 'https://linkedin.com/in/jane',
        },
      },
    });

    const result = await svc.getContactById('contact-1');

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('contacts/contact-1?properties=email,firstname,lastname,phone,jobtitle,company,hs_linkedin_url'),
      expect.any(Object)
    );
    expect(result.email).toBe('jane@corp.com');
    expect(result.firstname).toBe('Jane');
    expect(result.jobtitle).toBe('Engineer');
  });

  it('fetches only specified propertyNames when provided', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { id: 'contact-2', properties: { my_custom_field: 'custom_val', email: 'x@y.com' } },
    });

    const result = await svc.getContactById('contact-2', ['email', 'my_custom_field']);

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('contacts/contact-2?properties=email,my_custom_field'),
      expect.any(Object)
    );
    expect(result.my_custom_field).toBe('custom_val');
    expect(result.email).toBe('x@y.com');
  });

  it('returns empty object on 404', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    const result = await svc.getContactById('nonexistent');
    expect(result).toEqual({});
  });

  it('rethrows non-404 errors', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 500 }, message: 'Server error' });
    await expect(svc.getContactById('contact-err')).rejects.toMatchObject({ response: { status: 500 } });
  });
});

describe('HubSpotService — addContactToList chunking', () => {
  let svc: HubSpotService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('pat-test');
    mockAxiosPut.mockResolvedValue({ data: {} });
  });

  it('makes 1 PUT call for ≤100 contacts and returns correct addedCount', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `c${i}`);
    const result = await svc.addContactToList('list-1', ids);
    expect(mockAxiosPut).toHaveBeenCalledTimes(1);
    expect(mockAxiosPut.mock.calls[0][1]).toEqual(ids);
    expect(result.addedCount).toBe(50);
    expect(result.failedChunks).toEqual([]);
  });

  it('makes 1 PUT call for exactly 100 contacts', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const result = await svc.addContactToList('list-1', ids);
    expect(mockAxiosPut).toHaveBeenCalledTimes(1);
    expect(result.addedCount).toBe(100);
    expect(result.failedChunks).toEqual([]);
  });

  it('splits 101 contacts into 2 PUT calls (100 + 1)', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `c${i}`);
    const result = await svc.addContactToList('list-1', ids);
    expect(mockAxiosPut).toHaveBeenCalledTimes(2);
    expect(mockAxiosPut.mock.calls[0][1]).toHaveLength(100);
    expect(mockAxiosPut.mock.calls[1][1]).toHaveLength(1);
    expect(result.addedCount).toBe(101);
    expect(result.failedChunks).toEqual([]);
  });

  it('splits 250 contacts into 3 PUT calls (100 + 100 + 50)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const result = await svc.addContactToList('list-1', ids);
    expect(mockAxiosPut).toHaveBeenCalledTimes(3);
    expect(result.addedCount).toBe(250);
  });

  it('preserves contact ID ordering across chunks', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `contact-${i}`);
    await svc.addContactToList('list-1', ids);
    const allSent = [...mockAxiosPut.mock.calls[0][1], ...mockAxiosPut.mock.calls[1][1]];
    expect(allSent).toEqual(ids);
  });

  it('continues remaining chunks when one fails and reports partial success', async () => {
    mockAxiosPut
      .mockResolvedValueOnce({ data: {} })       // chunk 0 (0–99): success
      .mockRejectedValueOnce({ response: { status: 429, data: 'rate limited' } }) // chunk 1 (100–199): fail
      .mockResolvedValueOnce({ data: {} });       // chunk 2 (200–249): success

    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const result = await svc.addContactToList('list-1', ids);

    expect(mockAxiosPut).toHaveBeenCalledTimes(3);
    expect(result.addedCount).toBe(150);        // chunk 0 (100) + chunk 2 (50) succeeded
    expect(result.failedChunks).toEqual([100]); // chunk starting at index 100 failed
  });
});
