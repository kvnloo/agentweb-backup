import request from 'supertest';
import express from 'express';
import slackRouter from '../routes/slack';

// ENG-1263: Slack "client question" classifier fired on Harsha's own outbound weekly reports in
// customer channels. Root cause: the internal-author guard in handleSlackTriggeredSession only
// checked a resolved @agentweb.pro email — getSlackUserEmail() returns null on several paths that
// do NOT mean "external" (rate limit, missing users:read.email scope, or — most relevant for
// customer channels, which are Slack-Connect/externally-shared — a cross-workspace profile
// users.info can't resolve an email for). `senderEmail && senderEmail.endsWith(...)` treated
// "could not resolve" as "is external", so Harsha's own messages fell through to triage and were
// misclassified as inbound client questions.
//
// These tests pin: (1) a known-internal Slack user ID skips the pipeline even when email
// resolution fails — the exact regression; (2) a genuine external author whose email ALSO fails to
// resolve still gets triaged and notified — no over-correction / silent drop; (3) the
// unresolvable-author branch is logged distinguishably from both the internal-skip and the
// normal-continue paths, so a repeat is diagnosable from logs.

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

// slackService helpers used by the triggered flow. getSlackUserEmail is overridden per-test below
// to simulate the different resolution outcomes (resolved internal, resolved external, unresolved).
jest.mock('../services/slackService', () => {
  const actual = jest.requireActual('../services/slackService');
  return {
    ...actual,
    getSlackUserEmail: jest.fn(),
    getSlackUserDisplayName: jest.fn().mockResolvedValue('Some User'),
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
const slackService = require('../services/slackService');

const mockTriage = agentModeService.triageSlackMessage as jest.Mock;
const mockSendSlackTriggeredSessionEmail = emailService.sendSlackTriggeredSessionEmail as jest.Mock;
const mockGetSlackUserEmail = slackService.getSlackUserEmail as jest.Mock;

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 100));

// Harsha's Slack user ID — the module's default known-internal ID (reference-ids.md), and the
// exact author whose messages were misclassified on 2026-08-16.
const HARSHA_SLACK_ID = 'U08TM4QFQ1L';

describe('Slack internal-author guard (ENG-1263)', () => {
  let app: express.Application;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/slack', slackRouter);
    jest.clearAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    settingsService.getSetting.mockResolvedValue({ settingValue: 'user-123' });
    userDb.getUserById.mockResolvedValue({
      userId: 'user-123',
      email: 'customer@example.com',
      slackChannels: ['C12345'],
    });
    mockTriage.mockResolvedValue(true);
    chatbotDb.createChatSession.mockResolvedValue({ sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o' });
    chatbotDb.updateSessionSlackThread.mockResolvedValue({ sessionId: 'session-123' });
    generateSessionResponse.mockResolvedValue({ content: 'Draft reply', toolCalls: [] });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const postMessage = (user: string, text: string) =>
    request(app)
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'message',
          user,
          text,
          channel: 'C12345',
          ts: '1234567890.123456',
        },
      });

  it('skips the client-question pipeline for a known-internal author even when the email cannot be resolved (the ENG-1263 regression)', async () => {
    // This is exactly what happened on 2026-08-16: getSlackUserEmail() returned null for Harsha's
    // own account (cross-workspace profile in a Slack-Connect customer channel), so the old
    // `senderEmail && senderEmail.endsWith(...)` check silently fell through to triage.
    mockGetSlackUserEmail.mockResolvedValue(null);

    const res = await postMessage(HARSHA_SLACK_ID, "Hi @Lyndi! Closing the loop on last week and this week's numbers…");
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).not.toHaveBeenCalled();
    expect(chatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
  });

  it('still skips a known-internal author when the email DOES resolve to @agentweb.pro (no regression on the original behavior)', async () => {
    mockGetSlackUserEmail.mockResolvedValue('harsha@agentweb.pro');

    const res = await postMessage(HARSHA_SLACK_ID, 'Team, heads up on the Every.io account');
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).not.toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
  });

  it('skips a non-allowlisted author whose email resolves to @agentweb.pro (email-based path still works)', async () => {
    mockGetSlackUserEmail.mockResolvedValue('someoneelse@agentweb.pro');

    const res = await postMessage('U_OTHER_TEAMMATE', 'Anyone seen the deploy logs?');
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).not.toHaveBeenCalled();
    expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
  });

  it('still triages and notifies for a genuine external author whose email ALSO fails to resolve (no over-correction — the regression that matters most)', async () => {
    // Mirrors the 2026-08-19T21:22Z counter-evidence cited on the Linear issue: an external-org
    // author (Ed Mongiovi, emongiovi@xcures.com) whose profile email did resolve that day fired
    // correctly. This test covers the harder case — an external author whose email does NOT
    // resolve — to prove the fix doesn't fail closed and silently drop real customer questions.
    mockGetSlackUserEmail.mockResolvedValue(null);

    const res = await postMessage('U_CUSTOMER_UNRESOLVED', 'Can someone help with my campaign setup?');
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).toHaveBeenCalledWith('Can someone help with my campaign setup?');
    expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalled();
  });

  it('still triages and notifies for a genuine external author with a normally-resolving email (baseline, unchanged)', async () => {
    mockGetSlackUserEmail.mockResolvedValue('customer@external.com');

    const res = await postMessage('U_CUSTOMER', 'Hey, can someone help with my campaign?');
    expect(res.status).toBe(200);
    await flushAsync();

    expect(mockTriage).toHaveBeenCalledWith('Hey, can someone help with my campaign?');
    expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalled();
  });

  it('logs the unresolved-author branch distinguishably from both the internal-skip and normal-continue paths', async () => {
    mockGetSlackUserEmail.mockResolvedValue(null);

    await postMessage('U_CUSTOMER_UNRESOLVED', 'Can someone help with my campaign setup?');
    await flushAsync();

    const logMessages = logSpy.mock.calls.map((call) => call[0]);
    const unresolvedLog = logMessages.find((m: string) =>
      typeof m === 'string' && m.includes('could not resolve author identity') && m.includes('U_CUSTOMER_UNRESOLVED')
    );
    expect(unresolvedLog).toBeDefined();

    // Distinguishable: never the internal-skip wording, and only fired once (not once per branch).
    const internalSkipLogs = logMessages.filter((m: string) =>
      typeof m === 'string' && m.includes('skipping message from AgentWeb team member')
    );
    expect(internalSkipLogs).toHaveLength(0);
  });

  it('does NOT log the unresolved-author message for a known-internal author (branches are mutually exclusive)', async () => {
    mockGetSlackUserEmail.mockResolvedValue(null);

    await postMessage(HARSHA_SLACK_ID, "Hi @Lyndi! Closing the loop on last week and this week's numbers…");
    await flushAsync();

    const logMessages = logSpy.mock.calls.map((call) => call[0]);
    const unresolvedLog = logMessages.find((m: string) =>
      typeof m === 'string' && m.includes('could not resolve author identity')
    );
    expect(unresolvedLog).toBeUndefined();

    const internalSkipLog = logMessages.find((m: string) =>
      typeof m === 'string' && m.includes('skipping message from AgentWeb team member') && m.includes(HARSHA_SLACK_ID)
    );
    expect(internalSkipLog).toBeDefined();
  });

  // CodeRabbit (PR #2508): the top-level-message guard above and this monitored triggered-thread
  // reply path independently re-implemented the same "is this internal" check, and only the
  // top-level one was fixed initially — an allowlisted internal user replying in a monitored
  // thread with an unresolved email still fell through the exact same fail-open gap. Both paths
  // now share `isInternalSlackAuthor()`; these tests cover the thread-reply path directly.
  describe('monitored triggered-thread reply path', () => {
    const threadReply = (user: string, text: string) =>
      request(app)
        .post('/api/slack/events')
        .send({
          type: 'event_callback',
          event: {
            type: 'message',
            user,
            text,
            channel: 'C12345',
            ts: '1234567891.000000',
            thread_ts: '1234567890.123456',
          },
        });

    beforeEach(() => {
      // Thread mapping marks this as a monitored (email-only) session
      settingsService.getSetting.mockResolvedValue({
        settingValue: JSON.stringify({ sessionId: 'session-123', userId: 'user-123', type: 'triggered' }),
      });
      chatbotDb.getChatSession.mockResolvedValue({ sessionId: 'session-123', userId: 'user-123', messages: [], llmModel: 'gpt-4o' });
    });

    it('skips a known-internal reply even when the email cannot be resolved (the exact gap CodeRabbit flagged)', async () => {
      mockGetSlackUserEmail.mockResolvedValue(null);

      const res = await threadReply(HARSHA_SLACK_ID, 'Following up on the numbers');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(generateSessionResponse).not.toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).not.toHaveBeenCalled();
    });

    it('still generates a response and emails for a genuine external reply whose email fails to resolve (no over-correction)', async () => {
      mockGetSlackUserEmail.mockResolvedValue(null);

      const res = await threadReply('U_CUSTOMER_UNRESOLVED', 'Following up on this');
      expect(res.status).toBe(200);
      await flushAsync();

      expect(generateSessionResponse).toHaveBeenCalled();
      expect(mockSendSlackTriggeredSessionEmail).toHaveBeenCalled();
    });
  });
});
