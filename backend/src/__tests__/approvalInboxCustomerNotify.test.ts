// ENG-1644 Phase E: unit tests for approvalInboxCustomerNotify.ts —
// customer_credential-only email delivery, generalized from
// linkedInDisconnectNotifyService.ts's proven pattern.

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), sendOncallAlert: jest.fn() },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() },
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { findPendingCredentialDecisions: jest.fn(), claimDecision: jest.fn() },
}));

jest.mock('../services/approvalInboxExecution', () => ({
  executeResolvedDecision: jest.fn(),
}));

import { emailService } from '../services/emailService';
import { userDb } from '../services/db';
import { approvalInboxService } from '../services/approvalInboxService';
import { executeResolvedDecision } from '../services/approvalInboxExecution';
import { notifyCustomerOfPendingCredentialDecision, notifyCustomerOfExpiredCredentialDecision, autoResolveCredentialDecisionOnReconnect } from '../services/approvalInboxCustomerNotify';

const mockSendEmail = emailService.sendEmail as jest.Mock;
const mockSendOncallAlert = emailService.sendOncallAlert as jest.Mock;
const mockGetUserById = userDb.getUserById as jest.Mock;
const mockFindPendingCredentialDecisions = approvalInboxService.findPendingCredentialDecisions as jest.Mock;
const mockClaimDecision = approvalInboxService.claimDecision as jest.Mock;
const mockExecuteResolvedDecision = executeResolvedDecision as jest.Mock;

const baseDecision: any = {
  decisionId: 'd1',
  gateType: 'customer_credential',
  audience: 'customer',
  customerId: 'cust-1',
  subjectLabel: 'Meta Ad Account act_123',
  subjectContactEmail: 'owner@thinkingai.com',
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
    // ENG-2159: subjectLabel present alongside businessImpact, not instead of it.
    expect(text).toContain('Meta Ad Account act_123');
    expect(html).toContain('Meta Ad Account act_123');
    // ENG-2159 follow-up: subjectContactEmail parity with the Slack card.
    expect(text).toContain('owner@thinkingai.com');
    expect(html).toContain('owner@thinkingai.com');
  });

  it('omits the contact-email parenthetical when subjectContactEmail is absent (optional field)', async () => {
    await notifyCustomerOfPendingCredentialDecision({ ...baseDecision, subjectContactEmail: undefined });
    const [, , text, html] = mockSendEmail.mock.calls[0];
    expect(text).not.toContain('(');
    expect(html).not.toContain('owner@thinkingai.com');
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

describe('notifyCustomerOfExpiredCredentialDecision (review fix)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue({ userId: 'cust-1', email: 'customer@example.com' });
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('non-customer_credential gate types are a no-op', async () => {
    await notifyCustomerOfExpiredCredentialDecision({ ...baseDecision, gateType: 'plan_choice' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends a real, distinct email telling the customer the window closed', async () => {
    await notifyCustomerOfExpiredCredentialDecision(baseDecision);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, text] = mockSendEmail.mock.calls[0];
    expect(to).toBe('customer@example.com');
    expect(subject.toLowerCase()).toContain('closed');
    expect(text).toContain(baseDecision.businessImpact);
    expect(text.toLowerCase()).toContain('closed');
    expect(text).toContain('Meta Ad Account act_123');
    expect(text).toContain('owner@thinkingai.com');
  });

  it('fires an oncall alert and sends no email when no email is resolvable', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'cust-1' });
    await notifyCustomerOfExpiredCredentialDecision(baseDecision);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendOncallAlert).toHaveBeenCalledWith(
      expect.stringContaining('cust-1'),
      expect.stringContaining('d1'),
      expect.objectContaining({ decisionId: 'd1', customerId: 'cust-1' }),
    );
  });

  it('missing customerId is a no-op', async () => {
    await notifyCustomerOfExpiredCredentialDecision({ ...baseDecision, customerId: undefined });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('autoResolveCredentialDecisionOnReconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('no match: does nothing, never claims', async () => {
    mockFindPendingCredentialDecisions.mockResolvedValue([]);

    await autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123');

    expect(mockClaimDecision).not.toHaveBeenCalled();
    expect(mockExecuteResolvedDecision).not.toHaveBeenCalled();
  });

  it('a single match: claims as approve (system:auto-reconnect) and executes the resolution', async () => {
    const decision = { decisionId: 'd1', gateType: 'customer_credential' };
    mockFindPendingCredentialDecisions.mockResolvedValue([decision]);
    const claimedDecision = { ...decision, status: 'approved' };
    mockClaimDecision.mockResolvedValue({ claimed: true, decision: claimedDecision });

    await autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123');

    expect(mockFindPendingCredentialDecisions).toHaveBeenCalledWith('cust-1', 'meta', 'act_123');
    // Review fix: skipExpiryCheck:true — a real reconnect is ground truth,
    // not a stale UI click the expiry guard should reject. Without this, a
    // reconnect landing in the window between expiresAt and the next sweep
    // tick silently lost the claim and the customer got a false "expired"
    // email later.
    expect(mockClaimDecision).toHaveBeenCalledWith('d1', 'approve', 'system:auto-reconnect', undefined, { skipExpiryCheck: true });
    expect(mockExecuteResolvedDecision).toHaveBeenCalledWith(claimedDecision);
  });

  // ENG-1644 follow-up: real bug found live on prod, 2026-09-25 — a reconnect
  // previously only ever resolved the first (oldest) match; a second, newer
  // duplicate decision for the same account stayed pending indefinitely.
  it('multiple matches: resolves EVERY pending decision for the same account, not just the first (real bug found live on prod)', async () => {
    const older = { decisionId: 'older', gateType: 'customer_credential' };
    const newer = { decisionId: 'newer', gateType: 'customer_credential' };
    mockFindPendingCredentialDecisions.mockResolvedValue([older, newer]);
    mockClaimDecision.mockImplementation((decisionId: string) =>
      Promise.resolve({ claimed: true, decision: { decisionId, status: 'approved' } }),
    );

    await autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123');

    expect(mockClaimDecision).toHaveBeenCalledTimes(2);
    expect(mockClaimDecision).toHaveBeenCalledWith('older', 'approve', 'system:auto-reconnect', undefined, { skipExpiryCheck: true });
    expect(mockClaimDecision).toHaveBeenCalledWith('newer', 'approve', 'system:auto-reconnect', undefined, { skipExpiryCheck: true });
    expect(mockExecuteResolvedDecision).toHaveBeenCalledTimes(2);
    expect(mockExecuteResolvedDecision).toHaveBeenCalledWith({ decisionId: 'older', status: 'approved' });
    expect(mockExecuteResolvedDecision).toHaveBeenCalledWith({ decisionId: 'newer', status: 'approved' });
  });

  it('a lost claim race on one decision does not prevent a second matching decision from still being resolved', async () => {
    const lost = { decisionId: 'lost' };
    const won = { decisionId: 'won' };
    mockFindPendingCredentialDecisions.mockResolvedValue([lost, won]);
    mockClaimDecision.mockImplementation((decisionId: string) =>
      decisionId === 'lost'
        ? Promise.resolve({ claimed: false, reason: 'already_resolved' })
        : Promise.resolve({ claimed: true, decision: { decisionId, status: 'approved' } }),
    );

    await autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123');

    expect(mockClaimDecision).toHaveBeenCalledTimes(2);
    expect(mockExecuteResolvedDecision).toHaveBeenCalledTimes(1);
    expect(mockExecuteResolvedDecision).toHaveBeenCalledWith({ decisionId: 'won', status: 'approved' });
  });

  it('a lost claim race (already resolved some other way) is a clean no-op, not an error', async () => {
    mockFindPendingCredentialDecisions.mockResolvedValue([{ decisionId: 'd1' }]);
    mockClaimDecision.mockResolvedValue({ claimed: false, reason: 'already_resolved' });

    await expect(autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123')).resolves.toBeUndefined();
    expect(mockExecuteResolvedDecision).not.toHaveBeenCalled();
  });

  it('never throws — a failure here must not break the real reconnect flow calling it', async () => {
    mockFindPendingCredentialDecisions.mockRejectedValue(new Error('DynamoDB unavailable'));
    await expect(autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123')).resolves.toBeUndefined();
  });

  it('a failure resolving ONE decision does not stop the others from being attempted', async () => {
    const failing = { decisionId: 'failing' };
    const succeeding = { decisionId: 'succeeding' };
    mockFindPendingCredentialDecisions.mockResolvedValue([failing, succeeding]);
    mockClaimDecision.mockImplementation((decisionId: string) =>
      decisionId === 'failing'
        ? Promise.reject(new Error('transient claim error'))
        : Promise.resolve({ claimed: true, decision: { decisionId, status: 'approved' } }),
    );

    await expect(autoResolveCredentialDecisionOnReconnect('cust-1', 'meta', 'act_123')).resolves.toBeUndefined();
    expect(mockExecuteResolvedDecision).toHaveBeenCalledTimes(1);
    expect(mockExecuteResolvedDecision).toHaveBeenCalledWith({ decisionId: 'succeeding', status: 'approved' });
  });
});

describe('ENG-2301: resolveCustomerEmail for email-shaped customerId', () => {
  const mockGetUserByEmail = (userDb as any).getUserByEmail as jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue(null);
    mockGetUserByEmail.mockResolvedValue(null);
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('pending: email-shaped customerId with no user row emails the customer and does not alert oncall', async () => {
    await notifyCustomerOfPendingCredentialDecision({ ...baseDecision, customerId: 'juan@usehaven.ai' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toBe('juan@usehaven.ai');
    expect(mockSendOncallAlert).not.toHaveBeenCalled();
  });

  it('expired: email-shaped customerId with no user row emails the customer and does not alert oncall', async () => {
    await notifyCustomerOfExpiredCredentialDecision({ ...baseDecision, customerId: 'juan@usehaven.ai' });
    expect(mockSendEmail.mock.calls[0][0]).toBe('juan@usehaven.ai');
    expect(mockSendOncallAlert).not.toHaveBeenCalled();
  });

  it('prefers the user-by-email record when one exists', async () => {
    mockGetUserByEmail.mockResolvedValue({ email: 'juan@usehaven.ai' });
    await notifyCustomerOfPendingCredentialDecision({ ...baseDecision, customerId: 'Juan@UseHaven.ai' });
    expect(mockGetUserByEmail).toHaveBeenCalledWith('juan@usehaven.ai');
    expect(mockSendEmail.mock.calls[0][0]).toBe('juan@usehaven.ai');
  });

  it('opaque customerId with no user still fires the oncall alert (both paths)', async () => {
    await notifyCustomerOfPendingCredentialDecision({ ...baseDecision, customerId: 'cust-missing' });
    await notifyCustomerOfExpiredCredentialDecision({ ...baseDecision, customerId: 'cust-missing' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendOncallAlert).toHaveBeenCalledTimes(2);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });
});
