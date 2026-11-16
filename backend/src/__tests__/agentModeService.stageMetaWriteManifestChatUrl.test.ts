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

  const flush = () => new Promise((r) => setImmediate(r));
  const pending = (over: any = {}) => async (req: any) => ({ ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review', createdAt: new Date().toISOString(), ...over });
  const forAccount = (digest: string, account: string) => writeHalt({
    metaWriteManifestDigest: digest,
    metaWriteDispatch: { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: `act_${account}`, resolvedAccountId: `act_${account}`, params: {} },
    target: { account_id: account },
  });

  it('pings the assigned reviewer once per packet (not per item) and per account', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(pending());
    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [forAccount('d1', '111'), forAccount('d2', '111'), forAccount('d3', '222')]);
    await flush();
    const calls = (postManifestReadyNotice as jest.Mock).mock.calls.map(([approver, packet]: any) => ({ approver, n: packet.itemCount, acct: packet.accountLabel }));
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(expect.arrayContaining([
      { approver: 'matt', n: 2, acct: 'ad account 111' },
      { approver: 'matt', n: 1, acct: 'ad account 222' },
    ]));
  });

  it('does not ping for non-pending decisions, nor re-ping a retried iteration that hit an already-staged row', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(pending({ status: 'executed' }));
    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt()]);
    await flush();
    expect(postManifestReadyNotice).not.toHaveBeenCalled();

    // A retry within seconds: the row already existed before this call, so its createdAt is older than the call.
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(pending({ createdAt: new Date(Date.now() - 5_000).toISOString() }));
    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt()]);
    await flush();
    expect(postManifestReadyNotice).not.toHaveBeenCalled();
  });

  it('never puts a non-numeric account id (a possible mention/link injection) into the Slack text', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(pending());
    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [forAccount('d1', '<!channel>')]);
    await flush();
    expect((postManifestReadyNotice as jest.Mock).mock.calls[0][1].accountLabel).toBeUndefined();
  });

  it('does not wait for Slack: staging returns while the reminder is still in flight, and a Slack failure never breaks it', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(pending());
    let release: () => void = () => undefined;
    (postManifestReadyNotice as jest.Mock).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const result = await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt()]);
    expect(result.manifestId).toBeTruthy();
    release();

    (postManifestReadyNotice as jest.Mock).mockRejectedValue(new Error('slack down'));
    const again = await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt({ metaWriteManifestDigest: 'digest-9' })]);
    await flush();
    expect(again.manifestId).toBeTruthy();
  });

  it('counts a digest staged twice in one call once, so the reminder never overstates the packet', async () => {
    const rows = new Map<string, any>();
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(async (req: any) => {
      if (!rows.has(req.metaWriteManifestDigest)) rows.set(req.metaWriteManifestDigest, { ...req, decisionId: req.metaWriteManifestDigest, status: 'pending_team_review', createdAt: new Date().toISOString() });
      return rows.get(req.metaWriteManifestDigest);
    });
    await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [forAccount('dup', '111'), forAccount('dup', '111'), forAccount('other', '111')]);
    await flush();
    expect((postManifestReadyNotice as jest.Mock).mock.calls).toHaveLength(1);
    expect((postManifestReadyNotice as jest.Mock).mock.calls[0][1].itemCount).toBe(2);
  });

  it('logs (does not throw) when the reminder fails', async () => {
    (approvalInboxService.createDecision as jest.Mock).mockImplementation(pending());
    (postManifestReadyNotice as jest.Mock).mockRejectedValue(new Error('slack down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await (service as any).stageApprovalInboxMetaWriteManifest(SESSION_ID, [writeHalt({ metaWriteManifestDigest: 'digest-warn' })]);
      await flush();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to post the Approval Desk reminder'), 'slack down');
    } finally {
      warn.mockRestore();
    }
  });
});
