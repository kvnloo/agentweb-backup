import { AgentModeService } from '../services/agentModeService';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { appendRetryabilityGuidance } from '../services/agentMode/core/errorRetryability';
import { classifyToolFailureType } from '../utils/toolFailureType';

// ── Core dependency mocks (same boilerplate as fathomToolAccess.test.ts) ──────

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
    getAllSkills: jest.fn().mockResolvedValue([]),
    createSkill: jest.fn().mockResolvedValue({
      skillId: 'mock-skill-id',
      name: 'Test Skill',
      description: 'test',
      toolNames: [],
      isPublished: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    updateSkill: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addAssociatedSkills: jest.fn(),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  },
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getPublicAllowedSkills: jest.fn().mockResolvedValue([]),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools) => tools),
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
    refresh: jest.fn(),
  })),
}));

jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
  })),
}));

// ── Google Drive-specific mocks ────────────────────────────────────────────────

const mockOAuth2Client = {
  setCredentials: jest.fn(),
  on: jest.fn(),
};

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn(() => mockOAuth2Client),
}));

const mockDriveFiles = {
  list: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  get: jest.fn(),
  export: jest.fn(),
  delete: jest.fn(),
};
const mockDrivePermissions = { create: jest.fn() };
const mockDriveComments = { list: jest.fn() };
const mockDocuments = {
  get: jest.fn(),
  batchUpdate: jest.fn(),
};
const mockSheetsValues = { update: jest.fn() };
const mockSheets = { spreadsheets: { values: mockSheetsValues } };

jest.mock('googleapis', () => ({
  google: {
    drive: jest.fn(() => ({
      files: mockDriveFiles,
      permissions: mockDrivePermissions,
      comments: mockDriveComments,
    })),
    docs: jest.fn(() => ({ documents: mockDocuments })),
    sheets: jest.fn(() => mockSheets),
    auth: { GoogleAuth: jest.fn() },
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountByPlatform: jest.fn(),
  createAccount: jest.fn().mockResolvedValue({}),
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../config/integrations', () => ({
  // INTEGRATION_CONFIG is read at module-load time by linkedInAdsService.ts
  INTEGRATION_CONFIG: {
    linkedinAds: { apiVersion: '202603' },
    linkedin: { scopes: [], redirectUri: '', authorizationUrl: '', tokenUrl: '', profileUrl: '' },
    meta: {},
    google: {},
    googleAds: {},
    youtube: {},
    fathom: {},
    clickUp: {},
    hubspot: {},
    attio: {},
  },
  getGoogleDriveConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
  }),
  getLinkedInScopesForType: jest.fn().mockReturnValue([]),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_ACCOUNT = {
  config: {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_expires_at: Date.now() + 3_600_000,
    email: 'test@example.com',
    display_name: 'Test User',
  },
};

const USER_ID = 'user-123';

/**
 * The service's own walk budget, read rather than duplicated.
 *
 * These tests assert behaviour RELATIVE to the budget — "a request's timeout never exceeds it",
 * "the walk stops once it is spent" — so pinning 15_000 made them fail the moment the budget was
 * raised, even though every one of those behaviours still held.
 */
const WALK_BUDGET_MS: number = (AgentModeService as any).DRIVE_LIST_WALK_MAX_MS;

function makeApiError(code: number, message = 'API error') {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

/** A Drive error carrying the `error.errors[].reason` that discriminates a 403's real cause. */
function makeApiErrorWithReason(code: number, reason: string, message = 'API error') {
  const err: any = makeApiError(code, message);
  err.errors = [{ domain: 'usageLimits', reason, message }];
  return err;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AgentModeService - Google Drive methods', () => {
  let service: AgentModeService;

  it('offers user-OAuth Drive tools as foundation tools', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toEqual(
      expect.arrayContaining(['google_drive', 'read_google_doc'])
    );
  });
  let connectedAccountsDb: any;
  let secretsManager: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();

    connectedAccountsDb = require('../services/connectedAccountsDb');
    secretsManager = require('../utils/secretsManager');

    // Default: Drive IS connected
    connectedAccountsDb.getAccountByPlatform.mockResolvedValue(FAKE_ACCOUNT);

    // SA secret for getGoogleDriveClient
    secretsManager.getSecret = jest.fn().mockResolvedValue(
      JSON.stringify({ type: 'service_account' })
    );

    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
    };
  });

  // ────────────────────────────────────────────────────────────────────────────
  // getGoogleDriveOAuthClient (tested via public methods)
  // ────────────────────────────────────────────────────────────────────────────

  describe('getGoogleDriveOAuthClient (via listGoogleDriveFolder)', () => {
    it('throws "Google Drive not connected" when getAccountByPlatform returns null', async () => {
      connectedAccountsDb.getAccountByPlatform.mockResolvedValue(null);
      // listGoogleDriveFolder catches and returns a success:false result
      const result = await service.listGoogleDriveFolder('some-folder', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Google Drive not connected/i);
    });

    it('sets credentials from the stored account config', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });
      await service.listGoogleDriveFolder('some-folder', USER_ID);

      expect(mockOAuth2Client.setCredentials).toHaveBeenCalledWith({
        access_token: FAKE_ACCOUNT.config.access_token,
        refresh_token: FAKE_ACCOUNT.config.refresh_token,
        expiry_date: FAKE_ACCOUNT.config.token_expires_at,
      });
    });

    it('calls updateAccountTokens (not createAccount) when tokens are refreshed', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });
      await service.listGoogleDriveFolder('folder-id', USER_ID);

      // Find and invoke the 'tokens' handler registered on the OAuth client
      const tokenCall = mockOAuth2Client.on.mock.calls.find(([event]: [string]) => event === 'tokens');
      expect(tokenCall).toBeDefined();
      const [, tokenHandler] = tokenCall;
      await tokenHandler({ access_token: 'new-access-token', expiry_date: Date.now() + 7_200_000 });

      expect(connectedAccountsDb.updateAccountTokens).toHaveBeenCalledWith(
        USER_ID,
        'google_drive',
        expect.objectContaining({ access_token: 'new-access-token' }),
        FAKE_ACCOUNT.config.email
      );
      expect(connectedAccountsDb.createAccount).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // listGoogleDriveFolder
  // ────────────────────────────────────────────────────────────────────────────

  describe('listGoogleDriveFolder', () => {
    it('returns { success: false } when Drive is not connected', async () => {
      connectedAccountsDb.getAccountByPlatform.mockResolvedValue(null);
      const result = await service.listGoogleDriveFolder('folder-id', USER_ID);
      expect(result).toMatchObject({ success: false });
      expect(result.message).toMatch(/Google Drive not connected/i);
    });

    it('extracts folder ID from a full Google Drive URL', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });
      await service.listGoogleDriveFolder(
        'https://drive.google.com/drive/folders/FOLDER_ID_123',
        USER_ID
      );
      expect(mockDriveFiles.list).toHaveBeenCalledWith(
        expect.objectContaining({ q: expect.stringContaining('FOLDER_ID_123') })
      );
    });

    it('uses the raw value as folder ID when no URL pattern matches', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });
      await service.listGoogleDriveFolder('raw-folder-id', USER_ID);
      expect(mockDriveFiles.list).toHaveBeenCalledWith(
        expect.objectContaining({ q: expect.stringContaining('raw-folder-id') })
      );
    });

    it('returns { success: false } for a malformed folder ID without calling Drive API', async () => {
      const result = await service.listGoogleDriveFolder("abc' OR '1'='1", USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid folder ID/i);
      expect(mockDriveFiles.list).not.toHaveBeenCalled();
    });

    it('returns formatted file list on success', async () => {
      const fakeFiles = [
        {
          id: 'f1',
          name: 'Report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          modifiedTime: '2024-01-01T00:00:00Z',
          webViewLink: 'https://docs.google.com/...',
        },
      ];
      mockDriveFiles.list.mockResolvedValue({ data: { files: fakeFiles } });

      const result = await service.listGoogleDriveFolder('folder-id', USER_ID);
      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ id: 'f1', name: 'Report.docx' });
    });

    it('returns { success: true, message: "Folder is empty." } when no files', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });
      const result = await service.listGoogleDriveFolder('empty-folder', USER_ID);
      expect(result).toMatchObject({ success: true, message: 'Folder is empty.', files: [] });
    });

    it('returns friendly 403 message', async () => {
      mockDriveFiles.list.mockRejectedValue(makeApiError(403));
      const result = await service.listGoogleDriveFolder('folder-id', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Google Drive access denied/i);
    });

    it('returns friendly 404 message', async () => {
      mockDriveFiles.list.mockRejectedValue(makeApiError(404));
      const result = await service.listGoogleDriveFolder('folder-id', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Folder not found/i);
    });

    it('includes truncation warning when Drive returns nextPageToken', async () => {
      const files = Array.from({ length: 100 }, (_, i) => ({
        id: `f${i}`, name: `file-${i}.txt`, mimeType: 'text/plain',
        modifiedTime: '2024-01-01T00:00:00Z', webViewLink: `https://drive.google.com/file/d/f${i}`,
      }));
      mockDriveFiles.list.mockResolvedValue({ data: { files, nextPageToken: 'page-token-xyz' } });
      const result = await service.listGoogleDriveFolder('folder-id', USER_ID);
      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(100);
      expect(result.message).toMatch(/Showing first 100/i);
    });

    it('does not include truncation warning when all items fit in one page', async () => {
      const files = [{ id: 'f1', name: 'only.txt', mimeType: 'text/plain', modifiedTime: '2024-01-01', webViewLink: '' }];
      mockDriveFiles.list.mockResolvedValue({ data: { files } });
      const result = await service.listGoogleDriveFolder('folder-id', USER_ID);
      expect(result.message).not.toMatch(/Showing first 100/i);
    });

    // Regression test for the Phoenix Technologies incident (2026-08-25): a
    // folder living inside a Google Shared Drive returns zero results (not an
    // error) unless supportsAllDrives + includeItemsFromAllDrives are passed,
    // even when the folder is fully public.
    it('passes supportsAllDrives and includeItemsFromAllDrives so Shared Drive folders resolve', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });
      await service.listGoogleDriveFolder('folder-id', USER_ID);
      expect(mockDriveFiles.list).toHaveBeenCalledWith(
        expect.objectContaining({ supportsAllDrives: true, includeItemsFromAllDrives: true })
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // createGoogleDriveFolder
  // ────────────────────────────────────────────────────────────────────────────

  describe('createGoogleDriveFolder', () => {
    beforeEach(() => {
      mockDriveFiles.create.mockResolvedValue({
        data: {
          id: 'new-folder-id',
          name: 'My Folder',
          webViewLink: 'https://drive.google.com/drive/folders/new-folder-id',
        },
      });
    });

    it('returns success with folder_id and folder_url', async () => {
      const result = await service.createGoogleDriveFolder('My Folder', USER_ID);
      expect(result).toMatchObject({
        success: true,
        folder_id: 'new-folder-id',
        folder_url: 'https://drive.google.com/drive/folders/new-folder-id',
      });
    });

    it('passes parent_folder_id in parents array when provided', async () => {
      await service.createGoogleDriveFolder('My Folder', USER_ID, 'parent-id');
      expect(mockDriveFiles.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ parents: ['parent-id'] }),
        })
      );
    });

    it('does not include parents when parent_folder_id is omitted', async () => {
      await service.createGoogleDriveFolder('My Folder', USER_ID);
      const call = mockDriveFiles.create.mock.calls[0][0];
      expect(call.requestBody.parents).toBeUndefined();
    });

    it('returns friendly 403 message', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(403));
      const result = await service.createGoogleDriveFolder('My Folder', USER_ID, 'parent-id');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Cannot create folder in that location/i);
    });

    it('returns friendly 404 message', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(404));
      const result = await service.createGoogleDriveFolder('My Folder', USER_ID, 'parent-id');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Parent folder not found/i);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // createGoogleDoc
  // ────────────────────────────────────────────────────────────────────────────

  describe('createGoogleDoc', () => {
    beforeEach(() => {
      mockDriveFiles.create.mockResolvedValue({
        data: {
          id: 'doc-id-1',
          name: 'Test Doc',
          webViewLink: 'https://docs.google.com/document/d/doc-id-1/edit',
        },
      });
      mockDocuments.batchUpdate.mockResolvedValue({ data: {} });
      mockDrivePermissions.create.mockResolvedValue({ data: {} });
    });

    it('creates doc in root (no parents) when folderId is not provided', async () => {
      await service.createGoogleDoc('Test Doc', 'Some content', USER_ID);
      const call = mockDriveFiles.create.mock.calls[0][0];
      expect(call.requestBody.parents).toBeUndefined();
    });

    it('creates doc in a folder when folderId is provided', async () => {
      await service.createGoogleDoc('Test Doc', 'Some content', USER_ID, 'folder-id');
      expect(mockDriveFiles.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ parents: ['folder-id'] }),
        })
      );
    });

    it('uploads HTML media when content is provided', async () => {
      await service.createGoogleDoc('Test Doc', 'Hello world', USER_ID);
      const call = mockDriveFiles.create.mock.calls[0][0];
      expect(call.media?.mimeType).toBe('text/html');
      expect(call.media?.body).toContain('Hello world');
    });

    it('shares with emails when shareWithEmails is provided', async () => {
      await service.createGoogleDoc('Test Doc', 'content', USER_ID, undefined, [
        'a@example.com',
        'b@example.com',
      ]);
      expect(mockDrivePermissions.create).toHaveBeenCalledTimes(2);
      expect(mockDrivePermissions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ emailAddress: 'a@example.com' }),
        })
      );
    });

    it('does not fail the whole operation when a share permission call fails', async () => {
      mockDrivePermissions.create.mockRejectedValue(new Error('Permission denied'));
      const result = await service.createGoogleDoc('Test Doc', 'content', USER_ID, undefined, [
        'bad@example.com',
      ]);
      // Overall operation should still succeed
      expect(result.success).toBe(true);
      expect(result.doc_id).toBe('doc-id-1');
    });

    it('returns friendly 403 message when folderId is inaccessible', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(403));
      const result = await service.createGoogleDoc('Test Doc', 'content', USER_ID, 'bad-folder');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Cannot create Doc in that folder/i);
    });

    it('returns friendly 404 message when folder is not found', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(404));
      const result = await service.createGoogleDoc('Test Doc', 'content', USER_ID, 'missing-folder');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Folder not found/i);
    });

    it('does not call batchUpdate — formatting is done via HTML media upload', async () => {
      await service.createGoogleDoc('Test Doc', '# Heading\n\n**bold** text', USER_ID);
      expect(mockDocuments.batchUpdate).not.toHaveBeenCalled();
      const call = mockDriveFiles.create.mock.calls[0][0];
      expect(call.media?.body).toContain('<h1');
      expect(call.media?.body).toContain('<strong>');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // updateGoogleDoc
  // ────────────────────────────────────────────────────────────────────────────

  describe('updateGoogleDoc', () => {
    beforeEach(() => {
      mockDriveFiles.update.mockResolvedValue({ data: {} });
    });

    it('extracts file ID from a Google Doc URL and calls drive.files.update', async () => {
      const url = 'https://docs.google.com/document/d/file-id-abc/edit';
      await service.updateGoogleDoc(url, 'New content', USER_ID);
      expect(mockDriveFiles.update).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file-id-abc' })
      );
    });

    it('uploads HTML media replacing all previous content', async () => {
      const result = await service.updateGoogleDoc('file-id-plain', '# New heading\n\nParagraph', USER_ID);
      expect(result.success).toBe(true);
      const call = mockDriveFiles.update.mock.calls[0][0];
      expect(call.media.mimeType).toBe('text/html');
      expect(call.media.body).toContain('>New heading</h1>');
      expect(call.media.body).toContain('>Paragraph</p>');
    });

    it('returns friendly 403 message that reflects access issue, not file ownership', async () => {
      mockDriveFiles.update.mockRejectedValue(makeApiError(403));
      const result = await service.updateGoogleDoc('file-id', 'content', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Cannot update this Google Doc/i);
      expect(result.message).toMatch(/edit access/i);
      expect(result.message).not.toMatch(/not created by Emma/i);
    });

    it('returns friendly 404 message', async () => {
      mockDriveFiles.update.mockRejectedValue(makeApiError(404));
      const result = await service.updateGoogleDoc('file-id', 'content', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Google Doc not found/i);
    });

    it('skips drive.files.update when content is empty and returns success', async () => {
      const result = await service.updateGoogleDoc('file-id', '', USER_ID);
      expect(result.success).toBe(true);
      expect(mockDriveFiles.update).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // createGoogleSheet
  // ────────────────────────────────────────────────────────────────────────────

  describe('createGoogleSheet', () => {
    beforeEach(() => {
      mockDriveFiles.create.mockResolvedValue({
        data: {
          id: 'sheet-id-1',
          name: 'My Sheet',
          webViewLink: 'https://docs.google.com/spreadsheets/d/sheet-id-1/edit',
        },
      });
      mockSheetsValues.update.mockResolvedValue({ data: {} });
      mockDrivePermissions.create.mockResolvedValue({ data: {} });
    });

    it('creates sheet and writes data to Sheet1!A1', async () => {
      const data = [['A', 'B'], ['1', '2']];
      const result = await service.createGoogleSheet('My Sheet', data, USER_ID);

      expect(result.success).toBe(true);
      expect(result.sheet_id).toBe('sheet-id-1');
      expect(mockSheetsValues.update).toHaveBeenCalledWith(
        expect.objectContaining({
          spreadsheetId: 'sheet-id-1',
          range: 'Sheet1!A1',
          valueInputOption: 'RAW',
          requestBody: { values: data },
        })
      );
    });

    it('skips data write when data array is empty', async () => {
      await service.createGoogleSheet('Empty Sheet', [], USER_ID);
      expect(mockSheetsValues.update).not.toHaveBeenCalled();
    });

    it('returns friendly 403 message', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(403));
      const result = await service.createGoogleSheet('My Sheet', [], USER_ID, 'bad-folder');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Cannot create Sheet in that folder/i);
    });

    it('returns friendly 404 message', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(404));
      const result = await service.createGoogleSheet('My Sheet', [], USER_ID, 'missing-folder');
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Folder not found/i);
    });

    it('deletes the created file when data write fails to prevent orphaned sheets', async () => {
      mockDriveFiles.delete.mockResolvedValue({});
      mockSheetsValues.update.mockRejectedValue(new Error('Sheets API quota exceeded'));
      const result = await service.createGoogleSheet('My Sheet', [['A', 'B']], USER_ID);
      expect(result.success).toBe(false);
      expect(mockDriveFiles.delete).toHaveBeenCalledWith({ fileId: 'sheet-id-1' });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // updateGoogleSheet
  // ────────────────────────────────────────────────────────────────────────────

  describe('updateGoogleSheet', () => {
    beforeEach(() => {
      mockSheetsValues.update.mockResolvedValue({ data: {} });
    });

    it('calls spreadsheets.values.update with the correct range and data', async () => {
      const data = [['X', 'Y'], ['1', '2']];
      const result = await service.updateGoogleSheet(
        'sheet-id-plain',
        'Sheet1!A1:B2',
        data,
        USER_ID
      );

      expect(result.success).toBe(true);
      expect(mockSheetsValues.update).toHaveBeenCalledWith(
        expect.objectContaining({
          spreadsheetId: 'sheet-id-plain',
          range: 'Sheet1!A1:B2',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: data },
        })
      );
    });

    it('extracts file ID from a Google Sheets URL', async () => {
      const url = 'https://docs.google.com/spreadsheets/d/sheet-id-url/edit';
      await service.updateGoogleSheet(url, 'A1', [['v']], USER_ID);
      expect(mockSheetsValues.update).toHaveBeenCalledWith(
        expect.objectContaining({ spreadsheetId: 'sheet-id-url' })
      );
    });

    it('returns friendly 403 message', async () => {
      mockSheetsValues.update.mockRejectedValue(makeApiError(403));
      const result = await service.updateGoogleSheet('sheet-id', 'A1', [['v']], USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Cannot update this Google Sheet/i);
    });

    it('returns friendly 404 message', async () => {
      mockSheetsValues.update.mockRejectedValue(makeApiError(404));
      const result = await service.updateGoogleSheet('sheet-id', 'A1', [['v']], USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Google Sheet not found/i);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // ENG-1300: every "friendly 403 message" test above already proved the USER-
  // FACING message is unchanged. This proves the other half — the numeric
  // status now rides along on the result so classifyToolErrorClass sees
  // 'auth' (classifyToolFailureType 'config') instead of the generic
  // 'Error'/'bug' fallback a hand-written message alone cannot match. One
  // representative case per function, not every branch — the branch-level
  // message-text coverage already exists above.
  // ────────────────────────────────────────────────────────────────────────────

  describe('ENG-1300 — 403s classify as auth/config end-to-end', () => {
    const expectAuthConfig = (result: any) => {
      const classified = toolResultError(result);
      expect(classifyToolErrorClass(classified)).toBe('auth');
      expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
    };

    it('listGoogleDriveFolder', async () => {
      mockDriveFiles.list.mockRejectedValue(makeApiError(403));
      expectAuthConfig(await service.listGoogleDriveFolder('folder-id', USER_ID));
    });

    it('createGoogleDriveFolder', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(403));
      expectAuthConfig(await service.createGoogleDriveFolder('name', USER_ID));
    });

    it('searchGoogleDrive', async () => {
      mockDriveFiles.list.mockRejectedValue(makeApiError(403));
      expectAuthConfig(await service.searchGoogleDrive('query', USER_ID));
    });

    it('createGoogleDoc', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(403));
      expectAuthConfig(await service.createGoogleDoc('title', 'content', USER_ID));
    });

    it('updateGoogleDoc', async () => {
      mockDriveFiles.update.mockRejectedValue(makeApiError(403));
      expectAuthConfig(await service.updateGoogleDoc('doc-id', 'content', USER_ID));
    });

    it('createGoogleSheet', async () => {
      mockDriveFiles.create.mockRejectedValue(makeApiError(403));
      expectAuthConfig(await service.createGoogleSheet('title', [['a']], USER_ID));
    });

    it('updateGoogleSheet', async () => {
      mockSheetsValues.update.mockRejectedValue(makeApiError(403));
      expectAuthConfig(await service.updateGoogleSheet('sheet-id', 'A1', [['v']], USER_ID));
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // readGoogleFileById
  // ────────────────────────────────────────────────────────────────────────────

  describe('readGoogleFileById', () => {
    // Helpers for setting up the drive.files.get / export mocks
    const setupFileMeta = (mimeType: string, overrides = {}) => {
      mockDriveFiles.get.mockResolvedValue({
        data: {
          id: 'file-id',
          name: 'Test File',
          mimeType,
          modifiedTime: '2024-01-01T00:00:00Z',
          ...overrides,
        },
      });
    };

    beforeEach(() => {
      // Default: plain text file
      setupFileMeta('text/plain');
      mockDriveFiles.export.mockResolvedValue({ data: Buffer.from('content') });
      // Treat get for download as alt:media differently — same mock, return buffer
      mockDriveFiles.get.mockImplementation((params: any) => {
        if (params?.alt === 'media') {
          return Promise.resolve({ data: Buffer.from('binary content') });
        }
        return Promise.resolve({
          data: {
            id: params.fileId || 'file-id',
            name: 'Test File',
            mimeType: 'text/plain',
            modifiedTime: '2024-01-01T00:00:00Z',
          },
        });
      });
      mockDriveComments.list.mockResolvedValue({ data: { comments: [] } });
    });

    it('uses OAuth client when Google Drive is connected', async () => {
      const { google } = require('googleapis');
      const result = await service.readGoogleFileById('file-id', USER_ID);
      // OAuth path: google.drive() called with auth = mockOAuth2Client
      expect(google.drive).toHaveBeenCalledWith(
        expect.objectContaining({ auth: mockOAuth2Client })
      );
      expect(result.success).toBe(true);
    });

    // Regression test for the Phoenix Technologies incident (2026-08-25): a
    // file living inside a Google Shared Drive returns 404 unless
    // supportsAllDrives is passed, even when it's fully public.
    it('passes supportsAllDrives on the file metadata fetch', async () => {
      await service.readGoogleFileById('file-id', USER_ID);
      const metaCall = mockDriveFiles.get.mock.calls.find((call: any[]) => call[0]?.alt !== 'media');
      expect(metaCall?.[0]).toMatchObject({ supportsAllDrives: true });
    });

    it('goes straight to SA when Drive is not connected (OAuth throws)', async () => {
      connectedAccountsDb.getAccountByPlatform.mockResolvedValue(null);
      const result = await service.readGoogleFileById('file-id', USER_ID);
      // SA path uses GoogleAuth — check getSecret was called for the SA credentials
      expect(secretsManager.getSecret).toHaveBeenCalled();
      // Result should be success (SA drive mock returns file meta)
      expect(result.success).toBe(true);
    });

    it('falls back to SA when OAuth returns 403', async () => {
      // First call to mockDriveFiles.get (OAuth path) throws 403
      let callCount = 0;
      mockDriveFiles.get.mockImplementation((params: any) => {
        if (params?.alt === 'media') {
          return Promise.resolve({ data: Buffer.from('binary') });
        }
        callCount++;
        if (callCount === 1) throw makeApiError(403);
        return Promise.resolve({
          data: { id: 'file-id', name: 'SA File', mimeType: 'text/plain', modifiedTime: '' },
        });
      });

      const result = await service.readGoogleFileById('file-id', USER_ID);
      expect(result.success).toBe(true);
      // Secrets manager fetched for SA
      expect(secretsManager.getSecret).toHaveBeenCalled();
    });

    it('falls back to SA when OAuth returns 401', async () => {
      let callCount = 0;
      mockDriveFiles.get.mockImplementation((params: any) => {
        if (params?.alt === 'media') {
          return Promise.resolve({ data: Buffer.from('binary') });
        }
        callCount++;
        if (callCount === 1) throw makeApiError(401);
        return Promise.resolve({
          data: { id: 'file-id', name: 'SA File', mimeType: 'text/plain', modifiedTime: '' },
        });
      });

      const result = await service.readGoogleFileById('file-id', USER_ID);
      expect(result.success).toBe(true);
      expect(secretsManager.getSecret).toHaveBeenCalled();
    });

    it('returns SA result when SA succeeds after OAuth 403', async () => {
      let callCount = 0;
      mockDriveFiles.get.mockImplementation((params: any) => {
        if (params?.alt === 'media') {
          return Promise.resolve({ data: Buffer.from('sa content') });
        }
        callCount++;
        if (callCount === 1) throw makeApiError(403);
        return Promise.resolve({
          data: { id: 'file-id', name: 'SA File', mimeType: 'text/plain', modifiedTime: '2024-06-01' },
        });
      });

      const result = await service.readGoogleFileById('file-id', USER_ID);
      expect(result.success).toBe(true);
      expect(result.file_name).toBe('SA File');
    });

    it('returns friendly 404 message when SA also fails with 404', async () => {
      // OAuth call throws 403, SA call throws 404
      let callCount = 0;
      mockDriveFiles.get.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw makeApiError(403);
        throw makeApiError(404);
      });

      const result = await service.readGoogleFileById('file-id', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });

    // ENG-1300: the terminal error after both OAuth and SA fail now carries the
    // real status through, so this classifies as not_found/config instead of
    // the generic Error/bug fallback.
    it('ENG-1300: the terminal 404 (after SA also fails) classifies as not_found/config', async () => {
      let callCount = 0;
      mockDriveFiles.get.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw makeApiError(403);
        throw makeApiError(404);
      });

      const result = await service.readGoogleFileById('file-id', USER_ID);
      const classified = toolResultError(result);
      expect(classifyToolErrorClass(classified)).toBe('not_found');
      expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
    });

    it('reads Google Doc content via export', async () => {
      mockDriveFiles.get.mockImplementation((params: any) => {
        if (params?.alt === 'media') {
          return Promise.resolve({ data: Buffer.from('doc content') });
        }
        return Promise.resolve({
          data: {
            id: 'doc-id',
            name: 'My Doc',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '2024-01-01T00:00:00Z',
          },
        });
      });
      mockDriveFiles.export.mockResolvedValue({ data: Buffer.from('exported doc text') });
      mockDriveComments.list.mockResolvedValue({ data: { comments: [] } });

      const result = await service.readGoogleFileById('doc-id', USER_ID);
      expect(result.success).toBe(true);
      // export should have been called with mimeType: text/plain for Docs
      expect(mockDriveFiles.export).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'text/plain' }),
        expect.any(Object)
      );
    });

    it('reads Google Sheet content via export', async () => {
      mockDriveFiles.get.mockImplementation((params: any) => {
        if (params?.alt === 'media') {
          return Promise.resolve({ data: Buffer.from('sheet content') });
        }
        return Promise.resolve({
          data: {
            id: 'sheet-id',
            name: 'My Sheet',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            modifiedTime: '2024-01-01T00:00:00Z',
          },
        });
      });
      mockDriveFiles.export.mockResolvedValue({ data: Buffer.from('a,b,c\n1,2,3') });
      mockDriveComments.list.mockResolvedValue({ data: { comments: [] } });

      const result = await service.readGoogleFileById('sheet-id', USER_ID);
      expect(result.success).toBe(true);
      expect(mockDriveFiles.export).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'text/csv' }),
        expect.any(Object)
      );
    });

    it('fetches comments for Google native files (Doc)', async () => {
      mockDriveFiles.get.mockImplementation((params: any) => {
        if (params?.alt === 'media') {
          return Promise.resolve({ data: Buffer.from('doc content') });
        }
        return Promise.resolve({
          data: {
            id: 'doc-id',
            name: 'My Doc',
            mimeType: 'application/vnd.google-apps.document',
            modifiedTime: '',
          },
        });
      });
      mockDriveFiles.export.mockResolvedValue({ data: Buffer.from('text') });
      mockDriveComments.list.mockResolvedValue({
        data: {
          comments: [
            {
              content: 'Great doc!',
              author: { displayName: 'Alice' },
              replies: [],
              resolved: false,
              quotedFileContent: null,
              createdTime: '2024-01-01',
            },
          ],
        },
      });

      const result = await service.readGoogleFileById('doc-id', USER_ID);
      expect(result.success).toBe(true);
      // Comments section should be included in content
      expect(result.content).toMatch(/COMMENTS & FEEDBACK/);
      expect(result.content).toMatch(/Alice/);
    });
  });

  // ── materializeKnowledgeBaseAsset (ENG-1580) ───────────────────────────────
  //
  // read_knowledge_base_files / readGoogleDriveFileContent is text-oriented:
  // a binary (image/video) file falls through to `content.toString('base64')`
  // inside a response capped at 1,000,000 characters, silently truncating
  // (and corrupting) anything but a tiny file, with no downstream tool able
  // to consume that base64 anyway. materializeKnowledgeBaseAsset bypasses
  // that path: download raw bytes -> upload to S3 -> return a real URL.

  describe('materializeKnowledgeBaseAsset', () => {
    const { userDb } = require('../services/db');
    const s3Utils = require('../utils/s3Utils');

    beforeEach(() => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        googleDriveFolders: [{ folderId: 'folder-1', name: 'Ad Creatives' }],
      });
      (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({
        success: true,
        url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-123/files/123/abc/ad.png',
        key: 'users/user-123/files/123/abc/ad.png',
      });
    });

    it('returns an error when kb_identifier or file_name is missing', async () => {
      const result = await service.materializeKnowledgeBaseAsset('', 'ad.png', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/required/i);
    });

    it('rejects non-gdrive kb_identifier sources', async () => {
      const result = await service.materializeKnowledgeBaseAsset('clickup:workspace-1', 'ad.png', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/google drive/i);
    });

    it('returns not-authorized when the folder is not on the user/org account', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: USER_ID, googleDriveFolders: [] });
      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.png', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not authorized/i);
      expect(mockDriveFiles.list).not.toHaveBeenCalled();
    });

    it('returns not-found when no file with that name exists in the folder', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });
      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'missing.png', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found/i);
    });

    it('passes supportsAllDrives and includeItemsFromAllDrives on the folder lookup', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '1024' }] },
      });
      mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });

      await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.png', USER_ID);

      // Assert on the request options themselves rather than on the call's arity: these
      // calls now also carry a per-request `timeout` as a second argument, and the invariant
      // being pinned here is about the shared-drive flags, not how many arguments are passed.
      expect(mockDriveFiles.list).toHaveBeenCalled();
      for (const [requestOptions] of mockDriveFiles.list.mock.calls) {
        expect(requestOptions).toEqual(
          expect.objectContaining({ supportsAllDrives: true, includeItemsFromAllDrives: true }),
        );
      }
    });

    it('rejects non-image/video mimetypes without downloading or uploading', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'brief.pdf', mimeType: 'application/pdf', size: '1024' }] },
      });
      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'brief.pdf', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/read_knowledge_base_files/);
      expect(mockDriveFiles.get).not.toHaveBeenCalled();
      expect((s3Utils.uploadFileToS3 as jest.Mock)).not.toHaveBeenCalled();
    });

    it('rejects a file over the size ceiling without downloading', async () => {
      const oversized = 300 * 1024 * 1024; // 300MB > 200MB ceiling
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'huge.mp4', mimeType: 'video/mp4', size: String(oversized) }] },
      });
      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'huge.mp4', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/limit/i);
      expect(mockDriveFiles.get).not.toHaveBeenCalled();
    });

    it('rejects an oversized file even when Drive metadata under-reports size (e.g. 0 mid virus-scan)', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'huge.png', mimeType: 'image/png', size: '0' }] },
      });
      const oversizedBuffer = Buffer.alloc(201 * 1024 * 1024); // 201MB > 200MB ceiling
      mockDriveFiles.get.mockResolvedValue({ data: oversizedBuffer });

      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'huge.png', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/limit/i);
      expect((s3Utils.uploadFileToS3 as jest.Mock)).not.toHaveBeenCalled();
    });

    // ENG-2840: the download is streamed and stops once it passes the ceiling, so bad size metadata cannot make the process hold the
    // whole file in memory.
    it('stops a streamed download as soon as it passes the ceiling, without reading the rest', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'huge.mp4', mimeType: 'video/mp4', size: '0' }] },
      });
      const { Readable } = require('stream');
      const chunk = Buffer.alloc(8 * 1024 * 1024);
      let produced = 0;
      const body = new Readable({
        read() {
          produced++;
          this.push(produced <= 1000 ? chunk : null); // would be 8 GB if read to the end
        },
      });
      mockDriveFiles.get.mockResolvedValue({ data: body });

      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'huge.mp4', USER_ID);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/limit/i);
      expect(produced).toBeLessThan(40); // 200 MB ceiling / 8 MB chunks, plus read-ahead
      expect(body.destroyed).toBe(true);
      expect((s3Utils.uploadFileToS3 as jest.Mock)).not.toHaveBeenCalled();
    });

    it('reads a streamed download under the ceiling in full', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '0' }] },
      });
      const { Readable } = require('stream');
      mockDriveFiles.get.mockResolvedValue({ data: Readable.from([Buffer.from('fake-'), Buffer.from('png-bytes')]) });

      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.png', USER_ID);

      expect(result.success).toBe(true);
      expect((s3Utils.uploadFileToS3 as jest.Mock).mock.calls[0][0].toString()).toBe('fake-png-bytes');
    });

    it('downloads the binary via alt:media with supportsAllDrives and uploads to S3', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '2048' }] },
      });
      mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });

      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.png', USER_ID);

      expect(mockDriveFiles.get).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file-1', alt: 'media', supportsAllDrives: true }),
        expect.objectContaining({ responseType: 'stream' })
      );
      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        expect.any(Buffer), 'ad.png', USER_ID, 'image/png'
      );
      expect(result.success).toBe(true);
      expect(result.url).toBe('https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-123/files/123/abc/ad.png');
      expect(result.mime_type).toBe('image/png');
    });

    it('accepts video mimetypes the same way as images', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-2', name: 'ad.mp4', mimeType: 'video/mp4', size: '4096' }] },
      });
      mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('fake-mp4-bytes') });

      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.mp4', USER_ID);
      expect(result.success).toBe(true);
      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        expect.any(Buffer), 'ad.mp4', USER_ID, 'video/mp4'
      );
    });

    it('returns a failure (not a throw) when the S3 upload fails', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '2048' }] },
      });
      mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });
      (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({ success: false, error: 's3_down' });

      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.png', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toBe('s3_down');
    });

    it('returns a friendly message on a 404 from Drive', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '2048' }] },
      });
      mockDriveFiles.get.mockRejectedValue(makeApiError(404));
      const result = await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.png', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/not found|not accessible/i);
    });

    it('never routes through the text-truncating readGoogleDriveFileContent path', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '2048' }] },
      });
      mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });
      const readContentSpy = jest.spyOn(service as any, 'readGoogleDriveFileContent');

      await service.materializeKnowledgeBaseAsset('gdrive:folder-1', 'ad.png', USER_ID);

      expect(readContentSpy).not.toHaveBeenCalled();
      readContentSpy.mockRestore();
    });

    // ── ENG-1624: sub-folder traversal ────────────────────────────────────────
    // Phoenix Technologies' registered KB folder held only sub-folders (ratio
    // folders like "4x5"); the approved ad creatives lived inside those. Every
    // Drive query here was scoped to `'<folderId>' in parents` (direct children
    // only), so files nested under a sub-folder resolved as not-found.
    describe('sub-folder traversal (ENG-1624)', () => {
      const ROOT = 'root-folder';
      const SUB = '4x5-subfolder';

      beforeEach(() => {
        (userDb.getUserById as jest.Mock).mockResolvedValue({
          userId: USER_ID,
          googleDriveFolders: [{ folderId: ROOT, name: '8-18-26 Insurance Angle Ads' }],
        });
      });

      it('materializes a file nested in a sub-folder of the registered root, not just direct children', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          // Sub-folder discovery under the registered root
          if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
            return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
          }
          // Sub-folder discovery under the sub-folder — no further nesting
          if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType')) {
            return Promise.resolve({ data: { files: [] } });
          }
          // Target file search across the whole resolved tree
          if (q.includes("name = 'ad.png'")) {
            return Promise.resolve({
              data: { files: [{ id: 'file-99', name: 'ad.png', mimeType: 'image/png', size: '2048' }] },
            });
          }
          return Promise.resolve({ data: { files: [] } });
        });
        mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        // The fix must actually search inside the sub-folder — not just return
        // success by coincidence of a loose mock.
        const nameSearchCall = mockDriveFiles.list.mock.calls.find(
          ([arg]: any) => arg.q.includes("name = 'ad.png'")
        );
        expect(nameSearchCall).toBeDefined();
        expect(nameSearchCall![0].q).toContain(`'${SUB}' in parents`);

        expect(result.success).toBe(true);
        expect(result.url).toMatch(/^https:\/\//);
      });

      /*
       * ENG-1476 follow-up: Drive's query grammar requires BOTH a backslash and a quote to be
       * escaped inside a string literal. The call sites escaped only the quote, so a backslash
       * in a value survived verbatim and could terminate the literal early — an opaque Drive
       * 400 instead of a match, and the shape that lets a crafted value reach past the
       * parent-folder clause the query is scoped by.
       *
       * Rather than restating the escaping algorithm (a test that mirrors the implementation
       * proves nothing), these parse the emitted `q` the way Drive would and assert the
       * literal ROUND-TRIPS back to exactly the caller's value, with the scoping clause intact
       * outside it.
       */
      const parseDriveLiteral = (q: string) => {
        const marker = "name = '";
        const start = q.indexOf(marker);
        if (start < 0) return null;
        let i = start + marker.length;
        let out = '';
        while (i < q.length) {
          if (q[i] === '\\') { out += q[i + 1]; i += 2; continue; }
          if (q[i] === "'") return { value: out, rest: q.slice(i + 1) };
          out += q[i]; i += 1;
        }
        return null; // unterminated literal — Drive would 400
      };

      it.each([
        ['a trailing backslash', 'report\\'],
        ['a quote-parity break-out attempt', "x\\' or name != '"],
        ['a plain apostrophe', "Vince's ad"],
      ])('keeps the Drive query literal well-formed and scoped for %s', async (_label, fileName) => {
        mockDriveFiles.list.mockImplementation(() => Promise.resolve({ data: { files: [] } }));

        await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, fileName, USER_ID);

        const nameCall = mockDriveFiles.list.mock.calls.find(([a]: any) => a.q.includes('name = '));
        expect(nameCall).toBeDefined();
        const parsed = parseDriveLiteral(nameCall![0].q);

        // The literal terminates (an unescaped backslash would swallow the closing quote)...
        expect(parsed).not.toBeNull();
        // ...it carries exactly what the caller asked for, no more and no less...
        expect(parsed!.value).toBe(fileName);
        // ...and nothing the caller supplied escaped into query syntax: the clause after the
        // literal is still ours.
        expect(parsed!.rest.trimStart()).toMatch(/^and trashed = false/);
        expect(nameCall![0].q).toContain(`'${ROOT}' in parents`);
      });

      /*
       * ENG-1476 follow-up: the walk-wide DRIVE_LIST_WALK_MAX_MS is checked BETWEEN requests,
       * so it bounds how many calls the walk makes but cannot interrupt one call that has
       * already been issued and never answers — Node's fetch applies no default deadline.
       * Every request the walk and the batched file query issue therefore carries its own
       * timeout, the same split metaService uses (withReadDeadline alongside
       * META_LIST_MAX_MS).
       */
      it('gives every folder-walk and file-query request its own timeout', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes('mimeType')) return Promise.resolve({ data: { files: [] } });
          return Promise.resolve({ data: { files: [] } });
        });

        await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(mockDriveFiles.list).toHaveBeenCalled();
        for (const call of mockDriveFiles.list.mock.calls) {
          expect(call[1]).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));
          // Derived from the walk's REMAINING budget, so it can never be longer than the walk
          // itself would allow — a per-request timeout must not outlive the bound it protects.
          expect(call[1].timeout).toBeGreaterThan(0);
          expect(call[1].timeout).toBeLessThanOrEqual(WALK_BUDGET_MS);
        }
      });

      it('never sends timeout: 0 once the walk budget is all but spent', async () => {
        /*
         * The floor only matters when `deadline - Date.now()` has gone to ~0, so the budget has
         * to actually be consumed for this to pin anything — an assertion made against a fresh
         * 15s budget passes against an implementation with no floor at all.
         *
         * Each folder-discovery call burns most of the budget, so by the later requests the
         * remaining time is at or below the floor.
         */
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
          let n = 0;
          mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
            n += 1;
            // Leaves ~500ms of the 15s budget, which is below the floor but still passes the
            // loop's pre-check — the only window in which the floor is reachable at all.
            if (n === 1) jest.advanceTimersByTime(WALK_BUDGET_MS - 500);
            if (q.includes('mimeType') && n === 1) {
              return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
            }
            return Promise.resolve({ data: { files: [] } });
          });

          await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

          const timeouts = mockDriveFiles.list.mock.calls.map((c: any) => c[1].timeout);
          expect(timeouts.length).toBeGreaterThan(1);
          // Every one is floored, and at least one was issued on a spent budget — so this would
          // fail against an implementation that passed the raw remaining time.
          expect(Math.min(...timeouts)).toBeGreaterThanOrEqual(1_000);
          expect(Math.min(...timeouts)).toBe(1_000);
        } finally {
          jest.useRealTimers();
        }
      });

      it('names the sub-folder that needs sharing when it cannot be listed, instead of a bare "not found"', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
            return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
          }
          if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType')) {
            return Promise.reject(makeApiError(403, 'insufficientPermissions'));
          }
          // No file matches because the sub-folder couldn't be enumerated
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toContain('4x5');
        expect(result.message).toMatch(/share/i);
      });

      // ── Rework findings (post-review) ──────────────────────────────────────

      it('does not call the registered root a "sub-folder" when the root itself cannot be listed', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
            return Promise.reject(makeApiError(403, 'insufficientPermissions'));
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).not.toMatch(/sub-folder/i);
        expect(result.message).toMatch(/itself could not be accessed/i);
      });

      /*
       * When the root is unreadable AND the file search also failed, the ACTIONABLE cause wins.
       *
       * Drive answers 403 for a permission denial and for `userRateLimitExceeded` alike, and the
       * folder walk buckets every 403 as "permission" — so an unshared root very often makes the
       * name query fail too and BOTH flags are set. The incomplete-search branch used to be
       * checked first, which replaced the one remedy the user can act on ("share it with
       * <service-account>") with "retry the read", which cannot work while the folder stays
       * unshared. Same "remedy that cannot work" shape as ENG-1636.
       *
       * The search caveat is not dropped — it is appended, so the message carries the cause AND
       * the fact that absence was never confirmed.
       */
      it('prefers the shareable-root remedy over "retry" when BOTH the root and the search fail', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes('mimeType')) {
            return Promise.reject(makeApiError(403, 'insufficientPermissions'));
          }
          // The name query fails too — the usual consequence of the same lost access.
          return Promise.reject(makeApiError(403, 'insufficientPermissions'));
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/itself could not be accessed/i);
        expect(result.message).toMatch(/share it with/i);
        // The caveat rides along rather than replacing the remedy.
        expect(result.message).toMatch(/not a confirmed absence/i);
      });

      /*
       * A THROTTLED 403 is not an access decision.
       *
       * Drive returns 403 for `userRateLimitExceeded` / `dailyLimitExceeded` as well as for a
       * genuine permission denial, and the walk used to bucket every 403 as "permission" — so a
       * rate-limited user was told to share a folder with the service account that they had
       * already shared. The remedy could not work, and the one that would (wait and retry) was
       * never offered. `error.errors[].reason` is what tells them apart, and it was discarded.
       */
      it('does not tell a RATE-LIMITED user to share a folder they already shared', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes('mimeType')) {
            return Promise.reject(makeApiErrorWithReason(403, 'userRateLimitExceeded'));
          }
          return Promise.reject(makeApiErrorWithReason(403, 'userRateLimitExceeded'));
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        // Not a permissions answer …
        expect(result.message).not.toMatch(/share it with/i);
        expect(result.message).not.toMatch(/itself could not be accessed/i);
        /*
         * … and not a SIZE answer either, which is the trap the first version of this fix fell
         * into: routing a throttled 403 into the incomplete-walk branch made it inherit "the
         * folder tree is large enough that the scan stopped", so the user was told their folder
         * was too big and invited to narrow a search that would throttle identically. A quota
         * answer describes Drive, not the folder.
         */
        expect(result.message).not.toMatch(/large enough/i);
        expect(result.message).toMatch(/narrowing will not help/i);
        expect(result.message).toMatch(/rate-limited the scan/i);
        expect(result.message).toMatch(/temporary quota answer/i);
        expect(result.message).toMatch(/Do NOT report the file as absent/i);
      });

      /*
       * gaxios surfaces `code` as a STRING in some shapes, and every handler in this file
       * compares it strictly (`code === 403`). A string `'403'` therefore matched no branch and
       * fell through to the generic "temporary Drive error", losing both the permission remedy
       * and the throttle one. Normalised once in `driveErrorCode`.
       */
      it('handles a status code that arrives as a string, not a number', async () => {
        const stringCoded: any = new Error('API error');
        stringCoded.code = '403';
        stringCoded.errors = [{ domain: 'global', reason: 'insufficientPermissions' }];
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes('mimeType')) return Promise.reject(stringCoded);
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        // Reaches the permission branch instead of the generic fallback.
        expect(result.message).toMatch(/itself could not be accessed/i);
        expect(result.message).toMatch(/share it with/i);
      });

      it('still treats a genuine permission 403 as restricted', async () => {
        // The control for the test above — the discrimination must not disarm the real case.
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes('mimeType')) {
            return Promise.reject(makeApiErrorWithReason(403, 'insufficientPermissions'));
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/itself could not be accessed/i);
        expect(result.message).toMatch(/share it with/i);
      });

      it('follows nextPageToken when a folder has more sub-folders than fit in one page', async () => {
        const PAGE1_CHILD = 'page-1-child';
        const PAGE2_CHILD = 'page-2-child';
        mockDriveFiles.list.mockImplementation(({ q, pageToken }: { q: string; pageToken?: string }) => {
          if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
            if (!pageToken) {
              return Promise.resolve({ data: { files: [{ id: PAGE1_CHILD, name: 'p1' }], nextPageToken: 'tok-1' } });
            }
            if (pageToken === 'tok-1') {
              return Promise.resolve({ data: { files: [{ id: PAGE2_CHILD, name: 'p2' }] } });
            }
          }
          if ((q.includes(`'${PAGE1_CHILD}' in parents`) || q.includes(`'${PAGE2_CHILD}' in parents`)) && q.includes('mimeType')) {
            return Promise.resolve({ data: { files: [] } });
          }
          if (q.includes("name = 'ad.png'")) {
            return Promise.resolve({
              data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '1024' }] },
            });
          }
          return Promise.resolve({ data: { files: [] } });
        });
        mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('bytes') });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        const nameSearchCall = mockDriveFiles.list.mock.calls.find(
          ([arg]: any) => arg.q.includes("name = 'ad.png'")
        );
        expect(nameSearchCall).toBeDefined();
        // Only reachable if the walker followed nextPageToken to discover the
        // second page's child folder.
        expect(nameSearchCall![0].q).toContain(`'${PAGE2_CHILD}' in parents`);
        expect(result.success).toBe(true);
      });

      /*
       * `truncated` doubled as the BFS loop condition (`while (queue.length > 0 && !truncated)`),
       * so recording "this sub-folder could not be listed" also ABANDONED the walk: a 502 on
       * sub-folder 3 of 40 left the other 37 unvisited. Note the asymmetry it introduced —
       * a 403/401 takes the `restricted` branch and keeps walking, so a permission failure was
       * handled better than a transient one.
       */
      it('keeps walking the rest of the tree after a transient error on one sub-folder', async () => {
        const SUB_A = 'sub-a';
        const SUB_B = 'sub-b';
        const SUB_C = 'sub-c';
        const listed: string[] = [];
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${ROOT}' in parents`)) {
              return Promise.resolve({
                data: {
                  files: [{ id: SUB_A, name: 'a' }, { id: SUB_B, name: 'b' }, { id: SUB_C, name: 'c' }],
                },
              });
            }
            if (q.includes(`'${SUB_A}' in parents`)) {
              listed.push(SUB_A);
              return Promise.resolve({ data: { files: [] } });
            }
            if (q.includes(`'${SUB_B}' in parents`)) {
              listed.push(SUB_B);
              // Transient, NOT a permission answer — so it does not take the `restricted` branch.
              return Promise.reject(makeApiError(502, 'Bad Gateway'));
            }
            if (q.includes(`'${SUB_C}' in parents`)) {
              listed.push(SUB_C);
              return Promise.resolve({ data: { files: [] } });
            }
            return Promise.resolve({ data: { files: [] } });
          }
          if (q.includes("name = 'ad.png'")) {
            return Promise.resolve({
              data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '10', parents: [SUB_C] }] },
            });
          }
          return Promise.resolve({ data: { files: [] } });
        });
        mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('bytes') });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        // C comes AFTER the failing B in the queue: it is only reached if the walk continued.
        expect(listed).toContain(SUB_C);

        // And the file living in C is found, rather than reported missing from a walk that quit.
        const nameSearchCall = mockDriveFiles.list.mock.calls.find(
          ([arg]: any) => arg.q.includes("name = 'ad.png'")
        );
        expect(nameSearchCall![0].q).toContain(`'${SUB_C}' in parents`);
        expect(result.success).toBe(true);
      });

      it('still reports the walk as incomplete after a transient sub-folder error', async () => {
        // Continuing the walk must not cost the incompleteness signal: the failed sub-folder was
        // never read, so an empty result from this tree is still not a confirmed absence.
        const SUB_A = 'sub-a';
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${ROOT}' in parents`)) {
              return Promise.resolve({ data: { files: [{ id: SUB_A, name: 'a' }] } });
            }
            return Promise.reject(makeApiError(502, 'Bad Gateway'));
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not a confirmed absence/i);
      });

      it('does not re-list a folder reachable via two different parents, and terminates', async () => {
        const CHILD_A = 'child-a';
        const CHILD_B = 'child-b';
        const SHARED = 'shared-child';
        let sharedListCalls = 0;
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (!q.includes('mimeType')) return Promise.resolve({ data: { files: [] } });
          if (q.includes(`'${ROOT}' in parents`)) {
            return Promise.resolve({ data: { files: [{ id: CHILD_A, name: 'a' }, { id: CHILD_B, name: 'b' }] } });
          }
          if (q.includes(`'${CHILD_A}' in parents`) || q.includes(`'${CHILD_B}' in parents`)) {
            // Both A and B report the SAME child — a diamond in the folder graph.
            return Promise.resolve({ data: { files: [{ id: SHARED, name: 'shared' }] } });
          }
          if (q.includes(`'${SHARED}' in parents`)) {
            sharedListCalls++;
            return Promise.resolve({ data: { files: [] } });
          }
          return Promise.resolve({ data: { files: [] } });
        });

        await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        // If the walk re-queued SHARED every time it was discovered (once via A,
        // once via B), its children would be listed twice — or, with a real
        // cycle instead of a diamond, the walk would never terminate.
        expect(sharedListCalls).toBe(1);
      });

      // Same defect as readSingleKnowledgeBaseFile above: both callers ignored the helper's
      // `failed`/`capped` flags and turned an errored search into a definitive "not found".
      it('does not claim the asset is absent when the name query itself failed', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            return Promise.resolve({ data: { files: [] } });
          }
          return Promise.reject(makeApiError(500, 'Drive did not respond within 8000ms'));
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).not.toMatch(/not found/i);
        expect(result.message).toMatch(/could not determine/i);
        expect(result.message).toMatch(/failed/i);
        expect(result.message).toMatch(/retry the read/i);
      });

      // The capped/failed split, pinned on this caller too — the two paths were duplicated
      // literals before, which is exactly how one gets fixed and the other does not.
      // See readSingleKnowledgeBaseFile's equivalent for why a capped read is not retryable.
      it('does not tell the model to retry when the name search ran out of its time budget', async () => {
        jest.useFakeTimers();
        try {
          mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
            if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
              return Promise.resolve({ data: { files: [] } });
            }
            jest.advanceTimersByTime(WALK_BUDGET_MS + 5_000);
            return Promise.resolve({ data: { files: [], nextPageToken: 'page-2' } });
          });

          const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

          expect(result.success).toBe(false);
          expect(result.message).toMatch(/not a confirmed absence/i);
          expect(result.message).not.toMatch(/retry the read/i);
          expect(result.message).toMatch(/do not retry this same call/i);
          expect(result.message).toMatch(/direct google drive link/i);
        } finally {
          jest.useRealTimers();
        }
      });

      /*
       * The sibling to the wall-clock test above: a walk that stopped because a SUB-FOLDER READ
       * FAILED, not because it ran out of time. Only this cause can be cleared by trying again,
       * so it is the one case where telling the model to retry is correct — and unlike the
       * deterministic case, this exercises the branch through the real classifier too.
       */
      it('DOES tell the model retrying may help when a sub-folder read failed transiently', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${ROOT}' in parents`)) {
              return Promise.resolve({ data: { files: [{ id: 'bad-sub', name: 'bad' }] } });
            }
            const e: any = new Error('socket hang up');
            e.code = 'ECONNRESET';
            return Promise.reject(e);
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not a confirmed absence/i);
        expect(result.message).toMatch(/retrying may well complete the scan/i);

        const classified = classifyToolErrorClass(new Error(result.message));
        expect(classified).toBe('read_incomplete');
        expect(appendRetryabilityGuidance('x', classified)).toMatch(/Retryable: yes/i);
      });

      /*
       * The case the previous round of this fix got wrong: a walk that hit BOTH a transient
       * sub-folder failure AND a deterministic bound (the folder-count ceiling) in the same walk.
       * transientFailure alone is not enough to promise a useful retry, because the deterministic
       * bound will stop the walk in the same place next time regardless.
       */
      it('does NOT promise a useful retry when a transient failure AND a deterministic bound both fired', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${ROOT}' in parents`)) {
              return Promise.resolve({
                data: { files: [{ id: 'bad-sub', name: 'bad' }, { id: 'big-sub', name: 'big' }] },
              });
            }
            if (q.includes(`'bad-sub' in parents`)) {
              const e: any = new Error('socket hang up');
              e.code = 'ECONNRESET';
              return Promise.reject(e);
            }
            if (q.includes(`'big-sub' in parents`)) {
              return Promise.resolve({
                data: { files: Array.from({ length: 600 }, (_, i) => ({ id: `g${i}`, name: `g${i}` })) },
              });
            }
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not a confirmed absence/i);
        // The transient-only wording must NOT appear — the bound makes a retry futile regardless.
        expect(result.message).not.toMatch(/retrying may well complete the scan/i);
        expect(result.message).toMatch(/stop in the same place every time/i);

        const classified = classifyToolErrorClass(new Error(result.message));
        expect(classified).toBe('read_bounded');
        expect(appendRetryabilityGuidance('x', classified)).toMatch(/Retryable: no/i);
      });

      it('reports ambiguity instead of silently materializing one candidate when the same name exists in two sub-folders', async () => {
        const SUB_A = 'ratio-4x5';
        const SUB_B = 'ratio-9x16';
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${ROOT}' in parents`)) {
              return Promise.resolve({ data: { files: [{ id: SUB_A, name: '4x5' }, { id: SUB_B, name: '9x16' }] } });
            }
            return Promise.resolve({ data: { files: [] } });
          }
          if (q.includes("name = 'report.png'")) {
            return Promise.resolve({
              data: {
                files: [
                  { id: 'file-a', name: 'report.png', mimeType: 'image/png', size: '10', parents: [SUB_A] },
                  { id: 'file-b', name: 'report.png', mimeType: 'image/png', size: '10', parents: [SUB_B] },
                ],
              },
            });
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'report.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/multiple/i);
        expect(result.message).toContain('4x5');
        expect(result.message).toContain('9x16');
        // Must not have materialized (uploaded) either candidate.
        expect(mockDriveFiles.get).not.toHaveBeenCalled();
      });

      it('still makes exactly one files.list call per batch at target=2, and still reports ambiguity (round-2 rework)', async () => {
        const SUB_A = 'ratio-4x5';
        const SUB_B = 'ratio-9x16';
        let nameQueryCalls = 0;
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${ROOT}' in parents`)) {
              return Promise.resolve({ data: { files: [{ id: SUB_A, name: '4x5' }, { id: SUB_B, name: '9x16' }] } });
            }
            return Promise.resolve({ data: { files: [] } });
          }
          if (q.includes("name = 'dup.png'")) {
            nameQueryCalls++;
            return Promise.resolve({
              data: {
                files: [
                  { id: 'file-a', name: 'dup.png', mimeType: 'image/png', size: '10', parents: [SUB_A] },
                  { id: 'file-b', name: 'dup.png', mimeType: 'image/png', size: '10', parents: [SUB_B] },
                ],
              },
            });
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'dup.png', USER_ID);

        // folderIds = [ROOT, SUB_A, SUB_B] — 3 ids, one batch — so the in-batch
        // pagination added for the totalFiles/hasMore fix must not turn this
        // into more than one call: 2 matches at a target of 2 means the batch
        // is genuinely done after the first page (no nextPageToken to follow).
        expect(nameQueryCalls).toBe(1);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/multiple/i);
      });

      it('names a folder actually in the searched tree in the ambiguity message, even when a file lists an outside parent first', async () => {
        const SUB_A = 'ratio-4x5';
        const SUB_B = 'ratio-9x16';
        const OUTSIDE = 'some-unrelated-folder-not-in-the-tree';
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${ROOT}' in parents`)) {
              return Promise.resolve({ data: { files: [{ id: SUB_A, name: '4x5' }, { id: SUB_B, name: '9x16' }] } });
            }
            return Promise.resolve({ data: { files: [] } });
          }
          if (q.includes("name = 'dup.png'")) {
            return Promise.resolve({
              data: {
                files: [
                  // parents[0] is OUTSIDE the tree that was actually searched
                  // — naming it would point someone at the wrong place.
                  { id: 'file-a', name: 'dup.png', mimeType: 'image/png', size: '10', parents: [OUTSIDE, SUB_A] },
                  { id: 'file-b', name: 'dup.png', mimeType: 'image/png', size: '10', parents: [SUB_B] },
                ],
              },
            });
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'dup.png', USER_ID);

        expect(result.success).toBe(false);
        expect(result.message).toContain('4x5');
        expect(result.message).toContain('9x16');
        expect(result.message).not.toContain(OUTSIDE);
      });

      it('materializes against a nested child root identifier exactly as before (regression guard)', async () => {
        const PARENT = 'root-parent';
        const CHILD = 'root-child';
        (userDb.getUserById as jest.Mock).mockResolvedValue({
          userId: USER_ID,
          googleDriveFolders: [
            { folderId: PARENT, name: 'Parent' },
            { folderId: CHILD, name: 'Child' },
          ],
        });
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            return Promise.resolve({ data: { files: [] } }); // CHILD has no sub-folders of its own
          }
          if (q.includes("name = 'ad.png'")) {
            return Promise.resolve({
              data: { files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '2048' }] },
            });
          }
          return Promise.resolve({ data: { files: [] } });
        });
        mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('fake-png-bytes') });

        // Round 4 changes listKnowledgeBaseFiles' cross-root de-duplication —
        // materialize's own per-call tree walk (rooted at whichever
        // kb_identifier was passed) is untouched, so a saved reference to the
        // nested child root must resolve exactly as it always has.
        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${CHILD}`, 'ad.png', USER_ID);

        expect(result.success).toBe(true);
        expect(result.url).toMatch(/^https:\/\//);
      });

      it('flags an incomplete scan — and does not claim absence — when a tree exceeds the folder cap', async () => {
        let depth = 0;
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            // Every folder in this synthetic tree has exactly one child, so the
            // walk never runs out of folders to discover on its own — it must
            // stop at the folder-count bound, not run away.
            depth++;
            return Promise.resolve({ data: { files: [{ id: `deep-${depth}`, name: `deep-${depth}` }] } });
          }
          // Target file search across the (truncated) tree — never matches.
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

        expect(result.success).toBe(false);
        // Must not read as a confirmed absence — the scan didn't cover the whole tree.
        expect(result.message).not.toBe('File "ad.png" not found in Google Drive folder');
        expect(result.message).toMatch(/stopped before covering it entirely|not a confirmed absence/i);
      });

      it('flags an incomplete scan — and does not claim absence — when the tree walk exceeds its time bound', async () => {
        jest.useFakeTimers();
        try {
          let depth = 0;
          mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
            if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
              depth++;
              // Every folder discovery "costs" wall-clock time — an unbounded
              // (one-child-per-folder) tree that would run forever without a
              // time bound, not just a large one.
              jest.advanceTimersByTime(5_000);
              return Promise.resolve({ data: { files: [{ id: `deep-${depth}`, name: `deep-${depth}` }] } });
            }
            return Promise.resolve({ data: { files: [] } });
          });

          const result = await service.materializeKnowledgeBaseAsset(`gdrive:${ROOT}`, 'ad.png', USER_ID);

          expect(result.success).toBe(false);
          expect(result.message).not.toBe('File "ad.png" not found in Google Drive folder');
          expect(result.message).toMatch(/stopped before covering it entirely|not a confirmed absence/i);
          /*
           * Bounded by the TIME budget, not by a magic number. Each simulated folder discovery
           * costs 5s above, so the walk should stop after roughly WALK_BUDGET_MS/5s of them —
           * the assertion tracks the budget instead of pinning a count that silently encodes it.
           * What is being proven is that an unbounded (one-child-per-folder) tree terminates,
           * not that it terminates at any particular depth.
           */
          expect(depth).toBeLessThan(WALK_BUDGET_MS / 5_000 + 3);
        } finally {
          jest.useRealTimers();
        }
      });
    });
  });

  // ── listKnowledgeBaseFiles — Google Drive sub-folder recursion (ENG-1624) ──

  describe('listKnowledgeBaseFiles - Google Drive sub-folder recursion (ENG-1624)', () => {
    const { userDb, taskDb } = require('../services/db');
    const ROOT = 'root-folder';
    const SUB = '4x5-subfolder';

    beforeEach(() => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        googleDriveFolders: [{ folderId: ROOT, name: '8-18-26 Insurance Angle Ads' }],
      });
      (taskDb.getTasksWithKnowledgeBase as jest.Mock).mockResolvedValue([]);
      (taskDb.getAllPublicKnowledgeBaseTasks as jest.Mock).mockResolvedValue([]);
    });

    it('enumerates files nested in a sub-folder instead of listing the sub-folder as a 0-byte entry', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType =')) {
          return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
        }
        if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType =')) {
          return Promise.resolve({ data: { files: [] } });
        }
        // Final listing query — excludes folder entries, spans the whole tree
        return Promise.resolve({
          data: {
            files: [{ id: 'file-1', name: 'ad.png', mimeType: 'image/png', size: '2048', modifiedTime: '2026-08-01T00:00:00Z' }],
          },
        });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);
      expect(gdriveKb).toBeDefined();
      expect(gdriveKb.files).toEqual([
        expect.objectContaining({ fileName: 'ad.png', mimeType: 'image/png' }),
      ]);
      // No 0-byte folder placeholder for the "4x5" sub-folder itself
      expect(gdriveKb.files.some((f: any) => f.fileName === '4x5')).toBe(false);

      const finalCall = mockDriveFiles.list.mock.calls.find(
        ([arg]: any) => !arg.q.includes('mimeType =') && arg.q.includes(`'${SUB}' in parents`)
      );
      expect(finalCall).toBeDefined();
      expect(finalCall![0].q).toContain("mimeType != 'application/vnd.google-apps.folder'");
    });

    /*
     * modified_after/modified_before reach this method as a bare `type: "string"` off the tool
     * schema, with no validation anywhere, and were interpolated UNESCAPED into the same `q` as
     * the parent-folder clause. Drive's `or` binds looser than `and`, so
     * `"2020-01-01' or name != 'x"` ORs the parent scoping away — and the Drive client is a
     * SHARED service account with drive.readonly, so what comes back is other tenants' file
     * names, ids, sizes and modifiedTimes.
     */
    describe('date filters cannot escape the parent-folder clause', () => {
      const INJECTION = "2020-01-01' or name != 'x";

      it('refuses a crafted modified_after before any Drive query runs', async () => {
        mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });

        const result = await service.listKnowledgeBaseFiles(USER_ID, {
          kb_type: 'google-drive',
          modified_after: INJECTION,
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/YYYY-MM-DD/);
        // The point of the assertion: no `q` was ever built from it, scoped or otherwise.
        const injected = mockDriveFiles.list.mock.calls.filter(([arg]: any) => arg.q.includes('name !='));
        expect(injected).toHaveLength(0);
      });

      it('refuses a crafted modified_before too', async () => {
        mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });

        const result = await service.listKnowledgeBaseFiles(USER_ID, {
          kb_type: 'google-drive',
          modified_before: INJECTION,
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/YYYY-MM-DD/);
        expect(mockDriveFiles.list.mock.calls.filter(([arg]: any) => arg.q.includes('name !='))).toHaveLength(0);
      });

      it('refuses a date that is not a real calendar day', async () => {
        mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });

        const result = await service.listKnowledgeBaseFiles(USER_ID, {
          kb_type: 'google-drive',
          modified_after: '2026-02-31',
        });

        expect(result.success).toBe(false);
        expect(result.message).toMatch(/not a real calendar date/i);
      });

      it('still applies a well-formed date, inside the quoted literal and after the parent clause', async () => {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes('mimeType =')) return Promise.resolve({ data: { files: [] } });
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.listKnowledgeBaseFiles(USER_ID, {
          kb_type: 'google-drive',
          modified_after: '2026-04-15',
          modified_before: '2026-04-22',
        });

        expect(result.success).toBe(true);
        const listingCall = mockDriveFiles.list.mock.calls.find(([arg]: any) => !arg.q.includes('mimeType ='));
        expect(listingCall).toBeDefined();
        const q: string = listingCall![0].q;
        expect(q).toContain(`'${ROOT}' in parents`);
        expect(q).toContain("modifiedTime >= '2026-04-15T00:00:00'");
        expect(q).toContain("modifiedTime <= '2026-04-22T23:59:59'");
        // Quote parity: every literal in the query is closed, so nothing escaped one.
        expect((q.match(/'/g) || []).length % 2).toBe(0);
      });
    });

    it('surfaces inaccessibleFolders when a sub-folder cannot be listed, instead of silently shrinking the listing', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType =')) {
          return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
        }
        if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType =')) {
          return Promise.reject(makeApiError(403, 'insufficientPermissions'));
        }
        return Promise.resolve({
          data: {
            files: [{ id: 'file-1', name: 'root.png', mimeType: 'image/png', size: '2048', modifiedTime: '2026-08-01T00:00:00Z' }],
          },
        });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);
      expect(gdriveKb).toBeDefined();
      expect(gdriveKb.inaccessibleFolders).toEqual(['4x5']);
    });

    // ── Rework findings (post-review) ────────────────────────────────────────

    it('flags folderScanIncomplete in both the per-KB field and the human-readable message when the tree exceeds the folder cap', async () => {
      let depth = 0;
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          depth++;
          return Promise.resolve({ data: { files: [{ id: `deep-${depth}`, name: `deep-${depth}` }] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);
      expect(gdriveKb.folderScanIncomplete).toBe(true);
      expect(result.folderScanIncomplete).toBe(true);
      // The model reads prose, not just structured fields.
      expect(result.message).toMatch(/too large to fully scan|could not be accessed/i);
    });

    it('batches Drive queries across more than 50 folders and merges duplicate files by id', async () => {
      const CHILDREN = Array.from({ length: 60 }, (_, i) => ({ id: `child-${i}`, name: `child-${i}` }));
      const FILE_A = { id: 'file-a', name: 'a.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-01T00:00:00Z' };
      const FILE_B = { id: 'file-b', name: 'b.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-02T00:00:00Z' };
      const FILE_B_DUP = { ...FILE_B };
      const FILE_C = { id: 'file-c', name: 'c.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-03T00:00:00Z' };

      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          if (q.includes(`'${ROOT}' in parents`)) {
            return Promise.resolve({ data: { files: CHILDREN } });
          }
          return Promise.resolve({ data: { files: [] } });
        }

        // Batched file-listing query — the 61 folder ids (root + 60 children)
        // must be split across more than one query.
        const idsInBatch = (q.match(/' in parents/g) || []).length;
        expect(idsInBatch).toBeLessThanOrEqual(50);

        // Batch 1 (the one containing the root) returns file-a and file-b;
        // batch 2 returns file-b again (a legitimate multi-parent duplicate)
        // plus file-c.
        if (q.includes(`'${ROOT}' in parents`)) {
          return Promise.resolve({ data: { files: [FILE_A, FILE_B] } });
        }
        return Promise.resolve({ data: { files: [FILE_B_DUP, FILE_C] } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });
      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

      const finalCalls = mockDriveFiles.list.mock.calls.filter(
        ([arg]: any) => arg.q.includes("mimeType != 'application/vnd.google-apps.folder'")
      );
      expect(finalCalls.length).toBeGreaterThanOrEqual(2);

      // Merged, de-duplicated by file id — not a per-batch fragment.
      expect(gdriveKb.totalFiles).toBe(3);
      expect(gdriveKb.files.map((f: any) => f.fileName).sort()).toEqual(['a.png', 'b.png', 'c.png']);
      expect(gdriveKb.offset).toBe(0);
    });

    // ── Rework findings, round 2 (per-batch single-page cap) ───────────────────
    //
    // queryDriveFilesAcrossFolders fetched exactly one page per batch and never
    // requested nextPageToken, so a batch holding more matches than that one page
    // silently dropped the rest: totalFiles/hasMore could both read "complete"
    // while most of the tree was missing. Fixed by pursuing a per-batch target
    // via in-batch pagination; `files` was already correct (top-K-per-batch is a
    // safe superset of the true top-K), only totalFiles/hasMore needed fixing.

    it('follows nextPageToken within a batch when a full page indicates more results exist', async () => {
      const PAGE1 = { id: 'file-p1', name: 'p1.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-01T00:00:00Z' };
      const PAGE2 = { id: 'file-p2', name: 'p2.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-02T00:00:00Z' };
      let finalCallCount = 0;
      mockDriveFiles.list.mockImplementation(({ q, pageToken }: { q: string; pageToken?: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        finalCallCount++;
        if (!pageToken) {
          return Promise.resolve({ data: { files: [PAGE1], nextPageToken: 'tok-1' } });
        }
        return Promise.resolve({ data: { files: [PAGE2] } });
      });

      // limit: 2 → per-batch target = offset(0) + limit(2) + 1 = 3, so a 1-item
      // first page with a token isn't yet at target and must be followed.
      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive', limit: 2, offset: 0 });
      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

      expect(finalCallCount).toBe(2);
      expect(gdriveKb.files.map((f: any) => f.fileName).sort()).toEqual(['p1.png', 'p2.png']);
    });

    it('reports hasMore=true when more than one page of matches exists (was silently false under the old single-page fetch)', async () => {
      const FILES = Array.from({ length: 101 }, (_, i) => ({
        id: `file-${i}`,
        name: `file-${i}.png`,
        mimeType: 'image/png',
        size: '10',
        modifiedTime: '2026-08-01T00:00:00Z',
      }));
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        // Exactly 101 matches, no nextPageToken — genuinely exhaustive, and
        // exceeds the default limit of 100.
        return Promise.resolve({ data: { files: FILES } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });
      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

      expect(gdriveKb.hasMore).toBe(true);
      expect(gdriveKb.files.length).toBe(100);
      // Genuinely exhaustive (no token seen) — an exact total, not a lower bound.
      expect(gdriveKb.totalFiles).toBe(101);
      expect(gdriveKb.totalFilesIsLowerBound).toBeUndefined();
    });

    it('flags totalFiles as a lower bound — in both the field and the message — when the file query hits its per-batch target', async () => {
      const FILES = Array.from({ length: 101 }, (_, i) => ({
        id: `file-${i}`,
        name: `file-${i}.png`,
        mimeType: 'image/png',
        size: '10',
        modifiedTime: '2026-08-01T00:00:00Z',
      }));
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        // 101 matches AND a token — the fetch stopped at its target with more
        // genuinely available.
        return Promise.resolve({ data: { files: FILES, nextPageToken: 'more-beyond' } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });
      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

      expect(gdriveKb.totalFilesIsLowerBound).toBe(true);
      expect(gdriveKb.hasMore).toBe(true);
      // The model reads prose, not just structured fields.
      expect(result.totalFilesIsLowerBound).toBe(true);
      expect(result.message).toMatch(/lower bound/i);
    });

    it('reports an exact total and no lower-bound marker when the true count is below the limit', async () => {
      const FILES = [
        { id: 'file-1', name: 'a.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-01T00:00:00Z' },
        { id: 'file-2', name: 'b.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-02T00:00:00Z' },
      ];
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        return Promise.resolve({ data: { files: FILES } }); // no nextPageToken — genuine exhaustion
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });
      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

      expect(gdriveKb.totalFiles).toBe(2);
      expect(gdriveKb.hasMore).toBe(false);
      expect(gdriveKb.totalFilesIsLowerBound).toBeUndefined();
      expect(result.totalFilesIsLowerBound).toBeUndefined();
      expect(result.message).not.toMatch(/lower bound/i);
    });

    it('stops pagination at the per-batch target instead of draining an enormous folder', async () => {
      let callCount = 0;
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        callCount++;
        // Drive keeps claiming there's more, 10 items at a time — an enormous
        // (or pathological) folder. The walk must not drain it.
        const files = Array.from({ length: 10 }, (_, i) => ({
          id: `file-${callCount}-${i}`,
          name: `f-${callCount}-${i}.png`,
          mimeType: 'image/png',
          size: '10',
          modifiedTime: '2026-08-01T00:00:00Z',
        }));
        return Promise.resolve({ data: { files, nextPageToken: `tok-${callCount}` } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });
      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

      // Bounded — a handful of pages to reach the (offset+limit+1) target, not an
      // unbounded/runaway fetch.
      expect(callCount).toBeLessThanOrEqual(15);
      expect(gdriveKb.totalFilesIsLowerBound).toBe(true);
    });

    it('flags totalFilesIsLowerBound when the file query itself exceeds the time bound (not just the per-batch target)', async () => {
      jest.useFakeTimers();
      try {
        let callCount = 0;
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            return Promise.resolve({ data: { files: [] } });
          }
          callCount++;
          // Each simulated page "costs" wall-clock time past the walk's own
          // budget — a slow/throttled Drive response, not a huge result set.
          jest.advanceTimersByTime(WALK_BUDGET_MS + 5_000);
          return Promise.resolve({
            data: {
              files: [{ id: 'file-1', name: 'a.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-01T00:00:00Z' }],
              nextPageToken: 'more-beyond',
            },
          });
        });

        const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });
        const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

        expect(gdriveKb.totalFilesIsLowerBound).toBe(true);
        // Stopped quickly once the bound tripped — not draining pages.
        expect(callCount).toBeLessThanOrEqual(2);
      } finally {
        jest.useRealTimers();
      }
    });

    // ── Rework findings, round 3 (silent KB drop on error; no time budget) ─────
    //
    // queryDriveFilesAcrossFolders has no try/catch of its own — a 403 on one
    // batch, a 429, a 5xx, or a malformed-query 400 all propagate up to the
    // per-folder catch here. That catch used to just log and move on, which
    // silently dropped the whole KB from `knowledge_bases`: no inaccessibleFolders,
    // no folderScanIncomplete, nothing — indistinguishable from "this folder has
    // no files." Round 2 (the BFS walk + batched, paginated queries) multiplied
    // how many Drive calls a single listing makes, and therefore how often this
    // catch is hit.

    it('keeps a Drive knowledge base in the response — flagged, not dropped — when its file query throws', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        return Promise.reject(makeApiError(500, 'internal error'));
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });
      const gdriveKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT}`);

      // Must fail against the old code: the old catch just logged and the KB
      // never appeared in knowledge_bases at all.
      expect(gdriveKb).toBeDefined();
      expect(gdriveKb.listingFailed).toBe(true);
      expect(gdriveKb.files).toEqual([]);
      /*
       * The aggregate sentence used to say the failed sources are "shown as empty". That is a
       * state the code cannot produce: queryDriveFilesAcrossFolders sets `failed` AFTER merging
       * whatever batches succeeded, so a failed source can carry a PARTIAL list — and a model
       * told the list is "empty" will read a short list as complete. The message must cover
       * both shapes and end on the conclusion that matters: missing ≠ absent.
       */
      expect(result.message).toMatch(/could not be fully listed/i);
      expect(result.message).toMatch(/empty OR partial/i);
      expect(result.message).toMatch(/unknown, not absent/i);
      expect(result.message).not.toMatch(/shown as empty/i);

      /*
       * FIELD ORDER IS THE ASSERTION, not a style preference.
       *
       * A knowledge-base listing routinely clears the S3 offload threshold, after which the
       * model is handed a SEALED fixed-length PREFIX of this JSON — anything serialized after
       * the file array is not there at all. Measured at the default limit of 100 files, one
       * Drive source reached ~20.5k chars with `listingFailed` landing past the 20k cut: the
       * flag was set, was correct, and was unreadable on exactly the listings that need it.
       *
       * Asserting on the serialized offsets is what makes a future `{...kb, someFlag}` — which
       * appends behind the payload — fail here rather than in production.
       */
      const perSource = JSON.stringify(gdriveKb);
      expect(perSource.indexOf('"listingFailed"')).toBeGreaterThan(-1);
      expect(perSource.indexOf('"listingFailed"')).toBeLessThan(perSource.indexOf('"files"'));

      const topLevel = JSON.stringify(result);
      for (const field of ['"message"', '"totalKnowledgeBases"', '"driveListingFailures"']) {
        expect(topLevel.indexOf(field)).toBeGreaterThan(-1);
        expect(topLevel.indexOf(field)).toBeLessThan(topLevel.indexOf('"knowledge_bases"'));
      }
    });

    it('never puts the raw error object (or its message) in the returned payload', async () => {
      const SENSITIVE_MARKER = 'SECRET_REQUEST_URL_WITH_TOKEN_abc123';
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        return Promise.reject(new Error(SENSITIVE_MARKER));
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      expect(JSON.stringify(result)).not.toContain(SENSITIVE_MARKER);
    });

    it('states that Drive sources could not be enumerated at all when the whole-Drive path fails, rather than returning a Drive-free listing that looks complete', async () => {
      const { userDb, taskDb } = require('../services/db');
      (userDb.getUserById as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));
      (taskDb.getTasksWithKnowledgeBase as jest.Mock).mockResolvedValue([]);
      (taskDb.getAllPublicKnowledgeBaseTasks as jest.Mock).mockResolvedValue([]);

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      expect(result.driveEnumerationFailed).toBe(true);
      expect(result.message).toMatch(/could not be enumerated/i);
      expect(result.message).not.toMatch(/^No Google Drive shared folders found here/);
    });

    // ── Rework findings, round 4 (cross-root duplicate listing) ────────────────
    //
    // This loop pushes one knowledgeBases entry per registered root with no
    // cross-root de-duplication. Harmless while every query was direct-children
    // only; not harmless once the tree walk means a parent root's listing
    // legitimately includes a separately-registered descendant root's files too
    // — exactly Harsha's Phoenix mitigation shape (registering the ratio
    // sub-folders directly alongside the already-registered parent).

    it('lists both a parent and a nested child root, counts each file once, and states the nesting', async () => {
      const PARENT = 'root-parent';
      const CHILD = 'root-child';
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        googleDriveFolders: [
          { folderId: PARENT, name: 'Parent Folder' },
          { folderId: CHILD, name: 'Child Folder' },
        ],
      });

      const FILE = { id: 'shared-file-1', name: 'a.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-01T00:00:00Z' };
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          if (q.includes(`'${PARENT}' in parents`)) {
            return Promise.resolve({ data: { files: [{ id: CHILD, name: 'Child Folder' }] } });
          }
          return Promise.resolve({ data: { files: [] } }); // CHILD has no sub-folders of its own
        }
        if (q.includes(`'${CHILD}' in parents`)) {
          return Promise.resolve({ data: { files: [FILE] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      const parentKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${PARENT}`);
      const childKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${CHILD}`);

      // Must fail against the current (pre-fix) code: neither entry would be
      // dropped, but totalFiles would double-count and nestedUnder wouldn't exist.
      expect(parentKb).toBeDefined();
      expect(childKb).toBeDefined();
      expect(parentKb.files.map((f: any) => f.fileName)).toContain('a.png');
      expect(childKb.files.map((f: any) => f.fileName)).toContain('a.png');
      expect(childKb.nestedUnder).toBe(`gdrive:${PARENT}`);
      expect(result.totalFiles).toBe(1);
      expect(result.message).toMatch(/nested inside another registered source/i);
    });

    it('the real Phoenix shape — parent root plus three registered ratio sub-folders — reports the distinct file count, not a multiple of it', async () => {
      // Real folder ids from the Phoenix session (ENG-1624), so this fixture
      // stays traceable to the actual production account shape.
      const PARENT = '13A2WhVZiHpGW-scMBT5gcQSeH7mHZkn3'; // "8-18-26 Insurance Angle Ads"
      const SUB_4X5 = '1qG_eP4aG2yPu31ZAsAoGfFmqEqWHSd1t';
      const SUB_9X16 = '1zKbdC-8e0QH65MV_5mcEbE0btCJaWYnu';
      const SUB_1X1 = '1wSqSD7SYNnCd6K4VwEVg3BYL52ua95vZ';

      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        googleDriveFolders: [
          { folderId: PARENT, name: '8-18-26 Insurance Angle Ads' },
          { folderId: SUB_4X5, name: '8-18-26 Insurance Angle Ads / 4x5' },
          { folderId: SUB_9X16, name: '8-18-26 Insurance Angle Ads / 9x16' },
          { folderId: SUB_1X1, name: '8-18-26 Insurance Angle Ads / 1x1' },
        ],
      });

      const filesFor = (suffix: string) => ([
        { id: `BUSS-F-07-${suffix}`, name: `BUSS-F-07_iceberg-lifeboat_${suffix}.png`, mimeType: 'image/png', size: '4900000', modifiedTime: '2026-08-18T21:50:00Z' },
        { id: `BUSS-H-07-${suffix}`, name: `BUSS-H-07_iceberg-lifeboat_${suffix}.png`, mimeType: 'image/png', size: '4800000', modifiedTime: '2026-08-18T21:51:00Z' },
      ]);

      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          if (q.includes(`'${PARENT}' in parents`)) {
            return Promise.resolve({
              data: {
                files: [
                  { id: SUB_4X5, name: '4x5' },
                  { id: SUB_9X16, name: '9x16' },
                  { id: SUB_1X1, name: '1x1' },
                ],
              },
            });
          }
          return Promise.resolve({ data: { files: [] } }); // ratio folders have no sub-folders
        }
        let files: any[] = [];
        if (q.includes(`'${SUB_4X5}' in parents`)) files = files.concat(filesFor('4x5'));
        if (q.includes(`'${SUB_9X16}' in parents`)) files = files.concat(filesFor('9x16'));
        if (q.includes(`'${SUB_1X1}' in parents`)) files = files.concat(filesFor('1x1'));
        return Promise.resolve({ data: { files } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      const parentKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${PARENT}`);
      const sub4x5Kb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${SUB_4X5}`);

      expect(parentKb.files.length).toBe(6);
      expect(sub4x5Kb.files.length).toBe(2);
      expect(sub4x5Kb.nestedUnder).toBe(`gdrive:${PARENT}`);
      // 6 distinct creatives, not 6 (parent) + 2 + 2 + 2 (each ratio root) = 12.
      expect(result.totalFiles).toBe(6);
    });

    it('two roots sharing a sub-tree through a multi-parent folder — no nesting claimed, no double count', async () => {
      const ROOT_A = 'root-a';
      const ROOT_B = 'root-b';
      const SHARED = 'shared-child';
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        googleDriveFolders: [
          { folderId: ROOT_A, name: 'Root A' },
          { folderId: ROOT_B, name: 'Root B' },
        ],
      });

      const FILE = { id: 'shared-file', name: 'shared.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-01T00:00:00Z' };
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          if (q.includes(`'${ROOT_A}' in parents`) || q.includes(`'${ROOT_B}' in parents`)) {
            // Both roots independently discover the SAME child — a diamond,
            // not an ancestor/descendant relationship between the two roots.
            return Promise.resolve({ data: { files: [{ id: SHARED, name: 'shared' }] } });
          }
          return Promise.resolve({ data: { files: [] } });
        }
        if (q.includes(`'${SHARED}' in parents`)) {
          return Promise.resolve({ data: { files: [FILE] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

      const kbA = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT_A}`);
      const kbB = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${ROOT_B}`);

      // Neither root's own id was discovered inside the other's tree — SHARED
      // is a common descendant, not a containment relationship between A and B.
      expect(kbA.nestedUnder).toBeUndefined();
      expect(kbB.nestedUnder).toBeUndefined();
      expect(kbA.files.map((f: any) => f.fileName)).toContain('shared.png');
      expect(kbB.files.map((f: any) => f.fileName)).toContain('shared.png');
      expect(result.totalFiles).toBe(1);
    });

    it('a nested-looking root whose ancestor scan was truncated — no nesting claimed, files still deduplicated', async () => {
      jest.useFakeTimers();
      try {
        const PARENT = 'root-parent';
        const CHILD = 'root-child'; // genuinely a descendant of PARENT, but PARENT's walk never reaches it
        const DECOY = 'decoy-sibling';

        (userDb.getUserById as jest.Mock).mockResolvedValue({
          userId: USER_ID,
          googleDriveFolders: [
            { folderId: PARENT, name: 'Parent' },
            { folderId: CHILD, name: 'Child' },
          ],
        });

        const FILE = { id: 'file-1', name: 'a.png', mimeType: 'image/png', size: '10', modifiedTime: '2026-08-01T00:00:00Z' };

        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            if (q.includes(`'${PARENT}' in parents`)) {
              // Discovering PARENT's one child costs enough time that the walk
              // is truncated before it can ever descend into that child and
              // find CHILD underneath it.
              jest.advanceTimersByTime(WALK_BUDGET_MS + 5_000);
              return Promise.resolve({ data: { files: [{ id: DECOY, name: 'decoy' }] } });
            }
            return Promise.resolve({ data: { files: [] } }); // CHILD's own walk (registered separately) is fast and clean
          }
          if (q.includes(`'${CHILD}' in parents`)) {
            return Promise.resolve({ data: { files: [FILE] } });
          }
          return Promise.resolve({ data: { files: [] } });
        });

        const result = await service.listKnowledgeBaseFiles(USER_ID, { kb_type: 'google-drive' });

        const parentKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${PARENT}`);
        const childKb = result.knowledge_bases.find((kb: any) => kb.identifier === `gdrive:${CHILD}`);

        expect(parentKb.folderScanIncomplete).toBe(true);
        // PARENT's walk never actually discovered CHILD, so no relationship
        // is asserted — a scan that didn't observe something can't vouch for it.
        expect(childKb.nestedUnder).toBeUndefined();
        expect(childKb.files.map((f: any) => f.fileName)).toContain('a.png');
        expect(result.totalFiles).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── readSingleKnowledgeBaseFile / read_knowledge_base_files — Google Drive
  //    sub-folder traversal (ENG-1624) ────────────────────────────────────────
  //
  // readGoogleDriveSharedFile (behind read_knowledge_base_files) received the
  // identical tree-walk and restricted-error fix as materializeKnowledgeBaseAsset,
  // but had no test coverage of its own for either branch.

  describe('readSingleKnowledgeBaseFile - Google Drive sub-folder traversal (ENG-1624)', () => {
    const { userDb } = require('../services/db');
    const ROOT = 'root-folder';
    const SUB = '4x5-subfolder';

    beforeEach(() => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        googleDriveFolders: [{ folderId: ROOT, name: '8-18-26 Insurance Angle Ads' }],
      });
    });

    it('reads a file nested in a sub-folder of the registered root, not just direct children', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
          return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
        }
        if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType')) {
          return Promise.resolve({ data: { files: [] } });
        }
        if (q.includes("name = 'notes.txt'")) {
          return Promise.resolve({
            data: { files: [{ id: 'file-99', name: 'notes.txt', mimeType: 'text/plain', size: '12', modifiedTime: '2026-08-01T00:00:00Z' }] },
          });
        }
        return Promise.resolve({ data: { files: [] } });
      });
      mockDriveFiles.get.mockResolvedValue({ data: Buffer.from('hello world') });

      const result = await service.readSingleKnowledgeBaseFile(`gdrive:${ROOT}`, 'notes.txt', USER_ID);

      const nameSearchCall = mockDriveFiles.list.mock.calls.find(
        ([arg]: any) => arg.q.includes("name = 'notes.txt'")
      );
      expect(nameSearchCall).toBeDefined();
      expect(nameSearchCall![0].q).toContain(`'${SUB}' in parents`);

      expect(result.success).toBe(true);
      expect(result.content).toContain('hello world');
    });

    it('resolves a Drive shortcut and reads the target file content', async () => {
      mockDriveFiles.list.mockImplementation(({ q, fields }: { q: string; fields: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        if (q.includes("name = 'Quarterly plan'")) {
          expect(fields).toContain('shortcutDetails');
          return Promise.resolve({
            data: {
              files: [{
                id: 'shortcut-1',
                name: 'Quarterly plan',
                mimeType: 'application/vnd.google-apps.shortcut',
                shortcutDetails: {
                  targetId: 'target-doc-1',
                  targetMimeType: 'application/vnd.google-apps.document',
                },
                modifiedTime: '2026-08-01T00:00:00Z',
              }],
            },
          });
        }
        return Promise.resolve({ data: { files: [] } });
      });
      mockDriveFiles.get.mockResolvedValue({
        data: {
          id: 'target-doc-1',
          name: 'Quarterly plan target',
          mimeType: 'application/vnd.google-apps.document',
          size: '24',
          modifiedTime: '2026-08-02T00:00:00Z',
        },
      });
      mockDriveFiles.export.mockResolvedValue({ data: Buffer.from('shortcut target content') });
      mockDriveComments.list.mockResolvedValue({ data: { comments: [] } });

      const result = await service.readSingleKnowledgeBaseFile(
        `gdrive:${ROOT}`,
        'Quarterly plan',
        USER_ID
      );

      expect(mockDriveFiles.get).toHaveBeenCalledWith(expect.objectContaining({
        fileId: 'target-doc-1',
        fields: expect.stringContaining('mimeType'),
      }));
      expect(mockDriveFiles.export).toHaveBeenCalledWith(
        { fileId: 'target-doc-1', mimeType: 'text/plain' },
        expect.objectContaining({ responseType: 'stream' })
      );
      expect(result).toMatchObject({
        success: true,
        content: 'shortcut target content',
        size: 24,
        modifiedTime: '2026-08-02T00:00:00Z',
      });
    });

    it('names the sub-folder that needs sharing when it cannot be listed, instead of a bare "not found"', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
          return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
        }
        if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType')) {
          return Promise.reject(makeApiError(403, 'insufficientPermissions'));
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await service.readSingleKnowledgeBaseFile(`gdrive:${ROOT}`, 'notes.txt', USER_ID);

      expect(result.success).toBe(false);
      expect(result.message).toContain('4x5');
      expect(result.message).toMatch(/share/i);
    });

    /*
     * queryDriveFilesAcrossFolders no longer throws on a failed request — it merges what it
     * already has and reports `failed`/`capped` instead, so that a partial read is degraded to
     * incomplete rather than discarded. This caller destructured only `files` and so read that
     * empty map as a definitive absence: a timeout or 5xx on the NAME query produced
     * `File "X" not found in Google Drive folder "Y"`, a confident absence claim from a read
     * that errored. Before the helper caught the error, the rejection reached the outer try and
     * correctly said the read had failed.
     */
    it('does not claim the file is absent when the name query itself failed', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          return Promise.resolve({ data: { files: [] } });
        }
        // The name query — the one that would have found the file — times out.
        return Promise.reject(makeApiError(500, 'Drive did not respond within 8000ms'));
      });

      const result = await service.readSingleKnowledgeBaseFile(`gdrive:${ROOT}`, 'notes.txt', USER_ID);

      expect(result.success).toBe(false);
      expect(result.message).not.toMatch(/not found/i);
      expect(result.message).toMatch(/could not determine/i);
      expect(result.message).toMatch(/failed/i);
      // A request failure IS transient, so "retry" is the right remedy on THIS branch. Pinned
      // next to the capped test below so the two remedies cannot be collapsed back together.
      expect(result.message).toMatch(/retry the read/i);
    });

    /*
     * The CAPPED branch is not the failed branch, and telling the model to retry it was a
     * remedy that cannot work.
     *
     * `capped` with no `failed` can only mean queryDriveFilesAcrossFolders crossed
     * DRIVE_LIST_WALK_MAX_MS — a wall-clock bound spent on a folder tree whose size does not
     * change between attempts, and the SECOND such budget after the folder walk already spent
     * one. A tree large enough to exhaust it exhausts it again, in the same place, every time.
     * So "Retry the read." pointed the model at a deterministic non-answer, and each attempt
     * costs two more 15s budgets out of the turn.
     *
     * The time is advanced inside the NAME query specifically, so the folder walk finishes well
     * inside its own budget: this reproduces capped-without-failed, which is the only shape that
     * reaches the branch under test.
     */
    it('does not tell the model to retry when the name search ran out of its time budget', async () => {
      jest.useFakeTimers();
      try {
        mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
          if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
            return Promise.resolve({ data: { files: [] } });
          }
          // The name query returns a page and a cursor, but burns the whole budget doing it —
          // so the read stops at the bound rather than erroring.
          jest.advanceTimersByTime(WALK_BUDGET_MS + 5_000);
          return Promise.resolve({ data: { files: [], nextPageToken: 'page-2' } });
        });

        const result = await service.readSingleKnowledgeBaseFile(`gdrive:${ROOT}`, 'notes.txt', USER_ID);

        expect(result.success).toBe(false);
        // Still not an absence claim — that part was already right.
        expect(result.message).toMatch(/not a confirmed absence/i);
        // The defect: a retry instruction on a deterministic, non-transient stop.
        expect(result.message).not.toMatch(/retry the read/i);
        expect(result.message).toMatch(/do not retry this same call/i);
        // And a remedy that can actually change the outcome — a smaller search scope.
        expect(result.message).toMatch(/direct google drive link/i);
        expect(result.message).toMatch(/sub-folder/i);
      } finally {
        jest.useRealTimers();
      }
    });

    // ENG-1300: readGoogleDriveSharedFile's own catch (around the content-read
    // step, after the file is already found) previously flattened any coded
    // API error to a message-only result. This is the branch, not the
    // logic-driven "restricted sub-folder" message above (which never throws).
    it('ENG-1300: a coded error reading file content classifies as auth/config end-to-end', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
          return Promise.resolve({ data: { files: [] } });
        }
        if (q.includes("name = 'notes.txt'")) {
          return Promise.resolve({
            data: { files: [{ id: 'file-99', name: 'notes.txt', mimeType: 'text/plain', size: '12', modifiedTime: '2026-08-01T00:00:00Z' }] },
          });
        }
        return Promise.resolve({ data: { files: [] } });
      });
      mockDriveFiles.get.mockRejectedValue(makeApiError(403));

      const result = await service.readSingleKnowledgeBaseFile(`gdrive:${ROOT}`, 'notes.txt', USER_ID);
      expect(result.success).toBe(false);
      const classified = toolResultError(result);
      expect(classifyToolErrorClass(classified)).toBe('auth');
      expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
    });

    it('reports ambiguity instead of silently reading one candidate when the same name exists in two sub-folders', async () => {
      const SUB_A = 'ratio-4x5';
      const SUB_B = 'ratio-9x16';
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
          if (q.includes(`'${ROOT}' in parents`)) {
            return Promise.resolve({ data: { files: [{ id: SUB_A, name: '4x5' }, { id: SUB_B, name: '9x16' }] } });
          }
          return Promise.resolve({ data: { files: [] } });
        }
        if (q.includes("name = 'report.txt'")) {
          return Promise.resolve({
            data: {
              files: [
                { id: 'file-a', name: 'report.txt', mimeType: 'text/plain', size: '10', parents: [SUB_A] },
                { id: 'file-b', name: 'report.txt', mimeType: 'text/plain', size: '10', parents: [SUB_B] },
              ],
            },
          });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await service.readSingleKnowledgeBaseFile(`gdrive:${ROOT}`, 'report.txt', USER_ID);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/multiple/i);
      expect(result.message).toContain('4x5');
      expect(result.message).toContain('9x16');
    });
  });

  // ── searchKnowledgeBase — Google Drive sub-folder traversal (ENG-1624) ──────
  //
  // The failing production session actually called search_knowledge_base, which
  // still scoped queries to `'<folderId>' in parents` for each registered root
  // directly — the exact root-cause bug, live in the one call site the customer
  // hit first.

  describe('searchKnowledgeBase - Google Drive sub-folder traversal (ENG-1624)', () => {
    const { userDb } = require('../services/db');
    const ROOT = 'root-folder';
    const SUB = '4x5-subfolder';

    beforeEach(() => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: USER_ID,
        googleDriveFolders: [{ folderId: ROOT, name: '8-18-26 Insurance Angle Ads' }],
      });
    });

    it('spans sub-folder ids in the fullText search query, not just the registered root', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
          return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
        }
        if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType')) {
          return Promise.resolve({ data: { files: [] } });
        }
        if (q.includes('fullText contains')) {
          return Promise.resolve({ data: { files: [] } });
        }
        return Promise.resolve({ data: { files: [] } });
      });

      await service.searchKnowledgeBase('insurance ad copy', 5, USER_ID);

      const fullTextCall = mockDriveFiles.list.mock.calls.find(
        ([arg]: any) => arg.q.includes('fullText contains')
      );
      expect(fullTextCall).toBeDefined();
      expect(fullTextCall![0].q).toContain(`'${SUB}' in parents`);
      expect(fullTextCall![0].q).toContain(`'${ROOT}' in parents`);
    });

    it('reports an incomplete search — not an empty one — when a Drive request fails mid-read', async () => {
      /*
       * Regression guard. The per-request timeout can fire on a request the walk had not
       * abandoned (the loop-level deadline only stops NEW requests). If that throw escapes
       * queryDriveFilesAcrossFolders it reaches a caller that logs and continues, so every row
       * already merged is discarded and the answer presents an empty result as a COMPLETE
       * search — the ENG-1584 shape, caused by the guard against it. The helper must degrade
       * the read to incomplete instead of throwing it away.
       */
      let fullTextAttempts = 0;
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes('mimeType')) {
          // Tree walk succeeds, so there is a real tree to search.
          if (q.includes(`'${ROOT}' in parents`)) {
            return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
          }
          return Promise.resolve({ data: { files: [] } });
        }
        // The file query itself fails, the way an aborted request does.
        fullTextAttempts += 1;
        const err: any = new Error('The user aborted a request.');
        err.code = 'ECONNABORTED';
        return Promise.reject(err);
      });

      const result: any = await service.searchKnowledgeBase('iceberg', 5, USER_ID);

      expect(fullTextAttempts).toBeGreaterThan(0);
      // Named fields, not `JSON.stringify(result)` against a loose regex — the query string
      // itself, or any unrelated prose, could satisfy /incomplete|could not|partial/ without the
      // read ever having been reported as incomplete.
      expect(result.scanIncomplete).toBe(true);
      expect(result.message).toMatch(/not confirmed exhaustive/i);
    });

    /*
     * The other way this whole source can vanish: an exception BEFORE (or outside) the file
     * query — getGoogleDriveClient failing, or escapeDriveQueryValue refusing a non-string
     * query, whose throw lands in exactly this catch. It logged and continued without touching
     * driveScanIncomplete, so a search missing an entire source reported success and no caveat.
     */
    it('reports an incomplete search when the whole Drive source failed', async () => {
      mockDriveFiles.list.mockRejectedValue(makeApiError(500, 'Internal Error'));
      const secretsManager = require('../utils/secretsManager');
      secretsManager.getSecret = jest.fn().mockRejectedValue(new Error('Secrets Manager unavailable'));

      const result: any = await service.searchKnowledgeBase('iceberg', 5, USER_ID);

      expect(result.success).toBe(true);
      expect(result.scanIncomplete).toBe(true);
      expect(result.message).toMatch(/not confirmed exhaustive/i);
    });

    it('does not present Drive results as exhaustive when a sub-folder could not be scanned', async () => {
      mockDriveFiles.list.mockImplementation(({ q }: { q: string }) => {
        if (q.includes(`'${ROOT}' in parents`) && q.includes('mimeType')) {
          return Promise.resolve({ data: { files: [{ id: SUB, name: '4x5' }] } });
        }
        if (q.includes(`'${SUB}' in parents`) && q.includes('mimeType')) {
          return Promise.reject(makeApiError(403, 'insufficientPermissions'));
        }
        return Promise.resolve({ data: { files: [] } });
      });

      const result = await service.searchKnowledgeBase('insurance ad copy', 5, USER_ID);

      expect(result.scanIncomplete).toBe(true);
      expect(result.message).toMatch(/not confirmed exhaustive/i);
    });
  });

  // ── markdownToDocsRequests ─────────────────────────────────────────────────

  describe('markdownToDocsRequests', () => {
    const md2r = AgentModeService.markdownToDocsRequests.bind(AgentModeService);

    // ── Edge cases: empty / blank ────────────────────────────────────────────

    it('returns [] for empty string', () => {
      expect(md2r('')).toEqual([]);
    });

    it('returns [] for whitespace-only string', () => {
      expect(md2r('   \n\n  ')).toEqual([]);
    });

    // ── Plain text (no markdown) ─────────────────────────────────────────────

    it('plain text: emits only insertText, no style requests', () => {
      const reqs = md2r('Hello world');
      expect(reqs).toHaveLength(1);
      expect(reqs[0].insertText.text).toBe('Hello world\n');
    });

    // ── Headings ─────────────────────────────────────────────────────────────

    it('H1 emits updateParagraphStyle HEADING_1', () => {
      const reqs = md2r('# Title');
      const style = reqs.find(r => r.updateParagraphStyle);
      expect(style?.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_1');
    });

    it('H2 emits HEADING_2', () => {
      const reqs = md2r('## Section');
      const style = reqs.find(r => r.updateParagraphStyle);
      expect(style?.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_2');
    });

    it('H3 emits HEADING_3', () => {
      const reqs = md2r('### Sub');
      const style = reqs.find(r => r.updateParagraphStyle);
      expect(style?.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_3');
    });

    it('H4 is capped to HEADING_3', () => {
      const reqs = md2r('#### Deep');
      const style = reqs.find(r => r.updateParagraphStyle);
      expect(style?.updateParagraphStyle.paragraphStyle.namedStyleType).toBe('HEADING_3');
    });

    it('heading range startIndex = insertIndex (default 1)', () => {
      const reqs = md2r('# Title');
      const style = reqs.find(r => r.updateParagraphStyle);
      expect(style?.updateParagraphStyle.range.startIndex).toBe(1);
    });

    // ── Inline styles ─────────────────────────────────────────────────────────

    it('**bold** emits updateTextStyle with bold:true', () => {
      const reqs = md2r('Hello **world**');
      const boldReq = reqs.find(r => r.updateTextStyle?.textStyle?.bold === true);
      expect(boldReq).toBeDefined();
      expect(boldReq.updateTextStyle.fields).toContain('bold');
    });

    it('*italic* emits updateTextStyle with italic:true', () => {
      const reqs = md2r('Hello *world*');
      const italicReq = reqs.find(r => r.updateTextStyle?.textStyle?.italic === true);
      expect(italicReq).toBeDefined();
      expect(italicReq.updateTextStyle.fields).toContain('italic');
    });

    it('***bold+italic*** emits updateTextStyle with both bold and italic', () => {
      const reqs = md2r('***bold italic***');
      const both = reqs.find(
        r => r.updateTextStyle?.textStyle?.bold === true && r.updateTextStyle?.textStyle?.italic === true,
      );
      expect(both).toBeDefined();
    });

    it('`inline code` emits updateTextStyle with Courier New', () => {
      const reqs = md2r('Use `const x = 1`');
      const codeReq = reqs.find(
        r => r.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily === 'Courier New',
      );
      expect(codeReq).toBeDefined();
    });

    it('bold range startIndex matches offset after plain prefix', () => {
      // "Hello " = 6 chars, starts at index 1, bold starts at index 7
      const reqs = md2r('Hello **world**');
      const boldReq = reqs.find(r => r.updateTextStyle?.textStyle?.bold === true);
      expect(boldReq.updateTextStyle.range.startIndex).toBe(7); // 1 + len("Hello ")
      expect(boldReq.updateTextStyle.range.endIndex).toBe(12);  // 7 + len("world")
    });

    // ── Links ────────────────────────────────────────────────────────────────

    it('link renders as clickable hyperlink (text only in insertText, link style in updateTextStyle)', () => {
      const reqs = md2r('[Click here](https://example.com)');
      expect(reqs[0].insertText.text).toContain('Click here');
      expect(reqs[0].insertText.text).not.toContain('(https://example.com)');
      const linkStyle = reqs.find(r => r.updateTextStyle?.textStyle?.link);
      expect(linkStyle?.updateTextStyle.textStyle.link.url).toBe('https://example.com');
    });

    // ── Unordered list ───────────────────────────────────────────────────────

    it('unordered list emits createParagraphBullets with BULLET preset', () => {
      const reqs = md2r('- Apple\n- Banana\n- Cherry');
      const bullet = reqs.find(r => r.createParagraphBullets);
      expect(bullet?.createParagraphBullets.bulletPreset).toBe('BULLET_DISC_CIRCLE_SQUARE');
    });

    it('unordered list range covers all items', () => {
      const reqs = md2r('- A\n- B\n- C');
      const text = reqs[0].insertText.text; // "A\nB\nC\n"
      const bullet = reqs.find(r => r.createParagraphBullets);
      expect(bullet.createParagraphBullets.range.startIndex).toBe(1);
      // endIndex should be before the trailing \n of last item
      expect(bullet.createParagraphBullets.range.endIndex).toBe(1 + text.length - 1);
    });

    // ── Ordered list ─────────────────────────────────────────────────────────

    it('ordered list emits createParagraphBullets with NUMBERED preset', () => {
      const reqs = md2r('1. First\n2. Second');
      const bullet = reqs.find(r => r.createParagraphBullets);
      expect(bullet?.createParagraphBullets.bulletPreset).toBe('NUMBERED_DECIMAL_ALPHA_ROMAN_SEQUENCE');
    });

    // ── Nested list ───────────────────────────────────────────────────────────

    it('nested list item emits indent updateParagraphStyle', () => {
      const reqs = md2r('- Parent\n  - Child');
      const indentReq = reqs.find(
        r => r.updateParagraphStyle?.paragraphStyle?.indentStart?.magnitude === 36,
      );
      expect(indentReq).toBeDefined();
    });

    // ── Blockquote ───────────────────────────────────────────────────────────

    it('blockquote emits indent paragraph style', () => {
      const reqs = md2r('> A quote');
      const indent = reqs.find(r => r.updateParagraphStyle?.paragraphStyle?.indentStart);
      expect(indent?.updateParagraphStyle.paragraphStyle.indentStart.magnitude).toBe(36);
    });

    it('blockquote emits italic text style', () => {
      const reqs = md2r('> A quote');
      const italic = reqs.find(r => r.updateTextStyle?.textStyle?.italic === true);
      expect(italic).toBeDefined();
    });

    // ── Code block ───────────────────────────────────────────────────────────

    it('fenced code block emits Courier New text style per line', () => {
      const reqs = md2r('    const x = 1;');
      const mono = reqs.find(
        r => r.updateTextStyle?.textStyle?.weightedFontFamily?.fontFamily === 'Courier New',
      );
      expect(mono).toBeDefined();
    });

    // ── Table ────────────────────────────────────────────────────────────────

    it('table header row is inserted as bold text', () => {
      const reqs = md2r('| Col1 | Col2 |\n|------|------|\n| A    | B    |');
      const headerBold = reqs.find(r => r.updateTextStyle?.textStyle?.bold === true);
      expect(headerBold).toBeDefined();
      expect(reqs[0].insertText.text).toContain('Col1 | Col2');
    });

    it('table data row is included in plain text', () => {
      const reqs = md2r('| Col1 | Col2 |\n|------|------|\n| A    | B    |');
      expect(reqs[0].insertText.text).toContain('A | B');
    });

    // ── HR ───────────────────────────────────────────────────────────────────

    it('HR emits em-dash line as text', () => {
      const reqs = md2r('---');
      expect(reqs[0].insertText.text).toContain('─');
    });

    // ── Leading/trailing blank lines stripped ────────────────────────────────

    it('leading blank lines do not shift heading to wrong index', () => {
      const withBlanks = md2r('\n\n# Title');
      const withoutBlanks = md2r('# Title');
      const styleWith = withBlanks.find(r => r.updateParagraphStyle);
      const styleWithout = withoutBlanks.find(r => r.updateParagraphStyle);
      // Same heading startIndex — blanks stripped
      expect(styleWith?.updateParagraphStyle.range.startIndex).toBe(
        styleWithout?.updateParagraphStyle.range.startIndex,
      );
    });

    // ── Custom insertIndex ────────────────────────────────────────────────────

    it('custom insertIndex shifts all positions', () => {
      const reqs = md2r('# Title', 10);
      expect(reqs[0].insertText.location.index).toBe(10);
      const style = reqs.find(r => r.updateParagraphStyle);
      expect(style?.updateParagraphStyle.range.startIndex).toBe(10);
    });

    // ── Mixed document ────────────────────────────────────────────────────────

    it('mixed document: insertText is always first request', () => {
      const reqs = md2r('# Title\n\nSome **bold** text\n\n- item 1\n- item 2');
      expect(reqs[0]).toHaveProperty('insertText');
    });

    it('mixed document: produces heading + bold + bullet requests', () => {
      const reqs = md2r('# Title\n\nSome **bold** text\n\n- item 1\n- item 2');
      const hasHeading = reqs.some(r => r.updateParagraphStyle?.paragraphStyle?.namedStyleType === 'HEADING_1');
      const hasBold = reqs.some(r => r.updateTextStyle?.textStyle?.bold === true);
      const hasBullet = reqs.some(r => r.createParagraphBullets);
      expect(hasHeading).toBe(true);
      expect(hasBold).toBe(true);
      expect(hasBullet).toBe(true);
    });
  });

  // ── createGoogleDoc / updateGoogleDoc integration ─────────────────────────

  describe('createGoogleDoc - markdown formatting integration', () => {
    beforeEach(() => {
      const { getAccountByPlatform } = require('../services/connectedAccountsDb');
      getAccountByPlatform.mockResolvedValue(FAKE_ACCOUNT);

      mockDriveFiles.create.mockResolvedValue({
        data: { id: 'new-doc-id', webViewLink: 'https://docs.google.com/document/d/new-doc-id/edit' },
      });
    });

    it('uploads HTML with <h1> tag for markdown heading, styled mode has inline styles', async () => {
      await service.createGoogleDoc('My Doc', '# Hello\n\nWorld', USER_ID, undefined, undefined, 'styled');
      const html = mockDriveFiles.create.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<h1 style=');
      expect(html).toContain('>Hello</h1>');
      expect(html).toContain('>World</p>');
    });

    it('uploads HTML with <strong> tag for **bold** text', async () => {
      await service.createGoogleDoc('My Doc', 'Some **bold** text', USER_ID);
      const html = mockDriveFiles.create.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<strong>bold</strong>');
    });

    it('uploads HTML with <ul><li> for unordered list', async () => {
      await service.createGoogleDoc('My Doc', '- Apple\n- Banana', USER_ID);
      const html = mockDriveFiles.create.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<ul');
      expect(html).toContain('>Apple');
    });

    it('uploads HTML with <table> for markdown table', async () => {
      await service.createGoogleDoc('My Doc', '| A | B |\n|---|---|\n| 1 | 2 |', USER_ID);
      const html = mockDriveFiles.create.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<table');
      expect(html).toContain('<th');
      expect(html).toContain('>1</td>');
    });

    it('uploads HTML with <a href> for markdown link', async () => {
      await service.createGoogleDoc('My Doc', '[Click here](https://example.com)', USER_ID);
      const html = mockDriveFiles.create.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<a href="https://example.com">Click here</a>');
    });

    it('omits media entirely when content is empty', async () => {
      await service.createGoogleDoc('My Doc', '', USER_ID);
      const call = mockDriveFiles.create.mock.calls[0][0];
      expect(call.media).toBeUndefined();
    });
  });

  describe('updateGoogleDoc - markdown formatting integration', () => {
    beforeEach(() => {
      const { getAccountByPlatform } = require('../services/connectedAccountsDb');
      getAccountByPlatform.mockResolvedValue(FAKE_ACCOUNT);
      mockDriveFiles.update.mockResolvedValue({ data: {} });
    });

    it('calls drive.files.update with HTML media', async () => {
      await service.updateGoogleDoc('doc-id', '# New heading', USER_ID);
      expect(mockDriveFiles.update).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'doc-id',
          media: expect.objectContaining({ mimeType: 'text/html' }),
        }),
      );
    });

    it('HTML contains <h2> for ## heading', async () => {
      await service.updateGoogleDoc('doc-id', '## Section', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('>Section</h2>');
    });

    it('skips drive.files.update when content is empty', async () => {
      await service.updateGoogleDoc('doc-id', '', USER_ID);
      expect(mockDriveFiles.update).not.toHaveBeenCalled();
    });
  });

  describe('inline style span — [text]{attr=value;flag;...}', () => {
    it('renders a named color as a <span> around just that text', async () => {
      await service.updateGoogleDoc('doc-id', '[Emma tested works]{color=blue} and the rest is untouched', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="color:blue">Emma tested works</span>');
      expect(html).toContain('and the rest is untouched');
    });

    it('renders a hex color', async () => {
      await service.updateGoogleDoc('doc-id', '[alert text]{color=#ff0000}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="color:#ff0000">alert text</span>');
    });

    it('does not match and falls through to escaped literal text when the color value is empty', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{color=}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).not.toContain('<span');
      expect(html).toContain('[text]{color=}');
    });

    it('does not match and falls through to escaped literal text when malformed (missing closing brace)', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{color=blue', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).not.toContain('<span');
      expect(html).toContain('[text]{color=blue');
    });

    it('rejects CSS/attribute injection attempts in the color value — only hex or plain color-name characters match', async () => {
      await service.updateGoogleDoc(
        'doc-id',
        '[text]{color=red" onmouseover="alert(1)}',
        USER_ID,
      );
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      // The malformed value must not match the color-span pattern at all — it should
      // fall through to plain escaped text, not produce a real <span> with a broken-out attribute.
      expect(html).not.toContain('<span');
      expect(html).toContain('&quot; onmouseover=&quot;');
    });

    it('works inside a heading — colors just the heading text, the <h1> tag itself already provides big+bold', async () => {
      // Real user scenario: "make the heading 'test 2' big, bold, and blue" — big/bold come
      // from the heading tag itself; only the color needs the inline span, and it must not
      // recolor the document-wide heading accent (style_options.primary_color) to do it.
      await service.updateGoogleDoc('doc-id', '# [test 2]{color=blue}\n\nRest of the doc unaffected.', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<h1><span style="color:blue">test 2</span></h1>');
    });

    it('renders an underline flag alone', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{underline}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="text-decoration:underline">text</span>');
    });

    it('renders an italic flag alone', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{italic}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="font-style:italic">text</span>');
    });

    it('renders a bold flag alone', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{bold}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="font-weight:700">text</span>');
    });

    it('renders a font-family attribute alone', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{font=Verdana}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="font-family:Verdana">text</span>');
    });

    it('combines color, font, italic, and underline in one span — the real "italic, underline, Verdana, yellow" ask', async () => {
      await service.updateGoogleDoc(
        'doc-id',
        '[Phase 1: Legal Document Updates]{color=yellow;font=Verdana;italic;underline}',
        USER_ID,
      );
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain(
        '<span style="color:yellow;font-family:Verdana;font-style:italic;text-decoration:underline">Phase 1: Legal Document Updates</span>',
      );
    });

    it('silently ignores an unrecognized attribute name while still applying the valid ones in the same span', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{font=Verdana;bogus=xyz}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="font-family:Verdana">text</span>');
      expect(html).not.toContain('bogus');
    });

    it('falls through to escaped literal text when no attribute in the braces is recognized at all', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{bogus=xyz}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).not.toContain('<span');
      expect(html).toContain('[text]{bogus=xyz}');
    });

    it('rejects a font-value injection attempt using only otherwise-allowed characters', async () => {
      await service.updateGoogleDoc('doc-id', '[text]{font=Verdana;javascript=alert}', USER_ID);
      const html = mockDriveFiles.update.mock.calls[0][0].media?.body as string;
      expect(html).toContain('<span style="font-family:Verdana">text</span>');
      expect(html).not.toContain('javascript=alert');
    });
  });

  /*
   * ENG-1584's sentence, on the search edge.
   *
   * `Found N item(s) matching "x"` off a hard `pageSize: 20`, with `nextPageToken` not even
   * requested, reads as "these are all the matches" and means "these are the first 20". A model
   * that searches for a file, does not see it, and reports it absent is the exact failure that
   * told a customer a protected ad did not exist. The sibling `listGoogleDriveFolder` already
   * reported `hasMore`; this read did not.
   *
   * The 20-item bound is deliberate and stays — a name search is a lookup, not an inventory.
   * Going UNANNOUNCED was the defect.
   */
  describe('searchGoogleDrive announces an incomplete result', () => {
    const driveFile = (id: string, name: string) => ({
      id, name, mimeType: 'application/pdf', webViewLink: `https://drive/${id}`, parents: ['p1'],
    });

    it('requests nextPageToken at all — without it the cap is unknowable', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [driveFile('f1', 'Report.pdf')] } });

      await service.searchGoogleDrive('Report', USER_ID);

      expect(mockDriveFiles.list.mock.calls[0][0].fields).toContain('nextPageToken');
    });

    it('labels a full page with more behind it as INCOMPLETE, not as a count', async () => {
      mockDriveFiles.list.mockResolvedValue({
        data: { files: [driveFile('f1', 'Report.pdf')], nextPageToken: 'more' },
      });

      const result = await service.searchGoogleDrive('Report', USER_ID);

      expect(result.complete).toBe(false);
      expect(result.hasMore).toBe(true);
      expect(result.message).toMatch(/INCOMPLETE/);
      expect(result.message).toMatch(/Do NOT conclude a file is absent/i);
      // Completeness ahead of the payload — see the field-order rationale above.
      const serialized = JSON.stringify(result);
      expect(serialized.indexOf('"complete"')).toBeLessThan(serialized.indexOf('"results"'));
    });

    it('says "complete list" only when Drive returned no continuation token', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [driveFile('f1', 'Report.pdf')] } });

      const result = await service.searchGoogleDrive('Report', USER_ID);

      expect(result.complete).toBe(true);
      expect(result.hasMore).toBeUndefined();
      expect(result.message).toContain('(complete list)');
      expect(result.message).not.toMatch(/INCOMPLETE/);
    });

    it('an EMPTY first page with more behind it is not evidence of absence', async () => {
      // The most dangerous shape: zero rows plus a continuation token. "No items found" here
      // is the absence claim itself.
      mockDriveFiles.list.mockResolvedValue({ data: { files: [], nextPageToken: 'more' } });

      const result = await service.searchGoogleDrive('Missing', USER_ID);

      expect(result.complete).toBe(false);
      expect(result.message).toMatch(/MORE PAGES EXIST/);
      expect(result.message).toMatch(/not evidence that nothing matches/i);
    });

    it('a genuinely empty search still reports a clean, complete absence', async () => {
      mockDriveFiles.list.mockResolvedValue({ data: { files: [] } });

      const result = await service.searchGoogleDrive('Missing', USER_ID);

      expect(result.complete).toBe(true);
      expect(result.message).toContain('(complete search)');
    });
  });
});
