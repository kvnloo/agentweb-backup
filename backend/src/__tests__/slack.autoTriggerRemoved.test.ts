import request from 'supertest';
import express from 'express';
import slackRouter from '../routes/slack';

// ENG-1613: Harsha killed the Slack "auto-listen and draft a reply" pipeline entirely — no opt-in
// escape hatch. Even with the account-level `slackSuggestedRepliesDisabled` toggle (also removed),
// a customer never saw the drafted reply — it only emailed founders@agentweb.pro, never posted to
// Slack — so there was no way for them to know their message had triggered an LLM session at all.
// `handleSlackTriggeredSession()`, the `isTriggered` thread-continuation branch, the untracked-
// thread auto-trigger fallback, and the `PUT /admin/users/:userId/slack-suggested-replies` opt-in
// toggle were all removed outright (not defaulted off). Emma's Slack behavior is now exclusively
// tag-gated via the `app_mention` event handler.
//
// These are a removal guard, not a re-test of the deleted feature: they prove no remaining code
// path in slack.ts can start a session, call the triage/generation LLMs, or send the founders@
// email for a message that does not @-mention Emma. The `app_mention` path itself is untouched and
// already covered by slack.events.test.ts ("should reply in-thread when Emma is mentioned in
// Slack" et al.) and its thread-continuation tests ("should forward thread replies to existing
// Emma session") — not duplicated here.

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
    // Kept present (rather than omitted) so that IF a regression reintroduced a call to the
    // deleted triage step, the test would fail on the assertion below instead of on an unrelated
    // "triageSlackMessage is not a function" crash swallowed by a try/catch that no longer exists.
    triageSlackMessage: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendSlackTriggeredSessionEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return {
    ...actual,
    getSlackUserEmail: jest.fn().mockResolvedValue('customer@external.com'),
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

describe('Slack auto-trigger removed (ENG-1613)', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();

    settingsService.getSetting.mockResolvedValue({ settingValue: 'user-123' });
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      slackChannels: ['C12345'],
    });
  });

  it('does not triage, create a session, generate a response, or email for a plain untagged top-level message', async () => {
    const res = await request(app)
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U_CUSTOMER',
          text: 'Can someone help with my campaign setup?',
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      });

    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).not.toHaveBeenCalled();
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(generateSessionResponse).not.toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
  });

  it('does not triage, create a session, generate a response, or email for a reply in an untracked thread', async () => {
    settingsService.getSetting.mockResolvedValue(null); // no thread mapping found

    const res = await request(app)
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U_CUSTOMER',
          text: 'following up on this',
          channel: 'C12345',
          ts: '1234567891.000000',
          thread_ts: '1234567890.123456',
        },
      });

    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).not.toHaveBeenCalled();
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(generateSessionResponse).not.toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
  });

  it('stays silent even when the message would previously have passed triage (proves the call site is gone, not a triage-mock artifact)', async () => {
    mockTriage.mockResolvedValue(true); // would have "needed handling" under the deleted pipeline

    const res = await request(app)
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U_CUSTOMER',
          text: 'This is urgent, please respond!',
          channel: 'C12345',
          ts: '1234567892.000000',
        },
      });

    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).not.toHaveBeenCalled();
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
  });
});
