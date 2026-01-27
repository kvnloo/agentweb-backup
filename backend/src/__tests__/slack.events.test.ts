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
    createOrReuseInteractiveShare: jest.fn(),
  },
}));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-4o',
  },
}));

jest.mock('../utils/sseProgress', () => ({
  emitProgress: jest.fn(),
}));

const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: {
      postMessage: mockPostMessage,
    },
  })),
}));

const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { chatbotDb } = require('../services/chatbotService');
const { generateSessionResponse } = require('../controllers/agentModeController');
const { emitProgress } = require('../utils/sseProgress');
const { WebClient } = require('@slack/web-api');

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

    it('should create ishare session when Emma is mentioned in Slack', async () => {
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

      chatbotDb.createOrReuseInteractiveShare.mockResolvedValue(
        'http://localhost:5173/ishare/session-123?conversable=token-123'
      );

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
            user: 'U12345',
            text: '<@UEMMA123> help me create a blog article',
            channel: 'C12345',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);

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

      // Verify ishare link creation
      expect(chatbotDb.createOrReuseInteractiveShare).toHaveBeenCalledWith('session-123');

      // Verify initial progress emission
      expect(emitProgress).toHaveBeenCalledWith('session-123', {
        iteration: 0,
        status: 'thinking',
      });

      // Verify response generation started
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-123',
        'help me create a blog article',
        'user-123',
        'gpt-4o',
        []
      );

      // Verify Slack message sent
      expect(WebClient).toHaveBeenCalledWith(process.env.SLACK_BOT_TOKEN);
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

      chatbotDb.createOrReuseInteractiveShare.mockResolvedValue(
        'http://localhost:5173/ishare/session-456?conversable=token-456'
      );

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

      // Verify cache miss and fallback to scan
      expect(settingsService.getSetting).toHaveBeenCalledWith('slack_channel_mapping_C67890');
      expect(userDb.getAllUsers).toHaveBeenCalled();

      // Verify cache save
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

      // Verify error message sent to Slack
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C99999',
          text: expect.stringContaining('couldn\'t find a user account linked'),
        })
      );
    });
  });
});
