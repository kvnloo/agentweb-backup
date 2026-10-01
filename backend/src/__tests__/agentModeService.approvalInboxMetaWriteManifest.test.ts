/**
 * ENG-1853: the actual fix for ENG-1635/1644's own stated gap — verified
 * against live Linear text, not memory, that both tickets are marked Done
 * without ever really resuming the origin agent or reading external state
 * back for a durable, async-approved Meta write. This proves
 * executeApprovalInboxMetaWriteManifest (agentModeService.ts) closes that:
 * an approval-inbox manifest's meta_write decisions dispatch together, get
 * read back, and reconcile to fully_applied / partially_applied / unapplied
 * exactly like the live-deck path (metaWriteManifestReconciliation.test.ts)
 * already does — this is the same engine, reused for the durable, days-later
 * approval-inbox flow instead of the session-scoped deck.
 */

jest.setTimeout(30_000);
jest.mock('../services/metaLaunchGate', () => ({
  isMetaSpendStartingWrite: jest.fn().mockReturnValue(false),
  runMetaTrackingGate: jest.fn(),
  collectPendingDestinations: jest.requireActual('../services/metaLaunchGate').collectPendingDestinations,
  collectPendingCreativeIds: jest.requireActual('../services/metaLaunchGate').collectPendingCreativeIds,
  computeTrackingOverrideDigest: jest.requireActual('../services/metaLaunchGate').computeTrackingOverrideDigest,
  computeMetaWriteManifestDigest: jest.requireActual('../services/metaLaunchGate').computeMetaWriteManifestDigest,
  trackingOverrideTokenMatches: jest.requireActual('../services/metaLaunchGate').trackingOverrideTokenMatches,
}));

jest.mock('../services/chatbotService', () => {
  const actual = jest.requireActual('../services/chatbotService');
  return {
    ...actual,
    chatbotDb: {
      ...actual.chatbotDb,
      getChatSession: jest.fn(),
      updateSessionWorkflowRun: jest.fn(),
    },
  };
});

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: {
    listByManifest: jest.fn(),
    recordExecutionResult: jest.fn(),
    claimDispatch: jest.fn(),
    claimManifestFinalization: jest.fn(),
    markDispatching: jest.fn(),
  },
}));

jest.mock('../services/approvalInboxExecution', () => ({
  resumeOriginSession: jest.fn(),
}));

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { approvalInboxService } from '../services/approvalInboxService';
import { resumeOriginSession } from '../services/approvalInboxExecution';

const SESSION_ID = 'sess-inbox-manifest-1';
const ACCOUNT = '2041725529929988';
const CAMPAIGN = '120249715770410073';
const MANIFEST_ID = 'manifest-haven-1';

let service: AgentModeService;
let sessionState: any;

function metaWriteDispatchFor(name: string) {
  return {
    entity_type: 'AD_SET',
    action: 'CREATE',
    account_id: ACCOUNT,
    campaign_id: CAMPAIGN,
    ad_set_id: undefined,
    ad_id: undefined,
    params: { name, optimization_goal: 'OFFSITE_CONVERSIONS' },
  };
}

function decisionFor(id: string, name: string, overrides: Partial<any> = {}) {
  return {
    decisionId: id,
    gateType: 'meta_write',
    audience: 'team',
    approver: 'matt',
    status: 'dispatching',
    verdict: 'approve',
    subjectLabel: `Meta Ads · Account ${ACCOUNT}`,
    businessImpact: `Create ad set ${name}`,
    evidencePacket: {},
    metaWriteManifestDigest: id,
    metaWriteDispatch: metaWriteDispatchFor(name),
    originSessionId: SESSION_ID,
    manifestId: MANIFEST_ID,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'tok' });

  (approvalInboxService.claimDispatch as jest.Mock).mockResolvedValue(true);
  (approvalInboxService.claimManifestFinalization as jest.Mock).mockResolvedValue(true);
  (approvalInboxService.markDispatching as jest.Mock).mockResolvedValue(undefined);
  (resumeOriginSession as jest.Mock).mockResolvedValue(undefined);

  sessionState = { sessionId: SESSION_ID, userId: 'user-1' };
  (chatbotDb.getChatSession as jest.Mock).mockImplementation(async () => ({ ...sessionState }));
  (chatbotDb.updateSessionWorkflowRun as jest.Mock).mockImplementation(async (_sid: string, run: any, opts: any) => {
    if (
      opts?.failIfActiveExists &&
      sessionState.workflowRun &&
      (sessionState.workflowRun.status === 'in_progress' || sessionState.workflowRun.status === 'blocked_on_parameter')
    ) {
      return null;
    }
    if (opts?.requireVersion !== undefined && sessionState.workflowRun?.version !== opts.requireVersion) {
      return null;
    }
    sessionState.workflowRun = run;
    return { ...sessionState };
  });
});

describe('ENG-1853 executeApprovalInboxMetaWriteManifest', () => {
  it('no meta_write items in the manifest: reports no_meta_write_items, touches nothing', async () => {
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([]);
    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome).toEqual({ outcome: 'no_meta_write_items' });
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
  });

  it('refuses when a meta_write item has not yet been individually resolved to dispatching', async () => {
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([
      decisionFor('d1', 'AS_1'),
      decisionFor('d2', 'AS_2', { status: 'pending_team_review' }),
    ]);
    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome).toEqual({ outcome: 'not_all_resolved', unresolved: ['d2'] });
    expect(resumeOriginSession).not.toHaveBeenCalled();
  });

  it('refuses when approved items disagree on which session originated them', async () => {
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([
      decisionFor('d1', 'AS_1'),
      decisionFor('d2', 'AS_2', { originSessionId: 'a-different-session' }),
    ]);
    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome).toEqual({ outcome: 'mixed_origin_sessions' });
    expect(resumeOriginSession).not.toHaveBeenCalled();
  });

  it('all writes succeeding reconciles to fully_applied and records executed with read-back for every decision', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` }, readBackVerified: true };
    }) as any);
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([
      decisionFor('d1', 'AS_1'),
      decisionFor('d2', 'AS_2'),
    ]);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome.outcome).toBe('executed');
    if (outcome.outcome !== 'executed') throw new Error('unreachable');
    expect(outcome.summary?.status).toBe('fully_applied');

    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledWith(
      'd1', 'executed', expect.objectContaining({ success: true, appliedObjectId: 'id-AS_1' }),
    );
    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledWith(
      'd2', 'executed', expect.objectContaining({ success: true, appliedObjectId: 'id-AS_2' }),
    );

    // Review fix (critical): the manifest executor must close the loop back
    // to the originating agent, not just record outcomes nobody reads.
    expect(resumeOriginSession).toHaveBeenCalledWith(SESSION_ID, expect.any(String));
    const resumeMessage = (resumeOriginSession as jest.Mock).mock.calls[0][1];
    expect(resumeMessage).toContain('fully applied');
  });

  it('one real Meta-side failure reconciles to partially_applied — the other write still dispatches and is read back', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      if (params?.name === 'AS_bad') return { success: false, error: 'Invalid parameter', message: 'Invalid parameter' };
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([
      decisionFor('d1', 'AS_good'),
      decisionFor('d2', 'AS_bad'),
    ]);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome.outcome).toBe('executed');
    if (outcome.outcome !== 'executed') throw new Error('unreachable');
    expect(outcome.summary?.status).toBe('partially_applied');

    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledWith(
      'd1', 'executed', expect.objectContaining({ success: true }),
    );
    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledWith(
      'd2', 'execution_failed', expect.objectContaining({ success: false, message: 'Invalid parameter' }),
    );
  });

  it('a manifest containing a rejected sibling only dispatches the approved item', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([
      decisionFor('d1', 'AS_approved'),
      decisionFor('d2', 'AS_rejected', { verdict: 'reject', status: 'rejected' }),
    ]);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome.outcome).toBe('executed');
    if (outcome.outcome !== 'executed') throw new Error('unreachable');
    expect(outcome.summary?.items).toHaveLength(1);
    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledTimes(1);
    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.anything());
  });

  it('a second approve-all call against an already-completed run reports already_executed rather than re-dispatching', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([decisionFor('d1', 'AS_1')]);

    const first = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(first.outcome).toBe('executed');

    const second = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(second).toEqual({ outcome: 'already_executed' });
    // Only the first call actually dispatched — the real assertion that
    // matters: Meta was never written to twice.
    expect((service as any).manageMetaAdsAdSets).toHaveBeenCalledTimes(1);
  });

  it("third-review fix: a retry AFTER recordExecutionResult moved status to 'executed' still reports already_executed, not not_all_resolved", async () => {
    // The original test above used a STATIC mock (status stays 'dispatching'
    // forever), which never actually simulated what recordExecutionResult
    // does for real — masking the bug this test targets directly: the
    // already_executed check used to run AFTER the unresolved check, so a
    // genuinely-executed decision (status 'executed', which fails
    // `status !== 'dispatching'`) fell into not_all_resolved on every retry
    // and never reached already_executed at all.
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    const pending = decisionFor('d1', 'AS_1');
    (approvalInboxService.listByManifest as jest.Mock)
      .mockResolvedValueOnce([pending]) // first call: still dispatching
      .mockResolvedValueOnce([{ ...pending, status: 'executed' }]); // retry: really executed now

    const first = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(first.outcome).toBe('executed');

    const second = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(second).toEqual({ outcome: 'already_executed' });
    expect((service as any).manageMetaAdsAdSets).toHaveBeenCalledTimes(1);
  });

  it('review fix: a step whose dispatch is already claimed by a concurrent driver never reaches the real Meta write', async () => {
    // Simulates two concurrent drivers of the SAME workflow run racing on the
    // same step — claimDispatch is the at-most-once gate that must stop the
    // loser BEFORE dispatchAuthorizedMetaWrite, not after.
    (approvalInboxService.claimDispatch as jest.Mock).mockResolvedValue(false);
    const manageMetaAdsAdSets = jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([decisionFor('d1', 'AS_1')]);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    // 'contended' is not a checkpointed failure — findNextIndependentStep
    // keeps offering the same unattempted step back forever, so a
    // permanently-losing driver never reaches 'completed'
    // (driveIndependentWorkflowToCompletion gives up after
    // MAX_CONTENDED_RETRIES and this surfaces as 'conflict', matching the
    // "someone else is handling it, don't also dispatch" contract). The real
    // invariant under test: the write itself was never dispatched.
    expect(outcome).toEqual({ outcome: 'conflict' });
    expect(manageMetaAdsAdSets).not.toHaveBeenCalled();
  });

  it('third-review fix: claimDispatch THROWING (a real infra error) is treated as contended, not a permanent checkpointed failure for a write that was never attempted', async () => {
    // Distinct from the 'lost the race' test above: here claimDispatch
    // itself errors (not a clean false), which used to propagate straight
    // out of execute() and get permanently checkpointed as 'failed' by
    // advanceIndependentWorkflow — even though dispatchAuthorizedMetaWrite
    // was never called. The fix treats an uncertain claim the same as a
    // definitely-lost one: no checkpoint, so a later retry can still
    // attempt the real write.
    (approvalInboxService.claimDispatch as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));
    const manageMetaAdsAdSets = jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([decisionFor('d1', 'AS_1')]);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome).toEqual({ outcome: 'conflict' });
    expect(manageMetaAdsAdSets).not.toHaveBeenCalled();
    // The real assertion: this must NOT show up as a permanently
    // checkpointed execution_failed — recordExecutionResult is only called
    // from the (never-reached, since outcome is 'conflict') summary path.
    expect(approvalInboxService.recordExecutionResult).not.toHaveBeenCalled();
  });

  it('second-review fix: only dispatches the calling approver\'s own items, never a sibling approver\'s already-approved items in the same manifest', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([
      decisionFor('d1', 'AS_matt', { approver: 'matt' }),
      decisionFor('d2', 'AS_harsha', { approver: 'harsha' }),
    ]);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome.outcome).toBe('executed');
    if (outcome.outcome !== 'executed') throw new Error('unreachable');
    expect(outcome.summary?.items).toHaveLength(1);
    expect(outcome.summary?.items[0].stepId).toBe('d1');
    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledTimes(1);
    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.anything());
  });

  it('second-review fix: a decision self-heals when it is stuck at approved (a prior markDispatching failure) instead of permanently blocking the manifest', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    const wedged = decisionFor('d1', 'AS_1', { status: 'approved' });
    (approvalInboxService.listByManifest as jest.Mock)
      .mockResolvedValueOnce([wedged])
      // Re-read after the self-heal retry — markDispatching succeeded, so the
      // decision now reads back as 'dispatching'.
      .mockResolvedValueOnce([{ ...wedged, status: 'dispatching' }]);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(approvalInboxService.markDispatching).toHaveBeenCalledWith('d1');
    expect(outcome.outcome).toBe('executed');
  });

  it('second-review fix: a decision that stays wedged even after the self-heal retry ITSELF FAILS is still reported as not_all_resolved, not silently dropped', async () => {
    // Distinct from the success-but-stale-read case (third-review fix,
    // covered separately below): here the retry ATTEMPT genuinely fails —
    // markDispatching is an unconditional DynamoDB write, so if it resolves
    // without throwing, the base-table write DID land (only a GSI re-read
    // can lag, never the write itself); the third-review fix trusts that
    // certainty over a stale re-read on purpose. When the write attempt
    // itself rejects, there is no such certainty, and this must still
    // report unresolved.
    const wedged = decisionFor('d1', 'AS_1', { status: 'approved' });
    (approvalInboxService.listByManifest as jest.Mock)
      .mockResolvedValueOnce([wedged])
      .mockResolvedValueOnce([wedged]); // still 'approved' — the retry never actually landed
    (approvalInboxService.markDispatching as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(approvalInboxService.markDispatching).toHaveBeenCalledWith('d1');
    expect(outcome).toEqual({ outcome: 'not_all_resolved', unresolved: ['d1'] });
  });

  it('third-review fix: a self-heal retry that SUCCEEDS is trusted even if the immediate GSI re-read still shows stale approved (eventual consistency lag)', async () => {
    const wedged = decisionFor('d1', 'AS_1', { status: 'approved' });
    (approvalInboxService.listByManifest as jest.Mock)
      .mockResolvedValueOnce([wedged])
      .mockResolvedValueOnce([wedged]); // markDispatching succeeded, but the GSI read is still stale
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(approvalInboxService.markDispatching).toHaveBeenCalledWith('d1');
    expect(outcome.outcome).toBe('executed');
  });

  it('second-review fix: a concurrent finalization race never double-records results or double-resumes the origin session', async () => {
    // Simulates a second driver whose own poll loop observes the same
    // already-completed run (the real dispatch already happened via a
    // different caller) — this driver must not repeat the side effects.
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([decisionFor('d1', 'AS_1')]);
    (approvalInboxService.claimManifestFinalization as jest.Mock).mockResolvedValue(false);

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome.outcome).toBe('executed');
    expect(approvalInboxService.recordExecutionResult).not.toHaveBeenCalled();
    expect(resumeOriginSession).not.toHaveBeenCalled();
  });

  it('found while answering the pre-merge safety question: claimManifestFinalization THROWING (a real infra error, not a lost race) must fail open, not silently drop a real write\'s outcome', async () => {
    // The real Meta write has ALREADY succeeded and been checkpointed by the
    // time this claim runs — dropping recordExecutionResult/resumeOriginSession
    // here would leave a genuinely-applied write permanently unrecorded with
    // no automatic recovery.
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true, message: 'created', adSet: { id: 'id-1' } });
    (approvalInboxService.listByManifest as jest.Mock).mockResolvedValue([decisionFor('d1', 'AS_1')]);
    (approvalInboxService.claimManifestFinalization as jest.Mock).mockRejectedValue(new Error('DynamoDB unavailable'));

    const outcome = await service.executeApprovalInboxMetaWriteManifest(MANIFEST_ID, 'matt');
    expect(outcome.outcome).toBe('executed');
    expect(approvalInboxService.recordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.anything());
    expect(resumeOriginSession).toHaveBeenCalled();
  });
});
