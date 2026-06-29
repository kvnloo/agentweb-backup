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
  get: jest.fn(),
  export: jest.fn(),
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

    it('inserts content via batchUpdate', async () => {
      await service.createGoogleDoc('Test Doc', 'Hello world', USER_ID);
      expect(mockDocuments.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: 'doc-id-1',
          requestBody: {
            requests: [{ insertText: { location: { index: 1 }, text: 'Hello world' } }],
          },
        })
      );
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
  });

  // ────────────────────────────────────────────────────────────────────────────
  // updateGoogleDoc
  // ────────────────────────────────────────────────────────────────────────────

  describe('updateGoogleDoc', () => {
    beforeEach(() => {
      mockDocuments.get.mockResolvedValue({
        data: {
          body: {
            content: [
              { startIndex: 0, endIndex: 1 },
              { startIndex: 1, endIndex: 20 },
            ],
          },
        },
      });
      mockDocuments.batchUpdate.mockResolvedValue({ data: {} });
    });

    it('extracts file ID from a Google Doc URL', async () => {
      const url = 'https://docs.google.com/document/d/file-id-abc/edit';
      await service.updateGoogleDoc(url, 'New content', USER_ID);
      expect(mockDocuments.get).toHaveBeenCalledWith({ documentId: 'file-id-abc' });
      expect(mockDocuments.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'file-id-abc' })
      );
    });

    it('deletes existing content then inserts new content', async () => {
      await service.updateGoogleDoc('file-id-plain', 'New content', USER_ID);
      const call = mockDocuments.batchUpdate.mock.calls[0][0];
      const requests: any[] = call.requestBody.requests;
      // Should have a deleteContentRange followed by an insertText
      expect(requests.some((r: any) => r.deleteContentRange)).toBe(true);
      expect(requests.some((r: any) => r.insertText)).toBe(true);
    });

    it('returns friendly 403 message', async () => {
      mockDocuments.get.mockRejectedValue(makeApiError(403));
      const result = await service.updateGoogleDoc('file-id', 'content', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Cannot update this Google Doc/i);
    });

    it('returns friendly 404 message', async () => {
      mockDocuments.get.mockRejectedValue(makeApiError(404));
      const result = await service.updateGoogleDoc('file-id', 'content', USER_ID);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Google Doc not found/i);
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
});
