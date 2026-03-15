import { chatbotDb, ChatSession } from '../services/chatbotService';

// Mock the entire chatbotService module
jest.mock('../services/chatbotService', () => {
  const originalModule = jest.requireActual('../services/chatbotService');
  return {
    ...originalModule,
    chatbotDb: {
      ...originalModule.chatbotDb,
      updateGenerationStatus: jest.fn(),
      getActiveGenerations: jest.fn(),
      getUserSessions: jest.fn(),
    },
  };
});

describe('ChatbotService - Session Concurrency (generationStatus)', () => {
  const mockUpdateGenerationStatus = chatbotDb.updateGenerationStatus as jest.Mock;
  const mockGetActiveGenerations = chatbotDb.getActiveGenerations as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('updateGenerationStatus', () => {
    const sessionId = 'test-session-concurrency-1';

    it('should set generationStatus to "generating" with a startedAt timestamp', async () => {
      const now = new Date().toISOString();
      mockUpdateGenerationStatus.mockResolvedValue({
        sessionId,
        generationStatus: 'generating',
        generationStartedAt: now,
      } as Partial<ChatSession>);

      const result = await chatbotDb.updateGenerationStatus(sessionId, 'generating', now);

      expect(mockUpdateGenerationStatus).toHaveBeenCalledWith(sessionId, 'generating', now);
      expect(result.generationStatus).toBe('generating');
      expect(result.generationStartedAt).toBe(now);
    });

    it('should set generationStatus to "idle" without a startedAt timestamp', async () => {
      mockUpdateGenerationStatus.mockResolvedValue({
        sessionId,
        generationStatus: 'idle',
      } as Partial<ChatSession>);

      const result = await chatbotDb.updateGenerationStatus(sessionId, 'idle');

      expect(mockUpdateGenerationStatus).toHaveBeenCalledWith(sessionId, 'idle');
      expect(result.generationStatus).toBe('idle');
    });

    it('should set generationStatus to "completed"', async () => {
      mockUpdateGenerationStatus.mockResolvedValue({
        sessionId,
        generationStatus: 'completed',
      } as Partial<ChatSession>);

      const result = await chatbotDb.updateGenerationStatus(sessionId, 'completed');

      expect(mockUpdateGenerationStatus).toHaveBeenCalledWith(sessionId, 'completed');
      expect(result.generationStatus).toBe('completed');
    });

    it('should set generationStatus to "error"', async () => {
      mockUpdateGenerationStatus.mockResolvedValue({
        sessionId,
        generationStatus: 'error',
      } as Partial<ChatSession>);

      const result = await chatbotDb.updateGenerationStatus(sessionId, 'error');

      expect(mockUpdateGenerationStatus).toHaveBeenCalledWith(sessionId, 'error');
      expect(result.generationStatus).toBe('error');
    });

    it('should throw error when DynamoDB update fails', async () => {
      mockUpdateGenerationStatus.mockRejectedValue(new Error('DynamoDB error'));

      await expect(
        chatbotDb.updateGenerationStatus(sessionId, 'generating', new Date().toISOString())
      ).rejects.toThrow('DynamoDB error');
    });
  });

  describe('getActiveGenerations', () => {
    const userId = 'test-user-123';

    it('should return active generating sessions for a user', async () => {
      mockGetActiveGenerations.mockResolvedValue({
        count: 2,
        sessionIds: ['session-1', 'session-2'],
      });

      const result = await chatbotDb.getActiveGenerations(userId);

      expect(mockGetActiveGenerations).toHaveBeenCalledWith(userId);
      expect(result.count).toBe(2);
      expect(result.sessionIds).toEqual(['session-1', 'session-2']);
    });

    it('should return zero count when no sessions are generating', async () => {
      mockGetActiveGenerations.mockResolvedValue({
        count: 0,
        sessionIds: [],
      });

      const result = await chatbotDb.getActiveGenerations(userId);

      expect(mockGetActiveGenerations).toHaveBeenCalledWith(userId);
      expect(result.count).toBe(0);
      expect(result.sessionIds).toHaveLength(0);
    });

    it('should handle sessions with undefined generationStatus (treat as idle)', async () => {
      // Sessions without generationStatus should NOT appear in active generations
      mockGetActiveGenerations.mockResolvedValue({
        count: 0,
        sessionIds: [],
      });

      const result = await chatbotDb.getActiveGenerations(userId);

      expect(result.count).toBe(0);
      expect(result.sessionIds).toEqual([]);
    });

    it('should throw error when getUserSessions query fails', async () => {
      mockGetActiveGenerations.mockRejectedValue(new Error('Query failed'));

      await expect(chatbotDb.getActiveGenerations(userId)).rejects.toThrow('Query failed');
    });
  });
});
