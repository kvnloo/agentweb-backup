import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import slackRouter from '../routes/slack';

// Mock dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    invalidateSlackChannelMappings: jest.fn(),
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
const mockApiCall = jest.fn().mockResolvedValue({ ok: true });

jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return {
    ...actual,
    postThreadResponse: jest.fn().mockResolvedValue(undefined),
    postThinkingMessage: jest.fn().mockResolvedValue('thinking-msg-ts'),
    deleteSlackMessage: jest.fn().mockResolvedValue(undefined),
    setSlackAssistantStatus: jest.fn().mockResolvedValue(undefined),
    getSlackUserDisplayName: jest.fn().mockResolvedValue('John Doe'),
    getSlackUserEmail: jest.fn().mockResolvedValue('operator@agentweb.pro'),
    getSlackUserTeamId: jest.fn().mockResolvedValue(null),
    getOwnSlackTeamId: jest.fn().mockResolvedValue('TAGENTWEB'),
    downloadSlackFile: jest.fn().mockResolvedValue(Buffer.from('file-content')),
  };
});

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: true, url: 'https://s3.example.com/file.png', key: 'file.png' }),
}));

jest.mock('../services/humanEvalService', () => ({
  humanEvalService: { handleSlackThreadReply: jest.fn() },
}));

jest.mock('../services/loopSlackApprovalDispatcher', () => ({
  handleLoopApprovalReaction: jest.fn(),
  getEmmaBotUserId: jest.fn().mockResolvedValue('UEMMA123'),
}));

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: {
      postMessage: mockPostMessage,
      delete: mockChatDelete,
    },
    apiCall: mockApiCall,
  })),
}));

const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { chatbotDb } = require('../services/chatbotService');
const { generateSessionResponse } = require('../controllers/agentModeController');
const { postThreadResponse, postThinkingMessage, deleteSlackMessage, setSlackAssistantStatus, getSlackUserDisplayName, getSlackUserEmail, getSlackUserTeamId, getOwnSlackTeamId } = require('../services/slackService');
const { humanEvalService } = require('../services/humanEvalService');
const { getEmmaBotUserId } = require('../services/loopSlackApprovalDispatcher');

function slackSignature(rawBody: string, timestamp: number, secret: string): string {
  return `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

describe('Slack Events API', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json({ verify: (req: any, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();
    getEmmaBotUserId.mockResolvedValue('UEMMA123');
    userDb.getUserById.mockResolvedValue({ userId: 'user-123', email: 'test@example.com', slackChannel: 'C12345' });
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

    it('rejects unsigned event callbacks before mapped-session execution', async () => {
      process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
      try {
        const response = await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: { type: 'app_mention', user: 'U12345', text: '<@UEMMA123> continue', channel: 'C12345', ts: '2', thread_ts: '1' },
        });
        expect(response.status).toBe(401);
        expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
      } finally {
        delete process.env.SLACK_SIGNING_SECRET;
      }
    });

    it('accepts a fresh correctly signed Slack URL verification request', async () => {
      const secret = 'test-signing-secret';
      process.env.SLACK_SIGNING_SECRET = secret;
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'signed-challenge' });
      try {
        const response = await request(app)
          .post('/api/slack/events')
          .set('content-type', 'application/json')
          .set('x-slack-request-timestamp', String(timestamp))
          .set('x-slack-signature', slackSignature(rawBody, timestamp, secret))
          .send(rawBody);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ challenge: 'signed-challenge' });
      } finally {
        delete process.env.SLACK_SIGNING_SECRET;
      }
    });

    it('rejects a correctly signed Slack request with a stale timestamp', async () => {
      const secret = 'test-signing-secret';
      process.env.SLACK_SIGNING_SECRET = secret;
      const timestamp = Math.floor(Date.now() / 1000) - 301;
      const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'stale' });
      try {
        const response = await request(app)
          .post('/api/slack/events')
          .set('content-type', 'application/json')
          .set('x-slack-request-timestamp', String(timestamp))
          .set('x-slack-signature', slackSignature(rawBody, timestamp, secret))
          .send(rawBody);
        expect(response.status).toBe(401);
      } finally {
        delete process.env.SLACK_SIGNING_SECRET;
      }
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

      expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', '1234567890.123456', 'is working...');

      // Verify response generation (message prefixed with display name)
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-123',
        'John Doe: help me create a blog article',
        'user-123',
        'gpt-4o',
        []
      );

      expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', '1234567890.123456', '');
      expect(postThinkingMessage).not.toHaveBeenCalled();
      expect(deleteSlackMessage).not.toHaveBeenCalled();

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

    it('uses the root thread timestamp for threaded empty-message validation', async () => {
      const response = await request(app).post('/api/slack/events').send({
        type: 'event_callback',
        event: {
          type: 'app_mention', user: 'U12345', text: '<@UEMMA123>',
          channel: 'C12345', ts: 'reply-ts', thread_ts: 'root-ts',
        },
      });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C12345', thread_ts: 'root-ts',
        text: expect.stringContaining('Please include a message'),
      }));
    });

    it('uses the root thread timestamp for threaded app-mention errors', async () => {
      settingsService.getSetting.mockRejectedValueOnce(new Error('settings unavailable'));

      const response = await request(app).post('/api/slack/events').send({
        type: 'event_callback',
        event: {
          type: 'app_mention', user: 'U12345', text: '<@UEMMA123> help',
          channel: 'C12345', ts: 'reply-ts', thread_ts: 'root-ts',
        },
      });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C12345', thread_ts: 'root-ts',
        text: expect.stringContaining('something went wrong'),
      }));
    });

    it('should pass file attachments to Emma when app_mention includes files', async () => {
      const { uploadFileToS3 } = require('../utils/s3Utils');
      const { downloadSlackFile } = require('../services/slackService');

      settingsService.getSetting.mockResolvedValue({
        settingValue: 'user-123',
      });

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

      generateSessionResponse.mockResolvedValue({
        content: 'Yes, I can see the image!',
        toolCalls: [],
      });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U12345',
            text: '<@UEMMA123> can you see this image?',
            channel: 'C12345',
            ts: '1234567890.123456',
            files: [
              {
                url_private: 'https://files.slack.com/screenshot.png',
                name: 'screenshot.png',
                size: 420858,
                mimetype: 'image/png',
              },
            ],
          },
        });

      expect(response.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify file was downloaded from Slack and uploaded to S3
      expect(downloadSlackFile).toHaveBeenCalledWith('https://files.slack.com/screenshot.png');
      expect(uploadFileToS3).toHaveBeenCalledWith(
        Buffer.from('file-content'),
        'screenshot.png',
        'user-123',
        'image/png'
      );

      // Verify Emma received the message with the attachment
      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-123',
        'John Doe: can you see this image?',
        'user-123',
        'gpt-4o',
        [
          {
            url: 'https://s3.example.com/file.png',
            filename: 'screenshot.png',
            size: 420858,
            mimetype: 'image/png',
          },
        ]
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

    it('ENG-1292: names the concrete remedy (not "contact support") when neither the channel nor the requester\'s Slack identity resolves', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      userDb.getAllUsers.mockResolvedValue([]);
      // Default factory mock resolves an email with no matching AgentWeb account
      getSlackUserEmail.mockResolvedValue('operator@agentweb.pro');
      userDb.getUserByEmail.mockResolvedValue(undefined);

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

      // AC 2: attempted the identity fallback before giving up
      expect(getSlackUserEmail).toHaveBeenCalledWith('U99999');
      expect(userDb.getUserByEmail).toHaveBeenCalledWith('operator@agentweb.pro');

      // AC 2: names the concrete remedy — never the old generic "contact support"
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C99999',
          text: expect.stringContaining('link this channel'),
        })
      );
      const [[failureCall]] = mockPostMessage.mock.calls;
      expect(failureCall.text).not.toMatch(/contact support/i);
      expect(failureCall.text).toContain('operator@agentweb.pro');

      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('ENG-1292 (AC 1): resolves to the mentioning Slack user\'s own AgentWeb account when the channel has no binding', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      userDb.getAllUsers.mockResolvedValue([]);
      getSlackUserEmail.mockResolvedValue('fangfang@agentweb.pro');
      userDb.getUserByEmail.mockResolvedValue({
        userId: 'user-fangfang',
        email: 'fangfang@agentweb.pro',
      });

      chatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-fangfang',
        userId: 'user-fangfang',
        messages: [],
        llmModel: 'gpt-4o',
      });
      chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'session-fangfang' });
      generateSessionResponse.mockResolvedValue({ content: 'Here you go!', toolCalls: [] });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_FANGFANG',
            text: '<@UEMMA123> summarize this file',
            channel: 'C_GO_TO_MARKET',
            ts: '1786962214.047529',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(getSlackUserEmail).toHaveBeenCalledWith('U_FANGFANG');
      expect(userDb.getUserByEmail).toHaveBeenCalledWith('fangfang@agentweb.pro');

      // Request proceeds normally as that user — no "couldn't find" failure
      expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
        'user-fangfang',
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
      const failureCall = mockPostMessage.mock.calls.find(
        ([arg]) => typeof arg.text === 'string' && /couldn't find|link this channel/i.test(arg.text)
      );
      expect(failureCall).toBeUndefined();

      // Never cached as a channel binding — a shared channel must not silently
      // bind to whoever happened to mention Emma first (ENG-1292)
      expect(settingsService.setSetting).not.toHaveBeenCalledWith(
        'slack_channel_mapping_C_GO_TO_MARKET',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
    });

    it('ENG-1292: does not resolve the identity fallback to a tombstoned (deleted) account', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      userDb.getAllUsers.mockResolvedValue([]);
      getSlackUserEmail.mockResolvedValue('departed@agentweb.pro');
      // A defensive test double: even if getUserByEmail's own deleted_* filter
      // were ever bypassed, the call site must not trust a tombstoned account.
      userDb.getUserByEmail.mockResolvedValue({
        userId: 'deleted_1699999999999_user-departed',
        email: 'departed@agentweb.pro',
      });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_DEPARTED',
            text: '<@UEMMA123> test',
            channel: 'C_TOMBSTONE',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_TOMBSTONE',
          text: expect.stringContaining('link this channel'),
        })
      );
    });

    it('ENG-1292 (AC 3): no cross-tenant leak — a Slack user with no matching AgentWeb account still gets the failure path', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      userDb.getAllUsers.mockResolvedValue([]);
      getSlackUserEmail.mockResolvedValue('stranger@external-company.com');
      userDb.getUserByEmail.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_STRANGER',
            text: '<@UEMMA123> test',
            channel: 'C_UNBOUND',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).toHaveBeenCalledWith('stranger@external-company.com');
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_UNBOUND',
          text: expect.stringContaining('link this channel'),
        })
      );
    });

    it('ENG-1292 (AC 4): an existing channel binding still takes precedence — never attempts the identity fallback', async () => {
      settingsService.getSetting.mockResolvedValue({ settingValue: 'user-bound' });
      userDb.getUserById.mockResolvedValue({
        userId: 'user-bound',
        email: 'bound@agentweb.pro',
        slackChannel: 'C_BOUND',
      });

      chatbotDb.createChatSession.mockResolvedValue({
        sessionId: 'session-bound',
        userId: 'user-bound',
        messages: [],
        llmModel: 'gpt-4o',
      });
      chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'session-bound' });
      generateSessionResponse.mockResolvedValue({ content: 'ok', toolCalls: [] });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_SOMEONE_ELSE',
            text: '<@UEMMA123> test',
            channel: 'C_BOUND',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
        'user-bound',
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
      // Bound channel resolves entirely from the mapping — the identity
      // fallback path (getUserByEmail) must never run
      expect(userDb.getUserByEmail).not.toHaveBeenCalled();
    });

    it('links the current Slack channel to the requested user account', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      getSlackUserEmail.mockResolvedValue('operator@agentweb.pro');
      userDb.getUserByEmail.mockResolvedValue({
        userId: 'user-matthew',
        email: 'matthew@agentweb.pro',
        slackChannel: 'C_LEGACY',
        slackChannels: ['C_EXISTING'],
      });
      userDb.updateUser.mockResolvedValue({
        userId: 'user-matthew',
        email: 'matthew@agentweb.pro',
        slackChannels: ['C_EXISTING', 'C_LEGACY', 'C_MATTHEW'],
      });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_OPERATOR',
            text: '<@UEMMA123> for user <mailto:Matthew@agentweb.pro|Matthew@agentweb.pro> link to this channel',
            channel: 'C_MATTHEW',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).toHaveBeenCalledWith('matthew@agentweb.pro');
      expect(settingsService.invalidateSlackChannelMappings).toHaveBeenCalledWith(
        'user-matthew',
        expect.arrayContaining(['C_EXISTING', 'C_LEGACY', 'C_MATTHEW'])
      );
      expect(userDb.updateUser).toHaveBeenCalledWith('user-matthew', {
        slackChannels: ['C_EXISTING', 'C_LEGACY', 'C_MATTHEW'],
      });
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'slack_channel_mapping_C_MATTHEW',
        'user-matthew',
        'Slack channel to userId mapping for channel C_MATTHEW',
        'system'
      );
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_MATTHEW',
        thread_ts: '1234567890.123456',
        text: expect.stringContaining('Linked this channel to matthew@agentweb.pro'),
      }));
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    });

    it('does not fall through to channel lookup when link target user is missing', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      getSlackUserEmail.mockResolvedValue('operator@agentweb.pro');
      userDb.getUserByEmail.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_OPERATOR',
            text: '<@UEMMA123> for user missing@example.com link to this channel',
            channel: 'C_MISSING',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).toHaveBeenCalledWith('missing@example.com');
      expect(userDb.getAllUsers).not.toHaveBeenCalled();
      expect(userDb.updateUser).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_MISSING',
        thread_ts: '1234567890.123456',
        text: 'User not found: missing@example.com',
      }));
    });

    it('rejects channel-link requests from unrelated Slack users', async () => {
      getSlackUserEmail.mockResolvedValue('outsider@example.com');
      getSlackUserTeamId.mockResolvedValue('TCUSTOMER');

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_OUTSIDER',
            text: '<@UEMMA123> for user matthew@agentweb.pro link to this channel',
            channel: 'C_BLOCKED',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).not.toHaveBeenCalled();
      expect(userDb.updateUser).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_BLOCKED',
        thread_ts: '1234567890.123456',
        text: expect.stringContaining('Only AgentWeb admins or the target account owner can link'),
      }));
    });

    it('ENG-1294: falls back to team_id to authorize a link when the requester\'s own email fails to resolve (ENG-1263 pattern)', async () => {
      // Mirrors the empirically-confirmed prod failure (ENG-1263): a verified AgentWeb admin's
      // Slack profile.email fails to resolve via users.info (missing users:read.email scope or
      // similar), even though team_id — which rides the same response but needs no extra scope —
      // resolves fine. Without this fallback, nobody in that state could ever run the exact
      // remedy command Emma's own failure message tells them to run.
      settingsService.getSetting.mockResolvedValue(null);
      getSlackUserEmail.mockResolvedValue(null);
      getSlackUserTeamId.mockResolvedValue('TAGENTWEB');
      userDb.getUserByEmail.mockResolvedValue({ userId: 'user-fangfang', email: 'ftan@agentweb.pro', slackChannels: [] });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_FANGFANG',
            text: '<@UEMMA123> for user ftan@agentweb.pro link this channel',
            channel: 'C_GOTOMARKET',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).toHaveBeenCalledWith('ftan@agentweb.pro');
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'slack_channel_mapping_C_GOTOMARKET',
        'user-fangfang',
        'Slack channel to userId mapping for channel C_GOTOMARKET',
        'system'
      );
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_GOTOMARKET',
        thread_ts: '1234567890.123456',
        text: expect.stringContaining('Linked this channel to ftan@agentweb.pro'),
      }));
    });

    it('ENG-1294: does not authorize a link via team_id when the requester is on a different workspace (no over-correction)', async () => {
      // A Slack-Connect guest whose email also fails to resolve must not get authorized just
      // because *some* team_id resolved — it has to match our own workspace's team_id.
      getSlackUserEmail.mockResolvedValue(null);
      getSlackUserTeamId.mockResolvedValue('TCUSTOMER');

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_GUEST',
            text: '<@UEMMA123> for user matthew@agentweb.pro link to this channel',
            channel: 'C_BLOCKED2',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).not.toHaveBeenCalled();
      expect(userDb.updateUser).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_BLOCKED2',
        thread_ts: '1234567890.123456',
        text: expect.stringContaining('Only AgentWeb admins or the target account owner can link'),
      }));
    });

    it('ENG-1294: authorizes a link for a requester with a trusted @argusoft.com email', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      getSlackUserEmail.mockResolvedValue('operator@argusoft.com');
      userDb.getUserByEmail.mockResolvedValue({ userId: 'user-matthew', email: 'matthew@agentweb.pro', slackChannels: [] });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_ARGUSOFT',
            text: '<@UEMMA123> for user matthew@agentweb.pro link to this channel',
            channel: 'C_ARGUSOFT',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).toHaveBeenCalledWith('matthew@agentweb.pro');
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_ARGUSOFT',
        thread_ts: '1234567890.123456',
        text: expect.stringContaining('Linked this channel to matthew@agentweb.pro'),
      }));
    });

    it('ENG-1294: authorizes a link via user_team/source_team for a Slack Connect guest whose email and own-team_id both fail (Manan\'s real repro, 2026-09-03)', async () => {
      // Mirrors the actual production failure: a Slack Connect guest from Argusoft's own
      // workspace (T093CUE1WGP) whose profile.email doesn't resolve, and whose own team_id can
      // never equal ours since Slack Connect means a genuinely different home workspace.
      settingsService.getSetting.mockResolvedValue(null);
      getSlackUserEmail.mockResolvedValue(null);
      getSlackUserTeamId.mockResolvedValue(null);
      userDb.getUserByEmail.mockResolvedValue({ userId: 'user-matthew', email: 'matthew@agentweb.pro', slackChannels: [] });

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_MANAN',
            user_team: 'T093CUE1WGP',
            source_team: 'T093CUE1WGP',
            text: '<@UEMMA123> for user matthew@agentweb.pro link to this channel',
            channel: 'C_AGENTWEB_ARGUSOFT',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).toHaveBeenCalledWith('matthew@agentweb.pro');
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_AGENTWEB_ARGUSOFT',
        thread_ts: '1234567890.123456',
        text: expect.stringContaining('Linked this channel to matthew@agentweb.pro'),
      }));
    });

    it('ENG-1294: does not authorize a link for a Slack Connect guest from an untrusted external team (no over-correction)', async () => {
      settingsService.getSetting.mockResolvedValue(null);
      getSlackUserEmail.mockResolvedValue(null);
      getSlackUserTeamId.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'app_mention',
            user: 'U_RANDOM_GUEST',
            user_team: 'TSOMEOTHERCOMPANY',
            source_team: 'TSOMEOTHERCOMPANY',
            text: '<@UEMMA123> for user matthew@agentweb.pro link to this channel',
            channel: 'C_UNTRUSTED_GUEST',
            ts: '1234567890.123456',
          },
        });

      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(userDb.getUserByEmail).not.toHaveBeenCalled();
      expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C_UNTRUSTED_GUEST',
        thread_ts: '1234567890.123456',
        text: expect.stringContaining('Only AgentWeb admins or the target account owner can link'),
      }));
    });

    describe('Thread message handling', () => {
      it.each([
        ['missing mapped session', JSON.stringify({ sessionId: 'stale-session', userId: 'user-123' })],
        ['malformed mapping', '{not-json'],
      ])('falls back to normal app mention handling for a %s', async (_case, settingValue) => {
        settingsService.getSetting.mockImplementation(async (key: string) => {
          if (key === 'slack_thread_C12345_1234567890.123456') return { settingValue };
          if (key === 'slack_channel_mapping_C12345') return { settingValue: 'user-123' };
          return null;
        });
        userDb.getUserById.mockResolvedValue({
          userId: 'user-123', email: 'test@example.com', slackChannel: 'C12345',
        });
        chatbotDb.getChatSession.mockResolvedValue(null);
        chatbotDb.createChatSession.mockResolvedValue({
          sessionId: 'replacement-session', userId: 'user-123', messages: [], llmModel: 'gpt-4o',
        });
        chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'replacement-session' });
        generateSessionResponse.mockResolvedValue({ content: 'Replacement response', toolCalls: [] });

        const response = await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: {
            type: 'app_mention', user: 'U12345', text: '<@UEMMA123> start over',
            channel: 'C12345', ts: '1234567891.000000', thread_ts: '1234567890.123456',
          },
        });

        expect(response.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(chatbotDb.createChatSession).toHaveBeenCalledWith(
          'user-123', undefined, 'agent', 'slack-bot', undefined, undefined,
          undefined, undefined, 'regular', undefined
        );
        expect(generateSessionResponse).toHaveBeenCalledWith(
          'replacement-session', 'John Doe: start over', 'user-123', 'gpt-4o', []
        );
        expect(chatbotDb.updateSessionSlackThread).toHaveBeenCalledWith(
          'replacement-session', { channel: 'C12345', threadTs: '1234567890.123456' }
        );
        expect(settingsService.setSetting).toHaveBeenCalledWith(
          'slack_thread_C12345_1234567890.123456',
          JSON.stringify({ sessionId: 'replacement-session', userId: 'user-123' }),
          'Slack thread to session mapping', 'system'
        );
        expect(postThreadResponse).toHaveBeenCalledWith(
          'C12345', '1234567890.123456', 'Replacement response'
        );
      });

      it('releases native status when post-claim model setup fails', async () => {
        const { agentModeService } = require('../services/agentModeService');
        settingsService.getSetting.mockResolvedValue({ settingValue: 'user-123' });
        userDb.getUserById.mockResolvedValue({ userId: 'user-123', slackChannel: 'C12345' });
        chatbotDb.createChatSession.mockResolvedValue({ sessionId: 'session-setup-fails', userId: 'user-123', messages: [] });
        chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'session-setup-fails' });
        agentModeService.getDefaultModel.mockRejectedValueOnce(new Error('model unavailable'));

        await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: { type: 'app_mention', user: 'U12345', text: '<@UEMMA123> run', channel: 'C12345', ts: 'setup-fail-ts' },
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', 'setup-fail-ts', 'is working...');
        expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', 'setup-fail-ts', '');
      });

      it('does not capture the duplicate message event for an Emma mention as human eval feedback', async () => {
        humanEvalService.handleSlackThreadReply.mockResolvedValue(true);
        await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: { type: 'message', user: 'U12345', text: '<@UEMMA123> ship it', channel: 'C12345', ts: '2', thread_ts: '1' },
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(humanEvalService.handleSlackThreadReply).not.toHaveBeenCalled();
      });

      it('processes an attachment-only app mention', async () => {
        settingsService.getSetting.mockResolvedValue({ settingValue: 'user-123' });
        userDb.getUserById.mockResolvedValue({ userId: 'user-123', slackChannel: 'C12345' });
        chatbotDb.createChatSession.mockResolvedValue({ sessionId: 'file-session', userId: 'user-123', llmModel: 'gpt-4o' });
        chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'file-session' });
        generateSessionResponse.mockResolvedValue({ content: 'I read it.' });
        await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: { type: 'app_mention', user: 'U12345', text: '<@UEMMA123>', channel: 'C12345', ts: 'file-ts', files: [{ url_private: 'https://files.slack.com/a.png', name: 'a.png', mimetype: 'image/png' }] },
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(chatbotDb.createChatSession).toHaveBeenCalled();
        expect(generateSessionResponse).toHaveBeenCalledWith('file-session', 'John Doe: [attached file]', 'user-123', 'gpt-4o', expect.any(Array));
      });

      it('posts a fallback when a mapped-session response has empty content', async () => {
        settingsService.getSetting.mockResolvedValue({ settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }) });
        chatbotDb.getChatSession.mockResolvedValue({ sessionId: 'session-123', userId: 'user-123', llmModel: 'gpt-4o' });
        getSlackUserEmail.mockResolvedValue('owner@example.com');
        userDb.getUserByEmail.mockResolvedValue({ userId: 'user-123', slackChannel: 'C12345' });
        generateSessionResponse.mockResolvedValue({ content: '' });
        await request(app).post('/api/slack/events').send({ type: 'event_callback', event: { type: 'app_mention', user: 'U12345', text: '<@UEMMA123> continue', channel: 'C12345', ts: '2', thread_ts: '1' } });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(postThreadResponse).toHaveBeenCalledWith('C12345', '1', expect.stringContaining('unable to format a response'));
      });

      it.each([
        ['internal AgentWeb human', 'U08TM4QFQ1L', undefined],
        ['external Slack Connect human', 'U_EXTERNAL', undefined],
        ['external Slack Connect bot', 'U_EXTERNAL_BOT', 'B_EXTERNAL'],
      ])('allows an %s to explicitly mention Emma and continue Fangfang\'s mapped session', async (_participant, slackUserId, botId) => {
        settingsService.getSetting.mockImplementation(async (key: string) => {
          if (key === 'slack_thread_C0C1H9H5QVC_1789598550.553809') {
            return { settingValue: JSON.stringify({ sessionId: 'session-fangfang', userId: 'user-fangfang' }) };
          }
          return null;
        });
        chatbotDb.getChatSession.mockResolvedValue({ sessionId: 'session-fangfang', userId: 'user-fangfang', llmModel: 'gpt-4o' });
        generateSessionResponse.mockResolvedValue({ content: 'Follow-up handled' });

        await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: {
            type: 'app_mention', user: slackUserId, bot_id: botId,
            text: '<@UEMMA123> continue', channel: 'C0C1H9H5QVC', ts: '1789598925.000000', thread_ts: '1789598550.553809',
          },
        });
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(generateSessionResponse).toHaveBeenCalledWith(
          'session-fangfang', 'John Doe: continue', 'user-fangfang', 'gpt-4o', []
        );
      });

      it.each([
        ['Emma herself', 'UEMMA123'],
        ['an event whose Emma identity lookup fails closed', null],
      ])('ignores an app_mention emitted by %s', async (_case, emmaBotUserId) => {
        getEmmaBotUserId.mockResolvedValue(emmaBotUserId);
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-fangfang', userId: 'user-fangfang' }),
        });

        await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: {
            type: 'app_mention', user: 'UEMMA123', bot_id: 'B_EMMA',
            text: '<@UEMMA123> loop', channel: 'C0C1H9H5QVC', ts: '3', thread_ts: '1',
          },
        });
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(settingsService.getSetting).not.toHaveBeenCalledWith('slack_thread_C0C1H9H5QVC_1');
        expect(generateSessionResponse).not.toHaveBeenCalled();
      });

      it('allows a mapped delegated session to continue in an explicitly configured admin channel', async () => {
        settingsService.getSetting.mockImplementation(async (key: string) => {
          if (key === 'slack_thread_C_ADMIN_1') return { settingValue: JSON.stringify({ sessionId: 'delegated-session', userId: 'customer-user' }) };
          if (key === 'slack_admin_channels') return { settingValue: JSON.stringify(['C_ADMIN']) };
          return null;
        });
        chatbotDb.getChatSession.mockResolvedValue({ sessionId: 'delegated-session', userId: 'customer-user', llmModel: 'gpt-4o' });
        userDb.getUserById.mockResolvedValue({ userId: 'customer-user', slackChannel: 'C_CUSTOMER' });
        getSlackUserEmail.mockResolvedValue('admin@agentweb.pro');
        userDb.getUserByEmail.mockResolvedValue({ userId: 'admin-user', slackChannel: 'C_ADMIN' });
        generateSessionResponse.mockResolvedValue({ content: 'Delegated follow-up handled' });
        await request(app).post('/api/slack/events').send({ type: 'event_callback', event: { type: 'app_mention', user: 'U_ADMIN', text: '<@UEMMA123> continue', channel: 'C_ADMIN', ts: '2', thread_ts: '1' } });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(generateSessionResponse).toHaveBeenCalledWith('delegated-session', 'John Doe: continue', 'customer-user', 'gpt-4o', []);
      });

      it('keeps processing when the native status API fails', async () => {
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        });
        chatbotDb.getChatSession.mockResolvedValue({
          sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o',
        });
        setSlackAssistantStatus
          .mockRejectedValueOnce(new Error('status unavailable'))
          .mockRejectedValueOnce(new Error('status unavailable'));
        generateSessionResponse.mockResolvedValue({ content: 'Still handled', toolCalls: [] });
        const response = await request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: {
            type: 'app_mention', user: 'U12345', text: '<@UEMMA123> continue',
            channel: 'C12345', ts: '1234567891.000000', thread_ts: '1234567890.123456',
          },
        });
        expect(response.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(generateSessionResponse).toHaveBeenCalledWith(
          'session-123', 'John Doe: continue', 'user-123', 'gpt-4o', []
        );
        expect(postThreadResponse).toHaveBeenCalledWith(
          'C12345', '1234567890.123456', 'Still handled'
        );
      });
      it('does not let a never-resolving native status call block generation or retain the active turn', async () => {
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        });
        chatbotDb.getChatSession.mockResolvedValue({
          sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o',
        });
        setSlackAssistantStatus.mockImplementationOnce(() => new Promise(() => {}));
        generateSessionResponse.mockResolvedValue({ content: 'Handled after timeout', toolCalls: [] });

        const event = (ts: string) => request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: {
            type: 'app_mention', user: 'U12345', text: '<@UEMMA123> continue',
            channel: 'C12345', ts, thread_ts: 'root-ts',
          },
        });

        await event('reply-1');
        expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', 'root-ts', 'is working...');
        expect(generateSessionResponse).not.toHaveBeenCalled();

        await new Promise(resolve => setTimeout(resolve, 1_600));
        expect(generateSessionResponse).toHaveBeenCalledTimes(1);
        expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', 'root-ts', '');

        await event('reply-2');
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(setSlackAssistantStatus.mock.calls.filter((call: any[]) => call[2] === 'is working...')).toHaveLength(2);
      });

      it('keeps native status active until all concurrent mapped turns in a thread finish', async () => {
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        });
        chatbotDb.getChatSession.mockResolvedValue({
          sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o',
        });

        let resolveFirst!: (value: any) => void;
        let resolveSecond!: (value: any) => void;
        generateSessionResponse
          .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
          .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

        const event = (ts: string, text: string) => request(app).post('/api/slack/events').send({
          type: 'event_callback',
          event: {
            type: 'app_mention', user: 'U12345', text: `<@UEMMA123> ${text}`,
            channel: 'C12345', ts, thread_ts: '1234567890.123456',
          },
        });

        await Promise.all([event('1234567891.000000', 'first'), event('1234567892.000000', 'second')]);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(generateSessionResponse).toHaveBeenCalledTimes(2);
        expect(setSlackAssistantStatus).toHaveBeenCalledTimes(1);
        expect(setSlackAssistantStatus).toHaveBeenLastCalledWith(
          'C12345', '1234567890.123456', 'is working...'
        );

        resolveFirst({ content: 'First response', toolCalls: [] });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(setSlackAssistantStatus).not.toHaveBeenCalledWith(
          'C12345', '1234567890.123456', ''
        );

        resolveSecond({ content: 'Second response', toolCalls: [] });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(setSlackAssistantStatus).toHaveBeenCalledTimes(2);
        expect(setSlackAssistantStatus).toHaveBeenLastCalledWith(
          'C12345', '1234567890.123456', ''
        );
      });

      it('continues the mapped session at the root thread when Emma is explicitly mentioned in a thread', async () => {
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
              type: 'app_mention',
              user: 'U12345',
              text: '<@UEMMA123> Can you also add some images?',
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

        expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
        expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', '1234567890.123456', 'is working...');

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
        expect(setSlackAssistantStatus).toHaveBeenCalledWith('C12345', '1234567890.123456', '');
        expect(postThinkingMessage).not.toHaveBeenCalled();
        expect(deleteSlackMessage).not.toHaveBeenCalled();
      });

      it('ignores an unmentioned file-only reply in a tracked Emma thread', async () => {
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        });
        chatbotDb.getChatSession.mockResolvedValue({
          sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o',
        });
        generateSessionResponse.mockResolvedValue({ content: 'Got the logo.', toolCalls: [] });

        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              user: 'U12345',
              text: '', // file only, no text
              channel: 'C12345',
              ts: '1234567891.000000',
              thread_ts: '1234567890.123456',
              files: [
                { id: 'F1', name: 'logo.svg', mimetype: 'image/svg+xml', size: 10,
                  url_private: 'https://files.slack.com/logo.svg' },
              ],
            },
          });

        expect(response.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(generateSessionResponse).not.toHaveBeenCalled();
      });

      it('ignores an unreadable unmentioned file reply in a tracked Emma thread', async () => {
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        });
        chatbotDb.getChatSession.mockResolvedValue({
          sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o',
        });
        generateSessionResponse.mockResolvedValue({ content: 'I could not read that file.', toolCalls: [] });

        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              user: 'U12345',
              text: '', // file only, no text
              channel: 'C12345',
              ts: '1234567891.000000',
              thread_ts: '1234567890.123456',
              // Slack Connect stub: no url_private, hydration via files.info fails in-test.
              files: [{ id: 'F0BH7RZ6VM4', name: 'logo.png', filetype: 'png', file_access: 'check_file_info' }],
            },
          });

        expect(response.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(generateSessionResponse).not.toHaveBeenCalled();
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

      it('ignores an external bot\'s unmentioned message in a mapped thread', async () => {
        settingsService.getSetting.mockResolvedValue({
          settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }),
        });
        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              user: 'U_EXTERNAL_BOT',
              bot_id: 'B_EXTERNAL',
              text: 'Bot reply without an Emma mention',
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

      it('should ignore unmentioned file_share thread replies with text and files', async () => {
        const { uploadFileToS3 } = require('../utils/s3Utils');
        const { downloadSlackFile } = require('../services/slackService');

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
          content: 'I can see the video you shared!',
          toolCalls: [],
        });

        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              subtype: 'file_share',
              user: 'U12345',
              text: 'Checkout the video and make again',
              channel: 'C12345',
              ts: '1234567892.000000',
              thread_ts: '1234567890.123456',
              files: [
                {
                  url_private: 'https://files.slack.com/video.mp4',
                  name: 'video.mp4',
                  size: 1024000,
                  mimetype: 'video/mp4',
                },
              ],
            },
          });

        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(downloadSlackFile).not.toHaveBeenCalled();
        expect(uploadFileToS3).not.toHaveBeenCalled();
        expect(generateSessionResponse).not.toHaveBeenCalled();
      });

      it('should ignore unmentioned file_share thread replies with files but no text', async () => {
        const { downloadSlackFile } = require('../services/slackService');

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
          content: 'I see you shared a file.',
          toolCalls: [],
        });

        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              subtype: 'file_share',
              user: 'U12345',
              text: '',
              channel: 'C12345',
              ts: '1234567893.000000',
              thread_ts: '1234567890.123456',
              files: [
                {
                  url_private: 'https://files.slack.com/image.png',
                  name: 'image.png',
                  size: 51200,
                  mimetype: 'image/png',
                },
              ],
            },
          });

        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(downloadSlackFile).not.toHaveBeenCalled();
        expect(generateSessionResponse).not.toHaveBeenCalled();
      });

      it('should ignore file_share messages in untracked threads', async () => {
        settingsService.getSetting.mockResolvedValue(null);

        const response = await request(app)
          .post('/api/slack/events')
          .send({
            type: 'event_callback',
            event: {
              type: 'message',
              subtype: 'file_share',
              user: 'U12345',
              text: '',
              channel: 'C12345',
              ts: '1234567894.000000',
              thread_ts: '9999999999.999999',
              files: [
                {
                  url_private: 'https://files.slack.com/video.mp4',
                  name: 'video.mp4',
                  size: 1024000,
                  mimetype: 'video/mp4',
                },
              ],
            },
          });

        expect(response.status).toBe(200);

        await new Promise(resolve => setTimeout(resolve, 100));

        // No Emma response should be generated for untracked threads
        expect(generateSessionResponse).not.toHaveBeenCalled();
      });
    });
  });
});
