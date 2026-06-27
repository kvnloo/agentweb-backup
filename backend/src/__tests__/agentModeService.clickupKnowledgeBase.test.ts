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
const mockListTasks = jest.fn();
const mockReadTaskContent = jest.fn();
const mockCreateDoc = jest.fn();
const mockCreatePageInDoc = jest.fn();
const mockListSpaces = jest.fn();
const mockListFolders = jest.fn();
jest.mock('../services/clickupService', () => ({
  getAccessToken: (...args: any[]) => mockGetAccessToken(...args),
  getWorkspaces: (...args: any[]) => mockGetWorkspaces(...args),
  listDocs: (...args: any[]) => mockListDocs(...args),
  readDocContent: (...args: any[]) => mockReadDocContent(...args),
  listTasks: (...args: any[]) => mockListTasks(...args),
  readTaskContent: (...args: any[]) => mockReadTaskContent(...args),
  createDoc: (...args: any[]) => mockCreateDoc(...args),
  createPageInDoc: (...args: any[]) => mockCreatePageInDoc(...args),
  listSpaces: (...args: any[]) => mockListSpaces(...args),
  listFolders: (...args: any[]) => mockListFolders(...args),
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

    it('should read a fresh ClickUp document by doc id when the workspace listing is stale', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-old', name: 'Older Doc', dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadDocContent.mockResolvedValue('# Fresh Page\n\nNewly created content.');

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', '8cfrabr-76254', 'user-123');
      expect(result.success).toBe(true);
      expect(result.file_name).toBe('8cfrabr-76254');
      expect(result.content).toContain('Newly created content');
      expect(mockReadDocContent).toHaveBeenCalledWith('ck_token', 'ws-1', '8cfrabr-76254');
    });

    it('should read a fresh ClickUp document from a shared doc URL when the workspace listing is stale', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockListDocs.mockResolvedValue([]);
      mockReadDocContent.mockResolvedValue('# URL Page\n\nContent from URL doc.');

      const result = await (agentModeService as any).readClickUpSharedDoc(
        'clickup:ws-1',
        'https://doc.clickup.com/9009113464/d/h/8cfrabr-76254/84b3cd814509bfe',
        'user-123'
      );

      expect(result.success).toBe(true);
      expect(result.content).toContain('Content from URL doc');
      expect(mockReadDocContent).toHaveBeenCalledWith('ck_token', 'ws-1', '8cfrabr-76254');
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

    it('should truncate content exceeding 1MB', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'WS' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-1', name: 'Large Doc', dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadDocContent.mockResolvedValue('x'.repeat(1100000));

      const result = await (agentModeService as any).readClickUpSharedDoc('clickup:ws-1', 'Large Doc', 'user-123');
      expect(result.success).toBe(true);
      expect(result.content).toContain('[Content truncated due to size limit]');
      expect(result.content.length).toBeLessThan(1100000);
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

    it('should read ClickUp docs using explicit doc_id from read_knowledge_base_files entries', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockListDocs.mockResolvedValue([
        { id: 'doc-old', name: 'Older Doc', dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadDocContent.mockResolvedValue('# Explicit ID\n\nContent from explicit id.');

      const result = await (agentModeService as any).readKnowledgeBaseFiles([
        { kb_identifier: 'clickup:ws-1', file_name: 'Fresh Customer Doc', doc_id: '8cfrabr-76254' },
      ], 'user-123');

      expect(result.success).toBe(true);
      expect(result.files[0].success).toBe(true);
      expect(result.files[0].content).toContain('Content from explicit id');
      expect(mockReadDocContent).toHaveBeenCalledWith('ck_token', 'ws-1', '8cfrabr-76254');
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

  // ============================================
  // ClickUp Tasks integration tests
  // ============================================

  describe('readClickUpTask', () => {
    it('should return error when ClickUp is not connected', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const result = await (agentModeService as any).readClickUpTask('clickup-tasks:ws-1', 'My Task', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('ClickUp not connected');
    });

    it('should return error when workspace is not accessible', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-other', name: 'Other' }]);

      const result = await (agentModeService as any).readClickUpTask('clickup-tasks:ws-1', 'My Task', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('Not authorized to access this ClickUp workspace');
    });

    it('should return error when task not found in workspace', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockListTasks.mockResolvedValue([
        { id: 'task-1', name: 'Other Task', description: '', status: 'open', assignees: [], dueDate: null, tags: [], priority: null, attachments: [], dateCreated: '1000', dateUpdated: '2000' },
      ]);

      const result = await (agentModeService as any).readClickUpTask('clickup-tasks:ws-1', 'Missing Task', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found in ClickUp workspace');
    });

    it('should successfully read a ClickUp task', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockListTasks.mockResolvedValue([
        { id: 'task-1', name: 'Build Feature', description: 'Build it', status: 'in progress', assignees: ['alice'], dueDate: '1700000000000', tags: ['frontend'], priority: 'high', attachments: [{ id: 'att-1', title: 'spec.pdf', url: 'https://att.url/spec.pdf', size: 1234 }], dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadTaskContent.mockResolvedValue('# Build Feature\n\n**Status:** in progress\n\n## Description\n\nBuild it');

      const result = await (agentModeService as any).readClickUpTask('clickup-tasks:ws-1', 'Build Feature', 'user-123');
      expect(result.success).toBe(true);
      expect(result.kb_identifier).toBe('clickup-tasks:ws-1');
      expect(result.file_name).toBe('Build Feature');
      expect(result.name).toBe('Test Workspace');
      expect(result.content).toContain('Build Feature');
      expect(result.type).toBe('clickup-tasks');
    });

    it('should truncate content exceeding 1MB', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'WS' }]);
      mockListTasks.mockResolvedValue([
        { id: 'task-1', name: 'Large Task', description: '', status: 'open', assignees: [], dueDate: null, tags: [], priority: null, attachments: [], dateCreated: '1000', dateUpdated: '2000' },
      ]);
      mockReadTaskContent.mockResolvedValue('x'.repeat(1100000));

      const result = await (agentModeService as any).readClickUpTask('clickup-tasks:ws-1', 'Large Task', 'user-123');
      expect(result.success).toBe(true);
      expect(result.content).toContain('[Content truncated due to size limit]');
      expect(result.content.length).toBeLessThan(1100000);
    });

    it('should handle API errors gracefully', async () => {
      mockGetAccessToken.mockRejectedValue(new Error('API Error'));

      const result = await (agentModeService as any).readClickUpTask('clickup-tasks:ws-1', 'My Task', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to read ClickUp task');
    });
  });

  describe('readSingleKnowledgeBaseFile - ClickUp tasks routing', () => {
    it('should route clickup-tasks: identifiers to readClickUpTask', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const result = await (agentModeService as any).readSingleKnowledgeBaseFile('clickup-tasks:ws-1', 'My Task', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('ClickUp not connected');
    });
  });

  describe('listKnowledgeBaseFiles - ClickUp tasks integration', () => {
    it('should include ClickUp tasks in knowledge base listing', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([]);
      mockListTasks.mockResolvedValue([
        { id: 'task-1', name: 'Build Feature', description: 'Build it', status: 'in progress', assignees: ['alice'], dueDate: '1700000000000', tags: ['frontend'], priority: 'high', attachments: [], dateCreated: '1000', dateUpdated: '2000' },
        { id: 'task-2', name: 'Fix Bug', description: '', status: 'open', assignees: [], dueDate: null, tags: [], priority: null, attachments: [], dateCreated: '3000', dateUpdated: '4000' },
      ]);

      const { taskDb } = require('../services/db');
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
      taskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      expect(result.success).toBe(true);

      const tasksKb = result.knowledge_bases.find((kb: any) => kb.type === 'clickup-tasks');
      expect(tasksKb).toBeDefined();
      expect(tasksKb.identifier).toBe('clickup-tasks:ws-1');
      expect(tasksKb.name).toBe('ClickUp Tasks - My Workspace');
      expect(tasksKb.files).toHaveLength(2);
      expect(tasksKb.files[0].fileName).toBe('Build Feature');
      expect(tasksKb.files[0].taskId).toBe('task-1');
      expect(tasksKb.files[0].status).toBe('in progress');
      expect(tasksKb.files[0].priority).toBe('high');
      expect(tasksKb.files[1].fileName).toBe('Fix Bug');
    });

    it('should not include ClickUp tasks when user has no token', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const { taskDb } = require('../services/db');
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
      taskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      expect(result.success).toBe(true);

      const tasksKb = result.knowledge_bases?.find((kb: any) => kb.type === 'clickup-tasks');
      expect(tasksKb).toBeUndefined();
    });
  });

  describe('searchKnowledgeBase - ClickUp tasks integration', () => {
    it('should include ClickUp tasks matching by name', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([]);
      mockListTasks.mockResolvedValue([
        { id: 'task-1', name: 'Fix Login Bug', description: 'Users cannot log in with SSO', status: 'open', assignees: [], dueDate: null, tags: [], priority: 'urgent', attachments: [], dateCreated: '1000', dateUpdated: '2000' },
        { id: 'task-2', name: 'Add Feature', description: 'New dashboard feature', status: 'done', assignees: [], dueDate: null, tags: [], priority: null, attachments: [], dateCreated: '3000', dateUpdated: '4000' },
      ]);
      // No docs to read
      mockReadDocContent.mockResolvedValue('');

      const result = await (agentModeService as any).searchKnowledgeBase('login', 5, 'user-123');
      expect(result.success).toBe(true);

      const taskResults = result.results.filter((r: any) => r.source.startsWith('clickup-tasks/'));
      expect(taskResults).toHaveLength(1);
      expect(taskResults[0].source).toBe('clickup-tasks/My Workspace/Fix Login Bug');
      expect(taskResults[0].content).toContain('Fix Login Bug');
    });

    it('should include ClickUp tasks matching by description', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([]);
      mockListTasks.mockResolvedValue([
        { id: 'task-1', name: 'Improve UX', description: 'Enhance the customer onboarding flow', status: 'open', assignees: [], dueDate: null, tags: [], priority: null, attachments: [], dateCreated: '1000', dateUpdated: '2000' },
        { id: 'task-2', name: 'Other Task', description: 'Something else', status: 'done', assignees: [], dueDate: null, tags: [], priority: null, attachments: [], dateCreated: '3000', dateUpdated: '4000' },
      ]);
      mockReadDocContent.mockResolvedValue('');

      const result = await (agentModeService as any).searchKnowledgeBase('onboarding', 5, 'user-123');
      expect(result.success).toBe(true);

      const taskResults = result.results.filter((r: any) => r.source.startsWith('clickup-tasks/'));
      expect(taskResults).toHaveLength(1);
      expect(taskResults[0].source).toBe('clickup-tasks/My Workspace/Improve UX');
    });

    it('should handle ClickUp tasks search errors without failing the whole search', async () => {
      // First call for docs succeeds, tasks will use same token
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'WS' }]);
      mockListDocs.mockResolvedValue([]);
      mockListTasks.mockRejectedValue(new Error('Tasks API error'));

      const result = await (agentModeService as any).searchKnowledgeBase('test', 5, 'user-123');
      expect(result.success).toBe(true);
    });
  });

  // ============================================
  // writeClickUpDoc tests
  // ============================================

  describe('writeClickUpDoc', () => {
    it('should return error when ClickUp is not connected', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      const result = await (agentModeService as any).writeClickUpDoc('ws-1', 'New Doc', '# Content', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('ClickUp not connected');
    });

    it('should return error when workspace is not accessible', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-other', name: 'Other' }]);

      const result = await (agentModeService as any).writeClickUpDoc('ws-1', 'New Doc', '# Content', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toBe('Not authorized to access this ClickUp workspace');
    });

    it('should successfully create a ClickUp doc at workspace root', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockCreateDoc.mockResolvedValue({ id: 'doc-new-1', name: 'New Doc' });

      const result = await (agentModeService as any).writeClickUpDoc('ws-1', 'New Doc', '# Hello\n\nWorld', 'user-123');
      expect(result.success).toBe(true);
      expect(result.docId).toBe('doc-new-1');
      expect(result.message).toContain('New Doc');
      expect(mockCreateDoc).toHaveBeenCalledWith('ck_token', 'ws-1', 'New Doc', '# Hello\n\nWorld');
    });

    it('should handle API errors gracefully', async () => {
      mockGetAccessToken.mockRejectedValue(new Error('API Error'));

      const result = await (agentModeService as any).writeClickUpDoc('ws-1', 'New Doc', 'content', 'user-123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to create ClickUp document');
    });

    it('should create a page inside a parent doc when parent_doc_id is provided', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'Test Workspace' }]);
      mockCreatePageInDoc.mockResolvedValue({ id: 'page-1', name: 'Page Doc' });

      const result = await (agentModeService as any).writeClickUpDoc('ws-1', 'Page Doc', 'content', 'user-123', 'parent-doc-99');
      expect(result.success).toBe(true);
      expect(mockCreatePageInDoc).toHaveBeenCalledWith('ck_token', 'ws-1', 'parent-doc-99', 'Page Doc', 'content');
      expect(mockCreateDoc).not.toHaveBeenCalled();
      expect(result.message).toContain('parent-doc-99');
    });

  });

  // ============================================
  // listKnowledgeBaseFiles - folder listing tests
  // ============================================

  describe('listKnowledgeBaseFiles - ClickUp folder listing', () => {
    beforeEach(() => {
      // No private KB tasks
      const { taskDb } = require('../services/db');
      taskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
      taskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);
    });

    it('should include clickup-folder entries when folders exist', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([]);
      mockListTasks.mockResolvedValue([]);
      mockListSpaces.mockResolvedValue([{ id: 'sp-1', name: 'Engineering' }]);
      mockListFolders.mockResolvedValue([{ id: 'folder-42', name: 'AgentWeb' }]);

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      expect(result.success).toBe(true);
      const folderEntries = result.knowledge_bases.filter((kb: any) => kb.type === 'clickup-folder');
      expect(folderEntries).toHaveLength(1);
      expect(folderEntries[0].identifier).toBe('clickup-folder:folder-42');
      expect(folderEntries[0].name).toContain('AgentWeb');
      expect(folderEntries[0].name).toContain('Engineering');
      expect(folderEntries[0].name).toContain('My Workspace');
    });

    it('should not add folder entries when no folders exist', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([]);
      mockListTasks.mockResolvedValue([]);
      mockListSpaces.mockResolvedValue([{ id: 'sp-1', name: 'Engineering' }]);
      mockListFolders.mockResolvedValue([]);

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      expect(result.success).toBe(true);
      const folderEntries = result.knowledge_bases.filter((kb: any) => kb.type === 'clickup-folder');
      expect(folderEntries).toHaveLength(0);
    });

    it('should continue gracefully when folder listing fails for a space', async () => {
      mockGetAccessToken.mockResolvedValue('ck_token');
      mockGetWorkspaces.mockResolvedValue([{ id: 'ws-1', name: 'My Workspace' }]);
      mockListDocs.mockResolvedValue([]);
      mockListTasks.mockResolvedValue([]);
      mockListSpaces.mockResolvedValue([{ id: 'sp-1', name: 'Engineering' }]);
      mockListFolders.mockRejectedValue(new Error('Permission denied'));

      const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');
      // Should not throw — folder errors are caught per-space
      expect(result.success).toBe(true);
      const folderEntries = result.knowledge_bases.filter((kb: any) => kb.type === 'clickup-folder');
      expect(folderEntries).toHaveLength(0);
    });
  });
});
