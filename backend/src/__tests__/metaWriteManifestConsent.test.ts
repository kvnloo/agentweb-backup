/**
 * ENG-1642 — manifest consent: an approved deployment manifest authorizes its
 * exact Meta writes without re-confirmation.
 *
 * Exercises callMetaMarketingApi's unconfirmed-write path against a mocked
 * chatbotDb session so the manifest-grant seam (claimMetaWriteManifestGrant)
 * is proven end to end, matching the metaLaunchGateWiring.test.ts pattern.
 */
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

function manifestQuestion(digests: string[], overrides: Partial<Record<string, any>> = {}) {
  return {
    questionId: 'q-manifest-1',
    question: 'Approve deployment manifest?',
    kind: 'meta_write_manifest',
    immutable: false,
    allowEmmaDecide: false,
    status: 'answered',
    createdAt: new Date().toISOString(),
    options: [
      {
        id: 'approve',
        label: 'Approve',
        consequence: 'Authorizes the listed writes.',
        recommended: true,
        why: 'Reviewed manifest.',
        payload: { digests },
      },
      { id: 'reject', label: 'Reject', consequence: 'No writes authorized.', payload: {} },
    ],
    recommendedOptionId: 'approve',
    answer: { optionId: 'approve', delegated: false, answeredBy: 'user', at: new Date().toISOString() },
    ...overrides,
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

describe('ENG-1642 manifest consent', () => {
  it('AC1: a granted digest executes without a confirmation halt', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingUserQuestion: manifestQuestion([digest]),
    });
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(true);

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBeUndefined();
    expect(chatbotDb.claimMetaWriteManifestDigest).toHaveBeenCalledWith(SESSION_ID, digest);
    expect((service as any).updateMetaAdsAd).toHaveBeenCalled();
  });

  it('AC2: a call not in the grant (different param) still halts and confirms', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingUserQuestion: manifestQuestion([digest]),
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
      pendingUserQuestion: manifestQuestion([digest]),
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
      pendingUserQuestion: manifestQuestion([digest]),
    });
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(false);

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBe(true);
    expect((service as any).updateMetaAdsAd).not.toHaveBeenCalled();
  });

  it('AC4: a manifest card answered by nothing (unanswered/no card) grants nothing', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: SESSION_ID });

    const res: any = await invoke();

    expect(res.awaitingUserConfirmation).toBe(true);
    expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
  });

  it('AC5: a granted call never implies override_tracking_check', async () => {
    const digest = digestForCall(call.params);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      pendingUserQuestion: manifestQuestion([digest]),
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
