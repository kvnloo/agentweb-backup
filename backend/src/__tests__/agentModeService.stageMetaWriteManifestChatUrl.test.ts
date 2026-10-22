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

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: {
    createDecision: jest.fn(),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { approvalInboxService } from '../services/approvalInboxService';

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
});
