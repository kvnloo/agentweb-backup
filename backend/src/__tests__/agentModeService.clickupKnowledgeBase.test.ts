import { AgentModeService } from '../services/agentModeService';

// Mock dependencies
jest.mock('@google-cloud/storage');
jest.mock('../utils/secretsManager');
jest.mock('axios');

// Mock chatbotService to prevent Vertex AI connections
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

// Mock clickupService — the shared ClickUp API layer
const mockGetAccessToken = jest.fn();
const mockGetWorkspaces = jest.fn();
const mockListDocs = jest.fn();
const mockReadDocContent = jest.fn();
jest.mock('../services/clickupService', () => ({
  getAccessToken: (...args: any[]) => mockGetAccessToken(...args),
  getWorkspaces: (...args: any[]) => mockGetWorkspaces(...args),
  listDocs: (...args: any[]) => mockListDocs(...args),
  readDocContent: (...args: any[]) => mockReadDocContent(...args),
}));

// Mock userDb (needed by getUserGoogleDriveFolders in listKnowledgeBaseFiles)
const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateUser: jest.fn(),
  },
  taskDb: {
    getTasksWithKnowledgeBase: jest.fn().mockResolvedValue([]),
    getAllPublicKnowledgeBaseTasks: jest.fn().mockResolvedValue([]),
    getTaskById: jest.fn(),
  },
}));

jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn(),
  decryptPassword: jest.fn(),
}));

describe('AgentModeService - ClickUp Knowledge Base', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    await agentModeService.initialize();

    // Default: user has no Google Drive folders
    mockGetUserById.mockResolvedValue({ userId: 'user-123', googleDriveFolders: [] });
  });

  describe('readClickUpSharedDoc', () => {
    it('should return error when ClickUp is not connected', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', 'My Doc', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('ClickUp not connected');
    });

    it('should return error when workspace is not accessible', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-other', name: 'Other' }]);

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', 'My Doc', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('Not authorized to access this ClickUp workspace');
    });

    it('should return error when document not found in workspace', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'Other Doc', dateCreated: '1000', dateUpdated: '2000' },
      ]);

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', 'Missing Doc', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found in ClickUp workspace');
    });

    it('should successfully read a ClickUp document', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'My Doc', dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadDocContent.mockResolvedValue('# Page 1\n\nDocument content here.');

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', 'My Doc', 'user-123');
      expect(result.success).toBe(true);
      expect(result.kb_identifier).toBe('clickup:ws-1');
      expect(result.file_name).toBe('My Doc');
      expect(result.name).toBe('Test Workspace');
      expect(result.content).toContain('Document content here.');
      expect(result.type).toBe('clickup');
    });

    it('should truncate content exceeding 50000 characters', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'WS' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'Large Doc', dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadDocContent.mockResolvedValue('x'.repeat(60000));

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', 'Large Doc', 'user-123');
      expect(result.success).toBe(true);
      expect(result.content).toContain('[Content truncated due to size limit]');
      expect(result.content.length).toBeLessThan(60000);
    });

    it('should handle API errors gracefully', async () => {
      mockGetAccessToken.mockRejectedValue(new Error('API Error'));

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', 'My Doc', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to read ClickUp document');
    });
  });

  describe('readSingleKnowledgeBaseFile - ClickUp routing', () => {
    it('should route clickup: identifiers to readClickUpSharedDoc', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const result = await (agentModeService as any).readSingleKnowledgeBaseFile('clickup:ws-1', 'My Doc', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('ClickUp not connected');
    });
  });

  describe('listKnowledgeBaseFiles - ClickUp integration', () => {
    it('should include ClickUp docs in knowledge base listing', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'Product Spec', dateCreated: '1000', dateUpdated: '2000' },
        { id: 'doc-2', name: 'Meeting Notes', dateCreated: '3000', dateUpdated: '4000' },
      ]);

      const { taskDb } = require('../services/db');
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
      taskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      expect(result.success).toBe(true);

      const clickUpKb = result.knowledge_bases.find((kb: any) => kb.type === 'clickup');
      expect(clickUpKb).toBeDefined();
      expect(clickUpKb.identifier).toBe('clickup:ws-1');
      expect(clickUpKb.name).toBe('ClickUp - My Workspace');
      expect(clickUpKb.files).toHaveLength(2);
      expect(clickUpKb.files[0].fileName).toBe('Product Spec');
      expect(clickUpKb.files[0].docId).toBe('doc-1');
      expect(clickUpKb.files[1].fileName).toBe('Meeting Notes');
    });

    it('should not include ClickUp when user has no token', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const { taskDb } = require('../services/db');
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
      taskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      expect(result.success).toBe(true);

      const clickUpKb = result.knowledge_bases?.find((kb: any) => kb.type === 'clickup');
      expect(clickUpKb).toBeUndefined();
    });

    it('should handle ClickUp API errors without failing the whole listing', async () => {
      mockGetAccessToken.mockRejectedValue(new Error('ClickUp API error'));

      const { taskDb } = require('../services/db');
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
      taskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      expect(result.success).toBe(true);
    });
  });

  describe('searchKnowledgeBase - ClickUp integration', () => {
    it('should include ClickUp docs matching by name', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'Product Roadmap', dateCreated: '1000', dateUpdated: '2000' },
        { id: 'doc-2', name: 'Meeting Notes', dateCreated: '3000', dateUpdated: '4000' },
      ]);
      mockReadDocContent
        .mockResolvedValueOnce('# Roadmap\n\nQ1 goals: Launch feature X.')
        .mockResolvedValueOnce('Notes from last meeting.');

      const result = await (agentModeService as any).searchKnowledgeBase('roadmap', 5, 'user-123');
      expect(result.success).toBe(true);

      const clickUpResults = result.results.filter((r: any) => r.source.startsWith('clickup/'));
      expect(clickUpResults).toHaveLength(1);
      expect(clickUpResults[0].source).toBe('clickup/My Workspace/Product Roadmap');
      expect(clickUpResults[0].content).toContain('Q1 goals');
    });

    it('should include ClickUp docs matching by content', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'Q2 Plan', dateCreated: '1000', dateUpdated: '2000' },
        { id: 'doc-2', name: 'Meeting Notes', dateCreated: '3000', dateUpdated: '4000' },
      ]);
      mockReadDocContent
        .mockResolvedValueOnce('Improve customer engagement through targeted campaigns.')
        .mockResolvedValueOnce('Discussed office supplies.');

      const result = await (agentModeService as any).searchKnowledgeBase('customer engagement', 5, 'user-123');
      expect(result.success).toBe(true);

      const clickUpResults = result.results.filter((r: any) => r.source.startsWith('clickup/'));
      expect(clickUpResults).toHaveLength(1);
      expect(clickUpResults[0].source).toBe('clickup/My Workspace/Q2 Plan');
      expect(clickUpResults[0].content).toContain('customer engagement');
    });

    it('should not search ClickUp when user has no token', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const result = await (agentModeService as any).searchKnowledgeBase('test', 5, 'user-123');
      expect(result.success).toBe(true);
      expect(mockGetWorkspaces).not.toHaveBeenCalled();
    });

    it('should handle ClickUp search errors without failing the whole search', async () => {
      mockGetAccessToken.mockRejectedValue(new Error('ClickUp API error'));

      const result = await (agentModeService as any).searchKnowledgeBase('test', 5, 'user-123');
      expect(result.success).toBe(true);
    });

    it('should perform case-insensitive matching for search', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'WS' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'PRODUCT SPEC', dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadDocContent.mockResolvedValue('Product specification.');

      const result = await (agentModeService as any).searchKnowledgeBase('product', 5, 'user-123');
      expect(result.success).toBe(true);
      const clickUpResult = result.results.find((r: any) => r.source.startsWith('clickup/'));
      expect(clickUpResult).toBeDefined();
    });

    it('should truncate search results to 5000 characters', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'WS' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'Big Doc', dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadDocContent.mockResolvedValue('big ' + 'x'.repeat(10000));

      const result = await (agentModeService as any).searchKnowledgeBase('big', 5, 'user-123');
      const clickUpResult = result.results.find((r: any) => r.source.startsWith('clickup/'));
      expect(clickUpResult).toBeDefined();
      expect(clickUpResult.content).toContain('[Content truncated]');
      expect(clickUpResult.content.length).toBeLessThan(10000);
    });
  });
});
