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
      updateSessionLastFailedMetaWrite: jest.fn(),
    },
  };
});

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { computeMetaWriteManifestDigest } from '../services/metaLaunchGate';
import { getJwtSecret } from '../config/jwt';
import { advanceIndependentWorkflow } from '../services/agentMode/workflowRunner';
import type { WorkflowRunState } from '../services/agentMode/core/workflow';
import { applyDeckAnswers } from '../services/agentMode/core/approvalDeck';

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

  (chatbotDb.updateSessionLastFailedMetaWrite as jest.Mock).mockImplementation(async (_sid: string, value: any) => {
    sessionState.lastFailedMetaWrite = value;
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

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', approveAll(), 'user');

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

  it('ENG-1635/1644 (found live 2026-09-18): the enriched, actionable message wins over the raw SDK error when they differ', async () => {
    // Mirrors a real write method's catch block (agentModeService.ts's createMetaAdsAdSet
    // etc.): `error` is the raw top-level SDK message, `message` is enrichMetaError's
    // human-readable, actionable text. Found live: verify() checked `error` FIRST, so the
    // `||` chain always short-circuited on the raw string and silently discarded the
    // enriched one — a repeatedly-failing write ("Budget Is Too Low") got silently
    // re-proposed identically 3 times because Emma only ever saw "Invalid parameter."
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({
      success: false,
      error: 'Invalid parameter',
      message: 'Your ad set budget must be more than ₹94.91 or your ads may not deliver. (Meta code 100, subcode 1885272)',
    });

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', approveAll(), 'user');

    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('unreachable');
    const failed = result.summary!.items.filter((i) => i.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].error).toContain('budget must be more than ₹94.91');
    expect(failed[0].error).not.toBe('Invalid parameter');
  });

  it('all writes failing reconciles to unapplied, not partially_applied', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: false, error: 'Invalid parameter' });

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', approveAll(), 'user');

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

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', approveAll(), 'user');

    expect(result.outcome).toBe('submitted');
    if (result.outcome !== 'submitted') throw new Error('unreachable');
    expect(result.summary?.status).toBe('fully_applied');
    expect(result.summary!.items.every((i) => i.status === 'verified')).toBe(true);
  });

  describe('ENG-1635/1644 follow-up: lastFailedMetaWrite retry-backstop counter (found live 2026-09-18)', () => {
    // A fresh single-item deck against the SAME target each time, as if the model
    // re-proposed the write across separate turns — mirrors the real repro (3
    // consecutive AD_SET CREATE attempts, same campaign, same ad-set name). Each
    // attempt gets a SLIGHTLY different budget so its digest genuinely differs
    // (matching what was actually observed live — 3 different digests, same
    // target) — reusing byte-identical params would hit the at-most-once digest
    // claim guard on the second attempt instead of a fresh Meta-side failure,
    // which is a different thing than what this backstop is about.
    function singleItemDeck(deckId: string, dailyBudget: number) {
      const dispatch = { ...writeDispatchFor('94043'), params: { name: 'AS_94043', optimization_goal: 'OFFSITE_CONVERSIONS', daily_budget: dailyBudget } };
      const at = new Date().toISOString();
      return {
        deckId,
        status: 'awaiting' as const,
        createdAt: at,
        finalizedAt: at,
        items: [{
          itemId: 'write-1',
          kind: 'meta_write',
          question: 'Create ad set AS_94043?',
          allowFreeText: true,
          metaWriteManifestDigest: computeMetaWriteManifestDigest(getJwtSecret(), dispatch),
          metaWriteDispatch: dispatch,
        }],
      };
    }
    function approveOne() {
      return [{ itemId: 'write-1', verdict: 'approve' }];
    }

    it('a failed write records count:1 against its target signature', async () => {
      jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: false, error: 'Invalid parameter', message: 'Budget too low.' });
      sessionState.pendingApprovalDeck = singleItemDeck('deck-retry-1', 100);

      await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-retry-1', approveOne(), 'user');

      expect(sessionState.lastFailedMetaWrite).toEqual(
        expect.objectContaining({ signature: 'AD_SET:CREATE:2041725529929988:120249715770410073::', error: 'Budget too low.', count: 1 }),
      );
    });

    it('a second consecutive failure against the SAME target increments to count:2', async () => {
      jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: false, error: 'Invalid parameter', message: 'Budget too low.' });
      sessionState.pendingApprovalDeck = singleItemDeck('deck-retry-1', 100);
      await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-retry-1', approveOne(), 'user');

      sessionState.pendingApprovalDeck = singleItemDeck('deck-retry-2', 150);
      await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-retry-2', approveOne(), 'user');

      expect(sessionState.lastFailedMetaWrite).toEqual(expect.objectContaining({ count: 2 }));
    });

    it('a success against the same target clears the counter — recovery resets the streak', async () => {
      jest.spyOn(service as any, 'manageMetaAdsAdSets')
        .mockResolvedValueOnce({ success: false, error: 'Invalid parameter', message: 'Budget too low.' })
        .mockResolvedValueOnce({ success: true, message: 'created', adSet: { id: 'id-AS_94043' } });

      sessionState.pendingApprovalDeck = singleItemDeck('deck-retry-1', 100);
      await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-retry-1', approveOne(), 'user');
      expect(sessionState.lastFailedMetaWrite?.count).toBe(1);

      sessionState.pendingApprovalDeck = singleItemDeck('deck-retry-2', 300);
      await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-retry-2', approveOne(), 'user');

      expect(sessionState.lastFailedMetaWrite).toBeNull();
    });
  });

  it('a fully-processed deck refuses a second submission attempt outright (the awaiting-deck guard, NOT the crash-resume path below — see that test for the actual resume guarantee)', async () => {
    let createCalls = 0;
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      createCalls++;
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);

    // Submit and let it run to completion normally.
    const first = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', approveAll(), 'user');
    expect(first.outcome).toBe('submitted');
    expect(createCalls).toBe(3);

    // A second submission attempt against the SAME (already-answered) deck must
    // be refused — but this is applyDeckAnswers' own status check
    // ('answered' !== 'awaiting'), not the workflow engine's resume logic. It
    // proves resubmission is blocked; it says nothing about whether the engine
    // can resume a run that was genuinely interrupted mid-batch, which is what
    // gap 3b actually promises — see the next test for that.
    const second = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', approveAll(), 'user');
    expect(second.outcome).toBe('invalid');
    expect(createCalls).toBe(3); // no new dispatch attempted
  });

  it('stale-deckId guard: a submission naming a deckId that does not match the currently pending deck is refused outright, never dispatched — same shape as AskUserQuestion\'s questionId guard', async () => {
    // Whole-system review finding (2026-09-16): itemIds are only deck-scoped by
    // convention (write-1, write-2, ...) — two different decks with the same
    // item count collide on itemId. Without this guard, a stale/replayed
    // submission (double-click before the button disables, browser
    // back+resubmit, a client retry after the first attempt already
    // succeeded) that arrives AFTER the session has moved on to a different
    // pending deck would silently apply the user's old verdicts to that new,
    // never-reviewed deck's items instead of being refused.
    let createCalls = 0;
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      createCalls++;
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);

    const result = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-some-other-deck', approveAll(), 'user');

    expect(result.outcome).toBe('invalid');
    if (result.outcome !== 'invalid') throw new Error('unreachable');
    expect(result.reason).toContain('deck-some-other-deck');
    expect(result.reason).toContain('deck-vincent-1');
    expect(createCalls).toBe(0); // never dispatched against the wrong deck

    // The real, currently-pending deck can still be answered normally after —
    // the guard rejected the mismatched attempt, it didn't corrupt session state.
    const retry = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', approveAll(), 'user');
    expect(retry.outcome).toBe('submitted');
    expect(createCalls).toBe(3);
  });

  it('gap 3b, for real: advanceIndependentWorkflow resumes a genuinely interrupted run from a seeded PARTIAL checkpoint, never re-dispatching the step that was already verified before the crash', async () => {
    // The prior "kill-and-restart" test in this file (renamed above) never
    // simulated a crash — it only proved a SECOND submitApprovalDeckAnswers
    // call is refused once the deck is fully answered. That test can pass
    // even if the engine's actual resume logic were broken, since it never
    // exercises a partial-checkpoint state at all. This test constructs the
    // real condition instead: a run that died after step 1 of 3 verified,
    // then calls advanceIndependentWorkflow directly — the actual resume
    // primitive a restarted process would use — against that partial state.
    const createCalls: string[] = [];
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      createCalls.push(params?.name);
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);

    // Build the SAME step definitions submitApprovalDeckAnswers would build
    // for this deck's 3 approved items.
    const approved = ZIPS.map((zip, i) => ({
      item: { itemId: `write-${i + 1}`, metaWriteDispatch: writeDispatchFor(zip) },
    }));
    const steps = (service as any).buildMetaWriteWorkflowSteps(SESSION_ID, 'user-1', approved);
    const definition = { workflowId: 'approval-deck-deck-vincent-1', steps };

    // The deck itself was fully answered BEFORE the crash (dispatch only ever
    // starts once the whole deck is answered — see submitApprovalDeckAnswers)
    // — bypassing that call here means seeding the ANSWERED deck state
    // directly too, or every step's independent re-claim (gap 4's per-step
    // digest re-verification) correctly refuses, since findApprovalDeckAnswerForDigest
    // requires status === 'answered'.
    sessionState.pendingApprovalDeck = applyDeckAnswers(
      answeredDeckFixture(),
      approveAll(),
      'user',
      '2026-09-14T23:59:00.000Z',
    );

    // Seed the session with a run that already has write-1 checkpointed
    // 'verified' from BEFORE the simulated crash — bypassing
    // submitApprovalDeckAnswers'/startWorkflow's normal from-scratch drive
    // entirely, the same way a fresh process reading the persisted row after
    // a restart would find it.
    const priorVerifiedAt = '2026-09-15T00:00:00.000Z';
    const seededRun: WorkflowRunState = {
      runId: 'run-1',
      workflowId: definition.workflowId,
      status: 'in_progress',
      checkpoints: [
        { stepId: 'write-1', status: 'verified', entityIds: {}, verifiedFields: { appliedObjectId: 'id-AS_94041-prior' }, verifiedAt: priorVerifiedAt },
      ],
      resolvedParameters: {},
      version: 1,
      createdAt: priorVerifiedAt,
      updatedAt: priorVerifiedAt,
    };
    sessionState.workflowRun = seededRun;
    // write-1's digest was already consumed by the pre-crash attempt — realistic
    // prior state, though findNextIndependentStep already skips write-1 purely
    // because it has a checkpoint, independent of this.
    sessionState.consumedMetaWriteManifestDigests = { [digestFor('94041')]: priorVerifiedAt };

    let outcome = await advanceIndependentWorkflow(SESSION_ID, definition);
    // step_verified/step_failed both mean "keep going" for this driver — see
    // advanceIndependentWorkflow's own header.
    while (outcome.kind === 'step_verified' || outcome.kind === 'step_failed') {
      outcome = await advanceIndependentWorkflow(SESSION_ID, definition);
    }

    expect(outcome.kind).toBe('completed');
    // write-1 was NEVER re-dispatched on resume — only the two genuinely
    // unattempted steps ran.
    expect(createCalls.sort()).toEqual(['AS_94043', 'AS_94536']);
    expect(createCalls).not.toContain('AS_94041');
    // The final persisted state still carries write-1's ORIGINAL pre-crash
    // checkpoint, untouched, alongside the two new ones — not a fresh
    // re-verification that would prove it re-ran.
    expect(sessionState.workflowRun.checkpoints).toHaveLength(3);
    const write1Checkpoint = sessionState.workflowRun.checkpoints.find((c: any) => c.stepId === 'write-1');
    expect(write1Checkpoint.verifiedAt).toBe(priorVerifiedAt);
    expect(write1Checkpoint.verifiedFields.appliedObjectId).toBe('id-AS_94041-prior');
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
    const result = await service.submitApprovalDeckAnswers(SESSION_ID, 'deck-vincent-1', answers, 'user');

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
