import { Request, Response } from 'express';

// Mock dependencies
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['*']),
  getAllowedSkills: jest.fn(async () => ['*']),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionError: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set()),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    createSchedule: jest.fn(),
    getSchedulesByUserId: jest.fn(),
    getScheduleById: jest.fn(),
    updateSchedule: jest.fn(),
    addRunResult: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
  },
  scheduleTemplateDb: {
    createTemplate: jest.fn(),
    getTemplateById: jest.fn(),
    getTemplatesByCreator: jest.fn(),
    getTemplatesByVisibility: jest.fn(),
    updateTemplate: jest.fn(),
    deleteTemplate: jest.fn(),
    incrementUsageCount: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  taskDb: { getTaskExecutionById: jest.fn(), createTaskExecution: jest.fn(), updateTaskExecution: jest.fn() },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-template-id-123'),
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn() },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

jest.mock('../services/workPlanService', () => ({
  workPlanService: { getPublicPlansForAgentMode: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../utils/sseProgress', () => ({
  emitProgress: jest.fn(),
  registerProgressCallback: jest.fn(),
  getLatestProgress: jest.fn(),
  progressStore: new Map(),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
}));

import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb, scheduleTemplateDb } from '../services/db';

const mockUser = { userId: 'user-1', email: 'test@example.com', isAdmin: true };
const mockOtherUser = { userId: 'user-2', email: 'other@example.com', isAdmin: false };

function mockReq(overrides: any = {}) {
  return {
    user: mockUser,
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe('Schedule Templates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── CREATE ───────────────────────────────────────────────────────────────

  describe('createScheduleTemplate', () => {
    it('should reject when name is missing', async () => {
      const req = mockReq({ body: { startingMessage: 'Do something' } });
      const res = mockRes();
      await agentModeController.createScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('required') }));
    });

    it('should reject when startingMessage is missing', async () => {
      const req = mockReq({ body: { name: 'My Template' } });
      const res = mockRes();
      await agentModeController.createScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should reject invalid frequencyIntervalDays for every_n_days', async () => {
      const req = mockReq({
        body: { name: 'Test', startingMessage: 'Hello', suggestedFrequency: 'every_n_days', frequencyIntervalDays: 0 },
      });
      const res = mockRes();
      await agentModeController.createScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('frequencyIntervalDays') }));
    });

    it('should create a template successfully with defaults', async () => {
      (scheduleTemplateDb.createTemplate as jest.Mock).mockResolvedValue({});
      const req = mockReq({
        body: { name: 'SEO Check', startingMessage: 'Check SEO for {{website}}' },
      });
      const res = mockRes();
      await agentModeController.createScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'mock-template-id-123' }));

      // Verify template was created with extracted variables
      const createdTemplate = (scheduleTemplateDb.createTemplate as jest.Mock).mock.calls[0][0];
      expect(createdTemplate.variables).toEqual([{ name: 'website', description: '', type: 'text' }]);
      expect(createdTemplate.visibility).toBe('private');
      expect(createdTemplate.category).toBe('General');
      expect(createdTemplate.createdBy).toBe('user-1');
    });

    it('should always create templates as private regardless of requested visibility', async () => {
      (scheduleTemplateDb.createTemplate as jest.Mock).mockResolvedValue({});
      const req = mockReq({
        body: { name: 'SEO Check', startingMessage: 'Check SEO', visibility: 'system', category: 'SEO' },
      });
      const res = mockRes();
      await agentModeController.createScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(201);
      const created = (scheduleTemplateDb.createTemplate as jest.Mock).mock.calls[0][0];
      expect(created.visibility).toBe('private');
      expect(created.category).toBe('SEO');
    });
  });

  // ─── LIST ─────────────────────────────────────────────────────────────────

  describe('getScheduleTemplates', () => {
    it('should return merged system + public + private templates', async () => {
      const systemTemplate = { templateId: 't1', name: 'System', visibility: 'system', createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z' };
      const publicTemplate = { templateId: 't3', name: 'Public', visibility: 'public', createdBy: 'user-2', createdAt: '2026-01-03T00:00:00Z' };
      const privateTemplate = { templateId: 't2', name: 'Private', visibility: 'private', createdBy: 'user-1', createdAt: '2026-01-02T00:00:00Z' };
      (scheduleTemplateDb.getTemplatesByCreator as jest.Mock).mockResolvedValue([privateTemplate]);
      (scheduleTemplateDb.getTemplatesByVisibility as jest.Mock)
        .mockResolvedValueOnce([systemTemplate])   // system call
        .mockResolvedValueOnce([publicTemplate]);   // public call

      const req = mockReq();
      const res = mockRes();
      await agentModeController.getScheduleTemplates(req as any, res);

      expect(res.json).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ templateId: 't1' }),
        expect.objectContaining({ templateId: 't2' }),
        expect.objectContaining({ templateId: 't3' }),
      ]));
    });

    it('should not duplicate templates owned by user that are also system', async () => {
      const template = { templateId: 't1', name: 'Both', visibility: 'system', createdBy: 'user-1', createdAt: '2026-01-01T00:00:00Z' };
      (scheduleTemplateDb.getTemplatesByCreator as jest.Mock).mockResolvedValue([template]);
      (scheduleTemplateDb.getTemplatesByVisibility as jest.Mock)
        .mockResolvedValueOnce([template])   // system call
        .mockResolvedValueOnce([]);           // public call

      const req = mockReq();
      const res = mockRes();
      await agentModeController.getScheduleTemplates(req as any, res);

      const result = (res.json as jest.Mock).mock.calls[0][0];
      expect(result).toHaveLength(1);
    });
  });

  // ─── GET BY ID ────────────────────────────────────────────────────────────

  describe('getScheduleTemplate', () => {
    it('should return 404 for non-existent template', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(null);
      const req = mockReq({ params: { templateId: 'no-exist' } });
      const res = mockRes();
      await agentModeController.getScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should deny access to private template owned by another user', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', visibility: 'private', createdBy: 'user-2',
      });
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.getScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should allow access to system template by any user', async () => {
      const template = { templateId: 't1', visibility: 'system', createdBy: 'user-2' };
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(template);
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.getScheduleTemplate(req as any, res);
      expect(res.json).toHaveBeenCalledWith(template);
    });

    it('should allow access to public template by any user', async () => {
      const template = { templateId: 't1', visibility: 'public', createdBy: 'user-2' };
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(template);
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.getScheduleTemplate(req as any, res);
      expect(res.json).toHaveBeenCalledWith(template);
    });
  });

  // ─── UPDATE ───────────────────────────────────────────────────────────────

  describe('updateScheduleTemplate', () => {
    it('should reject update by non-owner', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', createdBy: 'user-2',
      });
      const req = mockReq({ params: { templateId: 't1' }, body: { name: 'New Name' } });
      const res = mockRes();
      await agentModeController.updateScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should update template owned by user', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', createdBy: 'user-1', variables: [],
      });
      (scheduleTemplateDb.updateTemplate as jest.Mock).mockResolvedValue({});
      const req = mockReq({ params: { templateId: 't1' }, body: { name: 'Updated', category: 'SEO' } });
      const res = mockRes();
      await agentModeController.updateScheduleTemplate(req as any, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('updated') }));
      expect(scheduleTemplateDb.updateTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'Updated', category: 'SEO' }));
    });
  });

  // ─── DELETE ───────────────────────────────────────────────────────────────

  describe('deleteScheduleTemplate', () => {
    it('should reject delete by non-owner', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', createdBy: 'user-2',
      });
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.deleteScheduleTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should delete template owned by user', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', createdBy: 'user-1',
      });
      (scheduleTemplateDb.deleteTemplate as jest.Mock).mockResolvedValue({});
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.deleteScheduleTemplate(req as any, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('deleted') }));
    });
  });

  // ─── CREATE FROM TEMPLATE ─────────────────────────────────────────────────

  describe('createScheduleFromTemplate', () => {
    const baseTemplate = {
      templateId: 't1',
      createdBy: 'admin',
      visibility: 'system',
      name: 'Weekly SEO',
      description: 'SEO audit',
      startingMessage: 'Check SEO for {{website}}',
      variables: [{ name: 'website', description: 'Target site', type: 'text' }],
      keywords: ['seo', 'ranking'],
      requiredFunctionCalls: [],
      functionCallMinCalls: {},
      suggestedFrequency: 'weekly',
      emailNotifications: ['test@example.com'],
      dailyDigest: false,
      llmModel: '',
    };

    it('should return 404 for non-existent template', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(null);
      const req = mockReq({ params: { templateId: 'no-exist' }, body: {} });
      const res = mockRes();
      await agentModeController.createScheduleFromTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should deny access to private template of another user', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        ...baseTemplate, visibility: 'private', createdBy: 'user-2',
      });
      const req = mockReq({ params: { templateId: 't1' }, body: {} });
      const res = mockRes();
      await agentModeController.createScheduleFromTemplate(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should create scheduled chat from template with variable values', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(baseTemplate);
      (scheduleDb.createSchedule as jest.Mock).mockResolvedValue({});
      (scheduleTemplateDb.incrementUsageCount as jest.Mock).mockResolvedValue({});

      const req = mockReq({
        params: { templateId: 't1' },
        body: { variableValues: { website: 'example.com' } },
      });
      const res = mockRes();
      await agentModeController.createScheduleFromTemplate(req as any, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        scheduleId: 'mock-template-id-123',
        templateId: 't1',
      }));

      // Verify schedule was created with template data
      const created = (scheduleDb.createSchedule as jest.Mock).mock.calls[0][0];
      expect(created.startingMessage).toBe('Check SEO for {{website}}');
      expect(created.variableValues).toEqual({ website: 'example.com' });
      expect(created.variableRequestStatus).toBe('provided');
      expect(created.frequency).toBe('weekly');
      expect(created.keywords).toEqual(['seo', 'ranking']);
      expect(created.type).toBe('scheduled_chat');

      // Verify usage count was incremented
      expect(scheduleTemplateDb.incrementUsageCount).toHaveBeenCalledWith('t1');
    });

    it('should allow overriding frequency and model', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(baseTemplate);
      (scheduleDb.createSchedule as jest.Mock).mockResolvedValue({});
      (scheduleTemplateDb.incrementUsageCount as jest.Mock).mockResolvedValue({});

      const req = mockReq({
        params: { templateId: 't1' },
        body: {
          scheduleFrequency: 'daily',
          llmModel: 'claude-opus-4-6',
          variableValues: { website: 'test.com' },
        },
      });
      const res = mockRes();
      await agentModeController.createScheduleFromTemplate(req as any, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const created = (scheduleDb.createSchedule as jest.Mock).mock.calls[0][0];
      expect(created.frequency).toBe('daily');
      expect(created.llmModel).toBe('claude-opus-4-6');
    });

    it('should set variableRequestStatus to pending when variables are missing', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(baseTemplate);
      (scheduleDb.createSchedule as jest.Mock).mockResolvedValue({});
      (scheduleTemplateDb.incrementUsageCount as jest.Mock).mockResolvedValue({});

      const req = mockReq({
        params: { templateId: 't1' },
        body: {}, // No variable values provided
      });
      const res = mockRes();
      await agentModeController.createScheduleFromTemplate(req as any, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const created = (scheduleDb.createSchedule as jest.Mock).mock.calls[0][0];
      expect(created.variableRequestStatus).toBe('pending');
    });
  });

  // ─── SUBMIT FOR REVIEW ───────────────────────────────────────────────────

  describe('submitTemplateForReview', () => {
    it('should reject if template not found', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(null);
      const req = mockReq({ params: { templateId: 'no-exist' } });
      const res = mockRes();
      await agentModeController.submitTemplateForReview(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should reject if not owned by user', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', createdBy: 'user-2', visibility: 'private',
      });
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.submitTemplateForReview(req as any, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should reject if not private', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', createdBy: 'user-1', visibility: 'system',
      });
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.submitTemplateForReview(req as any, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should submit private template for review', async () => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', createdBy: 'user-1', visibility: 'private',
      });
      (scheduleTemplateDb.updateTemplate as jest.Mock).mockResolvedValue({});
      const req = mockReq({ params: { templateId: 't1' } });
      const res = mockRes();
      await agentModeController.submitTemplateForReview(req as any, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('review') }));
      expect(scheduleTemplateDb.updateTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({
        visibility: 'pending_review',
        reviewFeedback: '',
      }));
    });
  });
});
