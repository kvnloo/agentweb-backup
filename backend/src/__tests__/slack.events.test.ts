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

        // Verify message forwarded with username prefix and silence rule
        expect(generateSessionResponse).toHaveBeenCalledWith(
          'session-123',
          'John Doe: Can you also add some images?\n\n[Silence Rule] If this message is a side-conversation between other people not directed at you, respond with exactly: BE_SILENT',
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

      it('should process file_share thread replies with text and files', async () => {
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

        // Verify file was downloaded from Slack and uploaded to S3
        expect(downloadSlackFile).toHaveBeenCalledWith('https://files.slack.com/video.mp4');
        expect(uploadFileToS3).toHaveBeenCalledWith(
          Buffer.from('file-content'),
          'video.mp4',
          'user-123',
          'video/mp4'
        );

        // Verify Emma received the message with the attachment and silence rule
        expect(generateSessionResponse).toHaveBeenCalledWith(
          'session-123',
          'John Doe: Checkout the video and make again\n\n[Silence Rule] If this message is a side-conversation between other people not directed at you, respond with exactly: BE_SILENT',
          'user-123',
          'gpt-4o',
          [
            {
              url: 'https://s3.example.com/file.png',
              filename: 'video.mp4',
              size: 1024000,
              mimetype: 'video/mp4',
            },
          ]
        );
      });

      it('should process file_share thread replies with files but no text', async () => {
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

        // Verify file was downloaded
        expect(downloadSlackFile).toHaveBeenCalledWith('https://files.slack.com/image.png');

        // Verify Emma received a placeholder message text when no text was provided, with silence rule
        expect(generateSessionResponse).toHaveBeenCalledWith(
          'session-123',
          'John Doe: [attached file]\n\n[Silence Rule] If this message is a side-conversation between other people not directed at you, respond with exactly: BE_SILENT',
          'user-123',
          'gpt-4o',
          expect.arrayContaining([
            expect.objectContaining({ filename: 'image.png', mimetype: 'image/png' }),
          ])
        );
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
