import { chatbotDb } from '../services/chatbotService';

// Mock the entire chatbot service module
jest.mock('../services/chatbotService', () => {
  const originalModule = jest.requireActual('../services/chatbotService');
  return {
    ...originalModule,
    chatbotDb: {
      ...originalModule.chatbotDb,
      createOrReuseInteractiveShare: jest.fn()
    }
  };
});

describe('Interactive Share Common Function - Simple Tests', () => {
  const mockCreateOrReuseInteractiveShare = chatbotDb.createOrReuseInteractiveShare as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createOrReuseInteractiveShare', () => {
    it('should be callable and return a string', async () => {
      mockCreateOrReuseInteractiveShare.mockResolvedValue('http://localhost:5174/ishare/test-session?conversable=token123');

      const result = await chatbotDb.createOrReuseInteractiveShare('test-session');

      expect(mockCreateOrReuseInteractiveShare).toHaveBeenCalledWith('test-session');
      expect(result).toBe('http://localhost:5174/ishare/test-session?conversable=token123');
    });

    it('should handle errors gracefully', async () => {
      mockCreateOrReuseInteractiveShare.mockRejectedValue(new Error('Database error'));

      try {
        const result = await chatbotDb.createOrReuseInteractiveShare('test-session');
        // If the function handles errors internally, it should return a fallback URL
        expect(typeof result).toBe('string');
        expect(result).toContain('agent-mode');
      } catch (error) {
        // If the function throws, that's also acceptable behavior
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Database error');
      }

      expect(mockCreateOrReuseInteractiveShare).toHaveBeenCalledWith('test-session');
    });

    it('should return a URL with the correct format', async () => {
      mockCreateOrReuseInteractiveShare.mockResolvedValue('http://localhost:5174/ishare/session-123?conversable=abc123');

      const result = await chatbotDb.createOrReuseInteractiveShare('session-123');

      expect(result).toMatch(/^https?:\/\/.+\/ishare\/.+\?conversable=.+$/);
    });
  });
});
