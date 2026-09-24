// ENG-1644 Phase E: unit tests for approvalInboxCustomerNotify.ts —
// customer_credential-only email delivery, generalized from
// linkedInDisconnectNotifyService.ts's proven pattern.

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), sendOncallAlert: jest.fn() },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { findPendingCredentialDecision: jest.fn(), claimDecision: jest.fn() },
}));

jest.mock('../services/approvalInboxExecution', () => ({
  executeResolvedDecision: jest.fn(),
}));

import { emailService } from '../services/emailService';
import { userDb } from '../services/db';
import { approvalInboxService } from '../services/approvalInboxService';
import { executeResolvedDecision } from '../services/approvalInboxExecution';
import { notifyCustomerOfPendingCredentialDecision, autoResolveCredentialDecisionOnReconnect } from '../services/approvalInboxCustomerNotify';

const mockSendEmail = emailService.sendEmail as jest.Mock;
const mockSendOncallAlert = emailService.sendOncallAlert as jest.Mock;
const mockGetUserById = userDb.getUserById as jest.Mock;
const mockFindPendingCredentialDecision = approvalInboxService.findPendingCredentialDecision as jest.Mock;
const mockClaimDecision = approvalInboxService.claimDecision as jest.Mock;
const mockExecuteResolvedDecision = executeResolvedDecision as jest.Mock;

const baseDecision: any = {
  decisionId: 'd1',
  gateType: 'customer_credential',
  audience: 'customer',
  customerId: 'cust-1',
  businessImpact: 'Your ad account needs to be reconnected.',
  customerActionUrl: 'https://app.agentweb.pro/settings?tab=connected-accounts&platform=meta',
};

describe('notifyCustomerOfPendingCredentialDecision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue({ userId: 'cust-1', email: 'customer@example.com' });
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('non-customer_credential gate types are a no-op', async () => {
    await notifyCustomerOfPendingCredentialDecision({ ...baseDecision, gateType: 'plan_choice' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('sends an email to the resolved customer email with the businessImpact and action URL', async () => {
    await notifyCustomerOfPendingCredentialDecision(baseDecision);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, text, html] = mockSendEmail.mock.calls[0];
    expect(to).toBe('customer@example.com');
    expect(subject).toContain('Action needed');
    expect(text).toContain('Your ad account needs to be reconnected.');
    expect(text).toContain(baseDecision.customerActionUrl);
    expect(html).toContain(baseDecision.customerActionUrl);
  });

  it('prefers decision.customerEmail over a DB lookup when both are present', async () => {
    await notifyCustomerOfPendingCredentialDecision({ ...baseDecision, customerEmail: 'explicit@example.com' });
    expect(mockSendEmail.mock.calls[0][0]).toBe('explicit@example.com');
  });

  it('fires an oncall alert and sends no email when no email is resolvable', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'cust-1' }); // no email field
    await notifyCustomerOfPendingCredentialDecision(baseDecision);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendOncallAlert).toHaveBeenCalledWith(
      expect.stringContaining('cust-1'),
      expect.stringContaining('d1'),
      expect.objectContaining({ decisionId: 'd1', customerId: 'cust-1' }),
    );
  });

  it('missing customerActionUrl is a no-op (should never happen — createDecision validates this, defense in depth)', async () => {
    await notifyCustomerOfPendingCredentialDecision({ ...baseDecision, customerActionUrl: undefined });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('autoResolveCredentialDecisionOnReconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('no match: does nothing, never claims', async () => {
    mockFindPendingCredentialDecision.mockResolvedValue(null);

    await autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123');

    expect(mockClaimDecision).not.toHaveBeenCalled();
    expect(mockExecuteResolvedDecision).not.toHaveBeenCalled();
  });

  it('a match: claims as approve (system:auto-reconnect) and executes the resolution', async () => {
    const decision = { decisionId: 'd1', gateType: 'customer_credential' };
    mockFindPendingCredentialDecision.mockResolvedValue(decision);
    const claimedDecision = { ...decision, status: 'approved' };
    mockClaimDecision.mockResolvedValue({ claimed: true, decision: claimedDecision });

    await autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123');

    expect(mockFindPendingCredentialDecision).toHaveBeenCalledWith('cust-1', 'meta', 'act_123');
    expect(mockClaimDecision).toHaveBeenCalledWith('d1', 'approve', 'system:auto-reconnect');
    expect(mockExecuteResolvedDecision).toHaveBeenCalledWith(claimedDecision);
  });

  it('a lost claim race (already resolved some other way) is a clean no-op, not an error', async () => {
    mockFindPendingCredentialDecision.mockResolvedValue({ decisionId: 'd1' });
    mockClaimDecision.mockResolvedValue({ claimed: false, reason: 'already_resolved' });

    await expect(autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123')).resolves.toBeUndefined();
    expect(mockExecuteResolvedDecision).not.toHaveBeenCalled();
  });

  it('never throws — a failure here must not break the real reconnect flow calling it', async () => {
    mockFindPendingCredentialDecision.mockRejectedValue(new Error('DynamoDB unavailable'));
    await expect(autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123')).resolves.toBeUndefined();
  });
});
