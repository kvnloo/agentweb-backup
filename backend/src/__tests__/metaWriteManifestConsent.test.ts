/**
 * ENG-1642/1635/1644 — manifest consent: an approved approval deck authorizes
 * its exact Meta writes without re-confirmation.
 *
 * Exercises callMetaMarketingApi's unconfirmed-write path against a mocked
 * chatbotDb session so the manifest-grant seam (claimMetaWriteManifestGrant,
 * now sourced from session.pendingApprovalDeck — ENG-1635/1644 gap 5's
 * Migration note) is proven end to end, matching the metaLaunchGateWiring.test.ts
 * pattern.
 */

/*
 * Jest's 5s default is not enough for these two under load, and the cause is contention rather
 * than slow code: every call here is mocked, and the only real work is an HMAC digest — work
 * measured in milliseconds. It passes alone and passed a full 1,631-suite run; it timed out in a
 * 372-suite pre-push batch where the workers were competing for CPU. A default that fails only
 * when the machine is busy is a flake that blocks every push touching a hub file, so the timeout
 * is raised to a value the assertions can survive on a loaded box.
 *
 * Deliberately NOT masking a hang: with the timeout raised the suite completes in well under a
 * second, so if these ever approach 30s something has genuinely broken and it should fail.
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
    },
  };
});

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { computeMetaWriteManifestDigest } from '../services/metaLaunchGate';
import { getJwtSecret } from '../config/jwt';

const ACCOUNT = '409853340719899';
const CAMPAIGN = '120200000000000';
const AD_SET = 'adset-1';
const AD_ID = 'ad-1';
const SESSION_ID = 'sess-manifest-1';

const call = {
  entity_type: 'AD',
  action: 'UPDATE',
  account_id: ACCOUNT,
  campaign_id: CAMPAIGN,
  ad_set_id: AD_SET,
  ad_id: AD_ID,
  params: { status: 'ACTIVE' },
};

function digestForCall(params: Record<string, any>) {
  return computeMetaWriteManifestDigest(getJwtSecret(), { ...call, params });
}

// ENG-1635/1644 gap 5's Migration note: claimMetaWriteManifestGrant's SOURCE
// moved from a pendingUserQuestion(kind='meta_write_manifest') to
// session.pendingApprovalDeck.answers — this fixture replaces the old
// manifestQuestion() helper.
function approvedDeck(digests: string[]) {
  const at = new Date().toISOString();
  return {
    deckId: 'deck-1',
    status: 'answered' as const,
    createdAt: at,
    finalizedAt: at,
    items: digests.map((digest, i) => ({
      itemId: `write-${i + 1}`,
      kind: 'meta_write',
      question: 'Approve this write?',
      metaWriteManifestDigest: digest,
      metaWriteDispatch: { ...call },
    })),
    answers: digests.map((digest, i) => ({
      itemId: `write-${i + 1}`,
      verdict: 'approve' as const,
      answeredBy: 'user' as const,
      at,
    })),
  };
}

let service: AgentModeService;

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'tok' });
  jest.spyOn(service as any, 'updateMetaAdsAd').mockResolvedValue({ success: true, message: 'ad updated' });
});

async function invoke(params: Record<string, any> = call.params) {
  return service.callMetaMarketingApi(
    'user-1', call.entity_type as any, call.action, ACCOUNT, CAMPAIGN, AD_SET, AD_ID, params, SESSION_ID,
  );
}

describe('ENG-1642/1635/1644 manifest consent', () => {
  it('AC1: a granted digest executes without a confirmation halt', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: approvedDeck([digest]),
    });
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(true);

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBeUndefined();
    expect(chatbotDb.claimMetaWriteManifestDigest).toHaveBeenCalledWith(SESSION_ID, digest);
    expect((service as any).updateMetaAdsAd).toHaveBeenCalled();
  });

  // ENG-1635 AC7/AC8 (outcome recording against a manifest-granted call) are
  // retired: dispatch through callMetaMarketingApi's manifestGranted branch
  // no longer records an outcome anywhere (see the Migration note at that
  // call site) — the normal path is submitApprovalDeckAnswers's step-per-write
  // dispatch, whose outcome lives in the workflow run's checkpoints and is
  // covered by metaWriteManifestReconciliation.test.ts instead.

  it('AC2: a call not in the grant (different param) still halts and confirms', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: approvedDeck([digest]),
    });

    const res: any = await invoke({ status: 'PAUSED' });

    expect(res.awaitingUserConfirmation).toBe(true);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
    expect((service as any).updateMetaAdsAd).not.toHaveBeenCalled();
  });

  it('AC3: a granted digest already consumed in this session re-confirms', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: approvedDeck([digest]),
      consumedMetaWriteManifestDigests: { [digest]: new Date().toISOString() },
    });

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBe(true);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });

  it('AC3b: a claim race loser (claim returns false) falls back to confirmation', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: approvedDeck([digest]),
    });
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(false);

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBe(true);
    expect((service as any).updateMetaAdsAd).not.toHaveBeenCalled();
  });

  it('AC4: no pending approval deck at all grants nothing', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: SESSION_ID });

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBe(true);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });

  it('AC4b: a deck that has NOT been answered yet (still "awaiting") grants nothing', async () => {
    const digest = digestForCall(call.params);
    const deck = approvedDeck([digest]);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: { ...deck, status: 'awaiting', answers: undefined },
    });

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBe(true);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });

  it('AC4c: a deck item the user REJECTED grants nothing', async () => {
    const digest = digestForCall(call.params);
    const deck = approvedDeck([digest]);
    (deck.answers as any) = [{ itemId: 'write-1', verdict: 'reject', answeredBy: 'user', at: new Date().toISOString() }];
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: SESSION_ID, pendingApprovalDeck: deck });

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBe(true);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });

  it('gap 5: params.confirm=true with no grant at all still halts — the raw flag is never independently sufficient', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: SESSION_ID });

    const res: any = await invoke({ ...call.params, confirm: true });

    expect(res.awaitingUserConfirmation).toBe(true);
    expect((service as any).updateMetaAdsAd).not.toHaveBeenCalled();
  });

  it('ENG-1635 AC6: a manifest digest computed against the RESOLVED account still grants a call whose raw account_id argument was omitted', async () => {
    // The manifest was built (preview time) with the resolved account id baked into the digest —
    // exactly what buildMetaWriteConfirmation's target.account_id already carries. The replay call
    // (claim time) omits account_id entirely, the common single-connected-account case. Before the
    // fix, claimMetaWriteManifestGrant hashed the raw '' argument instead of resolving credentials
    // first, so this digest would never match and the call would wrongly re-halt.
    const digest = digestForCall(call.params); // computed against ACCOUNT, the resolved id
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: approvedDeck([digest]),
    });
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(true);

    const res: any = await service.callMetaMarketingApi(
      'user-1', call.entity_type as any, call.action, '', CAMPAIGN, AD_SET, AD_ID, call.params, SESSION_ID,
    );

    expect(res.awaitingUserConfirmation).toBeUndefined();
    expect(chatbotDb.claimMetaWriteManifestDigest).toHaveBeenCalledWith(SESSION_ID, digest);
    expect((service as any).updateMetaAdsAd).toHaveBeenCalled();
  });

  it('ENG-1635 AC6b: two omitted-account_id calls that resolve to DIFFERENT real accounts do not share a digest', async () => {
    // Guards the other direction of the same bug: the raw argument must never be what collapses
    // two different real accounts onto the same digest.
    const digest = digestForCall(call.params); // computed against ACCOUNT
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: approvedDeck([digest]),
    });
    jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: 'a-different-account', accessToken: 'tok' });

    const res: any = await service.callMetaMarketingApi(
      'user-1', call.entity_type as any, call.action, '', CAMPAIGN, AD_SET, AD_ID, call.params, SESSION_ID,
    );

    expect(res.awaitingUserConfirmation).toBe(true);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });

  it('AC5: a granted call never implies override_tracking_check', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: approvedDeck([digest]),
    });
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(true);

    const res: any = await invoke();

    // The manifest grant executed the write directly (no confirmation halt),
    // so nothing here issued or consumed an override token — a grant never
    // implies override_tracking_check, it only replaces the plain-confirm halt.
    expect(res.tracking_override_token).toBeUndefined();
    expect(res.awaitingUserConfirmation).toBeUndefined();
  });
});
