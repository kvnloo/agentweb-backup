import request from 'supertest';
import express from 'express';
import slackRouter from '../routes/slack';

// Mock dependencies
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
  },
}));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-4o',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-4o'),
  },
}));

jest.mock('../utils/sseProgress', () => ({
  emitProgress: jest.fn(),
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
    getSlackUserDisplayName: jest.fn().mockResolvedValue('John Doe'),
    downloadSlackFile: jest.fn().mockResolvedValue(Buffer.from('file-content')),
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
  })),
}));

const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { chatbotDb } = require('../services/chatbotService');
const { generateSessionResponse } = require('../controllers/agentModeController');
const { postThreadResponse, postThinkingMessage, deleteSlackMessage, getSlackUserDisplayName } = require('../services/slackService');

describe('Slack Events API', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();
  });

  describe('POST /api/slack/events', () => {
    it('should handle URL verification challenge', async () => {
      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'url_verification',
          challenge: 'test-challenge-string',
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ challenge: 'test-challenge-string' });
    });

    it('should reply in-thread when Emma is mentioned in Slack', async () => {
      // Mock user lookup from cache
      settingsService.getSetting.mockResolvedValue({
        settingValue: 'user-123',
      });

      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
        slackChannel: 'C12345',
      });

      // Mock session creation
      chatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        llmModel: 'gpt-4o',
      });

      chatbotDb.updateSessionSlackThread.mockResolvedValue({
        sessionId: 'session-123',
      });

      generateSessionResponse.mockResolvedValue({
        content: 'Here is your blog article!',
        toolCalls: [],
      });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U12345',
            text: '<@UEMMA123> help me create a blog article',
            channel: 'C12345',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);

      // Wait for async event processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify user lookup from cache
      expect(settingsService.getSetting).toHaveBeenCalledWith('slack_channel_mapping_C12345');
      expect(userDb.getUserById).toHaveBeenCalledWith('user-123');

      // Verify session creation
      expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
        'user-123',
        undefined,
        'agent',
        'slack-bot',
        undefined,
        undefined,
        undefined,
        undefined,
        'regular',
        undefined
      );

      // Verify session title update
      expect(chatbotDb.updateSessionTitle).toHaveBeenCalledWith(
        'session-123',
        'help me create a blog article'
      );

      // Verify slack thread association
      expect(chatbotDb.updateSessionSlackThread).toHaveBeenCalledWith(
        'session-123',
        { channel: 'C12345', threadTs: '1234567890.123456' }
      );

      // Verify thread-to-session mapping saved
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'slack_thread_C12345_1234567890.123456',
        JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        'Slack thread to session mapping',
        'system'
      );

      // Verify thinking message posted
      expect(postThinkingMessage).toHaveBeenCalledWith('C12345', '1234567890.123456');

      // Verify response generation (message prefixed with display name)
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-123',
        'John Doe: help me create a blog article',
        'user-123',
        'gpt-4o',
        []
      );

      // Verify thinking message deleted
      expect(deleteSlackMessage).toHaveBeenCalledWith('C12345', 'thinking-msg-ts');

      // Verify response posted to thread
      expect(postThreadResponse).toHaveBeenCalledWith(
        'C12345',
        '1234567890.123456',
        'Here is your blog article!'
      );

      // Verify iShare link posted as follow-up
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C12345',
          thread_ts: '1234567890.123456',
          text: expect.stringContaining('Continue chat by simply reply or click to chat in AgentWeb portal'),
        })
      );
    });

    it('should handle user not found in cache by scanning all users', async () => {
      // Mock cache miss
      settingsService.getSetting.mockResolvedValue(null);

      // Mock getAllUsers scan
      userDb.getAllUsers.mockResolvedValue([
        {
          userId: 'user-456',
          email: 'test2@example.com',
          slackChannel: 'C67890',
        },
      ]);

      chatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-456',
        userId: 'user-456',
        messages: [],
      });

      chatbotDb.updateSessionSlackThread.mockResolvedValue({
        sessionId: 'session-456',
      });

      generateSessionResponse.mockResolvedValue({
        content: 'Test response',
        toolCalls: [],
      });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U67890',
            text: '<@UEMMA123> test message',
            channel: 'C67890',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);

      // Wait for async event processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify cache miss and fallback to scan
      expect(settingsService.getSetting).toHaveBeenCalledWith('slack_channel_mapping_C67890');
      expect(userDb.getAllUsers).toHaveBeenCalled();

      // Verify channel cache save
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'slack_channel_mapping_C67890',
        'user-456',
        'Slack channel to userId mapping for channel C67890',
        'system'
      );
    });

    it('should send error message when user not found for channel', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      userDb.getAllUsers.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U99999',
            text: '<@UEMMA123> test',
            channel: 'C99999',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);

      // Wait for async event processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify error message sent to Slack
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C99999',
          text: expect.stringContaining('couldn\'t find a user account linked'),
        })
      );
    });

    describe('Thread message handling', () => {
      it('should forward thread replies to existing Emma session', async () => {
        // Mock thread-to-session mapping exists
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        });

        chatbotDb.getChatSession.mockResolvedValue({
          sessionId: 'session-123',
          userId: 'user-123',
          messages: [],
          llmModel: 'gpt-4o',
        });

        generateSessionResponse.mockResolvedValue({
          content: 'Here is my follow-up response.',
          toolCalls: [],
        });

        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              user: 'U12345',
              text: 'Can you also add some images?',
              channel: 'C12345',
              ts: '1234567891.000000',
              thread_ts: '1234567890.123456',
            },
          });

        expect(response.status).toBe(200);

        // Wait for async event processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify thread mapping lookup
        expect(settingsService.getSetting).toHaveBeenCalledWith(
          'slack_thread_C12345_1234567890.123456'
        );

        // Verify session lookup
        expect(chatbotDb.getChatSession).toHaveBeenCalledWith('session-123');

        // Verify user display name fetched
        expect(getSlackUserDisplayName).toHaveBeenCalledWith('U12345');

        // Verify thinking message posted
        expect(postThinkingMessage).toHaveBeenCalledWith('C12345', '1234567890.123456');

        // Verify message forwarded with username prefix
        expect(generateSessionResponse).toHaveBeenCalledWith(
          'session-123',
          'John Doe: Can you also add some images?',
          'user-123',
          'gpt-4o',
          []
        );

        // Verify response posted back to thread
        expect(postThreadResponse).toHaveBeenCalledWith(
          'C12345',
          '1234567890.123456',
          'Here is my follow-up response.'
        );
      });

      it('should ignore messages not in a tracked thread', async () => {
        // Mock no thread mapping found
        settingsService.getSetting.mockResolvedValue(null);

        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              user: 'U12345',
              text: 'Some random thread message',
              channel: 'C12345',
              ts: '1234567891.000000',
              thread_ts: '9999999999.999999',
            },
          });

        expect(response.status).toBe(200);

        // Wait for async event processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should not generate a response
        expect(generateSessionResponse).not.toHaveBeenCalled();
      });

      it('should ignore bot messages in threads', async () => {
        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              bot_id: 'B12345',
              text: 'Bot reply',
              channel: 'C12345',
              ts: '1234567891.000000',
              thread_ts: '1234567890.123456',
            },
          });

        expect(response.status).toBe(200);

        // Wait for async event processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Should not even look up the thread mapping
        expect(generateSessionResponse).not.toHaveBeenCalled();
      });
    });
  });
});
