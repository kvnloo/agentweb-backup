import { AgentModeService } from '../services/agentModeService';

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

function makeApiError(code: number, message = 'API error') {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AgentModeService - Google Drive methods', () => {
  let service: AgentModeService;
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
      expect(result.message).toMatch(/Cannot list this folder/i);
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
});
