// ENG-1644 Phase B: unit tests for the stage_pending_decision Emma tool.
// Covers the tool's own logic (arg mapping into approvalInboxService,
// never-halts behavior, the hard meta_write rejection) — approvalInboxService's
// own validation/persistence is already covered by approvalInboxService.test.ts.

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { createDecision: jest.fn() },
}));

jest.mock('../services/approvalInboxCustomerNotify', () => ({
  notifyCustomerOfPendingCredentialDecision: jest.fn(),
}));

jest.mock('../services/approvalInboxSlack', () => ({
  upsertApproverQueueMessage: jest.fn(),
  postDecisionAddedNotice: jest.fn(),
}));

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { approvalInboxService } from '../services/approvalInboxService';
import { notifyCustomerOfPendingCredentialDecision } from '../services/approvalInboxCustomerNotify';
import { upsertApproverQueueMessage, postDecisionAddedNotice } from '../services/approvalInboxSlack';

const mockCreateDecision = approvalInboxService.createDecision as jest.Mock;
const mockNotifyCustomer = notifyCustomerOfPendingCredentialDecision as jest.Mock;
const mockUpsertApproverQueueMessage = upsertApproverQueueMessage as jest.Mock;
const mockPostDecisionAddedNotice = postDecisionAddedNotice as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateDecision.mockResolvedValue({
    decisionId: 'decision-1',
    audience: 'team',
    approver: 'matt',
    status: 'pending_team_review',
  });
  mockNotifyCustomer.mockResolvedValue(undefined);
  mockUpsertApproverQueueMessage.mockResolvedValue(undefined);
  mockPostDecisionAddedNotice.mockResolvedValue(undefined);
});

describe('stage_pending_decision', () => {
  it('maps a team plan_choice call into createDecision correctly and does not halt the turn', async () => {
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    const result = await tool.execute(
      {
        audience: 'team',
        approver: 'matt',
        gateType: 'plan_choice',
        businessImpact: 'Decides the ad set strategy for a live campaign.',
        evidencePacket: { chatUrl: 'https://app.agentweb.pro/agent-mode/sess-1', links: ['https://linear.app/x'] },
        options: [
          { label: 'Keep paused', consequence: 'No spend.', recommended: true, why: 'Creative not final.' },
          { label: 'Activate', consequence: 'Starts delivery.' },
        ],
      },
      { userId: 'user-1', sessionId: 'sess-1' },
    );

    expect(mockCreateDecision).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'plan_choice',
      approver: 'matt',
      customerId: undefined,
      businessImpact: 'Decides the ad set strategy for a live campaign.',
      originSessionId: 'sess-1',
    }));
    const call = mockCreateDecision.mock.calls[0][0];
    expect(call.options).toHaveLength(2);
    expect(call.options[0].recommended).toBe(true);
    expect(call.options[1].id).toBe('option-2'); // auto-generated id for the entry with no explicit id

    expect(result.success).toBe(true);
    expect(result.decisionId).toBe('decision-1');
    // gap-closing round: every new team-audience decision must both refresh
    // the queue message AND fire a real, always-new notification — the
    // queue-only update alone doesn't reliably notify an approver.
    expect(mockUpsertApproverQueueMessage).toHaveBeenCalledWith('matt');
    expect(mockPostDecisionAddedNotice).toHaveBeenCalledWith('matt', expect.objectContaining({ decisionId: 'decision-1' }));
    // No awaitingUserConfirmation anywhere in the result — this tool never
    // halts the turn, unlike present_question_deck/call_meta_marketing_api.
    expect(result.awaitingUserConfirmation).toBeUndefined();
  });

  it('maps a customer-audience call to customerId, never an approver', async () => {
    mockCreateDecision.mockResolvedValue({ decisionId: 'decision-2', status: 'pending_customer_response' });
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    await tool.execute(
      {
        audience: 'customer',
        customerId: 'cust-1',
        gateType: 'customer_credential',
        businessImpact: 'Needs a fresh OAuth token to keep syncing.',
        evidencePacket: { researchSummary: 'Token expired 3 days ago.' },
      },
      { userId: 'user-1', sessionId: 'sess-1' },
    );

    expect(mockCreateDecision).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'customer_credential',
      approver: undefined,
      customerId: 'cust-1',
    }));
  });

  it('rejects a meta_write gateType outright — structurally cannot carry write parameters, no createDecision call at all', async () => {
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    const result = await tool.execute(
      {
        audience: 'team',
        approver: 'matt',
        gateType: 'meta_write',
        businessImpact: 'x',
        evidencePacket: {},
      },
      { userId: 'user-1', sessionId: 'sess-1' },
    );

    expect(result.success).toBe(false);
    expect(mockCreateDecision).not.toHaveBeenCalled();
  });

  it('defaults expiresInDays to 7 when omitted, and honors an explicit value', async () => {
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    const before = Date.now();

    await tool.execute(
      { audience: 'team', approver: 'harsha', gateType: 'plan_choice', businessImpact: 'x', evidencePacket: {}, options: [
        { label: 'A', consequence: 'x', recommended: true },
        { label: 'B', consequence: 'x' },
      ] },
      { userId: 'user-1', sessionId: 'sess-1' },
    );
    const defaultExpiry = new Date(mockCreateDecision.mock.calls[0][0].expiresAt).getTime();
    expect(defaultExpiry).toBeGreaterThan(before + 6 * 24 * 60 * 60 * 1000);
    expect(defaultExpiry).toBeLessThan(before + 8 * 24 * 60 * 60 * 1000);

    mockCreateDecision.mockClear();
    await tool.execute(
      { audience: 'team', approver: 'harsha', gateType: 'plan_choice', businessImpact: 'x', evidencePacket: {}, expiresInDays: 1, options: [
        { label: 'A', consequence: 'x', recommended: true },
        { label: 'B', consequence: 'x' },
      ] },
      { userId: 'user-1', sessionId: 'sess-1' },
    );
    const explicitExpiry = new Date(mockCreateDecision.mock.calls[0][0].expiresAt).getTime();
    expect(explicitExpiry).toBeLessThan(before + 2 * 24 * 60 * 60 * 1000);
  });

  it('propagates a createDecision validation error as a failed tool result, not a throw', async () => {
    mockCreateDecision.mockRejectedValue(new Error('options must have exactly one recommended:true entry'));
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    const result = await tool.execute(
      { audience: 'team', approver: 'matt', gateType: 'plan_choice', businessImpact: 'x', evidencePacket: {}, options: [
        { label: 'A', consequence: 'x' },
        { label: 'B', consequence: 'x' },
      ] },
      { userId: 'user-1', sessionId: 'sess-1' },
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('exactly one recommended');
  });

  it('rejects gateType=customer_confirmation outright — no delivery surface exists, no createDecision call at all', async () => {
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    const result = await tool.execute(
      { audience: 'customer', customerId: 'cust-1', gateType: 'customer_confirmation', businessImpact: 'x', evidencePacket: {} },
      { userId: 'user-1', sessionId: 'sess-1' },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('customer_confirmation');
    expect(mockCreateDecision).not.toHaveBeenCalled();
  });

  it('customer_credential: passes customerActionUrl/credentialPlatform/credentialAccountId through and notifies the customer, not the Slack queue', async () => {
    mockCreateDecision.mockResolvedValue({
      decisionId: 'decision-2',
      audience: 'customer',
      gateType: 'customer_credential',
      customerId: 'cust-1',
      status: 'pending_customer_response',
    });
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    const result = await tool.execute(
      {
        audience: 'customer',
        customerId: 'cust-1',
        gateType: 'customer_credential',
        businessImpact: 'Your Meta ad account disconnected.',
        evidencePacket: {},
        customerActionUrl: 'https://app.agentweb.pro/settings?tab=connected-accounts&platform=meta',
        credentialPlatform: 'meta',
        credentialAccountId: 'act_123',
      },
      { userId: 'user-1', sessionId: 'sess-1' },
    );

    expect(mockCreateDecision).toHaveBeenCalledWith(expect.objectContaining({
      gateType: 'customer_credential',
      customerId: 'cust-1',
      customerActionUrl: 'https://app.agentweb.pro/settings?tab=connected-accounts&platform=meta',
      credentialPlatform: 'meta',
      credentialAccountId: 'act_123',
    }));
    expect(mockNotifyCustomer).toHaveBeenCalledWith(expect.objectContaining({ decisionId: 'decision-2' }));
    expect(result.success).toBe(true);
  });

  it('a customer-notify failure does not fail the tool call — decision is already persisted', async () => {
    mockCreateDecision.mockResolvedValue({
      decisionId: 'decision-3',
      audience: 'customer',
      gateType: 'customer_credential',
      customerId: 'cust-1',
    });
    mockNotifyCustomer.mockRejectedValue(new Error('email service down'));
    const tool = emmaToolRegistry.getTool('stage_pending_decision')!;
    const result = await tool.execute(
      { audience: 'customer', customerId: 'cust-1', gateType: 'customer_credential', businessImpact: 'x', evidencePacket: {}, customerActionUrl: 'https://x' },
      { userId: 'user-1', sessionId: 'sess-1' },
    );

    expect(result.success).toBe(true);
    expect(result.decisionId).toBe('decision-3');
  });
});
