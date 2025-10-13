import request from 'supertest';
import express from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';

// Mock the chatbotDb service
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionShareMetadata: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  }
}));

// Mock the User type
interface User {
  userId: string;
  email: string;
}

// Create a test app
const createTestApp = () => {
  const app = express();
  app.use(express.json());

  // Mock authentication middleware
  app.use((req, res, next) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' } as User;
    next();
  });

  // Add routes
  app.post('/api/agent-mode/share', agentModeController.createShareLink);
  app.delete('/api/agent-mode/session/:sessionId/share', agentModeController.stopSharing);
  app.post('/api/agent-mode/conversable-share', agentModeController.createConversableShare);
  app.delete('/api/agent-mode/session/:sessionId/conversable-share', agentModeController.stopConversableShare);
  app.get('/api/agent-mode/share/:shareId', agentModeController.getSharedConversation);
  app.post('/api/agent-mode/share/:shareId/generate', agentModeController.generateSharedResponse);

  return app;
};

describe('Sharing Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  describe('Complete Sharing Workflow', () => {
    it('should handle complete sharing workflow with separate metadata', async () => {
      const sessionId = 'test-session-id';
      const mockSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        pageIdentifier: 'agent-mode',
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { isActive: false }
      };

      // Mock initial session retrieval
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      // Step 1: Create view-only share
      const viewOnlyResponse = await request(app)
        .post('/api/agent-mode/share')
        .send({ sessionId })
        .expect(200);

      expect(viewOnlyResponse.body).toHaveProperty('shareId', sessionId);
      expect(viewOnlyResponse.body).toHaveProperty('shareUrl');
      expect(viewOnlyResponse.body.shareUrl).toContain(`/share/${sessionId}`);

      // Verify shareMetadata was updated
      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { isShared: true, sharedAt: expect.any(String) }
      );

      // Step 2: Create interactive share
      const interactiveResponse = await request(app)
        .post('/api/agent-mode/conversable-share')
        .send({ sessionId })
        .expect(200);

      expect(interactiveResponse.body).toHaveProperty('shareId', sessionId);
      expect(interactiveResponse.body).toHaveProperty('conversableToken');
      expect(interactiveResponse.body).toHaveProperty('conversableUrl');
      expect(interactiveResponse.body.conversableUrl).toContain(`/ishare/${sessionId}?conversable=`);

      // Verify interactiveShareMetadata was updated
      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isActive: true, 
          token: expect.any(String), 
          sharedAt: expect.any(String) 
        }
      );

      // Step 3: Test view-only access
      const sessionWithBothShares = {
        ...mockSession,
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { 
          isActive: true, 
          token: 'test-token', 
          sharedAt: '2024-01-01T00:00:00Z' 
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithBothShares);

      const viewOnlyAccessResponse = await request(app)
        .get(`/api/agent-mode/share/${sessionId}`)
        .expect(200);

      expect(viewOnlyAccessResponse.body.session).toHaveProperty('shareMetadata');
      expect(viewOnlyAccessResponse.body.session).toHaveProperty('interactiveShareMetadata');
      expect(viewOnlyAccessResponse.body.session.shareMetadata.isShared).toBe(true);
      expect(viewOnlyAccessResponse.body.session.interactiveShareMetadata.isActive).toBe(true);
      expect(viewOnlyAccessResponse.body.session.isConversable).toBe(false);

      // Step 4: Test interactive access
      const interactiveAccessResponse = await request(app)
        .get(`/api/agent-mode/share/${sessionId}?conversable=test-token`)
        .expect(200);

      expect(interactiveAccessResponse.body.session).toHaveProperty('shareMetadata');
      expect(interactiveAccessResponse.body.session).toHaveProperty('interactiveShareMetadata');
      expect(interactiveAccessResponse.body.session.shareMetadata.isShared).toBe(true);
      expect(interactiveAccessResponse.body.session.interactiveShareMetadata.isActive).toBe(true);
      expect(interactiveAccessResponse.body.session.isConversable).toBe(true);

      // Step 5: Revoke view-only share (should preserve interactive share)
      const sessionWithOnlyInteractive = {
        ...sessionWithBothShares,
        shareMetadata: { isShared: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithBothShares);
      (chatbotDb.updateSessionShareMetadata as jest.Mock).mockResolvedValue(sessionWithOnlyInteractive);

      await request(app)
        .delete(`/api/agent-mode/session/${sessionId}/share`)
        .expect(200);

      // Verify only shareMetadata was updated
      expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isShared: false,
          sharedAt: "2024-01-01T00:00:00Z"
        }
      );

      // Step 6: Verify interactive share still works
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithOnlyInteractive);

      const interactiveStillWorksResponse = await request(app)
        .get(`/api/agent-mode/share/${sessionId}?conversable=test-token`)
        .expect(200);

      expect(interactiveStillWorksResponse.body.session.shareMetadata.isShared).toBe(false);
      expect(interactiveStillWorksResponse.body.session.interactiveShareMetadata.isActive).toBe(true);

      // Step 7: Revoke interactive share
      const sessionWithNoShares = {
        ...sessionWithOnlyInteractive,
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithOnlyInteractive);
      (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mockResolvedValue(sessionWithNoShares);

      await request(app)
        .delete(`/api/agent-mode/session/${sessionId}/conversable-share`)
        .expect(200);

      // Verify only interactiveShareMetadata was updated (check the last call)
      const lastCall = (chatbotDb.updateSessionInteractiveShareMetadata as jest.Mock).mock.calls.slice(-1)[0];
      expect(lastCall).toEqual([
        sessionId,
        { 
          isActive: false,
          sharedAt: "2024-01-01T00:00:00Z",
          token: "test-token"
        }
      ]);

      // Step 8: Verify no sharing is available
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithNoShares);

      await request(app)
        .get(`/api/agent-mode/share/${sessionId}`)
        .expect(404);
    });

    it('should handle independent sharing creation', async () => {
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
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { isActive: false }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      // Create only interactive share (no view-only share)
      const interactiveResponse = await request(app)
        .post('/api/agent-mode/conversable-share')
        .send({ sessionId })
        .expect(200);

      expect(interactiveResponse.body).toHaveProperty('conversableToken');
      expect(interactiveResponse.body).toHaveProperty('conversableUrl');

      // Verify only interactiveShareMetadata was updated
      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isActive: true, 
          token: expect.any(String), 
          sharedAt: expect.any(String) 
        }
      );

      // Verify shareMetadata was not touched
      expect(chatbotDb.updateSessionShareMetadata).not.toHaveBeenCalled();
    });

    it('should handle independent sharing revocation', async () => {
      const sessionId = 'test-session-id';
      const sessionWithBothShares = {
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

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sessionWithBothShares);

      // Revoke only interactive share
      await request(app)
        .delete(`/api/agent-mode/session/${sessionId}/conversable-share`)
        .expect(200);

      // Verify only interactiveShareMetadata was updated
      expect(chatbotDb.updateSessionInteractiveShareMetadata).toHaveBeenCalledWith(
        sessionId,
        { 
          isActive: false,
          sharedAt: "2024-01-01T00:00:00Z",
          token: "test-token"
        }
      );

      // Verify shareMetadata was not touched
      expect(chatbotDb.updateSessionShareMetadata).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle session not found errors', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(null);

      await request(app)
        .post('/api/agent-mode/share')
        .send({ sessionId: 'non-existent-session' })
        .expect(404);

      await request(app)
        .post('/api/agent-mode/conversable-share')
        .send({ sessionId: 'non-existent-session' })
        .expect(404);

      await request(app)
        .get('/api/agent-mode/share/non-existent-session')
        .expect(404);
    });

    it('should handle invalid conversable tokens', async () => {
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
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { 
          isActive: true, 
          token: 'valid-token', 
          sharedAt: '2024-01-01T00:00:00Z' 
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      await request(app)
        .get(`/api/agent-mode/share/${sessionId}?conversable=invalid-token`)
        .expect(401);

      await request(app)
        .post(`/api/agent-mode/share/${sessionId}/generate`)
        .send({ 
          userMessage: 'Hello',
          conversable: 'invalid-token'
        })
        .expect(401);
    });

    it('should handle missing user message in generate request', async () => {
      await request(app)
        .post('/api/agent-mode/share/test-session-id/generate')
        .send({})
        .expect(400);
    });
  });

  describe('Metadata Separation', () => {
    it('should maintain separate metadata objects', async () => {
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
        shareMetadata: { isShared: true, sharedAt: '2024-01-01T00:00:00Z' },
        interactiveShareMetadata: { 
          isActive: true, 
          token: 'test-token', 
          sharedAt: '2024-01-01T00:00:00Z' 
        }
      };

      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(mockSession);

      const response = await request(app)
        .get(`/api/agent-mode/share/${sessionId}`)
        .expect(200);

      // Verify both metadata objects are present and separate
      expect(response.body.session).toHaveProperty('shareMetadata');
      expect(response.body.session).toHaveProperty('interactiveShareMetadata');
      
      // Verify they are separate objects
      expect(response.body.session.shareMetadata).not.toBe(response.body.session.interactiveShareMetadata);
      
      // Verify their structures are correct
      expect(response.body.session.shareMetadata).toHaveProperty('isShared');
      expect(response.body.session.shareMetadata).toHaveProperty('sharedAt');
      
      expect(response.body.session.interactiveShareMetadata).toHaveProperty('isActive');
      expect(response.body.session.interactiveShareMetadata).toHaveProperty('token');
      expect(response.body.session.interactiveShareMetadata).toHaveProperty('sharedAt');
    });
  });
});
