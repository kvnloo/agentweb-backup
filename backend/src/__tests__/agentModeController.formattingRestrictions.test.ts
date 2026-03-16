import { agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { generateSessionResponse } from '../controllers/agentModeController';
import { v4 as uuidv4 } from 'uuid';

// Mock dependencies
jest.mock('../services/agentModeService');
jest.mock('../services/chatbotService');
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn().mockResolvedValue({
      content: 'Plain text response without any markdown or HTML formatting',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [
        {
          role: 'assistant',
          content: 'Plain text response without any markdown or HTML formatting',
          timestamp: new Date().toISOString()
        }
      ]
    })
  }
}));

describe('AgentModeController - Formatting Restrictions', () => {
  const mockUserId = 'test-user-123';
  const mockSessionId = uuidv4();
  const baseSystemPrompt = `You are Emma, a helpful marketing assistant.

## Response Formatting
Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms`;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock getMarketingSystemPrompt to return base prompt
    (agentModeService.getMarketingSystemPrompt as jest.Mock).mockResolvedValue(baseSystemPrompt);

    // Mock generateSessionTitle
    (agentModeService.generateSessionTitle as jest.Mock).mockResolvedValue('Test Session');
  });

  describe('detectFormattingRestrictions integration', () => {
    it('should append formatting override when user says "no markdown"', async () => {
      const userMessage = 'Generate a LinkedIn post with no markdown formatting';

      // Mock empty session (first message)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        portalType: 'agent'
      });

      // Mock addMessageToSession to capture the system message
      let capturedSystemMessage: any = null;
      (chatbotDb.addMessageToSession as jest.Mock).mockImplementation((sessionId, message) => {
        if (message.role === 'system') {
          capturedSystemMessage = message;
        }
        return Promise.resolve();
      });

      // Mock addMessagesToSession
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      await generateSessionResponse(mockSessionId, userMessage, mockUserId, 'gpt-4');

      // Verify system message was added with formatting override
      expect(capturedSystemMessage).toBeTruthy();
      expect(capturedSystemMessage.content).toContain('CRITICAL FORMATTING OVERRIDE');
      expect(capturedSystemMessage.content).toContain('NO MARKDOWN SYNTAX');
      expect(capturedSystemMessage.content).toContain('NO HTML TAGS');
      expect(capturedSystemMessage.content).toContain('PLAIN TEXT ONLY');
    });

    it('should append formatting override when user says "plain text only"', async () => {
      const userMessage = 'Create a social media post in plain text only format';

      // Mock empty session (first message)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        portalType: 'agent'
      });

      // Mock addMessageToSession to capture the system message
      let capturedSystemMessage: any = null;
      (chatbotDb.addMessageToSession as jest.Mock).mockImplementation((sessionId, message) => {
        if (message.role === 'system') {
          capturedSystemMessage = message;
        }
        return Promise.resolve();
      });

      // Mock addMessagesToSession
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      await generateSessionResponse(mockSessionId, userMessage, mockUserId, 'gpt-4');

      // Verify system message was added with formatting override
      expect(capturedSystemMessage).toBeTruthy();
      expect(capturedSystemMessage.content).toContain('CRITICAL FORMATTING OVERRIDE');
      expect(capturedSystemMessage.content).toContain('explicitly requested plain text formatting');
    });

    it('should append formatting override when user says "text only"', async () => {
      const userMessage = 'Generate content text only no HTML';

      // Mock empty session (first message)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        portalType: 'agent'
      });

      // Mock addMessageToSession to capture the system message
      let capturedSystemMessage: any = null;
      (chatbotDb.addMessageToSession as jest.Mock).mockImplementation((sessionId, message) => {
        if (message.role === 'system') {
          capturedSystemMessage = message;
        }
        return Promise.resolve();
      });

      // Mock addMessagesToSession
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      await generateSessionResponse(mockSessionId, userMessage, mockUserId, 'gpt-4');

      // Verify system message was added with formatting override
      expect(capturedSystemMessage).toBeTruthy();
      expect(capturedSystemMessage.content).toContain('CRITICAL FORMATTING OVERRIDE');
    });

    it('should NOT append formatting override for normal messages', async () => {
      const userMessage = 'Generate a LinkedIn post about marketing strategies';

      // Mock empty session (first message)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        portalType: 'agent'
      });

      // Mock addMessageToSession to capture the system message
      let capturedSystemMessage: any = null;
      (chatbotDb.addMessageToSession as jest.Mock).mockImplementation((sessionId, message) => {
        if (message.role === 'system') {
          capturedSystemMessage = message;
        }
        return Promise.resolve();
      });

      // Mock addMessagesToSession
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      await generateSessionResponse(mockSessionId, userMessage, mockUserId, 'gpt-4');

      // Verify system message does NOT contain formatting override
      expect(capturedSystemMessage).toBeTruthy();
      expect(capturedSystemMessage.content).not.toContain('CRITICAL FORMATTING OVERRIDE');
      expect(capturedSystemMessage.content).toBe(baseSystemPrompt);
    });

    it('should only add system message on first user message', async () => {
      const userMessage = 'Follow-up message with no markdown';

      // Mock session with existing messages (not first message)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [
          { role: 'system', content: baseSystemPrompt },
          { role: 'user', content: 'Previous message' },
          { role: 'assistant', content: 'Previous response' }
        ],
        portalType: 'agent'
      });

      // Mock addMessageToSession to capture messages
      let systemMessageAdded = false;
      (chatbotDb.addMessageToSession as jest.Mock).mockImplementation((sessionId, message) => {
        if (message.role === 'system') {
          systemMessageAdded = true;
        }
        return Promise.resolve();
      });

      // Mock addMessagesToSession
      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      await generateSessionResponse(mockSessionId, userMessage, mockUserId, 'gpt-4');

      // Verify NO system message was added (since it's not the first message)
      expect(systemMessageAdded).toBe(false);
    });

    it('should handle "without markdown" pattern', async () => {
      const userMessage = 'Create a post without markdown please';

      // Mock empty session (first message)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        portalType: 'agent'
      });

      let capturedSystemMessage: any = null;
      (chatbotDb.addMessageToSession as jest.Mock).mockImplementation((sessionId, message) => {
        if (message.role === 'system') {
          capturedSystemMessage = message;
        }
        return Promise.resolve();
      });

      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      await generateSessionResponse(mockSessionId, userMessage, mockUserId, 'gpt-4');

      expect(capturedSystemMessage).toBeTruthy();
      expect(capturedSystemMessage.content).toContain('CRITICAL FORMATTING OVERRIDE');
    });

    it('should handle "no formatting" pattern', async () => {
      const userMessage = 'Generate content with no formatting whatsoever';

      // Mock empty session (first message)
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        sessionId: mockSessionId,
        userId: mockUserId,
        messages: [],
        portalType: 'agent'
      });

      let capturedSystemMessage: any = null;
      (chatbotDb.addMessageToSession as jest.Mock).mockImplementation((sessionId, message) => {
        if (message.role === 'system') {
          capturedSystemMessage = message;
        }
        return Promise.resolve();
      });

      (chatbotDb.addMessagesToSession as jest.Mock).mockResolvedValue(undefined);

      await generateSessionResponse(mockSessionId, userMessage, mockUserId, 'gpt-4');

      expect(capturedSystemMessage).toBeTruthy();
      expect(capturedSystemMessage.content).toContain('CRITICAL FORMATTING OVERRIDE');
    });
  });
});
