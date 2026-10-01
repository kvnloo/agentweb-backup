// ENG-1644 Phase C: unit tests for /api/slack/interactions routing of
// approve_decision/reject_decision/edit_decision, the approver-authorization
// gate, and the verdict modal submission. Mirrors slack.rejectionFeedback.test.ts's
// existing supertest-against-the-real-router pattern.

import express from 'express';
import request from 'supertest';
import { approvalInboxService } from '../services/approvalInboxService';
import {
  isAuthorizedApprover,
  openDecisionVerdictModal,
  resolveApprovalDecision,
} from '../services/approvalInboxSlack';

jest.mock('../services/approvalDb');
jest.mock('../services/slackService');
jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { getDecision: jest.fn() },
}));
jest.mock('../services/approvalInboxSlack', () => ({
  APPROVAL_DECISION_ACTION_IDS: ['approve_decision', 'reject_decision', 'edit_decision'],
  isAuthorizedApprover: jest.fn(),
  openDecisionVerdictModal: jest.fn(),
  resolveApprovalDecision: jest.fn(),
}));
jest.mock('../services/db', () => ({
  taskDb: { getTaskExecutionById: jest.fn(), getTaskById: jest.fn(), updateTask: jest.fn() },
  subscriberDb: { getSubscribersByTaskId: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn() } }));
jest.mock('../controllers/agentModeController', () => ({ runVerifiedChat: jest.fn() }));
jest.mock('../controllers/tasks', () => ({ createRevisionExecutionFromSlack: jest.fn() }));
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    views: { open: jest.fn().mockResolvedValue({ ok: true }) },
    chat: { update: jest.fn().mockResolvedValue({ ok: true }), postMessage: jest.fn().mockResolvedValue({ ok: true }) },
  })),
}));

const mockGetDecision = approvalInboxService.getDecision as jest.Mock;
const mockIsAuthorized = isAuthorizedApprover as jest.Mock;
const mockOpenModal = openDecisionVerdictModal as jest.Mock;
const mockResolve = resolveApprovalDecision as jest.Mock;

describe('Slack approval-inbox decision routing', () => {
  let app: express.Application;
  const TOKEN = 'test-verification-token';

  const baseDecision = {
    decisionId: 'decision-1',
    approver: 'matt',
    status: 'pending_team_review',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SLACK_VERIFICATION_TOKEN = TOKEN;
    app = express();
    app.use(express.urlencoded({ extended: true }));
    const slackRouter = require('../routes/slack').default;
    app.use('/api/slack', slackRouter);
    mockGetDecision.mockResolvedValue(baseDecision);
    mockIsAuthorized.mockResolvedValue(true);
    mockResolve.mockResolvedValue({ claimed: true, decision: { ...baseDecision, status: 'approved' } });
  });

  afterEach(() => {
    delete process.env.SLACK_VERIFICATION_TOKEN;
  });

  function blockActionPayload(actionId: string, userId = 'U-MATT') {
    return {
      type: 'block_actions',
      token: TOKEN,
      team: { id: 'T123', domain: 'test-workspace' },
      user: { id: userId, username: 'matt' },
      channel: { id: 'C123' },
      message: { ts: '1234567890.123456' },
      trigger_id: 'trigger123',
      actions: [{ action_id: actionId, value: JSON.stringify({ decisionId: 'decision-1' }) }],
    };
  }

  it('approve_decision: authorized approver claims directly, no modal', async () => {
    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(blockActionPayload('approve_decision')) });

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith('decision-1', 'approve', 'matt');
    expect(mockOpenModal).not.toHaveBeenCalled();
  });

  it('reject_decision: opens the verdict modal, does not claim yet', async () => {
    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(blockActionPayload('reject_decision')) });

    expect(response.status).toBe(200);
    expect(mockOpenModal).toHaveBeenCalledWith('trigger123', 'decision-1', 'reject');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('edit_decision: opens the verdict modal, does not claim yet', async () => {
    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(blockActionPayload('edit_decision')) });

    expect(response.status).toBe(200);
    expect(mockOpenModal).toHaveBeenCalledWith('trigger123', 'decision-1', 'edit');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('refuses an unauthorized Slack user with no claim and no modal', async () => {
    mockIsAuthorized.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(blockActionPayload('approve_decision', 'U-STRANGER')) });

    expect(response.status).toBe(200);
    expect(response.body.text).toContain('matt');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockOpenModal).not.toHaveBeenCalled();
  });

  it('a decision that no longer exists is refused with no claim', async () => {
    mockGetDecision.mockResolvedValue(null);

    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(blockActionPayload('approve_decision')) });

    expect(response.status).toBe(200);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  function viewSubmissionPayload(verdict: 'reject' | 'edit', freeText: string | undefined, userId = 'U-MATT') {
    return {
      type: 'view_submission',
      token: TOKEN,
      team: { id: 'T123', domain: 'test-workspace' },
      user: { id: userId, username: 'matt' },
      view: {
        callback_id: 'approval_decision_verdict_modal',
        private_metadata: JSON.stringify({ decisionId: 'decision-1', verdict }),
        state: {
          values: {
            decision_free_text_input: { decision_free_text: { value: freeText } },
          },
        },
      },
    };
  }

  it('reject modal submission with empty text still resolves (reason optional)', async () => {
    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(viewSubmissionPayload('reject', undefined)) });

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith('decision-1', 'reject', 'matt', undefined);
  });

  it('edit modal submission with empty text is rejected with a validation error, never claims', async () => {
    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(viewSubmissionPayload('edit', '')) });

    expect(response.status).toBe(200);
    expect(response.body.response_action).toBe('errors');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('edit modal submission with real text resolves with the correction as freeText', async () => {
    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(viewSubmissionPayload('edit', 'Use a shorter headline.')) });

    expect(response.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith('decision-1', 'edit', 'matt', 'Use a shorter headline.');
  });

  it('review fix: a failed claim (already resolved/expired) surfaces a real error in the modal, not a silent clear', async () => {
    mockResolve.mockResolvedValue({ claimed: false, reason: 'already_resolved' });

    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(viewSubmissionPayload('reject', 'too late')) });

    expect(response.status).toBe(200);
    expect(response.body.response_action).toBe('errors');
    expect(response.body.errors.decision_free_text_input).toContain('already_resolved');
  });

  it('an unauthorized user submitting the modal is silently ignored (clear, no claim)', async () => {
    mockIsAuthorized.mockResolvedValue(false);

    const response = await request(app)
      .post('/api/slack/interactions')
      .type('form')
      .send({ payload: JSON.stringify(viewSubmissionPayload('reject', 'nope', 'U-STRANGER')) });

    expect(response.status).toBe(200);
    expect(response.body.response_action).toBe('clear');
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
