/**
 * Tests for agentModeService.handleHubspotApi — marketing entities:
 * EMAIL DELETE, FORM CREATE/UPDATE/DELETE, LANDING_PAGE UPDATE/DELETE,
 * BLOG_POST UPDATE/DELETE, SOCIAL DELETE_BROADCAST, CONTACT_LIST (all actions).
 */

process.env.JWT_SECRET = 'test-secret';

// ── Mock HubSpotService before imports ────────────────────────────────────────

const mockDeleteEmail = jest.fn();
const mockUpdateLandingPage = jest.fn();
const mockDeleteLandingPage = jest.fn();
const mockUpdateBlogPost = jest.fn();
const mockDeleteBlogPost = jest.fn();
const mockDeleteSocialBroadcast = jest.fn();
const mockCreateForm = jest.fn();
const mockUpdateForm = jest.fn();
const mockDeleteForm = jest.fn();
const mockListContactLists = jest.fn();
const mockGetContactList = jest.fn();
const mockCreateContactList = jest.fn();
const mockAddContactsToList = jest.fn();
const mockRemoveContactsFromList = jest.fn();
const mockDeleteContactList = jest.fn();

const mockSvcInstance = {
  deleteEmail: mockDeleteEmail,
  updateLandingPage: mockUpdateLandingPage,
  deleteLandingPage: mockDeleteLandingPage,
  updateBlogPost: mockUpdateBlogPost,
  deleteBlogPost: mockDeleteBlogPost,
  deleteSocialBroadcast: mockDeleteSocialBroadcast,
  createForm: mockCreateForm,
  updateForm: mockUpdateForm,
  deleteForm: mockDeleteForm,
  listContactLists: mockListContactLists,
  getContactList: mockGetContactList,
  createContactList: mockCreateContactList,
  addContactsToList: mockAddContactsToList,
  removeContactsFromList: mockRemoveContactsFromList,
  deleteContactList: mockDeleteContactList,
};

const mockHubSpotCreate = jest.fn();
const mockHubSpotFromToken = jest.fn().mockReturnValue(mockSvcInstance);

jest.mock('../services/hubspotService', () => ({
  HubSpotService: {
    create: (...a: any[]) => mockHubSpotCreate(...a),
    fromToken: (...a: any[]) => mockHubSpotFromToken(...a),
  },
}));

// ── Minimal mocks to load agentModeService ────────────────────────────────────

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn().mockResolvedValue([]),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({ clientId: 'x', clientSecret: 'y', tokenUrl: 'u', redirectUri: 'r', scopes: [], authorizationUrl: 'a', tokenInfoUrl: 't' }),
  INTEGRATION_CONFIG: {
    hubspot: { scopes: [] },
    linkedinAds: { apiVersion: '202603', apiBaseUrl: 'https://api.linkedin.com', scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '', profileUrl: '' },
    linkedin: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '', profileUrl: '' },
    meta: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    google: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    googleAds: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    hubspotOAuth: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '' },
    clickup: { scopes: [] },
  },
  getLinkedInScopesForType: jest.fn().mockReturnValue([]),
}));
jest.mock('../services/notionService', () => ({ createOncallItem: jest.fn() }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/settingsService', () => ({ settingsService: { getJsonArraySetting: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/accountSummaryService', () => ({ getAccountSummary: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/askCrmService', () => ({ askCrm: jest.fn(), AskCrmLead: {} }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../routes/tasks', () => ({ getExecutionsWithAssets: jest.fn() }));
jest.mock('../config', () => ({ RESEND_SYSTEM_EMAIL: 'x@x.com', RESEND_SYSTEM_NAME: 'X' }));
jest.mock('../services/dealDb', () => ({
  DEAL_STAGES: ['Lead'],
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  dealDb: {},
}));
jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: { logEvent: jest.fn() },
  normalizeContactId: (r: string) => r,
  KNOWN_CONTACT_EVENT_TYPES: new Set(),
  PUBLIC_LOGGABLE_EVENT_TYPES: new Set(),
}));
jest.mock('../services/contactCaptureHooks', () => ({
  logManualEvent: jest.fn(),
  isKnownContactEventType: jest.fn(),
  onUserRegistered: jest.fn(),
  onOnboardingStageChanged: jest.fn(),
  onPublicFormSubmitted: jest.fn(),
  onPublicPageVisited: jest.fn(),
}));
jest.mock('../services/db', () => ({
  crmDb: { getLeadListsByUserId: jest.fn().mockResolvedValue([]) },
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: { getMemories: jest.fn().mockResolvedValue([]), putMemory: jest.fn(), deleteMemory: jest.fn() },
  orgMemoryDb: { getMemories: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../mcp/server/registry', () => ({
  McpToolRegistry: jest.fn().mockImplementation(() => ({ register: jest.fn(), getTool: jest.fn(), getToolNames: jest.fn(() => []), getAllToolDefinitions: jest.fn(() => []), getAllTools: jest.fn(() => []) })),
  mcpToolRegistry: { register: jest.fn(), getTool: jest.fn(), getToolNames: jest.fn(() => []), getAllToolDefinitions: jest.fn(() => []), getAllTools: jest.fn(() => []) },
}));
jest.mock('../mcp/server/apiTools', () => ({ adminToolNames: [] }));

import { agentModeService } from '../services/agentModeService';

const USER = 'user-456';
const EMAIL_ID = 'email-1';
const PAGE_ID = 'page-1';
const POST_ID = 'post-1';
const FORM_ID = 'form-1';
const BROADCAST_GUID = 'broadcast-guid-1';
const LIST_ID = 'list-1';

const hs = (args: any) => agentModeService.handleHubspotApi(USER, args);

beforeEach(() => {
  jest.clearAllMocks();
  mockHubSpotCreate.mockResolvedValue(mockSvcInstance);
});

// ─── EMAIL DELETE ─────────────────────────────────────────────────────────────

describe('EMAIL DELETE', () => {
  it('returns error when email_id missing', async () => {
    const result = await hs({ entity_type: 'EMAIL', action: 'DELETE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/email_id/i);
    expect(mockDeleteEmail).not.toHaveBeenCalled();
  });

  it('calls deleteEmail and returns deleted id', async () => {
    mockDeleteEmail.mockResolvedValue(undefined);
    const result = await hs({ entity_type: 'EMAIL', action: 'DELETE', email_id: EMAIL_ID });
    expect(mockDeleteEmail).toHaveBeenCalledWith(EMAIL_ID);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(EMAIL_ID);
  });
});

// ─── LANDING_PAGE UPDATE ──────────────────────────────────────────────────────

describe('LANDING_PAGE UPDATE', () => {
  it('returns error when page_id missing', async () => {
    const result = await hs({ entity_type: 'LANDING_PAGE', action: 'UPDATE', html_title: 'New Title' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/page_id/i);
    expect(mockUpdateLandingPage).not.toHaveBeenCalled();
  });

  it('calls updateLandingPage with camelCased props', async () => {
    const raw = { id: PAGE_ID, name: 'Updated' };
    mockUpdateLandingPage.mockResolvedValue(raw);
    const result = await hs({
      entity_type: 'LANDING_PAGE',
      action: 'UPDATE',
      page_id: PAGE_ID,
      html_title: 'New Title',
      meta_description: 'Desc',
    });
    expect(mockUpdateLandingPage).toHaveBeenCalledWith(PAGE_ID, {
      htmlTitle: 'New Title',
      metaDescription: 'Desc',
    });
    expect(result.success).toBe(true);
    expect(result.id).toBe(PAGE_ID);
  });

  it('does not pass entity_type or action to service', async () => {
    mockUpdateLandingPage.mockResolvedValue({ id: PAGE_ID });
    await hs({ entity_type: 'LANDING_PAGE', action: 'UPDATE', page_id: PAGE_ID, html_title: 'X' });
    const props = mockUpdateLandingPage.mock.calls[0][1];
    expect(props).not.toHaveProperty('entity_type');
    expect(props).not.toHaveProperty('action');
    expect(props).not.toHaveProperty('entityType');
  });
});

// ─── LANDING_PAGE DELETE ──────────────────────────────────────────────────────

describe('LANDING_PAGE DELETE', () => {
  it('returns error when page_id missing', async () => {
    const result = await hs({ entity_type: 'LANDING_PAGE', action: 'DELETE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/page_id/i);
    expect(mockDeleteLandingPage).not.toHaveBeenCalled();
  });

  it('calls deleteLandingPage and returns deleted id', async () => {
    mockDeleteLandingPage.mockResolvedValue(undefined);
    const result = await hs({ entity_type: 'LANDING_PAGE', action: 'DELETE', page_id: PAGE_ID });
    expect(mockDeleteLandingPage).toHaveBeenCalledWith(PAGE_ID);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(PAGE_ID);
  });
});

// ─── BLOG_POST UPDATE ─────────────────────────────────────────────────────────

describe('BLOG_POST UPDATE', () => {
  it('returns error when post_id missing', async () => {
    const result = await hs({ entity_type: 'BLOG_POST', action: 'UPDATE', post_body: '<p>Hello</p>' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/post_id/i);
    expect(mockUpdateBlogPost).not.toHaveBeenCalled();
  });

  it('calls updateBlogPost with camelCased props', async () => {
    const raw = { id: POST_ID, name: 'Updated Post' };
    mockUpdateBlogPost.mockResolvedValue(raw);
    const result = await hs({
      entity_type: 'BLOG_POST',
      action: 'UPDATE',
      post_id: POST_ID,
      post_body: '<p>New content</p>',
      meta_description: 'Meta',
      html_title: 'Title',
    });
    expect(mockUpdateBlogPost).toHaveBeenCalledWith(POST_ID, {
      postBody: '<p>New content</p>',
      metaDescription: 'Meta',
      htmlTitle: 'Title',
    });
    expect(result.success).toBe(true);
    expect(result.id).toBe(POST_ID);
  });

  it('does not pass entity_type or action to service', async () => {
    mockUpdateBlogPost.mockResolvedValue({ id: POST_ID });
    await hs({ entity_type: 'BLOG_POST', action: 'UPDATE', post_id: POST_ID, html_title: 'X' });
    const props = mockUpdateBlogPost.mock.calls[0][1];
    expect(props).not.toHaveProperty('entity_type');
    expect(props).not.toHaveProperty('action');
  });
});

// ─── BLOG_POST DELETE ─────────────────────────────────────────────────────────

describe('BLOG_POST DELETE', () => {
  it('returns error when post_id missing', async () => {
    const result = await hs({ entity_type: 'BLOG_POST', action: 'DELETE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/post_id/i);
    expect(mockDeleteBlogPost).not.toHaveBeenCalled();
  });

  it('calls deleteBlogPost and returns deleted id', async () => {
    mockDeleteBlogPost.mockResolvedValue(undefined);
    const result = await hs({ entity_type: 'BLOG_POST', action: 'DELETE', post_id: POST_ID });
    expect(mockDeleteBlogPost).toHaveBeenCalledWith(POST_ID);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(POST_ID);
  });
});

// ─── FORM CREATE ──────────────────────────────────────────────────────────────

describe('FORM CREATE', () => {
  it('returns error when name missing', async () => {
    const result = await hs({ entity_type: 'FORM', action: 'CREATE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name/i);
    expect(mockCreateForm).not.toHaveBeenCalled();
  });

  it('returns error when name is blank', async () => {
    const result = await hs({ entity_type: 'FORM', action: 'CREATE', name: '  ' });
    expect(result.success).toBe(false);
    expect(mockCreateForm).not.toHaveBeenCalled();
  });

  it('calls createForm with props and returns data', async () => {
    const raw = { id: FORM_ID, name: 'Contact Form' };
    mockCreateForm.mockResolvedValue(raw);
    const result = await hs({ entity_type: 'FORM', action: 'CREATE', name: 'Contact Form', formType: 'hubspot' });
    expect(mockCreateForm).toHaveBeenCalledWith(expect.objectContaining({ name: 'Contact Form', formType: 'hubspot' }));
    expect(result.success).toBe(true);
    expect(result.id).toBe(FORM_ID);
  });

  it('does not pass entity_type, action, or form_id to service', async () => {
    mockCreateForm.mockResolvedValue({ id: FORM_ID });
    await hs({ entity_type: 'FORM', action: 'CREATE', name: 'X', form_id: 'stray' });
    const props = mockCreateForm.mock.calls[0][0];
    expect(props).not.toHaveProperty('entity_type');
    expect(props).not.toHaveProperty('action');
    expect(props).not.toHaveProperty('form_id');
  });
});

// ─── FORM UPDATE ──────────────────────────────────────────────────────────────

describe('FORM UPDATE', () => {
  it('returns error when form_id missing', async () => {
    const result = await hs({ entity_type: 'FORM', action: 'UPDATE', name: 'New Name' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/form_id/i);
    expect(mockUpdateForm).not.toHaveBeenCalled();
  });

  it('calls updateForm with form_id and stripped props', async () => {
    const raw = { id: FORM_ID, name: 'Updated' };
    mockUpdateForm.mockResolvedValue(raw);
    const result = await hs({ entity_type: 'FORM', action: 'UPDATE', form_id: FORM_ID, name: 'Updated' });
    expect(mockUpdateForm).toHaveBeenCalledWith(FORM_ID, expect.objectContaining({ name: 'Updated' }));
    expect(result.success).toBe(true);
    expect(result.id).toBe(FORM_ID);
  });

  it('does not pass entity_type or action to service', async () => {
    mockUpdateForm.mockResolvedValue({ id: FORM_ID });
    await hs({ entity_type: 'FORM', action: 'UPDATE', form_id: FORM_ID, name: 'X' });
    const props = mockUpdateForm.mock.calls[0][1];
    expect(props).not.toHaveProperty('entity_type');
    expect(props).not.toHaveProperty('action');
  });
});

// ─── FORM DELETE ──────────────────────────────────────────────────────────────

describe('FORM DELETE', () => {
  it('returns error when form_id missing', async () => {
    const result = await hs({ entity_type: 'FORM', action: 'DELETE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/form_id/i);
    expect(mockDeleteForm).not.toHaveBeenCalled();
  });

  it('calls deleteForm and returns deleted id', async () => {
    mockDeleteForm.mockResolvedValue(undefined);
    const result = await hs({ entity_type: 'FORM', action: 'DELETE', form_id: FORM_ID });
    expect(mockDeleteForm).toHaveBeenCalledWith(FORM_ID);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(FORM_ID);
  });
});

// ─── SOCIAL DELETE_BROADCAST ──────────────────────────────────────────────────

describe('SOCIAL DELETE_BROADCAST', () => {
  it('returns error when broadcast_guid missing', async () => {
    const result = await hs({ entity_type: 'SOCIAL', action: 'DELETE_BROADCAST' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/broadcast_guid/i);
    expect(mockDeleteSocialBroadcast).not.toHaveBeenCalled();
  });

  it('calls deleteSocialBroadcast and returns deleted guid', async () => {
    mockDeleteSocialBroadcast.mockResolvedValue(undefined);
    const result = await hs({ entity_type: 'SOCIAL', action: 'DELETE_BROADCAST', broadcast_guid: BROADCAST_GUID });
    expect(mockDeleteSocialBroadcast).toHaveBeenCalledWith(BROADCAST_GUID);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(BROADCAST_GUID);
  });
});

// ─── CONTACT_LIST LIST ────────────────────────────────────────────────────────

describe('CONTACT_LIST LIST', () => {
  it('calls listContactLists and spreads raw response', async () => {
    const raw = { lists: [{ listId: LIST_ID, name: 'Test List' }], total: 1 };
    mockListContactLists.mockResolvedValue(raw);
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'LIST' });
    expect(mockListContactLists).toHaveBeenCalledWith({ query: undefined, cursor: undefined, count: undefined });
    expect(result.success).toBe(true);
    expect(result.lists).toEqual(raw.lists);
  });

  it('passes query, cursor, and count', async () => {
    mockListContactLists.mockResolvedValue({ lists: [] });
    await hs({ entity_type: 'CONTACT_LIST', action: 'LIST', query: 'VIP', cursor: 'tok123', count: 100 });
    expect(mockListContactLists).toHaveBeenCalledWith({ query: 'VIP', cursor: 'tok123', count: 100 });
  });
});

// ─── CONTACT_LIST GET ─────────────────────────────────────────────────────────

describe('CONTACT_LIST GET', () => {
  it('returns error when list_id missing', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'GET' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
    expect(mockGetContactList).not.toHaveBeenCalled();
  });

  it('calls getContactList and spreads raw response', async () => {
    const raw = { listId: LIST_ID, name: 'Test List' };
    mockGetContactList.mockResolvedValue(raw);
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'GET', list_id: LIST_ID });
    expect(mockGetContactList).toHaveBeenCalledWith(LIST_ID);
    expect(result.success).toBe(true);
    expect(result.listId).toBe(LIST_ID);
  });
});

// ─── CONTACT_LIST CREATE ──────────────────────────────────────────────────────

describe('CONTACT_LIST CREATE', () => {
  it('returns error when name missing', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'CREATE', processing_type: 'MANUAL' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name/i);
    expect(mockCreateContactList).not.toHaveBeenCalled();
  });

  it('returns error when processing_type missing', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'CREATE', name: 'New List' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/processing_type/i);
    expect(mockCreateContactList).not.toHaveBeenCalled();
  });

  it('returns error when name is blank', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'CREATE', name: '  ', processing_type: 'MANUAL' });
    expect(result.success).toBe(false);
    expect(mockCreateContactList).not.toHaveBeenCalled();
  });

  it('calls createContactList with name, processing_type, and opts', async () => {
    const raw = { listId: LIST_ID, name: 'VIP Contacts' };
    mockCreateContactList.mockResolvedValue(raw);
    const result = await hs({
      entity_type: 'CONTACT_LIST',
      action: 'CREATE',
      name: 'VIP Contacts',
      processing_type: 'MANUAL',
      object_type_id: '0-1',
    });
    expect(mockCreateContactList).toHaveBeenCalledWith('VIP Contacts', 'MANUAL', {
      objectTypeId: '0-1',
      filterBranch: undefined,
    });
    expect(result.success).toBe(true);
    expect(result.listId).toBe(LIST_ID);
  });
});

// ─── CONTACT_LIST ADD_CONTACTS ────────────────────────────────────────────────

describe('CONTACT_LIST ADD_CONTACTS', () => {
  it('returns error when list_id missing', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'ADD_CONTACTS', record_ids: ['r1'] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
    expect(mockAddContactsToList).not.toHaveBeenCalled();
  });

  it('returns error when record_ids missing or empty', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'ADD_CONTACTS', list_id: LIST_ID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/record_ids/i);
    expect(mockAddContactsToList).not.toHaveBeenCalled();
  });

  it('calls addContactsToList and spreads raw response', async () => {
    const raw = { updatedLists: [{ listId: LIST_ID }], recordIdsAdded: ['r1', 'r2'] };
    mockAddContactsToList.mockResolvedValue(raw);
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'ADD_CONTACTS', list_id: LIST_ID, record_ids: ['r1', 'r2'] });
    expect(mockAddContactsToList).toHaveBeenCalledWith(LIST_ID, ['r1', 'r2']);
    expect(result.success).toBe(true);
    expect(result.recordIdsAdded).toEqual(['r1', 'r2']);
  });
});

// ─── CONTACT_LIST REMOVE_CONTACTS ────────────────────────────────────────────

describe('CONTACT_LIST REMOVE_CONTACTS', () => {
  it('returns error when list_id missing', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'REMOVE_CONTACTS', record_ids: ['r1'] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
    expect(mockRemoveContactsFromList).not.toHaveBeenCalled();
  });

  it('returns error when record_ids missing or empty', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'REMOVE_CONTACTS', list_id: LIST_ID, record_ids: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/record_ids/i);
    expect(mockRemoveContactsFromList).not.toHaveBeenCalled();
  });

  it('calls removeContactsFromList and spreads raw response', async () => {
    const raw = { updatedLists: [{ listId: LIST_ID }], recordIdsRemoved: ['r1'] };
    mockRemoveContactsFromList.mockResolvedValue(raw);
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'REMOVE_CONTACTS', list_id: LIST_ID, record_ids: ['r1'] });
    expect(mockRemoveContactsFromList).toHaveBeenCalledWith(LIST_ID, ['r1']);
    expect(result.success).toBe(true);
    expect(result.recordIdsRemoved).toEqual(['r1']);
  });
});

// ─── CONTACT_LIST DELETE ──────────────────────────────────────────────────────

describe('CONTACT_LIST DELETE', () => {
  it('returns error when list_id missing', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'DELETE' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list_id/i);
    expect(mockDeleteContactList).not.toHaveBeenCalled();
  });

  it('calls deleteContactList and returns deleted list_id', async () => {
    mockDeleteContactList.mockResolvedValue(undefined);
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'DELETE', list_id: LIST_ID });
    expect(mockDeleteContactList).toHaveBeenCalledWith(LIST_ID);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(LIST_ID);
  });
});

// ─── CONTACT_LIST — unknown action ───────────────────────────────────────────

describe('CONTACT_LIST — unknown action', () => {
  it('returns error on unrecognized action', async () => {
    const result = await hs({ entity_type: 'CONTACT_LIST', action: 'PUBLISH' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown action/i);
  });
});
