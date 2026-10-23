/**
 * ENG-1853 follow-up: found live by a real reviewer looking at the actual
 * deployed page — a meta_write decision's evidencePacket carried no way
 * back to the conversation that proposed it, unlike a plan_choice decision
 * (ask_user_question lets the model supply chat_url explicitly).
 * sessionId is already a parameter to stageApprovalInboxMetaWriteManifest;
 * this pins that it's actually turned into the same
 * `${CUSTOMER_FRONTEND_URL}/agent-mode/${sessionId}` link
 * agentModeController.ts already uses elsewhere for "go back to this
 * session", and attached to every decision staged from one halt batch.
 */

jest.mock('../services/approvalInboxSlack', () => ({
  postManifestReadyNotice: jest.fn(),
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: {
    createDecision: jest.fn(),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { approvalInboxService } from '../services/approvalInboxService';
import { postManifestReadyNotice } from '../services/approvalInboxSlack';

const SESSION_ID = 'sess-chaturl-1';

function writeHalt(overrides: Partial<any> = {}) {
  return {
    metaWriteManifestDigest: 'digest-1',
    metaWriteDispatch: { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: 'act_1', params: {} },
    target: { account_id: 'act_1' },
    summary: 'UPDATE campaign "Summer Sale" in ad account act_1.',
    ...overrides,
  };
}

describe('stageApprovalInboxMetaWriteManifest attaches a real chatUrl', () => {
  let service: AgentModeService;
  const originalFrontendUrl = process.env.CUSTOMER_FRONTEND_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  afterEach(() => {
    if (originalFrontendUrl === undefined) delete process.env.CUSTOMER_FRONTEND_URL;
    else process.env.CUSTOMER_FRONTEND_URL = originalFrontendUrl;
  });

  it('sets evidencePacket.chatUrl to the real session link when CUSTOMER_FRONTEND_URL is configured', async () => {
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => ({
      ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review',
    }));

    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt()]);

    expect(approvalInboxService.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        evidencePacket: expect.objectContaining({ chatUrl: `https://app.agentweb.pro/agent-mode/${SESSION_ID}` }),
      }),
    );
  });

  it('attaches the SAME chatUrl to every decision staged from one multi-write halt batch', async () => {
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => ({
      ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review',
    }));

    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [
      writeHalt({ metaWriteManifestDigest: 'digest-1' }),
      writeHalt({ metaWriteManifestDigest: 'digest-2' }),
    ]);

    const calls = (approvalInboxService.createDecision as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    const expectedUrl = `https://app.agentweb.pro/agent-mode/${SESSION_ID}`;
    for (const [req] of calls) {
      expect(req.evidencePacket.chatUrl).toBe(expectedUrl);
    }
  });

  it('does not duplicate the summary into evidencePacket.researchSummary', async () => {
    // ENG-1853 follow-up: confirmationDetail (-> businessImpact) IS r.summary, so also
    // setting researchSummary to r.summary rendered the identical sentence twice on the
    // card ("UPDATE campaign..." shown once as businessImpact, once as researchSummary).
    // Caught live by a real reviewer looking at the actual deployed page. There's no
    // separate agent-authored rationale at this halt point to put in researchSummary
    // instead, so it's simply omitted now.
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => ({
      ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review',
    }));

    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt()]);

    const [req] = (approvalInboxService.createDecision as jest.Mock).mock.calls[0];
    expect(req.evidencePacket.researchSummary).toBeUndefined();
    expect(req.businessImpact).toBe('UPDATE campaign "Summer Sale" in ad account act_1.');
  });

  it('queues writes for different ad accounts as separate packets, and same-account writes together', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => ({
      ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review',
    }));
    const forAccount = (digest: string, account: string) => writeHalt({
      metaWriteManifestDigest: digest,
      metaWriteDispatch: { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: `act_${account}`, resolvedAccountId: `act_${account}`, params: {} },
      target: { account_id: account },
    });

    const result = await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [
      forAccount('d1', 'ALPHA'), forAccount('d2', 'BETA'), forAccount('d3', 'ALPHA'),
    ]);

    const calls = (approvalInboxService.createDecision as jest.Mock).mock.calls.map(([r]: any) => r);
    const byDigest = Object.fromEntries(calls.map((r: any) => [r.metaWriteManifestDigest, r.manifestId]));
    expect(byDigest.d1).toBe(byDigest.d3);
    expect(byDigest.d1).not.toBe(byDigest.d2);
    expect(result.turnMessage).toContain('2 separate packets');
  });

  it('pings the assigned reviewer once per packet (not per item) and per account', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => ({
      ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review',
    }));
    const forAccount = (digest: string, account: string) => writeHalt({
      metaWriteManifestDigest: digest,
      metaWriteDispatch: { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: `act_${account}`, resolvedAccountId: `act_${account}`, params: {} },
      target: { account_id: account },
    });
    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [forAccount('d1', 'ALPHA'), forAccount('d2', 'ALPHA'), forAccount('d3', 'BETA')]);
    const calls = (postManifestReadyNotice as jest.Mock).mock.calls.map(([approver, packet]: any) => ({ approver, n: packet.itemCount, acct: packet.accountLabel }));
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(expect.arrayContaining([
      { approver: 'matt', n: 2, acct: 'ad account ALPHA' },
      { approver: 'matt', n: 1, acct: 'ad account BETA' },
    ]));
  });

  it('does not ping for decisions that are not pending, and a Slack failure never breaks staging', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => ({
      ...req, decisionId: req.metaWriteManifestDigest, status: 'executed',
    }));
    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt()]);
    expect(postManifestReadyNotice).not.toHaveBeenCalled();

    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => ({
      ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review',
    }));
    (postManifestReadyNotice as jest.Mock).mockRejectedValue(new Error('slack down'));
    const result = await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt()]);
    expect(result.manifestId).toBeTruthy();
  });
});
