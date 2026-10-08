/**
 * ENG-1719 — before this fix, a SessionBusyError from runVerifiedChat (thrown when the
 * target session was already generating — e.g. the customer live-chatting on it) fell
 * straight into this function's generic catch, which pages on-call with "Agent Mode
 * Verified Generate: Failed" for something that is expected, benign contention, not a
 * real failure of the revision.
 *
 * Scoped follow-up review found this call site (unlike humanEvalActionService's identical
 * fix) had no dedicated test — the fix was verified correct only by hand-tracing the code.
 * This file closes that gap.
 */
jest.mock('../controllers/agentModeController', () => ({
  runVerifiedChat: jest.fn(),
  // Mirrors the real isSessionBusyError's contract: real SessionBusyError instances carry
  // `code: 'SESSION_BUSY'`.
  isSessionBusyError: jest.fn((error: unknown) =>
    typeof error === 'object' && error !== null && (error as any).code === 'SESSION_BUSY'),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://example.com/ishare/token'),
  },
}));

jest.mock('../utils/agentModeAlerts', () => ({
  sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/slackService', () => ({
  postSlackMessage: jest.fn().mockResolvedValue({ ts: '1', channel: 'C1' }),
}));

import { runVerifiedChat } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { postSlackMessage } from '../services/slackService';
import { triggerAutoRevision } from '../services/revisionService';
import type { AssetApproval } from '../services/approvalDb';

const mockRunVerifiedChat = runVerifiedChat as jest.Mock;
const mockGetChatSession = chatbotDb.getChatSession as jest.Mock;
const mockSendAgentModeOncallAlert = sendAgentModeOncallAlert as jest.Mock;
const mockPostSlackMessage = postSlackMessage as jest.Mock;

const approval: AssetApproval = {
  assetUrl: 'https://example.com/original.png',
  filename: 'original.png',
  assetType: 'image',
  executionId: 'exec-1-images', // the '-images' suffix routes triggerAutoRevision to the Agent Mode path
  userId: 'user-1',
  status: 'needs_changes',
  slackChannel: 'C1',
  slackChannelName: 'approvals',
  slackMessageTs: '100.0',
  createdAt: '2026-09-03T00:00:00.000Z',
  updatedAt: '2026-09-03T00:00:00.000Z',
};

describe('triggerAutoRevision — session-busy contention (ENG-1719)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChatSession.mockResolvedValue({ sessionId: 'exec-1', userId: 'user-1', messages: [] });
  });

  it('does not page on-call when the target session is already busy', async () => {
    mockRunVerifiedChat.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }),
    );

    await expect(triggerAutoRevision(approval, 'make it pop')).resolves.toBeUndefined();

    expect(mockSendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('ENG-1745: tells the reviewer directly in Slack when the session is busy', async () => {
    mockRunVerifiedChat.mockRejectedValueOnce(
      Object.assign(new Error('busy'), { code: 'SESSION_BUSY' }),
    );

    await triggerAutoRevision(approval, 'make it pop');

    expect(mockPostSlackMessage).toHaveBeenCalledWith(
      approval.slackChannel,
      expect.stringContaining('busy'),
      approval.slackMessageTs,
    );
  });

  it('still pages on-call for a genuine (non-busy) failure', async () => {
    mockRunVerifiedChat.mockRejectedValueOnce(new Error('LLM provider exploded'));

    await expect(triggerAutoRevision(approval, 'make it pop')).resolves.toBeUndefined();

    expect(mockSendAgentModeOncallAlert).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Agent Mode Verified Generate: Failed' }),
    );
  });

  it('ENG-1745 follow-up: tells the reviewer directly in Slack on a genuine (non-busy) failure', async () => {
    // Scoped review of the initial ENG-1745 fix found this branch (and the no-asset-extracted
    // one below) were missed — only the isSessionBusyError branch got the Slack notice.
    mockRunVerifiedChat.mockRejectedValueOnce(new Error('LLM provider exploded'));

    await triggerAutoRevision(approval, 'make it pop');

    expect(mockPostSlackMessage).toHaveBeenCalledWith(
      approval.slackChannel,
      expect.stringContaining("didn't go through"),
      approval.slackMessageTs,
    );
  });

  it('ENG-1745 follow-up: tells the reviewer directly in Slack when no asset was extracted', async () => {
    mockRunVerifiedChat.mockResolvedValueOnce({ success: false, toolCalls: [] });

    await triggerAutoRevision(approval, 'make it pop');

    expect(mockPostSlackMessage).toHaveBeenCalledWith(
      approval.slackChannel,
      expect.stringContaining("didn't go through"),
      approval.slackMessageTs,
    );
  });
});
