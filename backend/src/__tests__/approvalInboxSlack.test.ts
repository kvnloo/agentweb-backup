// ENG-1644 Phase C: unit tests for approvalInboxSlack.ts — the queue-message
// render/upsert, the approver-authorization check, and the shared claim path.

const mockUpdate = jest.fn();
const mockPostMessage = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { update: mockUpdate, postMessage: mockPostMessage },
  })),
}));

jest.mock('../services/slackService', () => ({ resolveSlackApiUrl: jest.fn().mockReturnValue(undefined) }));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

jest.mock('../services/approverDirectory', () => ({
  getApproverChannel: jest.fn(),
  getApproverSlackUserId: jest.fn(),
  getFallbackApproverSlackUserIds: jest.fn(),
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { listPendingForApprover: jest.fn(), claimDecision: jest.fn() },
}));

import { settingsService } from '../services/settingsService';
import { getApproverChannel, getApproverSlackUserId, getFallbackApproverSlackUserIds } from '../services/approverDirectory';
import { approvalInboxService } from '../services/approvalInboxService';

// approvalInboxSlack.ts reads SLACK_BOT_TOKEN at module-load time to decide
// whether to construct a real slackClient — must be set before this import,
// not in beforeEach (too late for a module-level singleton).
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
import * as approvalInboxSlack from '../services/approvalInboxSlack';

const mockGetSetting = settingsService.getSetting as jest.Mock;
const mockSetSetting = settingsService.setSetting as jest.Mock;
const mockGetApproverChannel = getApproverChannel as jest.Mock;
const mockGetApproverSlackUserId = getApproverSlackUserId as jest.Mock;
const mockGetFallback = getFallbackApproverSlackUserIds as jest.Mock;
const mockListPending = approvalInboxService.listPendingForApprover as jest.Mock;
const mockClaimDecision = approvalInboxService.claimDecision as jest.Mock;

describe('approvalInboxSlack', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    mockGetSetting.mockResolvedValue(null);
    mockGetApproverChannel.mockResolvedValue('C-MATT');
    mockGetApproverSlackUserId.mockResolvedValue('U-MATT');
    mockGetFallback.mockResolvedValue([]);
    mockListPending.mockResolvedValue([]);
    mockPostMessage.mockResolvedValue({ ok: true, ts: '1111.2222' });
    mockUpdate.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
  });

  describe('isAuthorizedApprover', () => {
    const decision: any = { decisionId: 'd1', approver: 'matt' };

    it('authorizes the named approver', async () => {
      await expect(approvalInboxSlack.isAuthorizedApprover(decision, 'U-MATT')).resolves.toBe(true);
    });

    it('refuses a different Slack user with no fallback configured', async () => {
      await expect(approvalInboxSlack.isAuthorizedApprover(decision, 'U-OTHER')).resolves.toBe(false);
    });

    it('authorizes a configured fallback user', async () => {
      mockGetFallback.mockResolvedValue(['U-FALLBACK']);
      await expect(approvalInboxSlack.isAuthorizedApprover(decision, 'U-FALLBACK')).resolves.toBe(true);
    });

    it('refuses when the decision has no approver at all (e.g. customer-audience)', async () => {
      await expect(approvalInboxSlack.isAuthorizedApprover({ decisionId: 'd2' } as any, 'U-MATT')).resolves.toBe(false);
    });
  });

  describe('upsertApproverQueueMessage', () => {
    it('posts a fresh message and stores the ref when none exists yet', async () => {
      mockListPending.mockResolvedValue([
        { decisionId: 'd1', businessImpact: 'x', evidencePacket: {}, options: [] },
      ]);

      await approvalInboxSlack.upsertApproverQueueMessage('matt');

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockSetSetting).toHaveBeenCalledWith(
        'approval_inbox_message_ref_matt',
        JSON.stringify({ channel: 'C-MATT', messageTs: '1111.2222' }),
        expect.any(String),
        'approval-inbox',
      );
    });

    it('updates an existing tracked message in place, no new post', async () => {
      mockGetSetting.mockImplementation(async (name: string) =>
        name === 'approval_inbox_message_ref_matt'
          ? { settingValue: JSON.stringify({ channel: 'C-MATT', messageTs: '999.1' }) }
          : null,
      );
      mockListPending.mockResolvedValue([]);

      await approvalInboxSlack.upsertApproverQueueMessage('matt');

      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C-MATT', ts: '999.1' }));
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it('falls back to posting fresh if the tracked update fails', async () => {
      mockGetSetting.mockImplementation(async (name: string) =>
        name === 'approval_inbox_message_ref_matt'
          ? { settingValue: JSON.stringify({ channel: 'C-MATT', messageTs: 'stale-ts' }) }
          : null,
      );
      mockUpdate.mockResolvedValue({ ok: false, error: 'message_not_found' });

      await approvalInboxSlack.upsertApproverQueueMessage('matt');

      expect(mockPostMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveApprovalDecision', () => {
    it('claims, then refreshes the queue message and posts a resolution notice', async () => {
      const decision = { decisionId: 'd1', approver: 'matt', verdict: 'approve', businessImpact: 'x' };
      mockClaimDecision.mockResolvedValue({ claimed: true, decision });

      const result = await approvalInboxSlack.resolveApprovalDecision('d1', 'approve', 'matt');

      expect(result.claimed).toBe(true);
      expect(mockClaimDecision).toHaveBeenCalledWith('d1', 'approve', 'matt', undefined);
      // Refresh (queue message) + resolution notice both post/update via Slack.
      expect(mockPostMessage.mock.calls.length + mockUpdate.mock.calls.length).toBeGreaterThan(0);
    });

    it('never touches Slack when the claim itself fails', async () => {
      mockClaimDecision.mockResolvedValue({ claimed: false, reason: 'already_resolved' });

      const result = await approvalInboxSlack.resolveApprovalDecision('d1', 'approve', 'matt');

      expect(result.claimed).toBe(false);
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
