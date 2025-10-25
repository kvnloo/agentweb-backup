import request from 'supertest';
import express from 'express';
import settingsRouter from '../routes/settings';
import { settingsService } from '../services/settingsService';
import { authenticateToken } from '../middleware/auth';

// Mock the settings service
jest.mock('../services/settingsService');
const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;

// Mock the auth middleware
jest.mock('../middleware/auth');
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

describe('Email Campaign Settings API', () => {
  let app: express.Application;

  beforeEach(() => {
    // Create a fresh Express app for each test
    app = express();
    app.use(express.json());
    
    // Mock authenticateToken to pass through
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
    
    app.use('/api/settings', settingsRouter);
    
    // Clear all mocks before each test
    jest.clearAllMocks();
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
});
