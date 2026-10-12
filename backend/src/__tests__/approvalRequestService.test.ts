/**
 * Approval delivery treats Slack and WhatsApp as peers (ENG-273).
 *
 * The WhatsApp notice used to sit behind the Slack post, so a bot that was not in the
 * channel silently cost a reviewer their WhatsApp message too. The rule now: an approval
 * is delivered if it reached the reviewer on EITHER channel, and fails only when it
 * reached nobody.
 */

const mockPostMessage = jest.fn();
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
    apiCall: jest.fn(),
  })),
}));
jest.mock('../services/approvalChannelNotifier', () => ({
  notifyApprovalOnWhatsApp: jest.fn(),
}));
jest.mock('../services/approvalDb', () => ({
  approvalDb: { createApproval: jest.fn() },
}));

process.env.SLACK_BOT_TOKEN = 'xoxb-test';

const { notifyApprovalOnWhatsApp } = require('../services/approvalChannelNotifier');
const { approvalDb } = require('../services/approvalDb');
const { sendApprovalRequestWithTracking } = require('../services/slackService');
const { requestApproval, ApprovalNotDeliveredError } = require('../services/approvalRequestService');

const request = {
  executionId: 'exec-1',
  imageUrl: 'https://assets.example.com/hero.png',
  filename: 'hero.png',
  assetType: 'image',
  userId: 'user-1',
  channel: 'C0APPROVALS',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPostMessage.mockResolvedValue({ ok: true, ts: '111.222' });
  notifyApprovalOnWhatsApp.mockResolvedValue(false);
  approvalDb.createApproval.mockImplementation(async (a: any) => a);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sendApprovalRequestWithTracking — peer channels', () => {
  it('tracks the approval when only Slack delivered (the pre-existing behaviour)', async () => {
    const result = await sendApprovalRequestWithTracking(request);
    expect(result.messageTs).toBe('111.222');
    expect(approvalDb.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ slackMessageTs: '111.222' }),
    );
  });

  it('still notifies WhatsApp when the Slack post fails', async () => {
    mockPostMessage.mockRejectedValue(new Error('not_in_channel'));
    notifyApprovalOnWhatsApp.mockResolvedValue(true);

    await sendApprovalRequestWithTracking(request);
    expect(notifyApprovalOnWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', assetUrl: request.imageUrl }),
    );
  });

  it('tracks the approval when only WhatsApp delivered', async () => {
    // Without the record, the Approve button the reviewer was just sent would update a
    // row that does not exist.
    mockPostMessage.mockRejectedValue(new Error('not_in_channel'));
    notifyApprovalOnWhatsApp.mockResolvedValue(true);

    const result = await sendApprovalRequestWithTracking(request);
    expect(result.messageTs).toBeNull();
    expect(approvalDb.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ assetUrl: request.imageUrl, slackMessageTs: null }),
    );
  });

  it('fails with the original Slack error when it reached nobody, and tracks nothing', async () => {
    mockPostMessage.mockRejectedValue(new Error('not_in_channel'));
    notifyApprovalOnWhatsApp.mockResolvedValue(false);

    await expect(sendApprovalRequestWithTracking(request)).rejects.toThrow('not_in_channel');
    expect(approvalDb.createApproval).not.toHaveBeenCalled();
  });

  it('is unaffected by a WhatsApp failure when Slack delivered', async () => {
    notifyApprovalOnWhatsApp.mockRejectedValue(new Error('meta down'));
    await expect(sendApprovalRequestWithTracking(request)).resolves.toEqual(
      expect.objectContaining({ messageTs: '111.222' }),
    );
    expect(approvalDb.createApproval).toHaveBeenCalled();
  });
});
describe('requestApproval — a customer who is not on Slack', () => {
  const noSlack = { ...request, channel: undefined };

  it('never touches Slack when there is no Slack channel', async () => {
    notifyApprovalOnWhatsApp.mockResolvedValue(true);
    await requestApproval(noSlack);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('delivers on WhatsApp alone and tracks the approval', async () => {
    notifyApprovalOnWhatsApp.mockResolvedValue(true);
    const result = await requestApproval(noSlack);

    expect(result.deliveredVia).toEqual(['whatsapp']);
    expect(approvalDb.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ slackChannel: '', slackMessageTs: null, userId: 'user-1' }),
    );
  });

  it('does not ask WhatsApp about Slack', async () => {
    notifyApprovalOnWhatsApp.mockResolvedValue(true);
    await requestApproval(noSlack);
    const arg = notifyApprovalOnWhatsApp.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['assetType', 'assetUrl', 'filename', 'userId']);
  });

  it('fails distinctly, and tracks nothing, when the customer has no channel at all', async () => {
    notifyApprovalOnWhatsApp.mockResolvedValue(false);
    await expect(requestApproval(noSlack)).rejects.toBeInstanceOf(ApprovalNotDeliveredError);
    expect(approvalDb.createApproval).not.toHaveBeenCalled();
  });

  it('reports both channels for a customer who somehow has both', async () => {
    notifyApprovalOnWhatsApp.mockResolvedValue(true);
    const result = await requestApproval(request);
    expect(result.deliveredVia).toEqual(['slack', 'whatsapp']);
  });
});

export {};
