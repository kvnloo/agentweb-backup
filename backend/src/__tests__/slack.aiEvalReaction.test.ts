/**
 * Tests for the ai-eval-funnel ✅ reaction handler in /api/slack/events.
 *
 * Behavioral contract — legacy Slack approvals during the Linear migration:
 *   1. POST /api/slack/events handles reaction_added events.
 *   2. Guard: white_check_mark + Harsha (U08TM4QFQ1L) + Emma-bot DM containing
 *      "AI Eval Funnel — daily run" + not already dispatched.
 *   3. Parse actionable digest items and file them through canonical Linear intake.
 *   4. Legacy items fail closed to Needs PM unless the digest explicitly admits a code change.
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

const mockFileAutoIssue = jest.fn();
jest.mock('../services/intakeService', () => ({
  fileAutoIssue: (...args: unknown[]) => mockFileAutoIssue(...args),
}));

const mockRecordLoopApproval = jest.fn();
jest.mock('../loops/core/learning/approvalPersistence', () => ({
  recordLoopApproval: (...args: unknown[]) => mockRecordLoopApproval(...args),
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

// Tracker — use the real DynamoDB-backed impl, but inject an in-memory fake
// DynamoPort so the test never touches live AWS. Each test resets the tracker
// with a FRESH fake table (so the dedupe set is empty), except the
// "survives redeploy" test, which deliberately re-injects the SAME table.
import {
  _resetForTesting as resetTracker,
  isDispatched,
  DynamoLoopDispatchTracker,
} from '../services/loopDispatchTracker';
import type { DynamoAttributeMap, DynamoPort } from '../loops/core/ports';
import { _resetLoopApprovalForTesting } from '../services/loopSlackApprovalDispatcher';

/** In-memory fake DynamoPort keyed on the messageTs partition key. */
function makeFakeDynamo() {
  const items = new Map<string, DynamoAttributeMap>();
  const port: DynamoPort = {
    putItem: async (_table: string, item: DynamoAttributeMap) => {
      items.set(String(item.messageTs), { ...item });
    },
    getItem: async (_table: string, key: DynamoAttributeMap) =>
      items.get(String(key.messageTs)) ?? null,
    query: async () => ({ items: [] }),
  };
  return { port, items };
}

// Import router AFTER all mocks declared.
import slackRouter from '../routes/slack';

const HARSHA = 'U08TM4QFQ1L';
const EMMA_BOT = 'UEMMA_BOT';
const DM_CHANNEL = 'D12345';
const MESSAGE_TS = '1700000000.000100';
const AI_READINESS_MESSAGE_TS = '1700000000.000200';
const FUTURE_LOOP_MESSAGE_TS = '1700000000.000300';
// One real Notion task URL from the daily DM (32-hex page id at end of slug).
const PAGE_URL_1 =
  '<https://www.notion.so/fix-ai-eval-funnel-capture-broken-Lots-of-landings-36d09247c9518127bc6fffd03dd0e887|fix(ai-eval-funnel): capture-broken — Lots of landings>';

const PAGE_URL_2 =
  '<https://www.notion.so/fix-ai-eval-funnel-wait-too-long-Funnel-stalls-abc12345678901234567890123456789|fix(ai-eval-funnel): wait-too-long — Funnel stalls>';

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

function buildFutureLoopDmMessage() {
  return [
    '*🧪 Revenue Loop — daily run 2026-06-10*',
    'Run ID: `loop-revenue-2026-06-10T16:45:00.000Z-123456`',
    'Events scanned: 17  |  Findings: 1',
    '',
    '*What I found*',
    '1. Trial signup drop-off spiked after pricing click',
    '   Kind: `code_change`  |  Fix: tighten the pricing CTA and preserve measurement.',
    '',
    'React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop',
  ].join('\n');
}

function buildUnparseableLoopDmMessage() {
  return [
    '*🧪 Revenue Loop — daily run 2026-06-10*',
    'Run ID: `loop-revenue-empty`',
    'Events scanned: 17  |  Findings: 1',
    '',
    'I found something, but this digest forgot to include numbered items.',
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
    // Fresh fake DynamoDB-backed tracker per test → empty dedupe set, no live AWS.
    resetTracker(makeFakeDynamo().port);
    _resetLoopApprovalForTesting();

    mockAuthTest.mockResolvedValue({ ok: true, user_id: EMMA_BOT });
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: 'reply-ts' });
    mockRecordLoopApproval.mockResolvedValue({ loopId: null, approved: 0, shipped: 0, dispatchFailures: 0 });
    mockFileAutoIssue.mockResolvedValue({
      id: 'ENG-999',
      url: 'https://linear.app/agentweb/issue/ENG-999/test',
      tracker: 'Linear',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails closed for the retired AI Eval Notion-link digest', async () => {
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

    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === MESSAGE_TS,
    );
    expect(replies[0][0].text).toMatch(/could not parse any dispatchable tasks/i);
    expect(await isDispatched(MESSAGE_TS)).toBe(false);
  });

  it('queues an approved AI Readiness item for human triage', async () => {
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

    expect(mockFileAutoIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: 'fix(ai-readiness-funnel): low-data-quiz-start-leak',
      description: expect.stringContaining('3/42 visitors started the quiz'),
      executionRoute: 'human-triage',
      notionContext: expect.objectContaining({
        'Alert Class': expect.stringContaining('slack-approved-loop:'),
      }),
    }));

    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === AI_READINESS_MESSAGE_TS,
    );
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(replies[0][0].text).toMatch(/Queuing 1 approved Linear task/i);
    expect(replies[replies.length - 1][0].text).toMatch(/Queued 1\/1 Linear task/i);
    expect(replies[replies.length - 1][0].text).toMatch(/Needs PM/i);
    expect(await isDispatched(AI_READINESS_MESSAGE_TS)).toBe(true);
  });

  it('persists the approval to the learning store after dispatch (Layer-4→5 write)', async () => {
    mockRecordLoopApproval.mockResolvedValue({
      loopId: 'ai-readiness-funnel',
      approved: 1,
      shipped: 1,
      dispatchFailures: 0,
    });
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

    expect(mockRecordLoopApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'loop-ai-readiness-funnel-2026-06-10T16:30:00.087Z-523167',
        approver: `slack:${HARSHA}`,
        items: [expect.objectContaining({ id: 'low-data-quiz-start-leak', ok: true })],
        stores: expect.any(Array),
      }),
    );
    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === AI_READINESS_MESSAGE_TS,
    );
    expect(replies[replies.length - 1][0].text).toMatch(/Learning store: 1 approved, 1 marked shipped/);
  });

  it('lets a new loop use the shared ✅ footer without adding a bespoke Slack handler', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: FUTURE_LOOP_MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildFutureLoopDmMessage(),
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
          item: { type: 'message', channel: DM_CHANNEL, ts: FUTURE_LOOP_MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();

    expect(mockFileAutoIssue).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('fix(revenue-loop)'),
      description: expect.stringContaining('tighten the pricing CTA'),
      executionRoute: 'human-triage',
    }));

    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === FUTURE_LOOP_MESSAGE_TS,
    );
    expect(replies[0][0].text).toMatch(/Queuing 1 approved Linear task/i);
    expect(replies[replies.length - 1][0].text).toMatch(/Queued 1\/1 Linear task/i);
    expect(replies[replies.length - 1][0].text).toMatch(/Needs PM/i);
    expect(replies[replies.length - 1][0].text).toMatch(/ENG-999/i);
    expect(await isDispatched(FUTURE_LOOP_MESSAGE_TS)).toBe(true);
  });

  it('reports a parse warning for new loop digests that have the shared footer but no dispatchable items', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: FUTURE_LOOP_MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildUnparseableLoopDmMessage(),
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
          item: { type: 'message', channel: DM_CHANNEL, ts: FUTURE_LOOP_MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();

    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === FUTURE_LOOP_MESSAGE_TS,
    );
    expect(replies[0][0].text).toMatch(/could not parse any dispatchable tasks/i);
  });

  it('reports failed generated-task dispatch without hiding the rest of the reaction handler', async () => {
    mockFileAutoIssue.mockRejectedValueOnce(new Error('Linear write denied'));
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: FUTURE_LOOP_MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildFutureLoopDmMessage(),
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
          item: { type: 'message', channel: DM_CHANNEL, ts: FUTURE_LOOP_MESSAGE_TS },
        },
      });

    expect(res.status).toBe(200);
    await wait();

    expect(mockFileAutoIssue).toHaveBeenCalledTimes(1);
    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === FUTURE_LOOP_MESSAGE_TS,
    );
    expect(replies[replies.length - 1][0].text).toMatch(/Queued 0\/1 Linear task/i);
    expect(replies[replies.length - 1][0].text).toMatch(/Linear write denied/i);
    expect(await isDispatched(FUTURE_LOOP_MESSAGE_TS)).toBe(true);
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
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
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
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
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
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
  });

  it('skips dispatch on duplicate ✅ for the same messageTs', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildAiReadinessDmMessage(),
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
    expect(mockFileAutoIssue).toHaveBeenCalledTimes(1);

    // Second reaction on same ts → no duplicate Linear intake.
    await request(buildApp()).post('/api/slack/events').send(payload);
    await wait();
    expect(mockFileAutoIssue).toHaveBeenCalledTimes(1);
  });

  // AC #2 (HUMAN-WRITTEN): reacting ✅ twice on the same DM ACROSS a simulated
  // backend redeploy files the approved Linear task exactly ONCE. This is the case
  // the in-memory v1 tracker FAILED — the Map reset on restart, so the second
  // ✅ re-dispatched. With DynamoDB persistence the dedupe survives.
  it('does not double-dispatch across a simulated redeploy (DynamoDB persistence)', async () => {
    const { port } = makeFakeDynamo(); // one persistent table shared across "restarts"
    resetTracker(new DynamoLoopDispatchTracker(port));

    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildAiReadinessDmMessage(),
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

    // First ✅ → files once.
    await request(buildApp()).post('/api/slack/events').send(payload);
    await wait();
    expect(mockFileAutoIssue).toHaveBeenCalledTimes(1);

    // Simulate a redeploy: a BRAND-NEW tracker instance over the SAME table.
    resetTracker(new DynamoLoopDispatchTracker(port));

    // Re-✅ the same (pre-deploy) DM → must NOT file again.
    await request(buildApp()).post('/api/slack/events').send(payload);
    await wait();
    expect(mockFileAutoIssue).toHaveBeenCalledTimes(1);
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

    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    // Must mention the scope name AND a Slack-config-style hint so a human can act on it.
    const calls = consoleSpy.mock.calls.flat().join(' ');
    expect(calls).toMatch(/reactions:read/);
    expect(calls).toMatch(/api\.slack\.com\/apps/);
    consoleSpy.mockRestore();
  });

  it('logs generic Slack history errors and returns 200 without dispatching', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockConversationsHistory.mockRejectedValue(new Error('slack api unavailable'));

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

    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    expect(consoleSpy.mock.calls.flat().join(' ')).toMatch(/conversations\.history failed/);
    consoleSpy.mockRestore();
  });

  it('reports partial success when one Linear intake write fails', async () => {
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
          bot_id: 'B_EMMA',
          text: buildFutureLoopDmMessage().replace(
            'React ✅ to dispatch',
            '2. Activation email delivery regressed\n   Kind: `code_change`  |  Fix: restore the existing delivery invariant.\n\nReact ✅ to dispatch',
          ),
        },
      ],
    });

    mockFileAutoIssue
      .mockResolvedValueOnce({
        id: 'ENG-999',
        url: 'https://linear.app/agentweb/issue/ENG-999/test',
        tracker: 'Linear',
      })
      .mockRejectedValueOnce(new Error('Linear rate limit exceeded'));

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

    expect(mockFileAutoIssue).toHaveBeenCalledTimes(2);
    const replies = mockChatPostMessage.mock.calls.filter(
      ([arg]) => arg.thread_ts === MESSAGE_TS,
    );
    const finalReply = replies[replies.length - 1][0].text as string;
    // Summary mentions partial success: 1 of 2.
    expect(finalReply).toMatch(/Queued 1\/2 Linear tasks/);
    expect(finalReply).toMatch(/Linear rate limit exceeded/);
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
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
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
    expect(mockFileAutoIssue).not.toHaveBeenCalled();
  });

  it('ignores no-bot_id messages when Emma bot identity lookup fails', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAuthTest.mockRejectedValue(new Error('auth.test failed'));
    mockConversationsHistory.mockResolvedValue({
      ok: true,
      messages: [
        {
          ts: MESSAGE_TS,
          user: EMMA_BOT,
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

    expect(mockFileAutoIssue).not.toHaveBeenCalled();
    expect(consoleSpy.mock.calls.flat().join(' ')).toMatch(/Could not fetch Emma bot user ID/);
    consoleSpy.mockRestore();
  });
});
