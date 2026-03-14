import { AgentModeService } from '../services/agentModeService';

// Mock all dependencies
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools) => tools)
}));

describe('AgentModeService - Content Filtering Error Handling', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Create service instance
    agentModeService = new AgentModeService();
  });

  describe('Error handling in generateMarketingResponse', () => {
    it('should throw user-friendly error for content filtering', async () => {
      // Mock callLLM to throw content filter error
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue({
        code: 'content_filter',
        status: 400,
        error: {
          code: 'ResponsibleAIPolicyViolation',
          message: 'Content policy violation'
        }
      });

      // Mock other required dependencies
      const mockDb = require('../services/db');
      mockDb.getUser = jest.fn().mockResolvedValue({ userId: 'test-user' });

      const mockChatbotService = require('../services/chatbotService');
      mockChatbotService.chatbotDb = {
        getChatSession: jest.fn().mockResolvedValue({
          sessionId: 'test-session',
          messages: []
        }),
        addMessagesToSession: jest.fn().mockResolvedValue(undefined)
      };

      const mockSettingsService = require('../services/settingsService');
      mockSettingsService.settingsService = {
        getSetting: jest.fn().mockResolvedValue(null)
      };

      await expect(
        agentModeService.generateMarketingResponse(
          'Test message',
          [{ role: 'user', content: 'Test message' }],
          'test-user',
          agentModeService.default_model,
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I encountered an error processing your request. Please try again.');
    });

    it('should throw user-friendly error for ResponsibleAIPolicyViolation', async () => {
      // Mock callLLM to throw ResponsibleAIPolicyViolation error
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue({
        status: 400,
        error: {
          code: 'ResponsibleAIPolicyViolation',
          message: 'Content policy violation'
        }
      });

      // Mock other required dependencies
      const mockDb = require('../services/db');
      mockDb.getUser = jest.fn().mockResolvedValue({ userId: 'test-user' });

      const mockChatbotService = require('../services/chatbotService');
      mockChatbotService.chatbotDb = {
        getChatSession: jest.fn().mockResolvedValue({
          sessionId: 'test-session',
          messages: []
        }),
        addMessagesToSession: jest.fn().mockResolvedValue(undefined)
      };

      const mockSettingsService = require('../services/settingsService');
      mockSettingsService.settingsService = {
        getSetting: jest.fn().mockResolvedValue(null)
      };

      await expect(
        agentModeService.generateMarketingResponse(
          'Test message',
          [{ role: 'user', content: 'Test message' }],
          'test-user',
          agentModeService.default_model,
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I encountered an error processing your request. Please try again.');
    });

    it('should throw user-friendly error for general 400 errors', async () => {
      // Mock callLLM to throw general 400 error
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue({
        status: 400,
        message: 'Bad request'
      });

      // Mock other required dependencies
      const mockDb = require('../services/db');
      mockDb.getUser = jest.fn().mockResolvedValue({ userId: 'test-user' });

      const mockChatbotService = require('../services/chatbotService');
      mockChatbotService.chatbotDb = {
        getChatSession: jest.fn().mockResolvedValue({
          sessionId: 'test-session',
          messages: []
        }),
        addMessagesToSession: jest.fn().mockResolvedValue(undefined)
      };

      const mockSettingsService = require('../services/settingsService');
      mockSettingsService.settingsService = {
        getSetting: jest.fn().mockResolvedValue(null)
      };

      await expect(
        agentModeService.generateMarketingResponse(
          'Test message',
          [{ role: 'user', content: 'Test message' }],
          'test-user',
          agentModeService.default_model,
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I encountered an error processing your request. Please try again.');
    });

    it('should throw user-friendly error for rate limiting', async () => {
      // Mock callLLM to throw rate limiting error
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue({
        status: 429,
        message: 'Rate limit exceeded'
      });

      // Mock other required dependencies
      const mockDb = require('../services/db');
      mockDb.getUser = jest.fn().mockResolvedValue({ userId: 'test-user' });

      const mockChatbotService = require('../services/chatbotService');
      mockChatbotService.chatbotDb = {
        getChatSession: jest.fn().mockResolvedValue({
          sessionId: 'test-session',
          messages: []
        }),
        addMessagesToSession: jest.fn().mockResolvedValue(undefined)
      };

      const mockSettingsService = require('../services/settingsService');
      mockSettingsService.settingsService = {
        getSetting: jest.fn().mockResolvedValue(null)
      };

      await expect(
        agentModeService.generateMarketingResponse(
          'Test message',
          [{ role: 'user', content: 'Test message' }],
          'test-user',
          agentModeService.default_model,
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I encountered an error processing your request. Please try again.');
    });

    it('should throw generic error for other errors', async () => {
      // Mock callLLM to throw generic error
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('Something went wrong'));

      // Mock other required dependencies
      const mockDb = require('../services/db');
      mockDb.getUser = jest.fn().mockResolvedValue({ userId: 'test-user' });
      
      const mockChatbotService = require('../services/chatbotService');
      mockChatbotService.chatbotDb = {
        getChatSession: jest.fn().mockResolvedValue({
          sessionId: 'test-session',
          messages: []
        }),
        addMessagesToSession: jest.fn().mockResolvedValue(undefined)
      };

      const mockSettingsService = require('../services/settingsService');
      mockSettingsService.settingsService = {
        getSetting: jest.fn().mockResolvedValue(null)
      };

      await expect(
        agentModeService.generateMarketingResponse(
          'Test message',
          [{ role: 'user', content: 'Test message' }],
          'test-user',
          agentModeService.default_model,
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I encountered an error processing your request. Please try again.');
    });
  });

  describe('Error handling in generateSessionTitle', () => {
    it('should return default title for content filtering errors', async () => {
      // Mock callLLM to throw content filter error
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue({
        code: 'content_filter',
        status: 400,
        error: {
          code: 'ResponsibleAIPolicyViolation',
          message: 'Content policy violation'
        }
      });

      const result = await agentModeService.generateSessionTitle('Test message');

      expect(result).toBe('Marketing Task');
    });

    it('should return default title for other errors', async () => {
      // Mock callLLM to throw generic error
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('Network error'));

      const result = await agentModeService.generateSessionTitle('Test message');

      expect(result).toBe('Marketing Task');
    });

    it('should return generated title on success', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [
          {
            message: {
              content: 'Generated Title'
            }
          }
        ]
      });

      const result = await agentModeService.generateSessionTitle('Test message');

      expect(result).toBe('Generated Title');
    });
  });
});
