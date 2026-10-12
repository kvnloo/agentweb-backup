import express from 'express';
import request from 'supertest';

let mockUser: any = { userId: 'u1', isAdmin: false };

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = mockUser;
    next();
  }),
  isRealAdmin: jest.fn((req: any) => !!req.user?.isAdmin),
}));

jest.mock('../../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../../services/batchReviewDb', () => ({
  batchReviewDb: {
    createBatchReview: jest.fn(async () => ({ batchId: 'b1' })),
    updateSlackMessageTs: jest.fn(),
  },
}));

jest.mock('../../services/approvalDb', () => ({
  approvalDb: { createApproval: jest.fn() },
  getAssetTypeFromFilename: jest.fn(() => 'image'),
}));

jest.mock('../../services/slackService', () => ({
  sendBatchApprovalRequest: jest.fn(async () => ({ messageTs: '123.4' })),
  updateBatchReviewMessage: jest.fn(),
  getEffectiveAllowedChannels: jest.fn(),
}));

jest.mock('../../services/revisionService', () => ({ triggerAutoRevision: jest.fn() }));

import batchReviewRoutes from '../batchReview';
import { userDb } from '../../services/db';
import { batchReviewDb } from '../../services/batchReviewDb';
import { approvalDb } from '../../services/approvalDb';
import { sendBatchApprovalRequest, getEffectiveAllowedChannels } from '../../services/slackService';

const app = express();
app.use(express.json());
app.use('/api/batch-review', batchReviewRoutes);

const body = (channel: string) => ({
  channel,
  channelName: 'x',
  assets: [{ assetUrl: 'https://cdn/a.png', filename: 'a.png' }],
});

describe('POST /api/batch-review/create channel entitlement (ENG-2407)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { userId: 'u1', isAdmin: false };
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', slackChannels: ['C_OWN'] });
    (getEffectiveAllowedChannels as jest.Mock).mockResolvedValue(['C_OWN']);
  });

  const expectNoSideEffects = () => {
    expect(sendBatchApprovalRequest).not.toHaveBeenCalled();
    expect(batchReviewDb.createBatchReview).not.toHaveBeenCalled();
    expect(approvalDb.createApproval).not.toHaveBeenCalled();
  };

  it('403s a non-entitled user posting to an arbitrary channel, with no Slack call or DB write', async () => {
    await request(app).post('/api/batch-review/create').send(body('C_INTERNAL')).expect(403);
    expectNoSideEffects();
  });

  it('403s a user with no configured channels', async () => {
    (getEffectiveAllowedChannels as jest.Mock).mockResolvedValue([]);
    await request(app).post('/api/batch-review/create').send(body('C_INTERNAL')).expect(403);
    expectNoSideEffects();
  });

  it('400s a non-string channel (array would stringify into an allowed ID), with no side effects', async () => {
    await request(app).post('/api/batch-review/create').send(body(['C_OWN'] as any)).expect(400);
    expectNoSideEffects();
  });

  it('allows the caller\'s configured channel', async () => {
    const res = await request(app).post('/api/batch-review/create').send(body('C_OWN')).expect(200);
    expect(res.body.batchId).toBe('b1');
    expect(sendBatchApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_OWN' }));
    expect(approvalDb.createApproval).toHaveBeenCalledTimes(1);
  });

  it('allows a real admin to target any channel without a channel lookup', async () => {
    mockUser = { userId: 'admin', isAdmin: true };
    await request(app).post('/api/batch-review/create').send(body('C_ANY')).expect(200);
    expect(getEffectiveAllowedChannels).not.toHaveBeenCalled();
    expect(sendBatchApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_ANY' }));
  });
});
