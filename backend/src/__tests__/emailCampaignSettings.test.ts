import request from 'supertest';
import express from 'express';
import settingsRouter from '../routes/settings';
import htmlTemplatesRouter from '../routes/htmlTemplates';
import { settingsService } from '../services/settingsService';
import { authenticateToken } from '../middleware/auth';
import { htmlTemplateService } from '../services/htmlTemplateService';
import { userDb, orgDb } from '../services/db';

// Mock the settings service
jest.mock('../services/settingsService');
const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;

// Mock the auth middleware
jest.mock('../middleware/auth');
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

// Mock htmlTemplateService (used by the new /api/html-templates routes)
jest.mock('../services/htmlTemplateService', () => ({
  htmlTemplateService: {
    createTemplate:       jest.fn(),
    getTemplate:          jest.fn(),
    getPublicTemplate:    jest.fn(),
    getTemplatesByOwner:  jest.fn(),
    getPublicTemplates:   jest.fn(),
    updateTemplate:       jest.fn(),
    deleteTemplate:       jest.fn(),
    transferAllTemplates: jest.fn(),
    deleteAllTemplates:   jest.fn(),
  },
}));

// Mock userDb / orgDb (used by the new /api/html-templates routes)
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb:  { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
}));

// Also mock orgShareService (imported by htmlTemplates route)
jest.mock('../services/orgShareService', () => ({
  canViewItem:                 jest.fn().mockReturnValue(true),
  canEditItem:                 jest.fn().mockReturnValue(true),
  canManageOrgFeature:         jest.fn().mockReturnValue(true),
  isFeatureEffectivelyEnabled: jest.fn().mockReturnValue(false),
  listOrgVisibleItems:         jest.fn().mockResolvedValue({ items: [], truncated: false }),
}));

const mockedHtmlTemplateService = htmlTemplateService as jest.Mocked<typeof htmlTemplateService>;
const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedOrgDb  = orgDb  as jest.Mocked<typeof orgDb>;

/**
 * The `/api/html-templates` POST/GET/DELETE describe blocks below were
 * rewritten in commit 94e4c192 against the new AW-HtmlTemplates table
 * shape (htmlTemplateService). Legacy variables/arrayVariables assertions
 * and settings-row tests were removed — see inline comments for rationale.
 *
 * The `/api/settings/customer/email-campaign-tasks` tests (everything above
 * the html-templates blocks) are NOT skipped — they test an unrelated
 * per-user settings feature and remain in force.
 */
describe('Email Campaign Settings API', () => {
  let app: express.Application;

  beforeEach(() => {
    // Create a fresh Express app for each test
    app = express();
    app.use(express.json());

    app.use('/api/settings', settingsRouter);
    // Apply auth middleware at mount point, mirroring app.ts: app.use('/api/html-templates', authenticateToken, htmlTemplatesRoutes)
    app.use('/api/html-templates', authenticateToken, htmlTemplatesRouter);

    // Clear all mocks before each test
    jest.clearAllMocks();

    // Mock authenticateToken to pass through (must be after clearAllMocks)
    mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
      // Set up a mock user
      (req as any).user = {
        userId: 'test-user-123',
        email: 'test@example.com',
        isAdmin: false
      };
      next();
      return undefined;
    });

    // Reset html-template service mocks
    mockedHtmlTemplateService.createTemplate.mockReset();
    mockedHtmlTemplateService.getTemplate.mockReset();
    (mockedHtmlTemplateService as any).getPublicTemplate?.mockReset?.();
    mockedHtmlTemplateService.getTemplatesByOwner.mockReset();
    mockedHtmlTemplateService.getPublicTemplates.mockReset();
    mockedHtmlTemplateService.updateTemplate.mockReset();
    mockedHtmlTemplateService.deleteTemplate.mockReset();
    mockedUserDb.getUserById.mockReset();
    mockedOrgDb.getOrgById.mockReset();
    mockedOrgDb.getOrgMembers.mockReset();

    // Default: solo user with no org so org fanout is skipped
    mockedUserDb.getUserById.mockResolvedValue({ userId: 'test-user-123', email: 'test@example.com' } as any);
    mockedOrgDb.getOrgById.mockResolvedValue(null);
    mockedOrgDb.getOrgMembers.mockResolvedValue([]);
    mockedHtmlTemplateService.getPublicTemplates.mockResolvedValue([]);
  });

  describe('GET /api/settings/customer/email-campaign-tasks', () => {
    it('should return empty array when no tasks are monitored', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(200);

      expect(response.body).toEqual({ taskIds: [] });
      expect(mockedSettingsService.getSetting).toHaveBeenCalledWith('user-test-user-123-email_campaign_tasks');
    });

    it('should return task IDs when tasks are monitored', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1", "task-2", "task-3"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);

      const response = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(200);

      expect(response.body).toEqual({ taskIds: ['task-1', 'task-2', 'task-3'] });
      expect(mockedSettingsService.getSetting).toHaveBeenCalledWith('user-test-user-123-email_campaign_tasks');
    });

    it('should handle invalid JSON in setting value', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: 'invalid-json',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);

      const response = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(200);

      expect(response.body).toEqual({ taskIds: [] });
    });

    it('should return 401 when user is not authenticated', async () => {
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = null;
        next();
        return undefined;
      });

      const response = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(401);

      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 500 when settings service throws error', async () => {
      mockedSettingsService.getSetting.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to get email campaign tasks' });
    });
  });

  describe('POST /api/settings/customer/email-campaign-tasks/:taskId', () => {
    it('should add a new task ID to monitoring', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);
      mockedSettingsService.setSetting.mockResolvedValue({
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      });

      const response = await request(app)
        .post('/api/settings/customer/email-campaign-tasks/task-1')
        .expect(200);

      expect(response.body).toEqual({
        message: 'Task added to email campaign monitoring',
        taskIds: ['task-1']
      });
      expect(mockedSettingsService.getSetting).toHaveBeenCalledWith('user-test-user-123-email_campaign_tasks');
      expect(mockedSettingsService.setSetting).toHaveBeenCalledWith(
        'user-test-user-123-email_campaign_tasks',
        '["task-1"]',
        'User-monitored email campaign tasks',
        'test@example.com'
      );
    });

    it('should not add duplicate task ID', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1", "task-2"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);

      const response = await request(app)
        .post('/api/settings/customer/email-campaign-tasks/task-1')
        .expect(200);

      expect(response.body).toEqual({
        message: 'Task added to email campaign monitoring',
        taskIds: ['task-1', 'task-2']
      });
      // Should not call setSetting since task already exists
      expect(mockedSettingsService.setSetting).not.toHaveBeenCalled();
    });

    it('should add task to existing list', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1", "task-2"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);
      mockedSettingsService.setSetting.mockResolvedValue({
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1", "task-2", "task-3"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      });

      const response = await request(app)
        .post('/api/settings/customer/email-campaign-tasks/task-3')
        .expect(200);

      expect(response.body).toEqual({
        message: 'Task added to email campaign monitoring',
        taskIds: ['task-1', 'task-2', 'task-3']
      });
      expect(mockedSettingsService.setSetting).toHaveBeenCalledWith(
        'user-test-user-123-email_campaign_tasks',
        '["task-1","task-2","task-3"]',
        'User-monitored email campaign tasks',
        'test@example.com'
      );
    });

    it('should return 401 when user is not authenticated', async () => {
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = null;
        next();
        return undefined;
      });

      const response = await request(app)
        .post('/api/settings/customer/email-campaign-tasks/task-1')
        .expect(401);

      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 400 when taskId is missing', async () => {
      const response = await request(app)
        .post('/api/settings/customer/email-campaign-tasks/')
        .expect(400); // General route expects tasks array in body
    });

    it('should return 500 when settings service throws error', async () => {
      mockedSettingsService.getSetting.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/settings/customer/email-campaign-tasks/task-1')
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to add email campaign task' });
    });
  });

  describe('DELETE /api/settings/customer/email-campaign-tasks/:taskId', () => {
    it('should remove a task ID from monitoring', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1", "task-2", "task-3"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);
      mockedSettingsService.setSetting.mockResolvedValue({
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1", "task-3"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      });

      const response = await request(app)
        .delete('/api/settings/customer/email-campaign-tasks/task-2')
        .expect(200);

      expect(response.body).toEqual({
        message: 'Task removed from email campaign monitoring',
        taskIds: ['task-1', 'task-3']
      });
      expect(mockedSettingsService.setSetting).toHaveBeenCalledWith(
        'user-test-user-123-email_campaign_tasks',
        '["task-1","task-3"]',
        'User-monitored email campaign tasks',
        'test@example.com'
      );
    });

    it('should handle removing non-existent task ID', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '["task-1", "task-2"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);

      const response = await request(app)
        .delete('/api/settings/customer/email-campaign-tasks/task-3')
        .expect(200);

      expect(response.body).toEqual({
        message: 'Task removed from email campaign monitoring',
        taskIds: ['task-1', 'task-2']
      });
      // Should not call setSetting since task wasn't in the list
      expect(mockedSettingsService.setSetting).not.toHaveBeenCalled();
    });

    it('should handle empty task list', async () => {
      mockedSettingsService.getSetting.mockResolvedValue(null);

      const response = await request(app)
        .delete('/api/settings/customer/email-campaign-tasks/task-1')
        .expect(200);

      expect(response.body).toEqual({
        message: 'Task removed from email campaign monitoring',
        taskIds: []
      });
      expect(mockedSettingsService.setSetting).not.toHaveBeenCalled();
    });

    it('should return 401 when user is not authenticated', async () => {
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = null;
        next();
        return undefined;
      });

      const response = await request(app)
        .delete('/api/settings/customer/email-campaign-tasks/task-1')
        .expect(401);

      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 400 when taskId is missing', async () => {
      const response = await request(app)
        .delete('/api/settings/customer/email-campaign-tasks/')
        .expect(404); // Express returns 404 for missing route parameter
    });

    it('should return 500 when settings service throws error', async () => {
      mockedSettingsService.getSetting.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .delete('/api/settings/customer/email-campaign-tasks/task-1')
        .expect(500);

      expect(response.body).toEqual({ error: 'Failed to remove email campaign task' });
    });
  });

  describe('User isolation', () => {
    it('should use different setting names for different users', async () => {
      // First user
      mockedSettingsService.getSetting.mockResolvedValueOnce({
        settingName: 'user-user-1-email_campaign_tasks',
        settingValue: '["task-1"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'user1@example.com',
        updatedAt: new Date().toISOString()
      });

      const response1 = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(200);

      expect(response1.body).toEqual({ taskIds: ['task-1'] });
      expect(mockedSettingsService.getSetting).toHaveBeenCalledWith('user-test-user-123-email_campaign_tasks');

      // Second user
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = {
          userId: 'user-456',
          email: 'user2@example.com',
          isAdmin: false
        };
        next();
        return undefined;
      });

      mockedSettingsService.getSetting.mockResolvedValueOnce({
        settingName: 'user-user-456-email_campaign_tasks',
        settingValue: '["task-2", "task-3"]',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'user2@example.com',
        updatedAt: new Date().toISOString()
      });

      const response2 = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(200);

      expect(response2.body).toEqual({ taskIds: ['task-2', 'task-3'] });
      expect(mockedSettingsService.getSetting).toHaveBeenCalledWith('user-user-456-email_campaign_tasks');
    });
  });

  describe('Error handling', () => {
    it('should handle malformed JSON in existing setting', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: 'malformed-json[',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);

      const response = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(200);

      expect(response.body).toEqual({ taskIds: [] });
    });

    it('should handle non-array JSON in existing setting', async () => {
      const mockSetting = {
        settingName: 'user-test-user-123-email_campaign_tasks',
        settingValue: '"not-an-array"',
        description: 'User-monitored email campaign tasks',
        updatedBy: 'test@example.com',
        updatedAt: new Date().toISOString()
      };
      mockedSettingsService.getSetting.mockResolvedValue(mockSetting);

      const response = await request(app)
        .get('/api/settings/customer/email-campaign-tasks')
        .expect(200);

      expect(response.body).toEqual({ taskIds: [] });
    });
  });

  describe('POST /api/html-templates', () => {
    it('creates a new template with valid body', async () => {
      mockedHtmlTemplateService.createTemplate.mockResolvedValue({
        template_id: 't-new',
        template_name: 'test_template',
        type: ['email'],
        html_content: '<h1>{{title}}</h1>',
        subject: 'Test',
        variables: ['title'],
        arrayVariables: [],
        created_at: '2026-05-19T00:00:00.000Z',
        updated_at: '2026-05-19T00:00:00.000Z',
      });

      const res = await request(app).post('/api/html-templates').send({
        template_name: 'test_template',
        type: ['email'],
        subject: 'Test',
        html_content: '<h1>{{title}}</h1>',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.template.template_id).toBe('t-new');
      expect(mockedHtmlTemplateService.createTemplate).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request(app).post('/api/html-templates').send({
        template_name: 'incomplete',
        type: ['email'],
        // missing html_content
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });
  });

  describe('GET /api/html-templates', () => {
    it('returns empty result when no templates exist', async () => {
      mockedHtmlTemplateService.getTemplatesByOwner.mockResolvedValue([]);

      const res = await request(app).get('/api/html-templates');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], truncated: false });
    });

    it("returns the caller's templates", async () => {
      mockedHtmlTemplateService.getTemplatesByOwner.mockResolvedValue([
        {
          template_id: 't-1',
          template_name: 'tpl1',
          type: ['email'],
          html_content: '<h1>{{title}}</h1>',
          subject: 'Subject',
          variables: ['title'],
          arrayVariables: [],
          created_at: '2026-05-19T00:00:00.000Z',
          updated_at: '2026-05-19T00:00:00.000Z',
        },
      ]);

      const res = await request(app).get('/api/html-templates');

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].template_name).toBe('tpl1');
      expect(res.body.truncated).toBe(false);
    });
  });

  describe('DELETE /api/html-templates/:templateId', () => {
    it('deletes an existing template owned by caller', async () => {
      mockedHtmlTemplateService.deleteTemplate.mockResolvedValue(true);

      const res = await request(app).delete('/api/html-templates/t-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockedHtmlTemplateService.deleteTemplate).toHaveBeenCalledWith(
        't-1',
        'test-user-123',
        'test@example.com',
      );
    });

    it('returns 404 when template does not exist', async () => {
      mockedHtmlTemplateService.deleteTemplate.mockResolvedValue(false);

      const res = await request(app).delete('/api/html-templates/missing');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });
});
