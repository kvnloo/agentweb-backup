/**
 * FAIL-LOUD (WP-I): when the session's selected model is not served, generateSessionResponse
 * throws ModelUnavailableError (before any write). Slack must say so with the ONE
 * server-produced sentence instead of the generic "Sorry", exactly once, no retry.
 * Covers both Slack entry points: the new-session mention (sessionResponder) and the
 * mapped-thread continuation (handleMappedSlackThreadResponse).
 */
import request from 'supertest';
import express from 'express';
import slackRouter from '../routes/slack';

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
    updateSessionGtmWorkItem: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    getChatSession: jest.fn(),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('http://localhost:5174/ishare/session-123?conversable=abc'),
  },
}));

jest.mock('../services/gtmPlanService', () => ({
  ensureGtmWorkItemForSlackSession: jest.fn(),
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

const mockPostMessage = jest.fn().mockResolvedValue({ ok: true, ts: 'ishare-msg-ts' });
const mockChatDelete = jest.fn().mockResolvedValue({ ok: true });

jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return {
    ...actual,
    postThreadResponse: jest.fn().mockResolvedValue(undefined),
    setSlackAssistantStatus: jest.fn().mockResolvedValue(undefined),
    getSlackUserDisplayName: jest.fn().mockResolvedValue('John Doe'),
    getSlackUserEmail: jest.fn().mockResolvedValue('customer@example.com'),
    resolveSlackFileUrl: jest.fn(),
    downloadSlackFile: jest.fn(),
  };
});

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

// main gates every app_mention on a resolvable Emma bot identity and drops the event
// when it is unavailable, so the identity has to be mocked or nothing reaches the pipeline.
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
  })),
}));

const { userDb } = require('../services/db');
const { settingsService } = require('../services/settingsService');
const { chatbotDb } = require('../services/chatbotService');
const { ensureGtmWorkItemForSlackSession } = require('../services/gtmPlanService');
const { generateSessionResponse } = require('../controllers/agentModeController');
const { ModelUnavailableError } = require('../services/agentMode/modelUnavailable');
const {
  postThreadResponse,
  setSlackAssistantStatus,
  resolveSlackFileUrl,
  downloadSlackFile,
} = require('../services/slackService');
const { uploadFileToS3 } = require('../utils/s3Utils');
const { getEmmaBotUserId } = require('../services/loopSlackApprovalDispatcher');

const CHANNEL = 'C12345';
const TS = '1234567890.123456';

/** Settings reads the app_mention path performs, keyed so each test controls them precisely. */
function mockSettings(overrides: Record<string, any> = {}) {
  settingsService.getSetting.mockImplementation(async (key: string) => {
    if (key in overrides) return overrides[key];
    if (key === `slack_channel_mapping_${CHANNEL}`) return { settingValue: 'user-123' };
    return null; // slack_admin_channels / slack_admin_channel → not an admin channel
  });
}

async function postMention(files?: any[], threadTs?: string) {
  const response = await request(express().use(express.json()).use('/api/slack', slackRouter))
    .post('/api/slack/events')
    .send({
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U12345',
        text: '<@UEMMA123> help me create a blog article',
        channel: CHANNEL,
        ts: TS,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(files ? { files } : {}),
      },
    });
  // The route acks immediately and processes asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return response;
}


const SENTENCE = "I can't answer in this thread because the model it was started with is no longer available. Please start a new thread, or switch the model in the AgentWeb app.";

describe('Slack — model_unavailable is loud', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettings();
    userDb.getUserById.mockResolvedValue({ userId: 'user-123', email: 'customer@example.com', slackChannel: CHANNEL });
    chatbotDb.createChatSession.mockResolvedValue({ sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'retired-model-9' });
    chatbotDb.createOrReuseInteractiveShare.mockResolvedValue('http://localhost:5174/ishare/session-123?conversable=abc');
    ensureGtmWorkItemForSlackSession.mockResolvedValue(null);
    setSlackAssistantStatus.mockResolvedValue(undefined);
    getEmmaBotUserId.mockResolvedValue('UEMMA123');
    generateSessionResponse.mockRejectedValue(new ModelUnavailableError('retired-model-9', 'not_served'));
  });

  it('new-session mention: posts the sentence once (not the generic Sorry) and saves it to the session', async () => {
    await postMention();

    expect(postThreadResponse).toHaveBeenCalledTimes(1);
    expect(postThreadResponse).toHaveBeenCalledWith(CHANNEL, TS, SENTENCE);
    expect(generateSessionResponse).toHaveBeenCalledTimes(1);
    // channel markup safety: the stored id is never echoed
    expect(JSON.stringify(postThreadResponse.mock.calls)).not.toContain('retired-model-9');
    expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith(
      'session-123',
      expect.objectContaining({ content: SENTENCE, metadata: expect.objectContaining({ isErrorMessage: true }) }),
    );
  });

  it('mapped-thread continuation: posts the sentence once, no generic Sorry, no retry', async () => {
    mockSettings({
      [`slack_thread_${CHANNEL}_1111.0001`]: { settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123' }) },
    });
    chatbotDb.getChatSession.mockResolvedValue({ sessionId: 'session-123', userId: 'user-123', llmModel: 'retired-model-9' });

    await postMention(undefined, '1111.0001');

    expect(postThreadResponse).toHaveBeenCalledTimes(1);
    expect(postThreadResponse).toHaveBeenCalledWith(CHANNEL, '1111.0001', SENTENCE);
    expect(generateSessionResponse).toHaveBeenCalledTimes(1);
    // proves it took the mapped-thread branch (no new session was created)
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('a generic error still gets the generic apology (unchanged)', async () => {
    generateSessionResponse.mockRejectedValue(new Error('generation blew up'));
    await postMention();
    expect(postThreadResponse).toHaveBeenCalledWith(
      CHANNEL, TS, 'Sorry, I encountered an error while processing your request. Please try again.');
  });
});
