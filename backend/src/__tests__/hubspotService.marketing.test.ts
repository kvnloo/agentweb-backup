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
    expect(url).toContain('/marketing/v3/campaigns/camp-1/assets/MARKETING_EMAIL/email-99');
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
    expect(url).toContain('/marketing/v3/campaigns/camp-1/assets/MARKETING_EMAIL/email-99');
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
  it('POSTs clone with name', async () => {
    const data = { id: 'e3', name: 'Clone' };
    mockPost.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.cloneEmail('e1', 'Clone');
    expect(result).toEqual(data);
    const body = mockPost.mock.calls[0][1];
    expect(body.name).toBe('Clone');
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
    expect(url).toContain('startTimestamp=');
    expect(url).toContain('endTimestamp=');
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
  it('GETs submissions for a form', async () => {
    const data = { results: [], paging: null };
    mockGet.mockResolvedValue({ data });
    const svc = makeSvc();
    const result = await svc.getFormSubmissions('f1');
    expect(result).toEqual(data);
    expect(mockGet.mock.calls[0][0]).toContain('f1');
  });

  it('appends cursor when provided', async () => {
    mockGet.mockResolvedValue({ data: { results: [] } });
    const svc = makeSvc();
    await svc.getFormSubmissions('f1', 'cursor-xyz');
    expect(mockGet.mock.calls[0][0]).toContain('cursor-xyz');
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

describe('deleteWorkflow', () => {
  it('DELETEs /automation/v4/flows/{id}', async () => {
    mockDelete.mockResolvedValue({ status: 204, data: null });
    const svc = makeSvc();
    await expect(svc.deleteWorkflow('wf1')).resolves.toBeUndefined();
    expect(mockDelete.mock.calls[0][0]).toContain('/automation/v4/flows/wf1');
  });

  it('throws if workflowId empty', async () => {
    const svc = makeSvc();
    await expect(svc.deleteWorkflow('')).rejects.toThrow(/workflowId/i);
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
