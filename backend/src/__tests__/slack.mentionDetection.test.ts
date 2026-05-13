/**
 * Tests for third-party @mention detection in Slack Agent Mode sessions.
 *
 * When a user sends a message in a Slack thread that mentions another person
 * (e.g. "@John can you send me the report?"), Emma should receive a context
 * note so she understands the user may be addressing that person rather than her.
 */
import request from 'supertest';
import express from 'express';
import slackRouter from '../routes/slack';

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionSlackThread: jest.fn(),
    getChatSession: jest.fn(),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('http://localhost:5174/ishare/session-123?conversable=abc123'),
    updateSessionLlmModel: jest.fn(),
    updateSessionGtmWorkItem: jest.fn(),
    addMessageToSession: jest.fn(),
  },
}));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-4o'),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  emitProgress: jest.fn(),
}));

jest.mock('../services/gtmPlanService', () => ({
  ensureGtmWorkItemForSlackSession: jest.fn().mockResolvedValue(null),
}));

const mockPostMessage = jest.fn().mockResolvedValue({ ok: true, ts: 'thinking-msg-ts' });
const mockChatDelete = jest.fn().mockResolvedValue({ ok: true });

jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return {
    ...actual,
    postThreadResponse: jest.fn().mockResolvedValue(undefined),
    postThinkingMessage: jest.fn().mockResolvedValue('thinking-msg-ts'),
    deleteSlackMessage: jest.fn().mockResolvedValue(undefined),
    getSlackUserDisplayName: jest.fn().mockResolvedValue('Alice'),
    getSlackUserEmail: jest.fn().mockResolvedValue('alice@customer.com'),
    downloadSlackFile: jest.fn().mockResolvedValue(Buffer.from('file-content')),
    resolveSlackMentionsInText: jest.fn().mockImplementation((text: string) =>
      // Simulate resolution: <@UJOHN> → @John, rest passes through
      Promise.resolve(text.replace(/<@UJOHN>/g, '@John').replace(/<@[A-Z0-9]+>/g, ''))
    ),
  };
});

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: true, url: 'https://s3.example.com/file.png', key: 'file.png' }),
}));

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: {
      postMessage: mockPostMessage,
      delete: mockChatDelete,
    },
    auth: {
      test: jest.fn().mockResolvedValue({ user_id: 'UEMMA123' }),
    },
  })),
}));

const { settingsService } = require('../services/settingsService');
const { chatbotDb } = require('../services/chatbotService');
const { generateSessionResponse } = require('../controllers/agentModeController');

describe('Slack @mention detection in Agent Mode', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();

    // Default mock: return null for GTM work item
    const { ensureGtmWorkItemForSlackSession } = require('../services/gtmPlanService');
    ensureGtmWorkItemForSlackSession.mockResolvedValue(null);
  });

  describe('app_mention with third-party @mention', () => {
    beforeEach(() => {
      settingsService.getSetting.mockResolvedValue({ settingValue: 'user-123' });
      const { userDb } = require('../services/db');
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
        slackChannel: 'C12345',
      });
      chatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        llmModel: 'gpt-4o',
      });
      chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'session-123' });
      generateSessionResponse.mockResolvedValue({ content: 'Emma response', toolCalls: [] });
    });

    it('should append context note when message mentions another person (@John)', async () => {
      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'UALICE',
            text: '<@UEMMA123> <@UJOHN> can you send me the Q2 report?',
            channel: 'C12345',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(generateSessionResponse).toHaveBeenCalled();
      const calledWith = generateSessionResponse.mock.calls[0][1] as string;

      // Should contain the original message content
      expect(calledWith).toContain('@John');
      expect(calledWith).toContain('can you send me the Q2 report?');

      // Should contain the context note about the third-party mention
      expect(calledWith).toContain('[Note:');
      expect(calledWith).toContain('@John');
      expect(calledWith).toContain('may be addressing them rather than you');
    });

    it('should NOT append context note when no @mentions in message', async () => {
      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'UALICE',
            text: '<@UEMMA123> help me write a blog post about AI trends',
            channel: 'C12345',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(generateSessionResponse).toHaveBeenCalled();
      const calledWith = generateSessionResponse.mock.calls[0][1] as string;

      // Should NOT contain the context note
      expect(calledWith).not.toContain('[Note:');
      expect(calledWith).toContain('help me write a blog post about AI trends');
    });
  });

  describe('thread reply in Emma session with third-party @mention', () => {
    beforeEach(() => {
      // Thread mapping found → Emma session (not triggered)
      settingsService.getSetting.mockImplementation((key: string) => {
        if (key === 'slack_thread_C12345_1111111111.111111') {
          return Promise.resolve({
            settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
          });
        }
        return Promise.resolve(null);
      });

      chatbotDb.getChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        llmModel: 'gpt-4o',
      });

      generateSessionResponse.mockResolvedValue({ content: 'Emma response', toolCalls: [] });
    });

    it('should append context note when thread reply mentions @John', async () => {
      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'message',
            user: 'UALICE',
            text: '<@UJOHN> can you share the deck?',
            channel: 'C12345',
            ts: '1234567891.000000',
            thread_ts: '1111111111.111111',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(generateSessionResponse).toHaveBeenCalled();
      const calledWith = generateSessionResponse.mock.calls[0][1] as string;

      expect(calledWith).toContain('@John');
      expect(calledWith).toContain('[Note:');
      expect(calledWith).toContain('may be addressing them rather than you');
    });

    it('should NOT append context note when thread reply has no @mentions', async () => {
      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'message',
            user: 'UALICE',
            text: 'please follow up on the earlier task',
            channel: 'C12345',
            ts: '1234567891.000000',
            thread_ts: '1111111111.111111',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(generateSessionResponse).toHaveBeenCalled();
      const calledWith = generateSessionResponse.mock.calls[0][1] as string;

      expect(calledWith).not.toContain('[Note:');
    });

    it('should include multiple @mentions in the context note', async () => {
      const { resolveSlackMentionsInText } = require('../services/slackService');
      resolveSlackMentionsInText.mockImplementation((text: string) =>
        Promise.resolve(
          text
            .replace(/<@UJOHN>/g, '@John')
            .replace(/<@USARAH>/g, '@Sarah')
            .replace(/<@[A-Z0-9]+>/g, '')
        )
      );

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'message',
            user: 'UALICE',
            text: '<@UJOHN> and <@USARAH> please review this',
            channel: 'C12345',
            ts: '1234567891.000000',
            thread_ts: '1111111111.111111',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(generateSessionResponse).toHaveBeenCalled();
      const calledWith = generateSessionResponse.mock.calls[0][1] as string;

      expect(calledWith).toContain('@John');
      expect(calledWith).toContain('@Sarah');
      expect(calledWith).toContain('[Note:');
    });
  });
});
