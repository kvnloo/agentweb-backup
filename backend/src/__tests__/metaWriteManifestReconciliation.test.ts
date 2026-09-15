/**
 * ENG-1635/1644 — read back, reconcile, one result: replays the Vincent Hu /
 * Smart Water Heater regression (2026-09-10, session 6a320867…) — a 20-ad-set
 * batch got ONE display-batched confirmation prompt, one "yes," then all 20
 * individually-gated writes failed identically (a CBO bid-strategy default
 * conflict), Meta rate-limited mid-diagnosis, and there was no persisted-state
 * resume: Emma had to manually rebuild the ad set from scratch. This proves an
 * approved deck with a MIX of success and failure now produces ONE reconciled
 * result (partially_applied, naming every exact failure) instead of N
 * scattered, unreconciled pass/fail tool messages — and, unlike the pre-Round-1
 * design this replaces, that one failure does not strand the other approved
 * writes: each gets its own independent checkpoint (see workflow.ts's
 * findNextIndependentStep/recordIndependentStepOutcome).
 *
 * Retargeted (ENG-1635/1644 gap 5's Migration note) at submitApprovalDeckAnswers
 * / the independent-step workflow engine — the mechanism that actually replaced
 * callMetaMarketingApi's old manifestGranted branch + recordMetaWriteManifestOutcome
 * + reconcileMetaWriteManifestIfComplete, all retired. Uses a stateful session
 * double (not a one-shot mock): execution genuinely depends on state
 * accumulating across calls (each workflow step reads the session, claims a
 * digest, and persists a checkpoint before the next step runs), exactly like
 * the real DynamoDB row.
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
      claimMetaWriteManifestDigest: jest.fn(),
      updateSessionApprovalDeck: jest.fn(),
      updateSessionWorkflowRun: jest.fn(),
    },
  };
});

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { computeMetaWriteManifestDigest } from '../services/metaLaunchGate';
import { getJwtSecret } from '../config/jwt';

const ACCOUNT = '2041725529929988'; // Vincent Hu's TriCityAI ad account id
const CAMPAIGN = '120249715770410073';
const SESSION_ID = 'sess-vincent-deck';
const ZIPS = ['94041', '94043', '94536'];

let service: AgentModeService;
/** In-memory stand-in for the DynamoDB session row. */
let sessionState: any;

function writeDispatchFor(zip: string) {
  return {
    entity_type: 'AD_SET',
    action: 'CREATE',
    account_id: ACCOUNT,
    campaign_id: CAMPAIGN,
    ad_set_id: undefined,
    ad_id: undefined,
    params: { name: `AS_${zip}`, optimization_goal: 'OFFSITE_CONVERSIONS' },
  };
}

function digestFor(zip: string) {
  const d = writeDispatchFor(zip);
  return computeMetaWriteManifestDigest(getJwtSecret(), d);
}

function answeredDeckFixture() {
  const at = new Date().toISOString();
  return {
    deckId: 'deck-vincent-1',
    status: 'awaiting' as const,
    createdAt: at,
    finalizedAt: at,
    items: ZIPS.map((zip, i) => ({
      itemId: `write-${i + 1}`,
      kind: 'meta_write',
      question: `Create ad set AS_${zip}?`,
      allowFreeText: true,
      metaWriteManifestDigest: digestFor(zip),
      metaWriteDispatch: writeDispatchFor(zip),
    })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'tok' });

  sessionState = { sessionId: SESSION_ID, userId: 'user-1', pendingApprovalDeck: answeredDeckFixture() };

  (chatbotDb.getChatSession as jest.Mock).mockImplementation(async () => ({ ...sessionState }));

  (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockImplementation(async (_sid: string, digest: string) => {
    if (sessionState.consumedMetaWriteManifestDigests?.[digest]) return false;
    sessionState.consumedMetaWriteManifestDigests = {
      ...(sessionState.consumedMetaWriteManifestDigests || {}),
      [digest]: new Date().toISOString(),
    };
    return true;
  });

  (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockImplementation(async (_sid: string, deck: any, opts: any) => {
    if (
      opts?.requireStillAwaiting &&
      (sessionState.pendingApprovalDeck?.deckId !== opts.requireStillAwaiting ||
        sessionState.pendingApprovalDeck?.status !== 'awaiting')
    ) {
      return null;
    }
    sessionState.pendingApprovalDeck = deck;
    return { ...sessionState };
  });

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

function approveAll() {
  return ZIPS.map((_zip, i) => ({ itemId: `write-${i + 1}`, verdict: 'approve' }));
}

describe('ENG-1635/1644 reconciliation — Vincent Hu partial-failure regression', () => {
  it('a batch with one real Meta-side failure reconciles to partially_applied, naming the exact failure — and the other two still ran', async () => {
    // Mirrors the actual session: Meta accepted 94041 and 94536, but rejected
    // 94043 with "Invalid parameter" the way the CBO bid-strategy conflict did.
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      if (params?.name === 'AS_94043') {
        return { success: false, error: 'Invalid parameter', message: 'Invalid parameter' };
      }
      return { success: true, message: `Ad set "${params?.name}" created successfully`, adSet: { id: `id-${params?.name}` }, readBackVerified: true };
    }) as any);

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, approveAll(), 'user');

    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('unreachable');
    expect(result.summary?.status).toBe('partially_applied');
    expect(result.summary?.items).toHaveLength(3);

    const failed = result.summary!.items.filter((i) => i.status === 'failed');
    const verified = result.summary!.items.filter((i) => i.status === 'verified');
    // Every step was ATTEMPTED — the one failure did not strand its siblings,
    // which is the exact defect Vincent Hu's incident exists to fix (before
    // Round 1's step-per-write correction, findNextStep's fail-fast semantics
    // would have stopped after the first failure and never attempted the rest).
    expect(failed).toHaveLength(1);
    expect(verified).toHaveLength(2);
    expect(failed[0].error).toBe('Invalid parameter');
    // Both successful creates are individually named with their real object ids —
    // the "exact accounting" ENG-1635 requires instead of Vincent Hu's scattered mess.
    expect(verified.map((i) => i.appliedObjectId).sort()).toEqual(['id-AS_94041', 'id-AS_94536'].sort());
  });

  it('all writes failing reconciles to unapplied, not partially_applied', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: false, error: 'Invalid parameter' });

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, approveAll(), 'user');

    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('unreachable');
    expect(result.summary?.status).toBe('unapplied');
    expect(result.summary!.items.every((i) => i.status === 'failed')).toBe(true);
  });

  it('all writes succeeding reconciles to fully_applied', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, approveAll(), 'user');

    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('unreachable');
    expect(result.summary?.status).toBe('fully_applied');
    expect(result.summary!.items.every((i) => i.status === 'verified')).toBe(true);
  });

  it('a kill-and-restart mid-batch resumes at the next unattempted step and never re-dispatches an already-verified one (gap 3b)', async () => {
    let createCalls = 0;
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      createCalls++;
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);

    // First "process": submit and let it run to completion normally (no real
    // crash simulation needed at this layer — the regression this guards is
    // "does a second pass over the SAME session re-dispatch a verified step,"
    // which a persisted checkpoint must prevent regardless of why the second
    // pass happens).
    const first = await service.submitApprovalDeckAnswers(SESSION_ID, approveAll(), 'user');
    expect(first.outcome).toBe('submitted');
    expect(createCalls).toBe(3);

    // "Restart": the deck is already answered (status stays 'answered'), so a
    // second submission attempt must be refused outright — the awaiting-deck
    // guard, not the workflow engine, is what makes this un-replayable.
    const second = await service.submitApprovalDeckAnswers(SESSION_ID, approveAll(), 'user');
    expect(second.outcome).toBe('invalid');
    expect(createCalls).toBe(3); // no new dispatch attempted
  });

  it('reject-with-correction: approve 2 of 3, reject the third with a correction — only the 2 approved ever get a workflow step, the correction is captured, never auto-applied', async () => {
    let createCalls = 0;
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      createCalls++;
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);

    const answers = [
      { itemId: 'write-1', verdict: 'approve' },
      { itemId: 'write-2', verdict: 'reject', freeText: 'Wrong optimization goal — use LINK_CLICKS instead.' },
      { itemId: 'write-3', verdict: 'approve' },
    ];
    const result = await service.submitApprovalDeckAnswers(SESSION_ID, answers, 'user');

    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('unreachable');
    // Only the 2 approved items ever became a workflow step — the rejected
    // one is simply absent, not a step that got skipped or auto-failed.
    expect(result.summary?.items).toHaveLength(2);
    expect(createCalls).toBe(2);
    expect(result.summary?.status).toBe('fully_applied');

    // The correction text is captured on the persisted answer, exactly as
    // submitted — never silently dropped, never auto-applied to a write that
    // was never approved.
    const persistedDeck = sessionState.pendingApprovalDeck;
    const rejectedAnswer = persistedDeck.answers.find((a: any) => a.itemId === 'write-2');
    expect(rejectedAnswer.verdict).toBe('reject');
    expect(rejectedAnswer.freeText).toBe('Wrong optimization goal — use LINK_CLICKS instead.');
  });
});
