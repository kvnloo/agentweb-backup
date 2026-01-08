// Unit tests for Slack rejection feedback collection

import express from 'express';
import request from 'supertest';
import { approvalDb } from '../services/approvalDb';
import { openRejectModal, updateApprovalMessage } from '../services/slackService';

// Mock dependencies
jest.mock('../services/approvalDb');
jest.mock('../services/slackService');
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskExecutionById: jest.fn(),
    getTaskById: jest.fn(),
    updateTask: jest.fn()
  },
  subscriberDb: {
    getSubscribersByTaskId: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn()
  }
}));
jest.mock('../controllers/agentModeController', () => ({
  runVerifiedChat: jest.fn()
}));
jest.mock('../controllers/tasks', () => ({
  createRevisionExecutionFromSlack: jest.fn()
}));

// Mock Slack client
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    views: {
      open: jest.fn().mockResolvedValue({ ok: true })
    },
    chat: {
      update: jest.fn().mockResolvedValue({ ok: true })
    }
  }))
}));

describe('Slack Rejection Feedback', () => {
  let app: express.Application;
  const mockVerificationToken = 'test-verification-token';

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up environment variables
    process.env.SLACK_VERIFICATION_TOKEN = mockVerificationToken;
    
    app = express();
    app.use(express.urlencoded({ extended: true }));
    
    // Import router after mocks are set up
    const slackRouter = require('../routes/slack').default;
    app.use('/api/slack', slackRouter);
  });

  afterEach(() => {
    delete process.env.SLACK_VERIFICATION_TOKEN;
  });

  describe('Reject button click', () => {
    it('should open rejection modal when reject button is clicked', async () => {
      const mockApproval = {
        assetUrl: 'https://example.com/image.png',
        filename: 'test.png',
        assetType: 'image',
        executionId: 'exec123'
      };

      // The reject_asset action handler calls getApproval to get assetType
      (approvalDb.getApproval as jest.Mock).mockResolvedValue(mockApproval);
      (openRejectModal as jest.Mock).mockResolvedValue(undefined);

      const payload = {
        type: 'block_actions',
        token: mockVerificationToken,
        team: { id: 'T123', domain: 'test-workspace' },
        user: { id: 'U123', username: 'testuser' },
        channel: { id: 'C123' },
        message: { ts: '1234567890.123456' },
        trigger_id: 'trigger123',
        actions: [{
          action_id: 'reject_asset',
          value: JSON.stringify({
            assetUrl: mockApproval.assetUrl,
            filename: mockApproval.filename,
            executionId: mockApproval.executionId
          })
        }]
      };

      const response = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(payload) });

      expect(response.status).toBe(200);
      expect(openRejectModal).toHaveBeenCalledWith(
        'trigger123',
        mockApproval.assetUrl,
        mockApproval.filename,
        mockApproval.executionId,
        mockApproval.assetType
      );
    });
  });

  describe('Rejection modal submission', () => {
    it('should save rejection feedback when modal is submitted', async () => {
      const mockApproval = {
        assetUrl: 'https://example.com/image.png',
        filename: 'test.png',
        assetType: 'image',
        executionId: 'exec123',
        slackChannel: 'C123',
        slackMessageTs: '1234567890.123456'
      };

      const rejectionReason = 'Logo is incorrect';

      (approvalDb.getApproval as jest.Mock).mockResolvedValue(mockApproval);
      (approvalDb.updateApprovalStatus as jest.Mock).mockResolvedValue(undefined);
      (updateApprovalMessage as jest.Mock).mockResolvedValue(undefined);

      const payload = {
        type: 'view_submission',
        token: mockVerificationToken,
        team: { id: 'T123', domain: 'test-workspace' },
        user: { id: 'U123', username: 'testuser' },
        view: {
          callback_id: 'reject_modal',
          private_metadata: JSON.stringify({
            assetUrl: mockApproval.assetUrl,
            filename: mockApproval.filename,
            executionId: mockApproval.executionId,
            assetType: mockApproval.assetType
          }),
          state: {
            values: {
              reject_reason_input: {
                reject_reason_text: {
                  value: rejectionReason
                }
              }
            }
          }
        }
      };

      const response = await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(payload) });

      expect(response.status).toBe(200);
      expect(approvalDb.updateApprovalStatus).toHaveBeenCalledWith(
        mockApproval.assetUrl,
        'rejected',
        'testuser',
        rejectionReason
      );
      expect(updateApprovalMessage).toHaveBeenCalledWith(
        mockApproval.slackChannel,
        mockApproval.slackMessageTs,
        'rejected',
        'testuser',
        rejectionReason,
        mockApproval.assetType
      );
    });

    it('should not trigger new execution when rejecting', async () => {
      const mockApproval = {
        assetUrl: 'https://example.com/image.png',
        filename: 'test.png',
        assetType: 'image',
        executionId: 'exec123',
        slackChannel: 'C123',
        slackMessageTs: '1234567890.123456'
      };

      (approvalDb.getApproval as jest.Mock).mockResolvedValue(mockApproval);
      (approvalDb.updateApprovalStatus as jest.Mock).mockResolvedValue(undefined);
      (updateApprovalMessage as jest.Mock).mockResolvedValue(undefined);

      const { createRevisionExecutionFromSlack } = require('../controllers/tasks');

      const payload = {
        type: 'view_submission',
        token: mockVerificationToken,
        team: { id: 'T123', domain: 'test-workspace' },
        user: { id: 'U123', username: 'testuser' },
        view: {
          callback_id: 'reject_modal',
          private_metadata: JSON.stringify({
            assetUrl: mockApproval.assetUrl,
            filename: mockApproval.filename,
            executionId: mockApproval.executionId,
            assetType: mockApproval.assetType
          }),
          state: {
            values: {
              reject_reason_input: {
                reject_reason_text: {
                  value: 'Not good enough'
                }
              }
            }
          }
        }
      };

      await request(app)
        .post('/api/slack/interactions')
        .type('form')
        .send({ payload: JSON.stringify(payload) });

      // Should NOT create a revision execution for rejection
      expect(createRevisionExecutionFromSlack).not.toHaveBeenCalled();
    });
  });
});
