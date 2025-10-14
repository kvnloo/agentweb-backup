import { AgentModeService } from '../services/agentModeService';

// Mock all dependencies
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../utils/secretsManager');

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
      // Mock the OpenAI instance to throw content filter error
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue({
              code: 'content_filter',
              status: 400,
              error: {
                code: 'ResponsibleAIPolicyViolation',
                message: 'Content policy violation'
              }
            })
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

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
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I cannot respond to that request as it may violate content policies. Please try rephrasing your question or asking about something else.');
    });

    it('should throw user-friendly error for ResponsibleAIPolicyViolation', async () => {
      // Mock the OpenAI instance to throw ResponsibleAIPolicyViolation error
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue({
              status: 400,
              error: {
                code: 'ResponsibleAIPolicyViolation',
                message: 'Content policy violation'
              }
            })
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

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
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I cannot respond to that request as it may violate content policies. Please try rephrasing your question or asking about something else.');
    });

    it('should throw user-friendly error for general 400 errors', async () => {
      // Mock the OpenAI instance to throw general 400 error
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue({
              status: 400,
              message: 'Bad request'
            })
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

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
          'test-session'
        )
      ).rejects.toThrow('I encountered an issue processing your request. Please try rephrasing your question.');
    });

    it('should throw user-friendly error for rate limiting', async () => {
      // Mock the OpenAI instance to throw rate limiting error
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue({
              status: 429,
              message: 'Rate limit exceeded'
            })
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

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
          'test-session'
        )
      ).rejects.toThrow('I\'m currently experiencing high demand. Please wait a moment and try again.');
    });

    it('should throw generic error for other errors', async () => {
      // Mock the OpenAI instance to throw generic error
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(new Error('Something went wrong'))
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

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
          'test-session'
        )
      ).rejects.toThrow('I apologize, but I encountered an error processing your request. Please try again.');
    });
  });

  describe('Error handling in generateSessionTitle', () => {
    it('should return default title for content filtering errors', async () => {
      // Mock the OpenAI instance to throw content filter error
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue({
              code: 'content_filter',
              status: 400,
              error: {
                code: 'ResponsibleAIPolicyViolation',
                message: 'Content policy violation'
              }
            })
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

      const result = await agentModeService.generateSessionTitle('Test message');

      expect(result).toBe('Marketing Task');
    });

    it('should return default title for other errors', async () => {
      // Mock the OpenAI instance to throw generic error
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockRejectedValue(new Error('Network error'))
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

      const result = await agentModeService.generateSessionTitle('Test message');

      expect(result).toBe('Marketing Task');
    });

    it('should return generated title on success', async () => {
      // Mock the OpenAI instance to return successful response
      const mockOpenAI = {
        chat: {
          completions: {
            create: jest.fn().mockResolvedValue({
              choices: [{
                message: {
                  content: 'Generated Title'
                }
              }]
            })
          }
        }
      };

      // Replace the OpenAI instance
      (agentModeService as any).openai = mockOpenAI;

      const result = await agentModeService.generateSessionTitle('Test message');

      expect(result).toBe('Generated Title');
    });
  });
});
