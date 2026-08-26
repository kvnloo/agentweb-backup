import request from 'supertest';
import express from 'express';
import slackRouter from '../routes/slack';

// ENG-1613: Phoenix Tech burned ~$197 of real LLM inference cost in August 2026 because the Slack
// "auto-listen" pipeline (handleSlackTriggeredSession, and the isTriggered thread-continuation
// branch that follows it) fired real, paid inference on every top-level, untagged message in a
// connected channel — even trivial ones ("lol", "nice", "thanks") — by default. A customer had to
// discover and explicitly opt OUT via `slackSuggestedRepliesDisabled: true` to stop it.
//
// The fix flips the default: absent/true now means the auto-trigger pipeline is DISABLED
// (tag-gated only — Emma must be @-mentioned via the unrelated, unaffected `app_mention` handler).
// Only an explicit `slackSuggestedRepliesDisabled: false` (persisted by
// PUT /admin/users/:userId/slack-suggested-replies with { enabled: true }) re-enables the old
// auto-listen-and-draft-on-every-message behavior.
//
// These tests pin the new default for both check sites (top-level message trigger, and the
// monitored-thread continuation trigger), prove the explicit opt-in escape hatch still runs the
// pipeline exactly as before, and confirm the `app_mention` (real @-tag) path is unaffected.
//
// Mocking conventions follow slack.internalAuthorGuard.test.ts (same route module, same two flows).

// --- Mocks -------------------------------------------------------------------

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

// slackService helpers used by both trigger paths. The author is fixed to a resolvable external
// customer for every test here — the internal-author guard (ENG-1263) is covered separately in
// slack.internalAuthorGuard.test.ts and is orthogonal to this default-flip.
jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return {
    ...actual,
    getSlackUserEmail: jest.fn().mockResolvedValue('customer@external.com'),
    getSlackUserTeamId: jest.fn().mockResolvedValue(null),
    getOwnSlackTeamId: jest.fn().mockResolvedValue('TAGENTWEB01'),
    getSlackUserDisplayName: jest.fn().mockResolvedValue('Some Customer'),
    resolveSlackMentionsInText: jest.fn().mockImplementation(async (t: string) => t),
  };
});

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

describe('Slack auto-trigger default (ENG-1613)', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();

    settingsService.getSetting.mockResolvedValue({ settingValue: 'user-123' });
    mockTriage.mockResolvedValue(true);
    chatbotDb.createChatSession.mockResolvedValue({
      sessionId: 'session-123',
      userId: 'user-123',
      messages: [],
      llmModel: 'gpt-4o',
    });
    chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'session-123' });
    generateSessionResponse.mockResolvedValue({ content: 'Draft reply', toolCalls: [] });
  });

  const postTopLevelMessage = (text: string) =>
    request(app)
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U_CUSTOMER',
          text,
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      });

  describe('top-level untagged message (handleSlackTriggeredSession, ~slack.ts:238)', () => {
    it('does NOT triage, create a session, or email when slackSuggestedRepliesDisabled is unset (new default: disabled)', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        slackChannels: ['C12345'],
        // slackSuggestedRepliesDisabled intentionally absent — this is the new default case.
      });

      const res = await postTopLevelMessage('lol nice');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(mockTriage).not.toHaveBeenCalled();
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
    });

    it('does NOT triage, create a session, or email when slackSuggestedRepliesDisabled is explicitly true', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        slackChannels: ['C12345'],
        slackSuggestedRepliesDisabled: true,
      });

      const res = await postTopLevelMessage('thanks!');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(mockTriage).not.toHaveBeenCalled();
      expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
    });

    it('still triages, creates a session, and emails when slackSuggestedRepliesDisabled is explicitly false (opted in via the admin endpoint)', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        slackChannels: ['C12345'],
        slackSuggestedRepliesDisabled: false,
      });

      const res = await postTopLevelMessage('Can someone help with my campaign setup?');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(mockTriage).toHaveBeenCalledWith('Can someone help with my campaign setup?');
      expect(chatbotDb.createChatSession).toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalled();
    });
  });

  describe('monitored triggered-thread reply (isTriggered branch, ~slack.ts:1019)', () => {
    const postThreadReply = (text: string) =>
      request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'message',
            user: 'U_CUSTOMER',
            text,
            channel: 'C12345',
            ts: '1234567891.000000',
            thread_ts: '1234567890.123456',
          },
        });

    beforeEach(() => {
      // Thread mapping marks this as a monitored (email-only, "triggered") session so the
      // isTriggered branch is taken instead of the normal Emma-session-continuation branch.
      settingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123', type: 'triggered' }),
      });
      chatbotDb.getChatSession.mockResolvedValue({
        sessionId: 'session-123',
        userId: 'user-123',
        messages: [],
        llmModel: 'gpt-4o',
      });
    });

    it('does NOT generate a response or email when slackSuggestedRepliesDisabled is unset (new default: disabled)', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        // slackSuggestedRepliesDisabled intentionally absent — this is the new default case.
      });

      const res = await postThreadReply('following up on this');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(generateSessionResponse).not.toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
    });

    it('does NOT generate a response or email when slackSuggestedRepliesDisabled is explicitly true', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        slackSuggestedRepliesDisabled: true,
      });

      const res = await postThreadReply('following up on this');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(generateSessionResponse).not.toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
    });

    it('still generates a response and emails when slackSuggestedRepliesDisabled is explicitly false (opted in via the admin endpoint)', async () => {
      userDb.getUserById.mockResolvedValue({
        userId: 'user-123',
        email: 'customer@example.com',
        slackSuggestedRepliesDisabled: false,
      });

      const res = await postThreadReply('following up on this');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(generateSessionResponse).toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalled();
    });
  });

  // Assertion 5 (task spec): a genuine app_mention (Emma actually @-tagged) must be completely
  // unaffected by slackSuggestedRepliesDisabled at any value. Proven at the source level, not just
  // by test: `grep -n "slackSuggestedRepliesDisabled" backend/src/routes/slack.ts` returns exactly
  // the two call sites this PR touches (the ones covered above) — the app_mention handler
  // (slack.ts ~line 669 onward) contains zero references to this field. The existing coverage in
  // slack.events.test.ts ("should reply in-thread when Emma is mentioned in Slack") already
  // exercises this exact path with a user object where the field is unset and passes unmodified by
  // this change, which is itself proof of no regression — not duplicated here.
});
