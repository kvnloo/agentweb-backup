/**
 * ENG-1635 — the manifest PRODUCER: replays the Phoenix Tech regression this
 * ticket was filed against (2026-08-26/27, session b32ec8af…) — "A complete
 * campaign approval currently becomes 12 serial prompts. Phoenix felt blocked
 * after already saying yes." ENG-1642 only ever shipped the grant CONSUMER
 * (claimMetaWriteManifestGrant); nothing built the manifest question itself.
 * This proves the producer (buildMetaWriteManifestQuestion) now does, and that
 * ONE resulting approval grants every listed write.
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
      recordMetaWriteManifestOutcome: jest.fn(),
      updateSessionAskUserQuestion: jest.fn(),
    },
  };
});

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { applyAnswer } from '../services/agentMode/core/askUserQuestion';

const ACCOUNT = '448692064923397'; // Phoenix Tech's real ad account id
const SESSION_ID = 'sess-phoenix-manifest';
const AD_COUNT = 12; // the exact count Phoenix hit before the fix

let service: AgentModeService;

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'tok' });
  jest.spyOn(service as any, 'updateMetaAdsAd').mockResolvedValue({ success: true, message: 'ad updated' });
});

async function previewAd(adId: string) {
  return service.callMetaMarketingApi(
    'user-1', 'AD' as any, 'UPDATE', ACCOUNT, 'campaign-1', 'adset-1', adId,
    { status: 'ACTIVE' }, SESSION_ID,
  );
}

describe('ENG-1635 manifest producer — Phoenix 12-prompt regression', () => {
  it('replays Phoenix: 12 halted writes in one iteration become ONE manifest question, not 12 prompts', async () => {
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
    }
    // All 12 digests must be distinct (different ad_id each) — a manifest that
    // silently collapsed them would authorize the wrong count of writes.
    expect(new Set(previews.map((p) => p.metaWriteManifestDigest)).size).toBe(AD_COUNT);

    // This is the loop-seam call: the same shape agentModeService's iteration
    // loop builds from toolCalls.slice(...).map(...) before trying the manifest
    // producer, ahead of the old per-item collectConfirmationPrompt fallback.
    const iterationResults = previews.map((result) => ({ status: 'success' as const, result }));
    const manifestQuestion = (service as any).buildMetaWriteManifestQuestion(iterationResults);

    expect(manifestQuestion).not.toBeNull();
    expect(manifestQuestion.kind).toBe('meta_write_manifest');
    expect(manifestQuestion.status).toBe('awaiting');
    expect(manifestQuestion.options).toHaveLength(2);
    const approve = manifestQuestion.options.find((o: any) => o.id === 'approve');
    const reject = manifestQuestion.options.find((o: any) => o.id === 'reject');
    expect(approve.recommended).toBe(true);
    expect(approve.payload.digests).toHaveLength(AD_COUNT);
    expect(approve.payload.digests.sort()).toEqual(previews.map((p) => p.metaWriteManifestDigest).sort());
    expect(reject.payload.digests).toBeUndefined();
    // The rendered question names every one of the 12 targets, once each — the
    // human-readable content Phoenix would actually see, just under ONE card.
    expect((manifestQuestion.question.match(/\n\d+\. /g) || []).length).toBe(AD_COUNT);

    // One approval — replay every one of the 12 original calls unconfirmed
    // (exactly what Emma would re-issue) and prove every single one executes
    // with ZERO further halts, i.e. one "yes" really did authorize all twelve.
    const answered = applyAnswer(manifestQuestion, {
      optionId: 'approve', delegated: false, answeredBy: 'user', at: new Date().toISOString(),
    });
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingUserQuestion: answered,
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
      confirmationDetail: 'Update ad ad-1.',
    };
    const nonMetaHalt = {
      // e.g. an image-edit confirmation — carries no digest at all.
      awaitingUserConfirmation: true,
      confirmationDetail: 'Regenerate 2 images.',
    };
    const result = (service as any).buildMetaWriteManifestQuestion([
      { status: 'success', result: metaHalt },
      { status: 'success', result: nonMetaHalt },
    ]);
    expect(result).toBeNull();
  });

  it('falls back to null for a single Meta write — no manifest wrapper needed for one item', () => {
    const result = (service as any).buildMetaWriteManifestQuestion([
      { status: 'success', result: { awaitingUserConfirmation: true, metaWriteManifestDigest: 'digest-1', confirmationDetail: 'x' } },
    ]);
    expect(result).toBeNull();
  });

  it('falls back to null when nothing halted this iteration', () => {
    const result = (service as any).buildMetaWriteManifestQuestion([
      { status: 'success', result: { success: true, message: 'read-only, nothing to confirm' } },
    ]);
    expect(result).toBeNull();
  });
});
