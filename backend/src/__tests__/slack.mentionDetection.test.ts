/**
 * Tests that Slack Agent Mode sessions pass clean messages to Emma (no injected [Note:] suffix).
 * Third-party @mention awareness is handled via the system prompt, not per-message injection.
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

describe('Slack @mention handling in Agent Mode', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();

    const { ensureGtmWorkItemForSlackSession } = require('../services/gtmPlanService');
    ensureGtmWorkItemForSlackSession.mockResolvedValue(null);
  });

  describe('app_mention — message is passed cleanly to Emma', () => {
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

    it('passes message with third-party @mention to Emma without injected [Note:] suffix', async () => {
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

      expect(calledWith).toContain('@John');
      expect(calledWith).toContain('can you send me the Q2 report?');
      // No injected note — awareness is via system prompt only
      expect(calledWith).not.toContain('[Note:');
    });

    it('passes plain message to Emma without any suffix', async () => {
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

      expect(calledWith).not.toContain('[Note:');
      expect(calledWith).toContain('help me write a blog post about AI trends');
    });
  });

  describe('thread reply in Emma session — message passed cleanly', () => {
    beforeEach(() => {
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

    it('passes thread reply with @mention to Emma without injected [Note:] suffix', async () => {
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
      expect(calledWith).not.toContain('[Note:');
    });

    it('passes thread reply without @mention to Emma cleanly', async () => {
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
      expect(calledWith).toContain('please follow up on the earlier task');
    });
  });
});
