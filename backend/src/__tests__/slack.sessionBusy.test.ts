/**
 * ENG-1719 — the two Agent Mode auto-revision entry points in this route (direct
 * asset revision keyed by `agentSessionId`, and task-based revision keyed by
 * `task.sessionId`) both fire `runVerifiedChat` fire-and-forget after responding
 * to Slack, then paged on-call via `sendAgentModeOncallAlert` for ANY rejection —
 * including a `SessionBusyError` from ordinary lock contention (e.g. the customer
 * live-chatting on the same session). That produced false oncall pages for
 * expected, benign contention. Both sites now check `isSessionBusyError` first.
 *
 * Scoped follow-up review found neither site had a dedicated test — both were
 * verified correct only by hand-tracing the code. This file closes that gap for
 * both remaining `SessionBusyError` call sites in `routes/slack.ts`.
 */
import express from 'express';
import request from 'supertest';
import { approvalDb } from '../services/approvalDb';
import { chatbotDb } from '../services/chatbotService';
import { runVerifiedChat, isSessionBusyError } from '../controllers/agentModeController';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { postSlackMessage } from '../services/slackService';
import { taskDb } from '../services/db';

jest.mock('../services/approvalDb');
jest.mock('../services/slackService');
jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn(),
    sendTaskExecutionEmail: jest.fn(),
    sendEmail: jest.fn(),
  },
}));
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskExecutionById: jest.fn(),
    getTaskById: jest.fn(),
    updateTask: jest.fn(),
  },
  subscriberDb: {
    getSubscribersByTaskId: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
  },
}));
jest.mock('../controllers/agentModeController', () => ({
  runVerifiedChat: jest.fn(),
  // Mirrors the real isSessionBusyError's contract: real SessionBusyError instances
  // carry `code: 'SESSION_BUSY'`.
  isSessionBusyError: jest.fn((error: unknown) =>
    typeof error === 'object' && error !== null && (error as any).code === 'SESSION_BUSY'),
}));
jest.mock('../controllers/tasks', () => ({
  createRevisionExecutionFromSlack: jest.fn(),
}));
jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    views: { open: jest.fn().mockResolvedValue({ ok: true }) },
    chat: { update: jest.fn().mockResolvedValue({ ok: true }) },
  })),
}));

const mockRunVerifiedChat = runVerifiedChat as jest.Mock;
const mockIsSessionBusyError = isSessionBusyError as jest.Mock;
const mockSendAgentModeOncallAlert = sendAgentModeOncallAlert as jest.Mock;
const mockGetChatSession = chatbotDb.getChatSession as jest.Mock;
const mockGetApproval = approvalDb.getApproval as jest.Mock;
const mockUpdateApprovalStatus = approvalDb.updateApprovalStatus as jest.Mock;
const mockGetTaskExecutionById = taskDb.getTaskExecutionById as jest.Mock;
const mockGetTaskById = taskDb.getTaskById as jest.Mock;
const mockPostSlackMessage = postSlackMessage as jest.Mock;

// Fire-and-forget: the route responds before runVerifiedChat's promise chain settles,
// so tests need to flush the microtask queue (mock rejection -> .catch -> dynamic
// import -> isSessionBusyError check) after the HTTP response comes back.
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  process.env.SLACK_VERIFICATION_TOKEN = 'test-verification-token';
  const slackRouter = require('../routes/slack').default;
  app.use('/api/slack', slackRouter);
  return app;
}

function feedbackModalPayload(metadata: Record<string, unknown>, feedback: string) {
  return {
    type: 'view_submission',
    token: 'test-verification-token',
    team: { id: 'T123', domain: 'test-workspace' },
    user: { id: 'U123', username: 'testuser' },
    view: {
      callback_id: 'feedback_modal',
      private_metadata: JSON.stringify(metadata),
      state: {
        values: {
          feedback_input: {
            feedback_text: { value: feedback },
          },
        },
      },
    },
  };
}

describe('Slack Agent Mode revision — session-busy contention (ENG-1719)', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSessionBusyError.mockImplementation((error: unknown) =>
      typeof error === 'object' && error !== null && (error as any).code === 'SESSION_BUSY');
    mockPostSlackMessage.mockResolvedValue({ ts: '1', channel: 'C1' });
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.SLACK_VERIFICATION_TOKEN;
  });

  describe('direct Agent Mode asset (agentSessionId branch)', () => {
    const approval = {
      assetUrl: 'https://example.com/original.png',
      filename: 'original.png',
      assetType: 'image',
      executionId: 'sess-a-images', // '-images' suffix routes to the agentSessionId branch
      userId: 'user-1',
      slackChannel: 'C1',
      slackChannelName: 'approvals',
      slackMessageTs: '100.0',
    };

    beforeEach(() => {
      mockGetApproval.mockResolvedValue(approval);
      mockUpdateApprovalStatus.mockResolvedValue(undefined);
      mockGetChatSession.mockResolvedValue({ userId: 'user-1' });
    });

    it('does not page on-call when the target session is already busy', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }),
      );

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockSendAgentModeOncallAlert).not.toHaveBeenCalled();
    });

    it('still pages on-call for a genuine (non-busy) failure', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(new Error('LLM provider exploded'));

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockSendAgentModeOncallAlert).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Agent Mode Verified Generate: Failed' }),
      );
    });

    it('ENG-1741: tells the reviewer directly in Slack when the session is busy', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }),
      );

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockPostSlackMessage).toHaveBeenCalledWith(
        approval.slackChannel,
        expect.stringContaining('busy'),
        approval.slackMessageTs,
      );
    });

    it('ENG-1741: tells the reviewer directly in Slack on a genuine (non-busy) failure', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(new Error('LLM provider exploded'));

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockPostSlackMessage).toHaveBeenCalledWith(
        approval.slackChannel,
        expect.stringContaining("didn't go through"),
        approval.slackMessageTs,
      );
    });

    it('ENG-1741: tells the reviewer directly in Slack when no asset was extracted', async () => {
      mockRunVerifiedChat.mockResolvedValueOnce({ success: false, toolCalls: [] });

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockPostSlackMessage).toHaveBeenCalledWith(
        approval.slackChannel,
        expect.stringContaining("didn't go through"),
        approval.slackMessageTs,
      );
    });
  });

  describe('task-based Agent Mode session (task.sessionId branch)', () => {
    const approval = {
      assetUrl: 'https://example.com/original.png',
      filename: 'original.png',
      assetType: 'image',
      executionId: 'exec-browser-task-1', // no agent-mode suffix -> routed via taskDb
      userId: 'user-1',
      slackChannel: 'C1',
      slackChannelName: 'approvals',
      slackMessageTs: '100.0',
    };

    beforeEach(() => {
      mockGetApproval.mockResolvedValue(approval);
      mockUpdateApprovalStatus.mockResolvedValue(undefined);
      mockGetTaskExecutionById.mockResolvedValue({ taskId: 'task-1', executionId: approval.executionId });
      mockGetTaskById.mockResolvedValue({ taskId: 'task-1', sessionId: 'sess-b' });
      mockGetChatSession.mockResolvedValue({ userId: 'user-1' });
    });

    it('does not page on-call when the target session is already busy', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }),
      );

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockSendAgentModeOncallAlert).not.toHaveBeenCalled();
    });

    it('still pages on-call for a genuine (non-busy) failure', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(new Error('LLM provider exploded'));

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockSendAgentModeOncallAlert).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Agent Mode Verified Generate: Failed' }),
      );
    });

    it('ENG-1741: tells the reviewer directly in Slack when the session is busy', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }),
      );

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockPostSlackMessage).toHaveBeenCalledWith(
        approval.slackChannel,
        expect.stringContaining('busy'),
        approval.slackMessageTs,
      );
    });

    it('ENG-1741: tells the reviewer directly in Slack on a genuine (non-busy) failure', async () => {
      mockRunVerifiedChat.mockRejectedValueOnce(new Error('LLM provider exploded'));

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockPostSlackMessage).toHaveBeenCalledWith(
        approval.slackChannel,
        expect.stringContaining("didn't go through"),
        approval.slackMessageTs,
      );
    });

    it('ENG-1741: tells the reviewer directly in Slack when no asset was extracted', async () => {
      mockRunVerifiedChat.mockResolvedValueOnce({ success: false, toolCalls: [] });

      const res = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });

      expect(res.status).toBe(200);
      await flushMicrotasks();

      expect(mockPostSlackMessage).toHaveBeenCalledWith(
        approval.slackChannel,
        expect.stringContaining("didn't go through"),
        approval.slackMessageTs,
      );
    });
  });
});

// ENG-669 PR-C (rv-3681): runVerifiedChat refuses a stored AgentWeb Model selection it cannot serve. Both revision
// branches tell the reviewer what is wrong and what to do, and do not page on-call (not an outage). Non-model failures
// keep the generic notice and the page (the ENG-1741 tests above).
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';

describe('Slack Agent Mode revision — the chat\'s model refused (model_unavailable)', () => {
  let app: express.Application;
  const base = {
    assetUrl: 'https://example.com/original.png', filename: 'original.png', assetType: 'image', userId: 'user-1',
    slackChannel: 'C1', slackChannelName: 'approvals', slackMessageTs: '100.0',
  };
  const branches: Array<[string, Record<string, unknown>, () => void]> = [
    ['direct asset (agentSessionId)', { ...base, executionId: 'sess-a-images' }, () => undefined],
    ['task-based (task.sessionId)', { ...base, executionId: 'exec-browser-task-1' }, () => {
      mockGetTaskExecutionById.mockResolvedValue({ taskId: 'task-1', executionId: 'exec-browser-task-1' });
      mockGetTaskById.mockResolvedValue({ taskId: 'task-1', sessionId: 'sess-b' });
    }],
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSessionBusyError.mockImplementation((error: unknown) =>
      typeof error === 'object' && error !== null && (error as any).code === 'SESSION_BUSY');
    mockPostSlackMessage.mockResolvedValue({ ts: '1', channel: 'C1' });
    mockUpdateApprovalStatus.mockResolvedValue(undefined);
    mockGetChatSession.mockResolvedValue({ userId: 'user-1', llmModel: 'agentweb-model' });
    app = buildApp();
  });
  afterEach(() => { delete process.env.SLACK_VERIFICATION_TOKEN; });

  it.each(branches)('%s: posts the refusal and what to do; no page, no generic notice', async (_label, approval, setUp) => {
    setUp();
    mockGetApproval.mockResolvedValue(approval);
    mockRunVerifiedChat.mockRejectedValueOnce(new ModelUnavailableError('agentweb-model', 'not_served'));

    const res = await request(app).post('/api/slack/interactions').type('form')
      .send({ payload: JSON.stringify(feedbackModalPayload(approval, 'make it pop')) });
    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(mockSendAgentModeOncallAlert).not.toHaveBeenCalled();
    const posts = mockPostSlackMessage.mock.calls.filter(([channel]) => channel === 'C1');
    expect(posts).toHaveLength(1);
    expect(posts[0][1]).toContain("AgentWeb Model isn't available right now");
    expect(posts[0][1]).toContain('choose another model for this chat in AgentWeb, then retry the feedback');
    expect(posts[0][1]).not.toContain("didn't go through");
    expect(posts[0][2]).toBe('100.0');
  });
});
