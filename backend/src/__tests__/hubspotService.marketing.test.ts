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
    scopes: ['marketing.campaigns.read', 'content', 'automation'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';

const mockGet = axios.get as jest.Mock;
const mockPost = axios.post as jest.Mock;
const mockPatch = axios.patch as jest.Mock;
const mockDelete = axios.delete as jest.Mock;
const mockPut = axios.put as jest.Mock;

function makeSvc(): HubSpotService {
  return HubSpotService.fromToken('test-access-token');
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Campaign Asset Association ───────────────────────────────────────────────

describe('addCampaignAsset', () => {
  it('PUTs to correct URL and resolves on 204', async () => {
    mockPut.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.addCampaignAsset('camp-1', 'MARKETING_EMAIL', 'email-99')).resolves.toBeUndefined();
    const url = mockPut.mock.calls[0][0];
    // Must use the 2026-03 campaigns API (same version as the asset read);
    // the /marketing/v3/campaigns path returns 500 INTERNAL_ERROR for some asset types.
    expect(url).toContain('/marketing/campaigns/2026-03/camp-1/assets/MARKETING_EMAIL/email-99');
    expect(url).not.toContain('/marketing/v3/campaigns/');
  });

  it('throws on API error', async () => {
    mockPut.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    const svc = makeSvc();
    await expect(svc.addCampaignAsset('camp-1', 'MARKETING_EMAIL', 'email-99')).rejects.toThrow();
  });

  it('rejects if guid is empty', async () => {
    const svc = makeSvc();
    await expect(svc.addCampaignAsset('', 'MARKETING_EMAIL', 'email-99')).rejects.toThrow();
  });

  it('rejects if assetType is empty', async () => {
    const svc = makeSvc();
    await expect(svc.addCampaignAsset('camp-1', '', 'email-99')).rejects.toThrow(/assetType/i);
  });
});

describe('removeCampaignAsset', () => {
  it('DELETEs correct URL and resolves on 204', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.removeCampaignAsset('camp-1', 'MARKETING_EMAIL', 'email-99')).resolves.toBeUndefined();
    const url = mockDelete.mock.calls[0][0];
    expect(url).toContain('/marketing/campaigns/2026-03/camp-1/assets/MARKETING_EMAIL/email-99');
    expect(url).not.toContain('/marketing/v3/campaigns/');
  });

  it('throws on API error', async () => {
    mockDelete.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    const svc = makeSvc();
    await expect(svc.removeCampaignAsset('camp-1', 'MARKETING_EMAIL', 'email-99')).rejects.toThrow();
  });

  it('rejects if assetId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.removeCampaignAsset('camp-1', 'MARKETING_EMAIL', '')).rejects.toThrow();
  });

  it('rejects if assetType is empty', async () => {
    const svc = makeSvc();
    await expect(svc.removeCampaignAsset('camp-1', '', 'email-99')).rejects.toThrow(/assetType/i);
  });
});

// ─── Marketing Emails ─────────────────────────────────────────────────────────

describe('listEmails', () => {
  it('GETs /marketing/v3/emails and returns raw data', async () => {
    const data = { results: [{ id: 'e1' }], paging: null };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listEmails();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/marketing/v3/emails');
  });

  it('appends cursor to URL when provided', async () => {
    mockGet.mockResolvedValue({ data: { results: [] } });
    const svc = makeSvc();
    await svc.listEmails('cursor-abc');
    expect(mockGet.mock.calls[0][0]).toContain('after=cursor-abc');
  });

  it('throws on API error', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));
    const svc = makeSvc();
    await expect(svc.listEmails()).rejects.toThrow();
  });
});

describe('getEmail', () => {
  it('returns email by id', async () => {
    const data = { id: 'e1', name: 'Welcome email' };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getEmail('e1');
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/marketing/v3/emails/e1');
  });
});

describe('createEmail', () => {
  it('POSTs to /marketing/v3/emails with name in body', async () => {
    const data = { id: 'e2', name: 'New email' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.createEmail('New email');
    expect(result).toEqual(data);
    const body = mockPost.mock.calls[0][1];
    expect(body.name).toBe('New email');
  });

  it('throws if name is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createEmail('')).rejects.toThrow(/name/i);
  });

  it('throws if name is whitespace', async () => {
    const svc = makeSvc();
    await expect(svc.createEmail('   ')).rejects.toThrow(/name/i);
  });
});

describe('updateEmail', () => {
  it('PATCHes /marketing/v3/emails/:id', async () => {
    const data = { id: 'e1', name: 'Updated' };
    mockPatch.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.updateEmail('e1', { name: 'Updated' });
    expect(result).toEqual(data);
    expect(mockPatch.mock.calls[0][0]).toContain('/marketing/v3/emails/e1');
  });
});

describe('cloneEmail', () => {
  it('POSTs to /marketing/v3/emails/clone with id + cloneName', async () => {
    const data = { id: 'e3', name: 'Clone' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.cloneEmail('e1', 'Clone');
    expect(result).toEqual(data);
    const [url, body] = mockPost.mock.calls[0];
    // Must be the collection-level clone endpoint, NOT /emails/{id}/clone
    expect(url).toMatch(/\/marketing\/v3\/emails\/clone$/);
    expect(body.id).toBe('e1');
    expect(body.cloneName).toBe('Clone');
  });

  it('throws if emailId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.cloneEmail('', 'Clone')).rejects.toThrow(/emailId/i);
  });

  it('throws if name is empty', async () => {
    const svc = makeSvc();
    await expect(svc.cloneEmail('e1', '')).rejects.toThrow(/name/i);
  });
});

describe('getEmailStatistics', () => {
  it('builds repeated query params for emailIds', async () => {
    const data = { results: [] };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    await svc.getEmailStatistics(['id1', 'id2']);
    const url = mockGet.mock.calls[0][0];
    expect(url).toContain('emailIds=id1');
    expect(url).toContain('emailIds=id2');
  });

  it('appends startTimestamp and endTimestamp', async () => {
    mockGet.mockResolvedValue({ data: {} });
    const svc = makeSvc();
    await svc.getEmailStatistics(['id1'], { startTimestamp: '2025-01-01T00:00:00Z', endTimestamp: '2025-12-31T23:59:59Z' });
    const url = mockGet.mock.calls[0][0];
    expect(url).toContain('startTimestamp=' + encodeURIComponent('2025-01-01T00:00:00Z'));
    expect(url).toContain('endTimestamp=' + encodeURIComponent('2025-12-31T23:59:59Z'));
  });

  it('always sends an ISO timestamp range even when none provided (HubSpot requires it)', async () => {
    mockGet.mockResolvedValue({ data: {} });
    const svc = makeSvc();
    await svc.getEmailStatistics(['id1']);
    const url = decodeURIComponent(mockGet.mock.calls[0][0]);
    expect(url).toMatch(/startTimestamp=\d{4}-\d{2}-\d{2}T/);
    expect(url).toMatch(/endTimestamp=\d{4}-\d{2}-\d{2}T/);
    expect(url).not.toContain('undefined');
  });

  it('converts epoch-ms timestamps to ISO (HubSpot rejects raw epoch)', async () => {
    mockGet.mockResolvedValue({ data: {} });
    const svc = makeSvc();
    await svc.getEmailStatistics(['id1'], { startTimestamp: '1735689600000', endTimestamp: '1767225600000' });
    const url = decodeURIComponent(mockGet.mock.calls[0][0]);
    expect(url).toContain('startTimestamp=' + new Date(1735689600000).toISOString());
    expect(url).toContain('endTimestamp=' + new Date(1767225600000).toISOString());
    expect(url).not.toContain('1735689600000');
  });

  it('throws if emailIds empty', async () => {
    const svc = makeSvc();
    await expect(svc.getEmailStatistics([])).rejects.toThrow(/emailIds/i);
  });
});

describe('deleteEmail', () => {
  it('DELETEs /marketing/v3/emails/{emailId} and resolves void on 204', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteEmail('e1')).resolves.toBeUndefined();
    expect(mockDelete.mock.calls[0][0]).toContain('/marketing/v3/emails/e1');
  });

  it('throws if emailId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteEmail('')).rejects.toThrow(/emailId/i);
  });

  it('throws on API error', async () => {
    mockDelete.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    const svc = makeSvc();
    await expect(svc.deleteEmail('e-missing')).rejects.toThrow();
  });
});

describe('publishEmail', () => {
  it('POSTs to /marketing/v3/emails/{id}/publish and resolves on 204', async () => {
    mockPost.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.publishEmail('e1')).resolves.toBeUndefined();
    expect(mockPost.mock.calls[0][0]).toContain('/marketing/v3/emails/e1/publish');
  });

  it('throws if emailId is empty or nullish', async () => {
    const svc = makeSvc();
    await expect(svc.publishEmail('')).rejects.toThrow(/emailId/i);
    await expect(svc.publishEmail(undefined as any)).rejects.toThrow(/emailId/i);
  });

  it('throws on API error', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    const svc = makeSvc();
    await expect(svc.publishEmail('e1')).rejects.toThrow();
  });
});

describe('unpublishEmail', () => {
  it('POSTs to /marketing/v3/emails/{id}/unpublish and resolves on 204', async () => {
    mockPost.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.unpublishEmail('e1')).resolves.toBeUndefined();
    expect(mockPost.mock.calls[0][0]).toContain('/marketing/v3/emails/e1/unpublish');
  });

  it('throws if emailId is empty or nullish', async () => {
    const svc = makeSvc();
    await expect(svc.unpublishEmail('')).rejects.toThrow(/emailId/i);
    await expect(svc.unpublishEmail(undefined as any)).rejects.toThrow(/emailId/i);
  });
});

describe('listSubscriptionTypes', () => {
  it('GETs /communication-preferences/v3/definitions and returns data', async () => {
    const data = { results: [{ id: '123', name: 'Marketing Information' }] };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listSubscriptionTypes();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/communication-preferences/v3/definitions');
  });

  it('throws on API error', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    const svc = makeSvc();
    await expect(svc.listSubscriptionTypes()).rejects.toThrow();
  });
});

describe('createEmail recipients/schedule', () => {
  it('builds to.contactLists and subscriptionDetails from opts', async () => {
    mockPost.mockResolvedValue({ data: { id: 'e9' } });
    const svc = makeSvc();
    await svc.createEmail('Newsletter', {
      subscriptionId: '555',
      contactListsInclude: ['101', '102'],
      contactListsExclude: ['201'],
      sendOnPublish: true,
      publishDate: '2026-07-01T10:00:00Z',
    });
    const body = mockPost.mock.calls[0][1];
    expect(body.to.contactLists.include).toEqual(['101', '102']);
    expect(body.to.contactLists.exclude).toEqual(['201']);
    expect(body.subscriptionDetails.subscriptionId).toBe('555');
    expect(body.sendOnPublish).toBe(true);
    expect(body.publishDate).toBe('2026-07-01T10:00:00Z');
  });

  it('omits to/subscriptionDetails when no recipient opts given', async () => {
    mockPost.mockResolvedValue({ data: { id: 'e9' } });
    const svc = makeSvc();
    await svc.createEmail('Plain');
    const body = mockPost.mock.calls[0][1];
    expect(body.to).toBeUndefined();
    expect(body.subscriptionDetails).toBeUndefined();
  });
});

// ─── Forms ────────────────────────────────────────────────────────────────────

describe('listForms', () => {
  it('GETs /forms/v2/forms and returns data', async () => {
    const data = [{ guid: 'f1' }];
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listForms();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/marketing/v3/forms');
  });
});

describe('getForm', () => {
  it('GETs form by id', async () => {
    const data = { guid: 'f1', name: 'Lead form' };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getForm('f1');
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/marketing/v3/forms/f1');
  });
});

describe('getFormSubmissions', () => {
  it('GETs submissions from the form-integrations endpoint (NOT /marketing/v3/forms/{id}/submissions, which 404s)', async () => {
    const data = { results: [], paging: null };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getFormSubmissions('f1');
    expect(result).toEqual(data);
    const url = mockGet.mock.calls[0][0];
    expect(url).toContain('/form-integrations/v1/submissions/forms/f1');
    expect(url).not.toContain('/marketing/v3/forms/f1/submissions');
  });

  it('appends cursor when provided', async () => {
    mockGet.mockResolvedValue({ data: { results: [] } });
    const svc = makeSvc();
    await svc.getFormSubmissions('f1', 'cursor-xyz');
    expect(mockGet.mock.calls[0][0]).toContain('cursor-xyz');
  });

  it('throws if formId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.getFormSubmissions('')).rejects.toThrow(/formId/i);
  });
});

describe('getFormFields', () => {
  it('flattens fieldGroups[].fields[] into a field list', async () => {
    mockGet.mockResolvedValue({
      data: {
        id: 'f1', name: 'Lead form',
        fieldGroups: [
          { fields: [
            { objectTypeId: '0-1', name: 'email', label: 'Email', fieldType: 'email', required: true },
            { objectTypeId: '0-1', name: 'firstname', label: 'First name', fieldType: 'single_line_text', required: false },
          ] },
          { fields: [
            { objectTypeId: '0-1', name: 'tier', label: 'Tier', fieldType: 'dropdown', required: false, options: [{ label: 'A', value: 'a' }] },
          ] },
        ],
      },
    });
    const svc = makeSvc();
    const result = await svc.getFormFields('f1');
    expect(mockGet.mock.calls[0][0]).toContain('/marketing/v3/forms/f1');
    expect(result.formId).toBe('f1');
    expect(result.fields).toHaveLength(3);
    expect(result.fields[0]).toEqual({ name: 'email', label: 'Email', fieldType: 'email', required: true, objectTypeId: '0-1', options: undefined });
    expect(result.fields[2].options).toEqual([{ label: 'A', value: 'a' }]);
  });

  it('returns empty fields array when form has no fieldGroups', async () => {
    mockGet.mockResolvedValue({ data: { id: 'f1', name: 'Empty' } });
    const svc = makeSvc();
    const result = await svc.getFormFields('f1');
    expect(result.fields).toEqual([]);
  });

  it('returns empty fields array when response data is null', async () => {
    mockGet.mockResolvedValue({ data: null });
    const svc = makeSvc();
    const result = await svc.getFormFields('f1');
    expect(result.fields).toEqual([]);
  });

  it('skips null/empty fieldGroup entries', async () => {
    mockGet.mockResolvedValue({ data: { fieldGroups: [null, { fields: [{ name: 'email', label: 'E', fieldType: 'email', required: true }] }] } });
    const svc = makeSvc();
    const result = await svc.getFormFields('f1');
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('email');
  });

  it('throws if formId is empty or nullish', async () => {
    const svc = makeSvc();
    await expect(svc.getFormFields('')).rejects.toThrow(/formId/i);
    await expect(svc.getFormFields(undefined as any)).rejects.toThrow(/formId/i);
  });

  it('treats a fieldGroup with no fields as empty', async () => {
    mockGet.mockResolvedValue({ data: { id: 'f1', fieldGroups: [{}, { fields: [{ name: 'email', label: 'E', fieldType: 'email', required: true }] }] } });
    const svc = makeSvc();
    const result = await svc.getFormFields('f1');
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].name).toBe('email');
  });
});

describe('submitForm', () => {
  it('POSTs to hsforms integration submit endpoint with fields', async () => {
    mockPost.mockResolvedValue({ data: { inlineMessage: 'Thanks!' } });
    const svc = makeSvc();
    const result = await svc.submitForm('portal-123', 'guid-9', [
      { name: 'email', value: 'a@b.com' },
      { name: 'firstname', value: 'Jane' },
    ]);
    expect(result).toEqual({ inlineMessage: 'Thanks!' });
    const url = mockPost.mock.calls[0][0];
    expect(url).toContain('https://api.hsforms.com/submissions/v3/integration/submit/portal-123/guid-9');
    const body = mockPost.mock.calls[0][1];
    expect(body.fields).toEqual([
      { name: 'email', value: 'a@b.com' },
      { name: 'firstname', value: 'Jane' },
    ]);
  });

  it('includes context and legalConsentOptions when provided', async () => {
    mockPost.mockResolvedValue({ data: {} });
    const svc = makeSvc();
    await svc.submitForm('portal-123', 'guid-9', [{ name: 'email', value: 'a@b.com' }], {
      context: { pageUri: 'https://x.com', pageName: 'Home' },
      legalConsentOptions: { consent: { consentToProcess: true } },
    });
    const body = mockPost.mock.calls[0][1];
    expect(body.context.pageUri).toBe('https://x.com');
    expect(body.legalConsentOptions.consent.consentToProcess).toBe(true);
  });

  it('throws if portalId is empty or nullish', async () => {
    const svc = makeSvc();
    await expect(svc.submitForm('', 'guid-9', [{ name: 'email', value: 'a@b.com' }])).rejects.toThrow(/portalId/i);
    await expect(svc.submitForm(undefined as any, 'guid-9', [{ name: 'email', value: 'a@b.com' }])).rejects.toThrow(/portalId/i);
  });

  it('throws if formGuid is empty or nullish', async () => {
    const svc = makeSvc();
    await expect(svc.submitForm('portal-123', '', [{ name: 'email', value: 'a@b.com' }])).rejects.toThrow(/formGuid/i);
    await expect(svc.submitForm('portal-123', undefined as any, [{ name: 'email', value: 'a@b.com' }])).rejects.toThrow(/formGuid/i);
  });

  it('throws if fields array is empty or nullish', async () => {
    const svc = makeSvc();
    await expect(svc.submitForm('portal-123', 'guid-9', [])).rejects.toThrow(/fields/i);
    await expect(svc.submitForm('portal-123', 'guid-9', undefined as any)).rejects.toThrow(/fields/i);
  });
});

// ─── Contact Lists ────────────────────────────────────────────────────────────

describe('listContactLists', () => {
  it('POSTs to /crm/lists/2026-03/search and returns lists', async () => {
    const data = { lists: [{ listId: 'l1', name: 'My list' }] };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listContactLists();
    expect(result).toEqual(data);
    expect(mockPost.mock.calls[0][0]).toContain('/crm/lists/2026-03/search');
  });

  it('passes query and cursor when provided', async () => {
    mockPost.mockResolvedValue({ data: { lists: [] } });
    const svc = makeSvc();
    await svc.listContactLists({ query: 'newsletter', cursor: 'abc' });
    const body = mockPost.mock.calls[0][1];
    expect(body.query).toBe('newsletter');
    expect(body.after).toBe('abc');
  });
});

describe('getContactList', () => {
  it('GETs /crm/lists/2026-03/{listId} and returns list', async () => {
    const data = { list: { listId: 'l1', name: 'My list' } };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getContactList('l1');
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/crm/lists/2026-03/l1');
  });

  it('throws if listId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.getContactList('')).rejects.toThrow(/listId/i);
  });
});

describe('createContactList', () => {
  it('POSTs to /crm/lists/2026-03 with required fields', async () => {
    const data = { listId: 'l2', name: 'New list', processingType: 'MANUAL' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.createContactList('New list', 'MANUAL');
    expect(result).toEqual(data);
    const body = mockPost.mock.calls[0][1];
    expect(body.name).toBe('New list');
    expect(body.processingType).toBe('MANUAL');
    expect(body.objectTypeId).toBe('0-1');
  });

  it('throws if name is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createContactList('', 'MANUAL')).rejects.toThrow(/name/i);
  });

  it('throws if processingType is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createContactList('My list', '')).rejects.toThrow(/processingType/i);
  });
});

describe('addContactsToList', () => {
  it('PUTs array of IDs to /crm/lists/2026-03/{listId}/memberships/add', async () => {
    const data = { recordsIdsAdded: ['c1', 'c2'], recordIdsRemoved: [], recordIdsMissing: [] };
    mockPut.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.addContactsToList('l1', ['c1', 'c2']);
    expect(result).toEqual(data);
    const url = mockPut.mock.calls[0][0];
    expect(url).toContain('/crm/lists/2026-03/l1/memberships/add');
    expect(mockPut.mock.calls[0][1]).toEqual(['c1', 'c2']);
  });

  it('throws if listId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.addContactsToList('', ['c1'])).rejects.toThrow(/listId/i);
  });

  it('throws if recordIds is empty', async () => {
    const svc = makeSvc();
    await expect(svc.addContactsToList('l1', [])).rejects.toThrow(/recordIds/i);
  });
});

describe('removeContactsFromList', () => {
  it('PUTs to /memberships/remove with raw array body', async () => {
    const data = { recordIdsRemoved: ['c1'], recordIdsMissing: [] };
    mockPut.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.removeContactsFromList('l1', ['c1']);
    expect(result).toEqual(data);
    const url = mockPut.mock.calls[0][0];
    expect(url).toContain('/crm/lists/2026-03/l1/memberships/remove');
    const body = mockPut.mock.calls[0][1];
    expect(body).toEqual(['c1']);
  });

  it('throws if listId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.removeContactsFromList('', ['c1'])).rejects.toThrow(/listId/i);
  });

  it('throws if recordIds is empty', async () => {
    const svc = makeSvc();
    await expect(svc.removeContactsFromList('l1', [])).rejects.toThrow(/recordIds/i);
  });
});

describe('deleteContactList', () => {
  it('DELETEs /crm/lists/2026-03/{listId} and resolves void on 204', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteContactList('l1')).resolves.toBeUndefined();
    expect(mockDelete.mock.calls[0][0]).toContain('/crm/lists/2026-03/l1');
  });

  it('throws if listId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteContactList('')).rejects.toThrow(/listId/i);
  });
});

// ─── Forms (write) ───────────────────────────────────────────────────────────

describe('createForm', () => {
  it('POSTs to /marketing/v3/forms and returns created form', async () => {
    const data = { id: 'f2', name: 'New form', formType: 'hubspot' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const props = { formType: 'hubspot', name: 'New form', fieldGroups: [], archived: false };
    const result = await svc.createForm(props);
    expect(result).toEqual(data);
    expect(mockPost.mock.calls[0][0]).toContain('/marketing/v3/forms');
    expect(mockPost.mock.calls[0][1].name).toBe('New form');
  });

  it('throws if name is missing from props', async () => {
    const svc = makeSvc();
    await expect(svc.createForm({ formType: 'hubspot', fieldGroups: [] })).rejects.toThrow(/name/i);
  });

  it('throws if name is empty string', async () => {
    const svc = makeSvc();
    await expect(svc.createForm({ name: '', formType: 'hubspot' })).rejects.toThrow(/name/i);
  });

  it('injects createdAt/updatedAt/archived defaults when missing (HubSpot requires them on create)', async () => {
    mockPost.mockResolvedValue({ data: { id: 'f9' } });
    const svc = makeSvc();
    await svc.createForm({ name: 'New form', formType: 'hubspot', fieldGroups: [] });
    const body = mockPost.mock.calls[0][1];
    expect(typeof body.createdAt).toBe('string');
    expect(typeof body.updatedAt).toBe('string');
    expect(body.archived).toBe(false);
  });

  it('does not overwrite caller-provided createdAt/archived', async () => {
    mockPost.mockResolvedValue({ data: { id: 'f9' } });
    const svc = makeSvc();
    await svc.createForm({ name: 'X', formType: 'hubspot', fieldGroups: [], createdAt: '2020-01-01T00:00:00Z', archived: true });
    const body = mockPost.mock.calls[0][1];
    expect(body.createdAt).toBe('2020-01-01T00:00:00Z');
    expect(body.archived).toBe(true);
  });
});

describe('updateForm', () => {
  it('PATCHes /marketing/v3/forms/{formId} and returns updated form', async () => {
    const data = { id: 'f1', name: 'Renamed form' };
    mockPatch.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.updateForm('f1', { name: 'Renamed form' });
    expect(result).toEqual(data);
    expect(mockPatch.mock.calls[0][0]).toContain('/marketing/v3/forms/f1');
    expect(mockPatch.mock.calls[0][1].name).toBe('Renamed form');
  });

  it('throws if formId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.updateForm('', { name: 'x' })).rejects.toThrow(/formId/i);
  });
});

describe('deleteForm', () => {
  it('DELETEs /marketing/v3/forms/{formId} and resolves void on 204', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteForm('f1')).resolves.toBeUndefined();
    expect(mockDelete.mock.calls[0][0]).toContain('/marketing/v3/forms/f1');
  });

  it('throws if formId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteForm('')).rejects.toThrow(/formId/i);
  });
});

// ─── Landing Pages ────────────────────────────────────────────────────────────

describe('listLandingPages', () => {
  it('GETs /cms/v3/pages/landing-pages', async () => {
    const data = { results: [], total: 0 };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listLandingPages();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/cms/v3/pages/landing-pages');
  });
});

describe('getLandingPage', () => {
  it('GETs a single landing page by id', async () => {
    const data = { id: 'p1', name: 'LP' };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getLandingPage('p1');
    expect(result).toEqual(data);
  });
});

describe('createLandingPage', () => {
  it('POSTs with name in body', async () => {
    const data = { id: 'p2', name: 'New LP' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.createLandingPage('New LP');
    expect(result).toEqual(data);
    expect(mockPost.mock.calls[0][1].name).toBe('New LP');
  });

  it('throws if name is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createLandingPage('')).rejects.toThrow(/name/i);
  });
});

describe('publishLandingPage', () => {
  it('POSTs to push-live endpoint', async () => {
    const data = { id: 'p1', state: 'PUBLISHED' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.publishLandingPage('p1');
    expect(result).toEqual(data);
    expect(mockPost.mock.calls[0][0]).toContain('push-live');
  });
});

describe('updateLandingPage', () => {
  it('PATCHes /cms/v3/pages/landing-pages/{pageId} and returns updated page', async () => {
    const data = { id: 'p1', name: 'Updated LP', htmlTitle: 'New title' };
    mockPatch.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.updateLandingPage('p1', { name: 'Updated LP', htmlTitle: 'New title' });
    expect(result).toEqual(data);
    expect(mockPatch.mock.calls[0][0]).toContain('/cms/v3/pages/landing-pages/p1');
    const body = mockPatch.mock.calls[0][1];
    expect(body.name).toBe('Updated LP');
  });

  it('throws if pageId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.updateLandingPage('', { name: 'x' })).rejects.toThrow(/pageId/i);
  });
});

describe('deleteLandingPage', () => {
  it('DELETEs /cms/v3/pages/landing-pages/{pageId} and resolves void on 204', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteLandingPage('p1')).resolves.toBeUndefined();
    expect(mockDelete.mock.calls[0][0]).toContain('/cms/v3/pages/landing-pages/p1');
  });

  it('throws if pageId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteLandingPage('')).rejects.toThrow(/pageId/i);
  });
});

// ─── Blog Posts ───────────────────────────────────────────────────────────────

describe('listBlogPosts', () => {
  it('GETs /cms/v3/blogs/posts', async () => {
    const data = { results: [], total: 0 };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listBlogPosts();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/cms/v3/blogs/posts');
  });
});

describe('getBlogPost', () => {
  it('GETs a single blog post by id', async () => {
    const data = { id: 'bp1', name: 'My post' };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getBlogPost('bp1');
    expect(result).toEqual(data);
  });
});

describe('createBlogPost', () => {
  it('POSTs with name and contentGroupId', async () => {
    const data = { id: 'bp2', name: 'New post' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.createBlogPost('New post', 'blog-group-1');
    expect(result).toEqual(data);
    const body = mockPost.mock.calls[0][1];
    expect(body.name).toBe('New post');
    expect(body.contentGroupId).toBe('blog-group-1');
  });

  it('throws if name is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createBlogPost('', 'group-1')).rejects.toThrow(/name/i);
  });

  it('throws if contentGroupId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createBlogPost('My post', '')).rejects.toThrow(/contentGroupId/i);
  });
});

describe('publishBlogPost', () => {
  it('POSTs to push-live endpoint and resolves void on 204', async () => {
    mockPost.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.publishBlogPost('bp1')).resolves.toBeUndefined();
    expect(mockPost.mock.calls[0][0]).toContain('/cms/blogs/2026-03/posts/bp1/draft/push-live');
  });
});

describe('updateBlogPost', () => {
  it('PATCHes /cms/v3/blogs/posts/{postId} and returns updated post', async () => {
    const data = { id: 'bp1', name: 'Updated post' };
    mockPatch.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.updateBlogPost('bp1', { name: 'Updated post', metaDescription: 'New desc' });
    expect(result).toEqual(data);
    expect(mockPatch.mock.calls[0][0]).toContain('/cms/v3/blogs/posts/bp1');
    const body = mockPatch.mock.calls[0][1];
    expect(body.name).toBe('Updated post');
  });

  it('throws if postId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.updateBlogPost('', { name: 'x' })).rejects.toThrow(/postId/i);
  });
});

describe('deleteBlogPost', () => {
  it('DELETEs /cms/v3/blogs/posts/{postId} and resolves void on 204', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteBlogPost('bp1')).resolves.toBeUndefined();
    expect(mockDelete.mock.calls[0][0]).toContain('/cms/v3/blogs/posts/bp1');
  });

  it('throws if postId is empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteBlogPost('')).rejects.toThrow(/postId/i);
  });
});

// ─── Workflows ────────────────────────────────────────────────────────────────

// v3 workflowId -> v4 flowId mapping response
const MAP_RESP = { data: { status: 'COMPLETE', results: [{ workflowId: 'wf1', flowId: 9001 }] } };

describe('deleteWorkflow', () => {
  it('maps the v3 workflowId to a v4 flowId, then DELETEs /automation/v4/flows/{flowId}', async () => {
    mockPost.mockResolvedValueOnce(MAP_RESP); // mapping
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteWorkflow('wf1')).resolves.toBeUndefined();
    const [mapUrl, mapBody] = mockPost.mock.calls[0];
    expect(mapUrl).toContain('/automation/v4/workflow-id-mappings/batch/read');
    expect(mapBody.inputs[0]).toEqual({ type: 'WORKFLOW_ID', workflowId: 'wf1' });
    // must DELETE the mapped flowId (9001), NOT the v3 id (wf1)
    expect(mockDelete.mock.calls[0][0]).toContain('/automation/v4/flows/9001');
    expect(mockDelete.mock.calls[0][0]).not.toContain('/flows/wf1');
  });

  it('throws if the workflowId cannot be mapped to a flowId', async () => {
    mockPost.mockResolvedValueOnce({ data: { status: 'COMPLETE', results: [] } });
    const svc = makeSvc();
    await expect(svc.deleteWorkflow('wf1')).rejects.toThrow(/map/i);
  });

  it('throws if workflowId empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteWorkflow('')).rejects.toThrow(/workflowId/i);
  });
});

describe('setWorkflowEnabled', () => {
  const FLOW = {
    id: '9001', type: 'CONTACT_FLOW', revisionId: 'rev-7', isEnabled: false,
    name: 'Nurture', actions: [{ actionId: '1' }], blockedDates: [],
    createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-02-01T00:00:00Z', dataSources: { a: 1 },
  };
  const batchRead = (flow: any) => ({ data: { status: 'COMPLETE', results: [flow] } });

  it('maps v3->v4, batch-reads the flow, PUTs it back to /flows/{flowId} with isEnabled=true', async () => {
    mockPost.mockResolvedValueOnce(MAP_RESP)            // mapping
            .mockResolvedValueOnce(batchRead({ ...FLOW })); // batch read
    mockPut.mockResolvedValue({ data: { ...FLOW, isEnabled: true, revisionId: 'rev-8' } });
    const svc = makeSvc();
    const result = await svc.setWorkflowEnabled('wf1', true);
    // mapping + batch-read endpoints
    expect(mockPost.mock.calls[0][0]).toContain('/automation/v4/workflow-id-mappings/batch/read');
    expect(mockPost.mock.calls[1][0]).toContain('/automation/v4/flows/batch/read');
    expect(mockPost.mock.calls[1][1].inputs[0]).toEqual({ type: 'FLOW_ID', flowId: '9001' });
    const [putUrl, putBody] = mockPut.mock.calls[0];
    expect(putUrl).toContain('/automation/v4/flows/9001');
    expect(putBody.isEnabled).toBe(true);
    expect(putBody.revisionId).toBe('rev-7');
    expect(putBody.type).toBe('CONTACT_FLOW');
    expect(putBody.actions).toEqual([{ actionId: '1' }]);
    // server-managed fields stripped from the full-replace PUT
    expect(putBody.createdAt).toBeUndefined();
    expect(putBody.updatedAt).toBeUndefined();
    expect(putBody.dataSources).toBeUndefined();
    expect(result.isEnabled).toBe(true);
  });

  it('PUTs isEnabled=false when disabling', async () => {
    mockPost.mockResolvedValueOnce(MAP_RESP).mockResolvedValueOnce(batchRead({ ...FLOW, isEnabled: true }));
    mockPut.mockResolvedValue({ data: { ...FLOW, isEnabled: false } });
    const svc = makeSvc();
    await svc.setWorkflowEnabled('wf1', false);
    expect(mockPut.mock.calls[0][1].isEnabled).toBe(false);
  });

  it('throws with the HubSpot error when the flow is not readable (e.g. missing sensitive scopes)', async () => {
    mockPost.mockResolvedValueOnce(MAP_RESP)
            .mockResolvedValueOnce({ data: { status: 'COMPLETE', results: [], errors: [{ message: 'sensitive data scopes must be provided' }] } });
    const svc = makeSvc();
    await expect(svc.setWorkflowEnabled('wf1', true)).rejects.toThrow(/sensitive data scopes/i);
  });

  it('throws if workflowId empty', async () => {
    const svc = makeSvc();
    await expect(svc.setWorkflowEnabled('', true)).rejects.toThrow(/workflowId/i);
  });
});

describe('getWorkflowPerformance', () => {
  it('GETs v3 performance endpoint with correct params', async () => {
    const data = [{ series: 'ENROLLED', bucket: '2025-01-01', frequency: 50 }];
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getWorkflowPerformance('wf1', 1000, 2000, 'DAY');
    expect(result).toEqual(data);
    const url = mockGet.mock.calls[0][0];
    expect(url).toContain('/automation/v3/performance/workflow/wf1');
    expect(url).toContain('start=1000');
    expect(url).toContain('end=2000');
    expect(url).toContain('bucket=DAY');
  });

  it('throws if workflowId empty', async () => {
    const svc = makeSvc();
    await expect(svc.getWorkflowPerformance('', 1000, 2000, 'DAY')).rejects.toThrow(/workflowId/i);
  });
});

describe('listWorkflows', () => {
  it('GETs /automation/v3/workflows', async () => {
    const data = { workflows: [] };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listWorkflows();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/automation/v3/workflows');
  });

  it('throws on API error', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    const svc = makeSvc();
    await expect(svc.listWorkflows()).rejects.toThrow();
  });
});

describe('getWorkflow', () => {
  it('GETs single workflow by id', async () => {
    const data = { id: 'wf1', name: 'Nurture sequence' };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getWorkflow('wf1');
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/automation/v3/workflows/wf1');
  });
});

// ─── Social Broadcasts ────────────────────────────────────────────────────────

describe('listSocialChannels', () => {
  it('GETs /broadcast/v1/channels', async () => {
    const data = { channels: [] };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listSocialChannels();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/broadcast/v1/channels');
  });
});

describe('listSocialBroadcasts', () => {
  it('GETs /broadcast/v1/broadcasts', async () => {
    const data = { broadcasts: [] };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.listSocialBroadcasts();
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('/broadcast/v1/broadcasts');
  });
});

describe('createSocialBroadcast', () => {
  it('POSTs with channelKey and body', async () => {
    const data = { id: 'sb1' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.createSocialBroadcast('Twitter:123', 'Hello world!');
    expect(result).toEqual(data);
    const payload = mockPost.mock.calls[0][1];
    expect(payload.channelKey).toBe('Twitter:123');
    expect(payload.content.body).toBe('Hello world!');
  });

  it('includes triggerAt when provided', async () => {
    mockPost.mockResolvedValue({ data: { id: 'sb2' } });
    const svc = makeSvc();
    await svc.createSocialBroadcast('Twitter:123', 'Scheduled post', { triggerAt: 1750000000000 });
    const payload = mockPost.mock.calls[0][1];
    expect(payload.triggerAt).toBe(1750000000000);
  });

  it('throws if channelKey is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createSocialBroadcast('', 'Body text')).rejects.toThrow(/channelKey/i);
  });

  it('throws if body is empty', async () => {
    const svc = makeSvc();
    await expect(svc.createSocialBroadcast('Twitter:123', '')).rejects.toThrow(/body/i);
  });
});

describe('deleteSocialBroadcast', () => {
  it('DELETEs /broadcast/v1/broadcasts/{guid} and resolves void on 204', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteSocialBroadcast('sb1')).resolves.toBeUndefined();
    expect(mockDelete.mock.calls[0][0]).toContain('/broadcast/v1/broadcasts/sb1');
  });

  it('throws if broadcastGuid is empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteSocialBroadcast('')).rejects.toThrow(/broadcastGuid/i);
  });

  it('throws on API error', async () => {
    mockDelete.mockRejectedValue(Object.assign(new Error('Not found'), { response: { status: 404 } }));
    const svc = makeSvc();
    await expect(svc.deleteSocialBroadcast('sb-missing')).rejects.toThrow();
  });
});

describe('getAllLists — pagination cap', () => {
  it('stops at MAX_PAGES (50) when cursor never terminates', async () => {
    mockPost.mockResolvedValue({
      data: {
        lists: [{ listId: 'list-1', name: 'Test List' }],
        paging: { next: { after: 'cursor-infinite' } },
      },
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const svc = makeSvc();
    const results = await svc.getAllLists();

    expect(mockPost).toHaveBeenCalledTimes(50);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('50-page cap'));
    expect(results).toHaveLength(50);
    warnSpy.mockRestore();
  });
});
