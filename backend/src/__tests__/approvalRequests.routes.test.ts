/**
 * POST /api/approval-requests — asking for approval without assuming Slack (ENG-273).
 */
import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1' };
    next();
  },
}));
jest.mock('../services/approvalRequestService', () => {
  class ApprovalNotDeliveredError extends Error {}
  class ApprovalDeliveryFailedError extends Error {}
  class ApprovalForbiddenError extends Error {}
  return {
    requestApproval: jest.fn(),
    ApprovalNotDeliveredError,
    ApprovalDeliveryFailedError,
    ApprovalForbiddenError,
  };
});

const svc = require('../services/approvalRequestService');
import router from '../routes/approvalRequests';

const app = express();
app.use(express.json());
app.use('/api/approval-requests', router);

beforeEach(() => {
  jest.resetAllMocks();
  svc.requestApproval.mockResolvedValue({
    messageTs: null,
    approvalId: 'https://a/x.png',
    deliveredVia: ['whatsapp'],
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

it('accepts a request with no Slack channel', async () => {
  const res = await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png', executionId: 'e1' });

  expect(res.status).toBe(200);
  expect(res.body.deliveredVia).toEqual(['whatsapp']);
  expect(svc.requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'user-1', channel: null, imageUrl: 'https://a/x.png' }),
  );
});

it('asks for typed delivery failures so a Slack outage answers 502, not 500', async () => {
  await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png' });
  expect(svc.requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({ typedFailures: true, enforceOwnership: true }),
  );
});

it('never takes a Slack channel from the body (the bot would post wherever it is pointed)', async () => {
  await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png', channel: 'C_SOMEONE_ELSES', channelName: 'x' });
  expect(svc.requestApproval.mock.calls[0][0].channel).toBeNull();
  expect(svc.requestApproval.mock.calls[0][0]).not.toHaveProperty('channelName');
});

it('takes the user from the token, never from the body', async () => {
  await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png', userId: 'someone-else' });
  expect(svc.requestApproval.mock.calls[0][0].userId).toBe('user-1');
});

it('rejects a request missing the asset', async () => {
  const res = await request(app).post('/api/approval-requests').send({ filename: 'x.png' });
  expect(res.status).toBe(400);
  expect(svc.requestApproval).not.toHaveBeenCalled();
});

it('answers 409 no_channel when the account has nowhere to be asked', async () => {
  // The task engine tells this apart from a 500 to fall back to its no-approval path.
  svc.requestApproval.mockRejectedValue(new svc.ApprovalNotDeliveredError('none'));
  const res = await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png' });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('no_channel');
});

it('always asks the service to enforce ownership', async () => {
  await request(app).post('/api/approval-requests').send({ assetUrl: 'https://a/x.png', filename: 'x.png' });
  expect(svc.requestApproval).toHaveBeenCalledWith(expect.objectContaining({ enforceOwnership: true }));
});

it('answers 403 forbidden when the asset or execution is not the caller\'s', async () => {
  svc.requestApproval.mockRejectedValue(new svc.ApprovalForbiddenError('not yours'));
  const res = await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png', executionId: 'someone-elses' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('forbidden');
});

it('answers 502 delivery_failed when the account has a channel and the send failed', async () => {
  // Not the same answer as no_channel: the task engine carries on past "nobody to ask" but
  // must HOLD its output for a customer who can be reached and was not.
  svc.requestApproval.mockRejectedValue(new svc.ApprovalDeliveryFailedError('send failed'));
  const res = await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png' });
  expect(res.status).toBe(502);
  expect(res.body.code).toBe('delivery_failed');
});

it('answers 500 for a real failure', async () => {
  svc.requestApproval.mockRejectedValue(new Error('dynamo down'));
  const res = await request(app)
    .post('/api/approval-requests')
    .send({ assetUrl: 'https://a/x.png', filename: 'x.png' });
  expect(res.status).toBe(500);
});
