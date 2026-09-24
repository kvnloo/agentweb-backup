// ENG-1644 gap-closing round: unit tests for approvalExpirySweepCron.ts —
// the sweep that flips silently-unanswered decisions to 'expired' and tells
// their origin session, closing the "dies silently" gap.

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { listDuePending: jest.fn(), expireDecision: jest.fn() },
}));

jest.mock('../services/approvalInboxExecution', () => ({
  notifyOriginSessionOfExpiry: jest.fn(),
}));

import { approvalInboxService } from '../services/approvalInboxService';
import { notifyOriginSessionOfExpiry } from '../services/approvalInboxExecution';
import { runApprovalExpirySweep } from '../cron/approvalExpirySweepCron';

const mockListDuePending = approvalInboxService.listDuePending as jest.Mock;
const mockExpireDecision = approvalInboxService.expireDecision as jest.Mock;
const mockNotify = notifyOriginSessionOfExpiry as jest.Mock;

describe('runApprovalExpirySweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDuePending.mockResolvedValue([]);
    mockExpireDecision.mockResolvedValue({ expired: false });
    mockNotify.mockResolvedValue(undefined);
  });

  it('queries both pending statuses, not just one', async () => {
    await runApprovalExpirySweep();
    expect(mockListDuePending).toHaveBeenCalledWith('pending_team_review');
    expect(mockListDuePending).toHaveBeenCalledWith('pending_customer_response');
  });

  it('expires a genuinely-due decision and notifies its origin session', async () => {
    const decision = { decisionId: 'd1', originSessionId: 'sess-1' };
    mockListDuePending.mockImplementation(async (status: string) =>
      status === 'pending_team_review' ? [decision] : []);
    mockExpireDecision.mockResolvedValue({ expired: true, decision });

    const summary = await runApprovalExpirySweep();

    expect(mockExpireDecision).toHaveBeenCalledWith('d1');
    expect(mockNotify).toHaveBeenCalledWith(decision);
    expect(summary).toEqual({ scanned: 1, expired: 1, alreadyResolved: 0, failed: 0 });
  });

  it('a decision that expireDecision reports as already claimed is counted, not notified', async () => {
    const decision = { decisionId: 'd1' };
    mockListDuePending.mockImplementation(async (status: string) =>
      status === 'pending_team_review' ? [decision] : []);
    mockExpireDecision.mockResolvedValue({ expired: false });

    const summary = await runApprovalExpirySweep();

    expect(mockNotify).not.toHaveBeenCalled();
    expect(summary.alreadyResolved).toBe(1);
    expect(summary.expired).toBe(0);
  });

  it('one decision failing never aborts the sweep for the rest', async () => {
    const decisionA = { decisionId: 'a' };
    const decisionB = { decisionId: 'b' };
    mockListDuePending.mockImplementation(async (status: string) =>
      status === 'pending_team_review' ? [decisionA, decisionB] : []);
    mockExpireDecision
      .mockRejectedValueOnce(new Error('DynamoDB unavailable'))
      .mockResolvedValueOnce({ expired: true, decision: decisionB });

    const summary = await runApprovalExpirySweep();

    expect(mockExpireDecision).toHaveBeenCalledTimes(2);
    expect(summary.failed).toBe(1);
    expect(summary.expired).toBe(1);
  });

  it('a listDuePending failure for one status does not prevent scanning the other', async () => {
    const decision = { decisionId: 'c' };
    mockListDuePending.mockImplementation(async (status: string) => {
      if (status === 'pending_team_review') throw new Error('query failed');
      return [decision];
    });
    mockExpireDecision.mockResolvedValue({ expired: true, decision });

    const summary = await runApprovalExpirySweep();

    expect(summary.scanned).toBe(1);
    expect(summary.expired).toBe(1);
  });
});
