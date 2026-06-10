/**
 * Tests for the ai-eval-funnel ✅ reaction handler in /api/slack/events.
 *
 * Behavioral contract — from Notion task 36d09247c95181a9bf6fe75a7cb7c6af:
 *   1. POST /api/slack/events handles reaction_added events.
 *   2. Guard: white_check_mark + Harsha (U08TM4QFQ1L) + Emma-bot DM containing
 *      "AI Eval Funnel — daily run" + not already dispatched.
 *   3. Parse Notion page IDs from message text and call launchEnvironment(...)
 *      with the Sprint Tasks data-source ID.
 *   4. Post thread reply: "Dispatching N..." then completion summary.
 *   5. Idempotency via loopDispatchTracker (in-memory Map).
 *   6. missing_scope from Slack: clear console.error, still 200, no launches.
 *   7. (cron template change tested separately.)
 */

import request from 'supertest';
import express from 'express';

// ---------- Mocks (must be declared before importing the router) ----------

const mockConversationsHistory = jest.fn();
const mockChatPostMessage = jest.fn();
const mockAuthTest = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockChatPostMessage, delete: jest.fn() },
    conversations: { history: mockConversationsHistory },
    auth: { test: mockAuthTest },
  })),
}));

const mockLaunchEnvironment = jest.fn();
const mockGetNotionPage = jest.fn();
const mockGetNotionPageContent = jest.fn();
const mockGetNotionCredentials = jest.fn();
const mockGetSprintTasksDatabaseId = jest.fn();

jest.mock('../services/devEnvService', () => ({
  launchEnvironment: (...args: unknown[]) => mockLaunchEnvironment(...args),
  getNotionPage: (...args: unknown[]) => mockGetNotionPage(...args),
  getNotionPageContent: (...args: unknown[]) => mockGetNotionPageContent(...args),
}));

jest.mock('../services/notionService', () => ({
  getNotionCredentials: (...args: unknown[]) => mockGetNotionCredentials(...args),
  getSprintTasksDatabaseId: (...args: unknown[]) => mockGetSprintTasksDatabaseId(...args),
}));

// Generic mocks so unrelated handlers in the same file don't blow up.
jest.mock('../services/db', () => ({
  userDb: { getAllUsers: jest.fn(), getUserById: jest.fn(), getUserByEmail: jest.fn() },
  taskDb: {},
  subscriberDb: {},
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
}));
jest.mock('../services/approvalDb', () => ({
  approvalDb: {},
  getAssetTypeFromFilename: jest.fn(),
}));
jest.mock('../services/emailService', () => ({
  emailService: {},
}));
jest.mock('../controllers/tasks', () => ({
  createRevisionExecutionFromSlack: jest.fn(),
}));
jest.mock('../utils/agentModeErrors', () => ({ isSessionLimitError: jest.fn() }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn() }));
jest.mock('../services/slackService', () => ({
  getSlackChannels: jest.fn(),
  sendApprovalRequest: jest.fn(),
  sendApprovalRequestWithTracking: jest.fn(),
  updateApprovalMessage: jest.fn(),
  openFeedbackModal: jest.fn(),
  openRejectModal: jest.fn(),
  openTestEmailModal: jest.fn(),
  postThreadResponse: jest.fn(),
  postThinkingMessage: jest.fn(),
  deleteSlackMessage: jest.fn(),
  getSlackUserDisplayName: jest.fn(),
  getSlackUserEmail: jest.fn(),
  resolveSlackMentionsInText: jest.fn((s: string) => Promise.resolve(s)),
  downloadSlackFile: jest.fn(),
}));

// Tracker — use real impl, just reset between tests.
import { _resetForTesting as resetTracker, isDispatched } from '../services/loopDispatchTracker';

// Import router AFTER all mocks declared.
import slackRouter from '../routes/slack';

const HARSHA = 'U08TM4QFQ1L';
const EMMA_BOT = 'UEMMA_BOT';
const DM_CHANNEL = 'D12345';
const MESSAGE_TS = '1700000000.000100';
const AI_READINESS_MESSAGE_TS = '1700000000.000200';
const SPRINT_TASKS_DATA_SOURCE = '2bf09247-c951-812a-bd0a-000bd4c05bbf';

// One real Notion task URL from the daily DM (32-hex page id at end of slug).
const PAGE_URL_1 =
  '<https://www.notion.so/fix-ai-eval-funnel-capture-broken-Lots-of-landings-36d09247c9518127bc6fffd03dd0e887|fix(ai-eval-funnel): capture-broken — Lots of landings>';
const PAGE_ID_1 = '36d09247c9518127bc6fffd03dd0e887';

const PAGE_URL_2 =
  '<https://www.notion.so/fix-ai-eval-funnel-wait-too-long-Funnel-stalls-abc12345678901234567890123456789|fix(ai-eval-funnel): wait-too-long — Funnel stalls>';
const PAGE_ID_2 = 'abc12345678901234567890123456789';

function buildLoopDmMessage(urls: string[] = [PAGE_URL_1]) {
  return [
    '*🌅 AI Eval Funnel — daily run 2026-05-27*',
    'Run ID: `abc-123`',
    'Events scanned: 5  |  Rules fired: 1  |  Mutations: 1',
    '',
    '*Proposed fixes*',
    ...urls.map((u, i) => `${i + 1}. ${u}\n   Rule: \`capture-broken\``),
    '',
    'React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop',
  ].join('\n');
}

function buildAiReadinessDmMessage() {
  return [
    '*🧭 AI Readiness Funnel — daily run 2026-06-10*',
    'Run ID: `loop-ai-readiness-funnel-2026-06-10T16:30:00.087Z-523167`',
    'Events scanned: 58  |  Findings: 0',
    'Funnel (7d): landed 42 → quiz 3 → captured 11 → book 0 / signup 2',
    '',
    'No disproportionate leak this window. Watch the shape above; the next push is whichever stage is thinnest.',
    '',
    '*Startup decisions (low-data, permission-gated)*',
    '1. `low-data-quiz-start-leak` — Try one above-the-fold change: make the first screen promise the delivered roadmap and reduce the perceived quiz commitment.',
    '   Evidence: 3/42 visitors started the quiz (7%).  |  Confidence: medium  |  Needs approval: yes',
    '',
    'React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop',
  ].join('\n');
}

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/slack', slackRouter);
  return app;
}

async function wait(ms = 200) {
  await new Promise((r) => setTimeout(r, ms));
}

describe('POST /api/slack/events — reaction_added handler (ai-eval-funnel)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTracker();

    mockAuthTest.mockResolvedValue({ ok: true, user_id: EMMA_BOT });
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: 'reply-ts' });
    mockGetNotionCredentials.mockResolvedValue({ apiToken: 'notion-token', userGuidePageId: 'guide' });
    mockGetSprintTasksDatabaseId.mockResolvedValue(SPRINT_TASKS_DATA_SOURCE);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'notion-ai-readiness-page-id',
        url: 'https://notion.so/notionaireadinesspageid',
      }),
    } as Response);
    mockGetNotionPage.mockResolvedValue({
      title: 'fix(ai-eval-funnel): capture-broken',
      status: 'To-do',
      instanceId: '',
      sgId: '',
      publicIp: '',
      databaseId: '2bf09247-c951-8122-a327-ee39ef7a6ec7',
      launchedBy: '',
    });
    mockGetNotionPageContent.mockResolvedValue({
      text: 'task content here',
      attachments: [],
    });
    mockLaunchEnvironment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dispatches cloud-dev runs when Harsha reacts ✅ on the daily Emma DM', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildLoopDmMessage([PAGE_URL_1, PAGE_URL_2]),
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: HARSHA,
          item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();

    // Verified BOTH page IDs were extracted and dispatched.
    expect(mockLaunchEnvironment).toHaveBeenCalledTimes(2);
    expect(mockLaunchEnvironment).toHaveBeenCalledWith(
      PAGE_ID_1,
      expect.any(String),
      expect.any(String),
      '2bf09247-c951-812a-bd0a-000bd4c05bbf',
    );
    expect(mockLaunchEnvironment).toHaveBeenCalledWith(
      PAGE_ID_2,
      expect.any(String),
      expect.any(String),
      '2bf09247-c951-812a-bd0a-000bd4c05bbf',
    );

    // Two thread replies posted: "Dispatching N" then summary.
    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === MESSAGE_TS,
    );
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(replies[0][0].text).toMatch(/Dispatching 2 cloud-dev/i);
    expect(replies[replies.length - 1][0].text).toMatch(/Launched 2\/2/i);

    // Idempotency: marked dispatched.
    expect(isDispatched(MESSAGE_TS)).toBe(true);
  });

  it('creates and launches cloud-dev task when Harsha reacts ✅ on AI Readiness low-data digest', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: AI_READINESS_MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildAiReadinessDmMessage(),
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: HARSHA,
          item: { type: 'message', channel: DM_CHANNEL, ts: AI_READINESS_MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.notion.com/v1/pages',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('low-data-quiz-start-leak'),
      }),
    );
    expect(mockLaunchEnvironment).toHaveBeenCalledWith(
      'notion-ai-readiness-page-id',
      'fix(ai-readiness-funnel): low-data-quiz-start-leak',
      expect.stringContaining('3/42 visitors started the quiz'),
      SPRINT_TASKS_DATA_SOURCE,
    );

    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === AI_READINESS_MESSAGE_TS,
    );
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(replies[0][0].text).toMatch(/Creating 1 AI Readiness cloud-dev task/i);
    expect(replies[replies.length - 1][0].text).toMatch(/Launched 1\/1 AI Readiness/i);
    expect(isDispatched(AI_READINESS_MESSAGE_TS)).toBe(true);
  });

  it('ignores reactions from users other than Harsha', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildLoopDmMessage(),
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: 'U_RANDO',
          item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();
    expect(mockLaunchEnvironment).not.toHaveBeenCalled();
  });

  it('ignores reactions on messages without the daily-run marker', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: 'Hey, just a regular DM from the bot, not a loop run.',
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: HARSHA,
          item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();
    expect(mockLaunchEnvironment).not.toHaveBeenCalled();
  });

  it('ignores reactions other than white_check_mark', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildLoopDmMessage(),
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'eyes',
          user: HARSHA,
          item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();
    expect(mockLaunchEnvironment).not.toHaveBeenCalled();
  });

  it('skips dispatch on duplicate ✅ for the same messageTs', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildLoopDmMessage([PAGE_URL_1]),
        },
      ],
    });

    const payload = {
      type: 'event_callback',
      event: {
        type: 'reaction_added',
        reaction: 'white_check_mark',
        user: HARSHA,
        item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
      },
    };

    await request(buildApp()).post('/api/slack/events').send(payload);
    await wait();
    expect(mockLaunchEnvironment).toHaveBeenCalledTimes(1);

    // Second reaction on same ts → no new launches
    await request(buildApp()).post('/api/slack/events').send(payload);
    await wait();
    expect(mockLaunchEnvironment).toHaveBeenCalledTimes(1);
  });

  it('logs a clear error and returns 200 when Slack returns missing_scope', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = Object.assign(new Error('missing_scope: reactions:read required'), {
      data: { error: 'missing_scope', needed: 'reactions:read' },
    });
    mockConversationsHistory.mockRejectedValue(err);

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: HARSHA,
          item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();

    expect(mockLaunchEnvironment).not.toHaveBeenCalled();
    // Must mention the scope name AND a Slack-config-style hint so a human can act on it.
    const calls = consoleSpy.mock.calls.flat().join(' ');
    expect(calls).toMatch(/reactions:read/);
    expect(calls).toMatch(/api\.slack\.com\/apps/);
    consoleSpy.mockRestore();
  });

  it('reports partial-success when one launchEnvironment throws', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildLoopDmMessage([PAGE_URL_1, PAGE_URL_2]),
        },
      ],
    });

    mockLaunchEnvironment
      .mockResolvedValueOnce(undefined) // first succeeds
      .mockRejectedValueOnce(new Error('EC2 quota exceeded')); // second fails

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: HARSHA,
          item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();

    expect(mockLaunchEnvironment).toHaveBeenCalledTimes(2);
    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === MESSAGE_TS,
    );
    const finalReply = replies[replies.length - 1][0].text as string;
    // Summary mentions partial success: 1 of 2.
    expect(finalReply).toMatch(/Launched 1\/2/);
    expect(finalReply).toMatch(/EC2 quota exceeded/);
  });

  it('ignores reactions on non-DM channels (channel id does not start with D)', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildLoopDmMessage(),
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: HARSHA,
          item: { type: 'message', channel: 'C_PUBLIC', ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();
    expect(mockLaunchEnvironment).not.toHaveBeenCalled();
  });

  it('ignores reactions on messages NOT posted by Emma (no bot_id)', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: HARSHA, // not a bot
          text: buildLoopDmMessage(),
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/slack/events')
      .send({
        type: 'event_callback',
        event: {
          type: 'reaction_added',
          reaction: 'white_check_mark',
          user: HARSHA,
          item: { type: 'message', channel: DM_CHANNEL, ts: MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();
    expect(mockLaunchEnvironment).not.toHaveBeenCalled();
  });
});
