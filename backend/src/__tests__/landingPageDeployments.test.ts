/**
 * Tests for landing page deployment approval flow.
 * Verifies: Vercel service, deployment routes, Slack approval integration.
 */
import request from 'supertest';
import express from 'express';

// Mock dependencies
const mockListDeployments = jest.fn();
const mockGetDeployment = jest.fn();
const mockPromoteToProduction = jest.fn();

jest.mock('../services/vercelService', () => ({
  vercelService: {
    listDeployments: (...args: any[]) => mockListDeployments(...args),
    getDeployment: (...args: any[]) => mockGetDeployment(...args),
    promoteToProduction: (...args: any[]) => mockPromoteToProduction(...args),
  },
}));

const mockSendMessage = jest.fn();
jest.mock('../services/slackService', () => ({
  sendSlackMessage: (...args: any[]) => mockSendMessage(...args),
  sendApprovalRequest: jest.fn(),
  sendApprovalRequestWithTracking: jest.fn(),
  getSlackClient: () => ({
    chat: { postMessage: mockSendMessage },
  }),
}));

const mockCreateApproval = jest.fn();
const mockGetApproval = jest.fn();
const mockUpdateApprovalStatus = jest.fn();

jest.mock('../services/approvalDb', () => ({
  approvalDb: {
    createApproval: (...args: any[]) => mockCreateApproval(...args),
    getApproval: (...args: any[]) => mockGetApproval(...args),
    updateApprovalStatus: (...args: any[]) => mockUpdateApprovalStatus(...args),
  },
}));

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ SecretString: '{}' }),
    }),
  })),
  DynamoDB: {
    DocumentClient: jest.fn(() => ({})),
  },
}));

import landingPageDeploymentsRouter from '../routes/landingPageDeployments';

const app = express();
app.use(express.json());
// Simulate authenticated user
app.use((req, _res, next) => {
  (req as any).user = { userId: 'user-1', email: 'test@test.com', isAdmin: true };
  next();
});
app.use('/api/landing-page-deployments', landingPageDeploymentsRouter);

describe('Landing Page Deployments', () => {
  beforeEach(() => jest.clearAllMocks());

  // ─── FAIL tests ───────────────────────────────────────────────────────

  // FAIL test 1: Request approval without required fields
  it('should return 400 when requesting approval without deploymentUrl', async () => {
    const res = await request(app)
      .post('/api/landing-page-deployments/request-approval')
      .send({ slackChannel: 'C123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('deploymentUrl');
  });

  // FAIL test 2: Request approval without slackChannel
  it('should return 400 when requesting approval without slackChannel', async () => {
    const res = await request(app)
      .post('/api/landing-page-deployments/request-approval')
      .send({ deploymentUrl: 'https://my-site.vercel.app', projectName: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('slackChannel');
  });

  // FAIL test 3: Approve deployment with non-existent approval
  it('should return 404 when approving non-existent deployment', async () => {
    mockGetApproval.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/landing-page-deployments/approve')
      .send({ deploymentUrl: 'https://nonexistent.vercel.app' });

    expect(res.status).toBe(404);
  });

  // FAIL test 4: Vercel promote failure should return 500
  it('should return 500 when Vercel promotion fails', async () => {
    mockGetApproval.mockResolvedValue({
      assetUrl: 'https://my-site.vercel.app',
      status: 'pending',
      slackChannel: 'C123',
    });
    mockPromoteToProduction.mockRejectedValue(new Error('Vercel API error'));

    const res = await request(app)
      .post('/api/landing-page-deployments/approve')
      .send({ deploymentUrl: 'https://my-site.vercel.app' });

    expect(res.status).toBe(500);
    expect(res.body.message).toContain('Failed to promote');
  });

  // ─── SUCCESS tests ────────────────────────────────────────────────────

  // SUCCESS test 1: Request approval sends Slack message and creates DB record
  it('should send Slack message and create approval record', async () => {
    mockSendMessage.mockResolvedValue({ ts: '123.456' });
    mockCreateApproval.mockResolvedValue({
      assetUrl: 'https://my-site.vercel.app',
      status: 'pending',
    });

    const res = await request(app)
      .post('/api/landing-page-deployments/request-approval')
      .send({
        deploymentUrl: 'https://my-site.vercel.app',
        projectName: 'My Landing Page',
        slackChannel: 'C123',
        note: 'Ready for review',
      });

    expect(res.status).toBe(201);
    expect(mockSendMessage).toHaveBeenCalled();
    expect(mockCreateApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        assetUrl: 'https://my-site.vercel.app',
        assetType: 'html',
        slackChannel: 'C123',
      })
    );
  });

  // SUCCESS test 2: Approve triggers Vercel promotion
  it('should promote to production on approval', async () => {
    mockGetApproval.mockResolvedValue({
      assetUrl: 'https://my-site-abc123.vercel.app',
      status: 'pending',
      slackChannel: 'C123',
      slackMessageTs: '123.456',
    });
    mockPromoteToProduction.mockResolvedValue({ url: 'https://my-site.com' });
    mockUpdateApprovalStatus.mockResolvedValue({ status: 'approved' });

    const res = await request(app)
      .post('/api/landing-page-deployments/approve')
      .send({ deploymentUrl: 'https://my-site-abc123.vercel.app' });

    expect(res.status).toBe(200);
    expect(mockPromoteToProduction).toHaveBeenCalledWith('https://my-site-abc123.vercel.app');
    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      'https://my-site-abc123.vercel.app',
      'approved',
      'test@test.com',
      undefined
    );
  });

  // SUCCESS test 3: Reject captures feedback and does NOT promote
  it('should reject without promoting and capture feedback', async () => {
    mockGetApproval.mockResolvedValue({
      assetUrl: 'https://my-site.vercel.app',
      status: 'pending',
      slackChannel: 'C123',
      slackMessageTs: '123.456',
    });
    mockUpdateApprovalStatus.mockResolvedValue({ status: 'rejected' });

    const res = await request(app)
      .post('/api/landing-page-deployments/reject')
      .send({
        deploymentUrl: 'https://my-site.vercel.app',
        feedback: 'Hero image needs to be updated',
      });

    expect(res.status).toBe(200);
    expect(mockPromoteToProduction).not.toHaveBeenCalled();
    expect(mockUpdateApprovalStatus).toHaveBeenCalledWith(
      'https://my-site.vercel.app',
      'rejected',
      'test@test.com',
      'Hero image needs to be updated'
    );
  });

  // SUCCESS test 4: List deployments returns Vercel data
  it('should list deployments from Vercel', async () => {
    mockListDeployments.mockResolvedValue([
      { uid: 'd1', url: 'my-site-abc.vercel.app', state: 'READY', createdAt: Date.now() },
    ]);

    const res = await request(app)
      .get('/api/landing-page-deployments')
      .query({ projectId: 'prj_123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockListDeployments).toHaveBeenCalledWith('prj_123');
  });
});
