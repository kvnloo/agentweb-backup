/**
 * Characterization tests for handleSlackSessionResponse (routes/slack.ts).
 *
 * These pin behavior that `slack.events.test.ts` does not cover, ahead of the
 * ENG-272 extraction of the transport-agnostic session-response core. They
 * describe what the code does TODAY, not what it ought to do — if one of these
 * starts failing during the extraction, the refactor changed behavior and is
 * wrong.
 *
 * Deliberately a separate file: covering the GTM branch requires mocking
 * `gtmPlanService`, which is intentionally NOT mocked in slack.events.test.ts
 * (there it runs for real, throws, and is swallowed). Mocking it in that file
 * would alter the existing golden master.
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

async function postMention(files?: any[]) {
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
        ...(files ? { files } : {}),
      },
    });
  // The route acks immediately and processes asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return response;
}

/** The follow-up message carrying the iShare / GTM context block. */
function followUpCall() {
  return mockPostMessage.mock.calls.find(
    (c: any[]) => c[0]?.blocks?.[0]?.type === 'context'
  )?.[0];
}

describe('handleSlackSessionResponse — characterization (pre-ENG-272 extraction)', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockSettings();
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      slackChannel: CHANNEL,
    });
    chatbotDb.createChatSession.mockResolvedValue({
      sessionId: 'session-123',
      userId: 'user-123',
      messages: [],
      llmModel: 'gpt-4o',
    });
    chatbotDb.createOrReuseInteractiveShare.mockResolvedValue(
      'http://localhost:5174/ishare/session-123?conversable=abc'
    );
    ensureGtmWorkItemForSlackSession.mockResolvedValue(null);
    setSlackAssistantStatus.mockResolvedValue(undefined);
    getEmmaBotUserId.mockResolvedValue('UEMMA123');
    generateSessionResponse.mockResolvedValue({ content: 'Here is your blog article!' });
  });

  describe('empty response content', () => {
    it('posts the fallback message instead of staying silent when response.content is empty', async () => {
      generateSessionResponse.mockResolvedValue({ content: '' });

      await postMention();

      expect(postThreadResponse).toHaveBeenCalledWith(
        CHANNEL,
        TS,
        'I completed the task but was unable to format a response. Please check the portal for results or try again.'
      );
    });

    it('still clears the assistant thread status when the response is empty', async () => {
      generateSessionResponse.mockResolvedValue({ content: '' });

      await postMention();

      expect(setSlackAssistantStatus).toHaveBeenCalledWith(CHANNEL, TS, 'is working...');
      expect(setSlackAssistantStatus).toHaveBeenCalledWith(CHANNEL, TS, '');
    });
  });

  describe('GTM work-item tracking', () => {
    it('stamps the GTM work item on the session and appends a customer-portal tracker link for a non-admin channel', async () => {
      ensureGtmWorkItemForSlackSession.mockResolvedValue({
        planId: 'plan-1',
        phaseId: 'phase-1',
        workItemId: 'wi-1',
      });

      await postMention();

      expect(chatbotDb.updateSessionGtmWorkItem).toHaveBeenCalledWith('session-123', {
        planId: 'plan-1',
        phaseId: 'phase-1',
        workItemId: 'wi-1',
      });

      const followUp = followUpCall();
      expect(followUp).toBeDefined();
      const texts = followUp.blocks[0].elements.map((e: any) => e.text);
      expect(texts).toHaveLength(2);
      expect(texts[1]).toContain('/gtm-plan?planId=plan-1&phaseId=phase-1');
      expect(texts[1]).not.toContain('/gtm-ops');
    });

    it('uses the partner-portal gtm-ops link when the mention is in an admin channel', async () => {
      mockSettings({ slack_admin_channels: { settingValue: JSON.stringify([CHANNEL]) } });
      ensureGtmWorkItemForSlackSession.mockResolvedValue({
        planId: 'plan-1',
        phaseId: 'phase-1',
        workItemId: 'wi-1',
      });

      await postMention();

      const followUp = followUpCall();
      expect(followUp).toBeDefined();
      const texts = followUp.blocks[0].elements.map((e: any) => e.text);
      expect(texts[1]).toContain('/gtm-ops?planId=plan-1&phaseId=phase-1');
    });

    it('is non-blocking: a GTM tracking failure still delivers the response, with no tracker link', async () => {
      ensureGtmWorkItemForSlackSession.mockRejectedValue(new Error('gtm exploded'));

      await postMention();

      expect(postThreadResponse).toHaveBeenCalledWith(CHANNEL, TS, 'Here is your blog article!');

      const followUp = followUpCall();
      expect(followUp).toBeDefined();
      expect(followUp.blocks[0].elements).toHaveLength(1);
    });
  });

  describe('generation failure path', () => {
    it('persists partial token usage accumulated before the error', async () => {
      const err: any = new Error('generation blew up');
      err.partialUsageMessages = [{ role: 'assistant', content: 'partial' }];
      generateSessionResponse.mockRejectedValue(err);

      await postMention();

      expect(chatbotDb.addMessagesToSession).toHaveBeenCalledWith('session-123', [
        { role: 'assistant', content: 'partial' },
      ]);
    });

    it('does not call addMessagesToSession when the error carries no partial usage', async () => {
      generateSessionResponse.mockRejectedValue(new Error('generation blew up'));

      await postMention();

      expect(chatbotDb.addMessagesToSession).not.toHaveBeenCalled();
    });

    it('clears the assistant thread status and posts the error text to the thread', async () => {
      generateSessionResponse.mockRejectedValue(new Error('generation blew up'));

      await postMention();

      expect(setSlackAssistantStatus).toHaveBeenCalledWith(CHANNEL, TS, '');
      expect(postThreadResponse).toHaveBeenCalledWith(
        CHANNEL,
        TS,
        'Sorry, I encountered an error while processing your request. Please try again.'
      );
    });

    it('saves an assistant error message to the session so iShare viewers see the failure', async () => {
      generateSessionResponse.mockRejectedValue(new Error('generation blew up'));

      await postMention();

      expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith(
        'session-123',
        expect.objectContaining({
          role: 'assistant',
          // NOTE: deliberately differs from the posted text above — no "while".
          content: 'Sorry, I encountered an error processing your request. Please try again.',
          metadata: expect.objectContaining({ isErrorMessage: true }),
        })
      );
    });
  });

  describe('attachment resolution', () => {
    const twoFiles = [
      { name: 'good.png', mimetype: 'image/png', size: 10, url_private: 'https://files.slack.com/good.png' },
      { name: 'bad.png', mimetype: 'image/png', size: 10, url_private: 'https://files.slack.com/bad.png' },
    ];

    it('is non-fatal when one file fails to download — the others still reach Emma', async () => {
      resolveSlackFileUrl.mockImplementation(async (f: any) => f.url_private);
      downloadSlackFile.mockImplementation(async (url: string) => {
        if (url.includes('bad')) throw new Error('download failed');
        return Buffer.from('good-bytes');
      });
      uploadFileToS3.mockResolvedValue({ success: true, url: 'https://s3.example.com/good.png' });

      await postMention(twoFiles);

      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-123',
        'John Doe: help me create a blog article',
        'user-123',
        'gpt-4o',
        [
          expect.objectContaining({
            url: 'https://s3.example.com/good.png',
            filename: 'good.png',
            mimetype: 'image/png',
          }),
        ]
      );
    });

    it('skips a file whose S3 upload reports failure rather than attaching a broken reference', async () => {
      resolveSlackFileUrl.mockImplementation(async (f: any) => f.url_private);
      downloadSlackFile.mockResolvedValue(Buffer.from('bytes'));
      uploadFileToS3.mockResolvedValue({ success: false });

      await postMention([twoFiles[0]]);

      expect(generateSessionResponse).toHaveBeenCalledWith(
        'session-123',
        expect.any(String),
        'user-123',
        'gpt-4o',
        []
      );
    });
  });
});
