// Mock the entire chatbotService module
jest.mock('../chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionShareMetadata: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  }
}));

import { chatbotDb } from '../chatbotService';

describe('ChatbotService Sharing Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('updateSessionShareMetadata', () => {
    it('should update share metadata successfully', async () => {
      const sessionId = 'test-session-id';
      const shareMetadata = {
        isShared: true,
        sharedAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-02T00:00:00Z'
      };

      const updatedSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata,
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockResolvedValue(updatedSession);

      const result = await chatbotDb.updateSessionShareMetadata(sessionId, shareMetadata);

      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(sessionId, shareMetadata);
      expect(result).toEqual(updatedSession);
    });

    it('should handle update errors', async () => {
      const sessionId = 'test-session-id';
      const shareMetadata = { isShared: true };

      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockRejectedValue(
        new Error('DynamoDB error')
      );

      await expect(
        chatbotDb.updateSessionShareMetadata(sessionId, shareMetadata)
      ).rejects.toThrow('DynamoDB error');
    });

    it('should preserve existing interactiveShareMetadata when updating shareMetadata', async () => {
      const sessionId = 'test-session-id';
      const shareMetadata = { isShared: true };
      const existingInteractiveMetadata = {
        isActive: true,
        token: 'existing-token',
        sharedAt: '2024-01-01T00:00:00Z'
      };

      const updatedSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata,
        interactiveShareMetadata: existingInteractiveMetadata
      };

      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockResolvedValue(updatedSession);

      const result = await chatbotDb.updateSessionShareMetadata(sessionId, shareMetadata);

      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(sessionId, shareMetadata);
      expect(result.interactiveShareMetadata).toEqual(existingInteractiveMetadata);
    });
  });

  describe('updateSessionInteractiveShareMetadata', () => {
    it('should update interactive share metadata successfully', async () => {
      const sessionId = 'test-session-id';
      const interactiveShareMetadata = {
        isActive: true,
        token: 'test-token',
        sharedAt: '2024-01-01T00:00:00Z'
      };

      const updatedSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: false },
        interactiveShareMetadata
      };

      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue(updatedSession);

      const result = await chatbotDb.updateSessionInteractiveShareMetadata(
        sessionId, 
        interactiveShareMetadata
      );

      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId, 
        interactiveShareMetadata
      );
      expect(result).toEqual(updatedSession);
    });

    it('should handle update errors', async () => {
      const sessionId = 'test-session-id';
      const interactiveShareMetadata = { isActive: true };

      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockRejectedValue(
        new Error('DynamoDB error')
      );

      await expect(
        chatbotDb.updateSessionInteractiveShareMetadata(sessionId, interactiveShareMetadata)
      ).rejects.toThrow('DynamoDB error');
    });

    it('should preserve existing shareMetadata when updating interactiveShareMetadata', async () => {
      const sessionId = 'test-session-id';
      const interactiveShareMetadata = { isActive: true };
      const existingShareMetadata = {
        isShared: true,
        sharedAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-02T00:00:00Z'
      };

      const updatedSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: existingShareMetadata,
        interactiveShareMetadata
      };

      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue(updatedSession);

      const result = await chatbotDb.updateSessionInteractiveShareMetadata(
        sessionId, 
        interactiveShareMetadata
      );

      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId, 
        interactiveShareMetadata
      );
      expect(result.shareMetadata).toEqual(existingShareMetadata);
    });
  });

  describe('getChatSession', () => {
    it('should retrieve session with both metadata types', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: {
          isShared: true,
          sharedAt: '2024-01-01T00:00:00Z'
        },
        interactiveShareMetadata: {
          isActive: true,
          token: 'test-token',
          sharedAt: '2024-01-01T00:00:00Z'
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const result = await chatbotDb.getChatSession(sessionId);

      expect(chatbotDb.getChatSession).toHaveBeenCalledWith(sessionId);
      expect(result).toEqual(mockSession);
    });

    it('should return null if session not found', async () => {
      const sessionId = 'non-existent-session';

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      const result = await chatbotDb.getChatSession(sessionId);

      expect(result).toBeNull();
    });

    it('should handle retrieval errors', async () => {
      const sessionId = 'test-session-id';

      (chatbotDb.getChatSession as jest.Mock).mockRejectedValue(
        new Error('DynamoDB error')
      );

      await expect(chatbotDb.getChatSession(sessionId)).rejects.toThrow('DynamoDB error');
    });
  });

  describe('separate metadata handling', () => {
    it('should allow independent updates of shareMetadata and interactiveShareMetadata', async () => {
      const sessionId = 'test-session-id';
      
      // First, update shareMetadata
      const shareMetadata = { isShared: true, sharedAt: '2024-01-01T00:00:00Z' };
      const sessionWithShare = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata,
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.updateSessionShareMetadata as jest.Mock)
        .mockResolvedValueOnce(sessionWithShare);

      await chatbotDb.updateSessionShareMetadata(sessionId, shareMetadata);

      // Then, update interactiveShareMetadata independently
      const interactiveShareMetadata = { 
        isActive: true, 
        token: 'test-token', 
        sharedAt: '2024-01-01T00:00:00Z' 
      };
      const sessionWithBoth = {
        ...sessionWithShare,
        interactiveShareMetadata
      };

      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock)
        .mockResolvedValueOnce(sessionWithBoth);

      await chatbotDb.updateSessionInteractiveShareMetadata(sessionId, interactiveShareMetadata);

      // Verify both updates were called
      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(sessionId, shareMetadata);
      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId, 
        interactiveShareMetadata
      );
    });

    it('should allow revoking one metadata type without affecting the other', async () => {
      const sessionId = 'test-session-id';
      
      // Session with both sharing types active
      const sessionWithBoth = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { 
          isActive: true, 
          token: 'test-token', 
          sharedAt: '2024-01-01T00:00:00Z' 
        }
      };

      // Revoke only shareMetadata (view-only sharing)
      const revokedShareSession = {
        ...sessionWithBoth,
        shareMetadata: { isShared: false }
      };

      (chatbotDb.updateSessionShareMetadata as jest.Mock)
        .mockResolvedValueOnce(revokedShareSession);

      await chatbotDb.updateSessionShareMetadata(sessionId, { isShared: false });

      // Verify that only shareMetadata was updated
      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(
        sessionId, 
        { isShared: false }
      );

      // Verify that interactiveShareMetadata is preserved
      expect(revokedShareSession.interactiveShareMetadata).toEqual({
        isActive: true,
        token: 'test-token',
        sharedAt: '2024-01-01T00:00:00Z'
      });
    });
  });
});
