/**
 * ENG-1635/1644 — the manifest PRODUCER: replays the Phoenix Tech regression
 * this ticket was filed against (2026-08-26/27, session b32ec8af…) — "A
 * complete campaign approval currently becomes 12 serial prompts. Phoenix
 * felt blocked after already saying yes." Retargeted (gap 5's Migration note)
 * at buildMetaWriteApprovalDeck — the approval-deck producer that superseded
 * buildMetaWriteManifestQuestion — and its persistence via
 * updateSessionApprovalDeck instead of updateSessionAskUserQuestion.
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
    },
  };
});

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { applyDeckAnswers, renderApprovalDeckPrompt } from '../services/agentMode/core/approvalDeck';

const ACCOUNT = '448692064923397'; // Phoenix Tech's real ad account id
const SESSION_ID = 'sess-phoenix-deck';
const AD_COUNT = 12; // the exact count Phoenix hit before the fix

let service: AgentModeService;

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'tok' });
  jest.spyOn(service as any, 'updateMetaAdsAd').mockResolvedValue({ success: true, message: 'ad updated' });
});

// Routes through extractMinimalToolResult, exactly like the real iteration loop
// (toolDispatch.ts) does before a result ever reaches buildMetaWriteApprovalDeck —
// NOT the raw callMetaMarketingApi return. Skipping the minimizer here is exactly how
// the live env1 bug (metaWriteManifestDigest silently dropped) stayed invisible to
// every test in this file despite them all passing.
async function previewAd(adId: string) {
  const raw = await service.callMetaMarketingApi(
    'user-1', 'AD' as any, 'UPDATE', ACCOUNT, 'campaign-1', 'adset-1', adId,
    { status: 'ACTIVE' }, SESSION_ID,
  );
  return (service as any).extractMinimalToolResult(raw, 'call_meta_marketing_api');
}

describe('ENG-1635/1644 approval deck producer — Phoenix 12-prompt regression', () => {
  it('replays Phoenix: 12 halted writes in one iteration become ONE approval deck, not 12 prompts', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: SESSION_ID });

    // Each preview call is independent — this is exactly what 12 different
    // ad-id UPDATE calls in one turn's tool_calls produce today.
    const previews: any[] = [];
    for (let i = 0; i < AD_COUNT; i++) {
      previews.push(await previewAd(`ad-${i}`));
    }
    expect(previews).toHaveLength(AD_COUNT);
    for (const p of previews) {
      expect(p.awaitingUserConfirmation).toBe(true);
      expect(typeof p.metaWriteManifestDigest).toBe('string');
      expect(p.metaWriteManifestDigest.length).toBeGreaterThan(0);
      expect(p.metaWriteDispatch).toBeDefined();
    }
    // All 12 digests must be distinct (different ad_id each) — a deck that
    // silently collapsed them would authorize the wrong count of writes.
    expect(new Set(previews.map((p) => p.metaWriteManifestDigest)).size).toBe(AD_COUNT);

    // This is the loop-seam call: the same shape agentModeService's iteration
    // loop builds from toolCalls.slice(...).map(...) before trying the deck
    // producer, ahead of the old per-item collectConfirmationPrompt fallback.
    const iterationResults = previews.map((result) => ({ status: 'success' as const, result }));
    const deck = (service as any).buildMetaWriteApprovalDeck(iterationResults);

    expect(deck).not.toBeNull();
    expect(deck.status).toBe('awaiting');
    expect(deck.items).toHaveLength(AD_COUNT);
    expect(deck.items.every((i: any) => i.kind === 'meta_write')).toBe(true);
    expect(deck.items.map((i: any) => i.metaWriteManifestDigest).sort()).toEqual(
      previews.map((p) => p.metaWriteManifestDigest).sort(),
    );
    // The rendered prompt names every one of the 12 targets, once each — the
    // human-readable content Phoenix would actually see, just under ONE deck.
    const prompt = renderApprovalDeckPrompt(deck);
    expect((prompt.match(/^\d+\. /gm) || []).length).toBe(AD_COUNT);

    // One submission, approving all 12 — replay every one of the 12 original
    // calls unconfirmed (exactly what Emma would re-issue) and prove every
    // single one executes with ZERO further halts, i.e. one submission really
    // did authorize all twelve.
    const answered = applyDeckAnswers(
      deck,
      deck.items.map((i: any) => ({ itemId: i.itemId, verdict: 'approve' })),
      'user',
      new Date().toISOString(),
    );
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingApprovalDeck: answered,
    });
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(true);

    const replays: any[] = [];
    for (let i = 0; i < AD_COUNT; i++) {
      replays.push(await previewAd(`ad-${i}`));
    }
    for (const r of replays) {
      expect(r.awaitingUserConfirmation).toBeUndefined();
    }
    expect((service as any).updateMetaAdsAd).toHaveBeenCalledTimes(AD_COUNT);
  });

  it('falls back to null (plain per-item prompt) when a non-Meta-write confirmation is mixed into the batch', () => {
    const metaHalt = {
      awaitingUserConfirmation: true,
      metaWriteManifestDigest: 'digest-1',
      metaWriteDispatch: { entity_type: 'AD', action: 'UPDATE', account_id: ACCOUNT, params: {} },
      confirmationDetail: 'Update ad ad-1.',
    };
    const nonMetaHalt = {
      // e.g. an image-edit confirmation — carries no digest at all.
      awaitingUserConfirmation: true,
      confirmationDetail: 'Regenerate 2 images.',
    };
    const result = (service as any).buildMetaWriteApprovalDeck([
      { status: 'success', result: metaHalt },
      { status: 'success', result: nonMetaHalt },
    ]);
    expect(result).toBeNull();
  });

  it('a SINGLE Meta write still becomes a deck (deck of one) — gap 5 Round 3: confirm=true alone can no longer carry a solo write', () => {
    const result = (service as any).buildMetaWriteApprovalDeck([
      {
        status: 'success',
        result: {
          awaitingUserConfirmation: true,
          metaWriteManifestDigest: 'digest-1',
          metaWriteDispatch: { entity_type: 'AD', action: 'UPDATE', account_id: ACCOUNT, params: {} },
          confirmationDetail: 'x',
        },
      },
    ]);
    expect(result).not.toBeNull();
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe('awaiting');
  });

  it('extractMinimalToolResult (the loop-seam minimizer) preserves metaWriteManifestDigest AND metaWriteDispatch on a halt — found live on env1 once already, not by any handler-level test', () => {
    // The minimizer between callMetaMarketingApi's return and the loop seam discards
    // any field it doesn't explicitly name (same class of bug as ENG-1526's dropped
    // approval tokens, a few lines above this one in the real file). A handler-level
    // test that calls callMetaMarketingApi directly — like every other test in this
    // suite — never exercises this function at all, which is exactly how the field
    // went missing in production while every unit test stayed green.
    const raw = {
      success: true,
      requiresConfirmation: true,
      awaitingUserConfirmation: true,
      summary: 'Create ad set X.',
      confirmationPrompt: 'Approve?',
      confirmationDetail: 'Create ad set X.',
      target: { entity_type: 'AD_SET', action: 'CREATE' },
      metaWriteManifestDigest: 'abc123digest',
      metaWriteDispatch: { entity_type: 'AD_SET', action: 'CREATE', account_id: ACCOUNT, params: { name: 'x' } },
    };
    const minimized = (service as any).extractMinimalToolResult(raw, 'call_meta_marketing_api');
    expect(minimized.metaWriteManifestDigest).toBe('abc123digest');
    expect(minimized.metaWriteDispatch).toEqual(raw.metaWriteDispatch);
    expect(minimized.awaitingUserConfirmation).toBe(true);
  });

  it('falls back to null when nothing halted this iteration', () => {
    const result = (service as any).buildMetaWriteApprovalDeck([
      { status: 'success', result: { success: true, message: 'read-only, nothing to confirm' } },
    ]);
    expect(result).toBeNull();
  });
});
