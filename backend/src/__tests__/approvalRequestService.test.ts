/**
 * Asking for approval on whichever platform the customer is on (ENG-273).
 *
 * A customer is on Slack OR WhatsApp. Neither send depends on the other, the approval
 * record is always written before anything the customer could tap, and a failure says
 * whether the account has nowhere to be asked or has somewhere and the send failed.
 */
const mockPostMessage = jest.fn();
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
    apiCall: jest.fn(),
  })),
}));
jest.mock('../services/approvalChannelNotifier', () => ({ notifyApprovalOnWhatsApp: jest.fn() }));
jest.mock('../services/approvalDb', () => ({
  approvalDb: { createApproval: jest.fn(), deleteApproval: jest.fn() },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));

process.env.SLACK_BOT_TOKEN = 'xoxb-test';

const { notifyApprovalOnWhatsApp } = require('../services/approvalChannelNotifier');
const { approvalDb } = require('../services/approvalDb');
const { userDb } = require('../services/db');
const { sendApprovalRequestWithTracking } = require('../services/slackService');
import {
  requestApproval,
  ApprovalDeliveryFailedError,
  ApprovalNotDeliveredError,
} from '../services/approvalRequestService';

const request = {
  executionId: 'exec-1',
  imageUrl: 'https://assets.example.com/hero.png',
  filename: 'hero.png',
  assetType: 'image',
  userId: 'user-1',
  channel: 'C0APPROVALS',
};

const onSlack = { userId: 'user-1', slackChannels: ['C0APPROVALS'] };
const onWhatsApp = {
  userId: 'user-1',
  messagingChannels: [
    {
      channel: 'whatsapp',
      destination: '+918005326946',
      enabled: true,
      optIn: { at: 'x', source: 'inbound_verification', verifiedAt: 'y' },
    },
  ],
};

let calls: string[];

beforeEach(() => {
  jest.resetAllMocks();
  calls = [];
  userDb.getUserById.mockResolvedValue(onSlack);
  mockPostMessage.mockImplementation(async () => {
    calls.push('slack-post');
    return { ok: true, ts: '111.222' };
  });
  approvalDb.createApproval.mockImplementation(async (a: any) => {
    calls.push('record');
    return a;
  });
  approvalDb.deleteApproval.mockResolvedValue(true);
  notifyApprovalOnWhatsApp.mockImplementation(async () => {
    calls.push('whatsapp');
    return 'not_applicable';
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a customer on Slack', () => {
  it('is asked on Slack and the approval is tracked', async () => {
    const result = await requestApproval(request);
    expect(result).toEqual({
      messageTs: '111.222',
      approvalId: request.imageUrl,
      deliveredVia: ['slack'],
    });
    expect(approvalDb.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ slackChannel: 'C0APPROVALS', slackMessageTs: '111.222' }),
    );
  });

  it('never touches WhatsApp', async () => {
    await requestApproval(request);
    expect(notifyApprovalOnWhatsApp).not.toHaveBeenCalled();
  });

  it('has its record written straight after the post, exactly as before WhatsApp existed', async () => {
    await requestApproval(request);
    expect(calls).toEqual(['slack-post', 'record']);
  });

  it('fails with the ORIGINAL Slack error when the post fails, and tracks nothing', async () => {
    mockPostMessage.mockRejectedValue(new Error('not_in_channel'));
    await expect(requestApproval(request)).rejects.toThrow('not_in_channel');
    expect(approvalDb.createApproval).not.toHaveBeenCalled();
    expect(approvalDb.deleteApproval).not.toHaveBeenCalled();
  });

  it('still throws the old error type through the legacy entry point', async () => {
    mockPostMessage.mockRejectedValue(new Error('not_in_channel'));
    await expect(sendApprovalRequestWithTracking(request)).rejects.toThrow('not_in_channel');
  });

  it('still returns the old shape through the legacy entry point', async () => {
    await expect(sendApprovalRequestWithTracking(request)).resolves.toEqual({
      messageTs: '111.222',
      approvalId: request.imageUrl,
    });
  });

  it('is asked normally when the account cannot be loaded', async () => {
    // Falls toward the behaviour before WhatsApp existed rather than refusing the request.
    userDb.getUserById.mockRejectedValue(new Error('dynamo down'));
    await expect(requestApproval(request)).resolves.toMatchObject({ deliveredVia: ['slack'] });
  });
});

describe('a customer on WhatsApp', () => {
  beforeEach(() => {
    userDb.getUserById.mockResolvedValue(onWhatsApp);
    notifyApprovalOnWhatsApp.mockImplementation(async () => {
      calls.push('whatsapp');
      return 'delivered';
    });
  });

  it('is asked on WhatsApp with no Slack channel at all', async () => {
    const result = await requestApproval({ ...request, channel: undefined });
    expect(result.deliveredVia).toEqual(['whatsapp']);
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(approvalDb.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ slackChannel: '', slackMessageTs: null, userId: 'user-1' }),
    );
  });

  it('is NOT posted to in Slack even when the task names a Slack channel', async () => {
    // Task-level channels are typed in per task and outlive a switch of platform.
    const result = await requestApproval(request);
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(result.deliveredVia).toEqual(['whatsapp']);
    expect(approvalDb.createApproval).toHaveBeenCalledWith(expect.objectContaining({ slackChannel: '' }));
  });

  it('has the record written BEFORE the message that carries the buttons goes out', async () => {
    // Buttons cannot be taken back, so one that reaches the customer ahead of its record
    // can never be answered.
    await requestApproval({ ...request, channel: undefined });
    expect(calls).toEqual(['record', 'whatsapp']);
  });

  it('hands the notifier the account it already loaded', async () => {
    await requestApproval({ ...request, channel: undefined });
    expect(notifyApprovalOnWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', user: onWhatsApp, assetUrl: request.imageUrl }),
    );
  });

  it('says it was FAILED, not unreachable, when the send fails — and removes the unsent record', async () => {
    notifyApprovalOnWhatsApp.mockResolvedValue('failed');
    await expect(requestApproval({ ...request, channel: undefined })).rejects.toBeInstanceOf(
      ApprovalDeliveryFailedError,
    );
    // An approval nobody was shown can never be answered.
    expect(approvalDb.deleteApproval).toHaveBeenCalledWith(request.imageUrl);
  });

  it('treats a notifier that throws as a failed send', async () => {
    notifyApprovalOnWhatsApp.mockRejectedValue(new Error('module load failed'));
    await expect(requestApproval({ ...request, channel: undefined })).rejects.toBeInstanceOf(
      ApprovalDeliveryFailedError,
    );
  });

  it('keeps the approval when it was delivered', async () => {
    await requestApproval({ ...request, channel: undefined });
    expect(approvalDb.deleteApproval).not.toHaveBeenCalled();
  });

  it('is still failed when removing the unsent record also fails', async () => {
    notifyApprovalOnWhatsApp.mockResolvedValue('failed');
    approvalDb.deleteApproval.mockRejectedValue(new Error('dynamo down'));
    await expect(requestApproval({ ...request, channel: undefined })).rejects.toBeInstanceOf(
      ApprovalDeliveryFailedError,
    );
  });
});

describe('a customer with no channel at all', () => {
  it('is told there is nowhere to ask, and nothing is written', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'user-1' });
    await expect(requestApproval({ ...request, channel: undefined })).rejects.toBeInstanceOf(
      ApprovalNotDeliveredError,
    );
    expect(approvalDb.createApproval).not.toHaveBeenCalled();
    expect(notifyApprovalOnWhatsApp).not.toHaveBeenCalled();
  });

  it('is told that apart from a delivery failure', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'user-1' });
    await expect(requestApproval({ ...request, channel: undefined })).rejects.not.toBeInstanceOf(
      ApprovalDeliveryFailedError,
    );
  });
});
