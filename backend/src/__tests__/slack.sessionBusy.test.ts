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
  });
});
