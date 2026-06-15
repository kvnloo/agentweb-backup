import request from 'supertest';
import express from 'express';
import slackRouter from '../routes/slack';

// --- Mocks -----------------------------------------------------------------

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
    getUserById: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
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
  },
}));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-4o',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-4o'),
    triageSlackMessage: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendSlackTriggeredSessionEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

// slackService helpers used by the triggered flow
jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return {
    ...actual,
    getSlackUserEmail: jest.fn().mockResolvedValue('customer@external.com'),
    getSlackUserDisplayName: jest.fn().mockResolvedValue('Jane Customer'),
    resolveSlackMentionsInText: jest.fn().mockImplementation(async (t: string) => t),
  };
});

// @slack/web-api — bot auth lookup + conversations.info
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    auth: { test: jest.fn().mockResolvedValue({ user_id: 'UEMMA_BOT' }) },
    chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) },
    conversations: { info: jest.fn().mockResolvedValue({ channel: { name: 'customer-channel' } }) },
  })),
}));

const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { chatbotDb } = require('../services/chatbotService');
const { generateSessionResponse } = require('../controllers/agentModeController');
const { agentModeService } = require('../services/agentModeService');
const { emailService } = require('../services/emailService');

const mockTriage = agentModeService.triageSlackMessage as jest.Mock;
const mockSendSlackTriggeredSessionEmail = emailService.sendSlackTriggeredSessionEmail as jest.Mock;

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('Slack suggested-reply gating (slackSuggestedRepliesDisabled)', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();

    // Channel resolves to a user via cache
    settingsService.getSetting.mockResolvedValue({ settingValue: 'user-123' });
    mockTriage.mockResolvedValue(true);
    chatbotDb.createChatSession.mockResolvedValue({ sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o' });
    chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'session-123' });
    generateSessionResponse.mockResolvedValue({ content: 'Draft reply', toolCalls: [] });
  });

  const topLevelMessage = () =>
    request(app)
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U_CUSTOMER',
          text: 'Hey, can someone help with my campaign?',
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      });

  it('does NOT triage or email when the user has suggested replies disabled', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      slackChannels: ['C12345'],
      slackSuggestedRepliesDisabled: true,
    });

    const res = await topLevelMessage();
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).not.toHaveBeenCalled();
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
  });

  it('triages and emails the suggested reply when the flag is absent (default enabled)', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      slackChannels: ['C12345'],
    });

    const res = await topLevelMessage();
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).toHaveBeenCalledWith('Hey, can someone help with my campaign?');
    expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalledWith(
      'founders@agentweb.pro',
      expect.objectContaining({ sessionId: 'session-123', userEmail: 'customer@example.com' })
    );
  });

  it('triages and emails when the flag is explicitly false (enabled)', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      slackChannels: ['C12345'],
      slackSuggestedRepliesDisabled: false,
    });

    const res = await topLevelMessage();
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalled();
  });

  describe('monitored thread-reply path', () => {
    const threadReply = () =>
      request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'message',
            user: 'U_CUSTOMER',
            text: 'Following up on this',
            channel: 'C12345',
            ts: '1234567891.000000',
            thread_ts: '1234567890.123456',
          },
        });

    beforeEach(() => {
      // Thread mapping marks this as a monitored (triggered) session
      settingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123', type: 'triggered' }),
      });
      chatbotDb.getChatSession.mockResolvedValue({ sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o' });
    });

    it('does NOT generate a response or email when disabled', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        slackChannels: ['C12345'],
        slackSuggestedRepliesDisabled: true,
      });

      const res = await threadReply();
      expect(res.status).toBe(200);
      await flushAsync();

      expect(generateSessionResponse).not.toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
    });

    it('generates a response and emails when enabled', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        slackChannels: ['C12345'],
      });

      const res = await threadReply();
      expect(res.status).toBe(200);
      await flushAsync();

      expect(generateSessionResponse).toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalled();
    });
  });
});
