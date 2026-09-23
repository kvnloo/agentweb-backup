/**
 * ENG-1635/1644 follow-up: cross-TURN retry-backstop TRANSPARENCY for a Meta
 * write that keeps failing Meta-side validation.
 *
 * Found live: an ad-set create that failed Meta-side validation ("Budget Is
 * Too Low" for the account's currency) got silently re-proposed identically,
 * turn after turn (each turn triggered by a real user "Approve" click on the
 * resulting deck), with zero explanation ever shown. The model's own in-turn
 * anti-loop detector (MAX_CONSECUTIVE_REPEATS / the sliding-window check,
 * same file) never caught it, because each retry is only ONE iteration per
 * turn — there's never two identical tool-call signatures WITHIN one turn to
 * trip that detector. This is a genuinely separate, cross-turn case.
 *
 * An EARLIER version of this fix hard-blocked dispatch once a target had
 * failed twice, replacing the turn with a code-authored stop message. Found
 * live, re-verifying that exact fix, that this could silently refuse a
 * genuinely corrected, would-succeed 3rd attempt too — the signature is
 * TARGET identity (entity+action+campaign/ad-set), not exact params, so a
 * real budget correction still matches the same "blocked" target. That
 * trades one failure mode (silent identical retry) for a worse one (silently
 * refusing a good attempt) — reverted same day (Manan: "make sure being
 * overly cautious... does not impact quality or behavior negatively
 * anywhere").
 *
 * Current design: NEVER blocks dispatch. Once a target has failed at/past the
 * threshold, the NEXT approval card for that same target is annotated with
 * the failure history (a code-level guarantee, independent of whether the
 * model mentions it in its own prose) — the user always sees the context and
 * decides for themselves, every time, with zero risk of a legitimate attempt
 * being silently refused.
 */

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { settingsService } from '../services/settingsService';

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../services/db', () => ({
  ...jest.requireActual('../services/db'),
  taskTemplateDb: {
    getAllTemplates: jest.fn().mockResolvedValue([]),
    getPublishedTemplates: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../utils/secretsManager');

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  },
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: { update: jest.fn() },
}));

const AD_SET_DISPATCH = {
  entity_type: 'AD_SET',
  action: 'CREATE',
  account_id: '1916400978974090',
  campaign_id: '6992830887577',
};
// Mirrors AgentModeService.computeMetaWriteTargetSignature's join exactly —
// entity_type:action:account_id:campaign_id:ad_set_id:ad_id.
const AD_SET_SIGNATURE = 'AD_SET:CREATE:1916400978974090:6992830887577::';

const metaToolCall = {
  id: 'tc1',
  type: 'function',
  function: {
    name: 'call_meta_marketing_api',
    arguments: JSON.stringify({
      entity_type: AD_SET_DISPATCH.entity_type,
      action: AD_SET_DISPATCH.action,
      account_id: AD_SET_DISPATCH.account_id,
      campaign_id: AD_SET_DISPATCH.campaign_id,
      // A genuinely DIFFERENT (corrected) budget from whatever failed before —
      // the point of several of these tests is that this must still be shown
      // and approvable, never silently refused just because the TARGET matches.
      params: { name: 'Holiday Gift Guide Shoppers - US', daily_budget: 10000 },
    }),
  },
};

function writeHaltResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    requiresConfirmation: true,
    awaitingUserConfirmation: true,
    confirmationPrompt: 'Create a NEW ad set "Holiday Gift Guide Shoppers - US"...',
    summary: 'Create a NEW ad set "Holiday Gift Guide Shoppers - US"...',
    target: { campaign: 'Holiday Gift Guide Promo 2026' },
    metaWriteManifestDigest: 'digest-abc',
    metaWriteDispatch: { ...AD_SET_DISPATCH, params: { name: 'Holiday Gift Guide Shoppers - US', daily_budget: 10000 } },
    ...overrides,
  };
}

describe('AgentModeService - Meta write retry-backstop transparency (ENG-1635/1644 follow-up)', () => {
  let service: AgentModeService;
  let executeToolSpy: jest.SpyInstance;

  function mockSession(lastFailedMetaWrite: { signature: string; error: string; count: number; at: string } | null) {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: 'test-session',
      userId: 'test-user',
      messages: [],
      workPlan: null,
      ...(lastFailedMetaWrite ? { lastFailedMetaWrite } : {}),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();

    mockSession(null);
    (chatbotDb.addMessageToSession as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.incrementCalledFunctions as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.incrementFailedFunctions as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.updateSessionApprovalDeck as jest.Mock) = jest.fn().mockResolvedValue({});
    (chatbotDb.updateSessionLastFailedMetaWrite as jest.Mock) = jest.fn().mockResolvedValue({});
    (settingsService.getSetting as jest.Mock) = jest.fn().mockResolvedValue(null);

    service = new AgentModeService();

    jest.spyOn(service as any, 'callLLM').mockImplementation(async () => {
      return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [metaToolCall] }, finish_reason: 'tool_calls' }] };
    });

    executeToolSpy = jest.spyOn(service as any, 'executeTool').mockResolvedValue(writeHaltResult());
  });

  it('NEVER blocks dispatch — a fresh, genuinely different 3rd attempt against the same target is still built into a real approval deck', async () => {
    mockSession({ signature: AD_SET_SIGNATURE, error: 'Your ad set budget must be more than ₹94.91 or your ads may not deliver.', count: 2, at: '2026-09-18T16:16:50.200Z' });

    await service.generateMarketingResponse(
      'create the ad set again with a higher budget',
      [],
      'test-user',
      service.default_model,
      'test-session',
    );

    // The whole point: dispatch is NEVER refused just because the target has
    // a failure streak. The deck is built exactly as it would be otherwise.
    expect(chatbotDb.updateSessionApprovalDeck).toHaveBeenCalledTimes(1);
  });

  it('annotates the built deck item with the failure history when at/past the threshold', async () => {
    mockSession({ signature: AD_SET_SIGNATURE, error: 'Your ad set budget must be more than ₹94.91 or your ads may not deliver.', count: 2, at: '2026-09-18T16:16:50.200Z' });

    await service.generateMarketingResponse(
      'create the ad set again',
      [],
      'test-user',
      service.default_model,
      'test-session',
    );

    const deckArg = (chatbotDb.updateSessionApprovalDeck as jest.Mock).mock.calls[0][1];
    const question: string = deckArg.items[0].question;
    expect(question).toContain('already failed 2 time(s) in a row');
    expect(question).toContain('budget must be more than ₹94.91');
    // The original halt text is still present underneath the warning — this
    // is an annotation, not a replacement.
    expect(question).toContain('Holiday Gift Guide Shoppers - US');
  });

  it('does NOT annotate below the threshold — one automatic retry gets no extra noise on the card', async () => {
    mockSession({ signature: AD_SET_SIGNATURE, error: 'Budget too low.', count: 1, at: '2026-09-18T16:11:14.330Z' });

    await service.generateMarketingResponse(
      'create the ad set again',
      [],
      'test-user',
      service.default_model,
      'test-session',
    );

    const deckArg = (chatbotDb.updateSessionApprovalDeck as jest.Mock).mock.calls[0][1];
    expect(deckArg.items[0].question).not.toContain('already failed');
  });

  it('does NOT annotate a write against a different target, even past the threshold', async () => {
    mockSession({ signature: 'AD_SET:CREATE:1916400978974090:different-campaign::', error: 'Some other failure.', count: 5, at: '2026-09-18T16:11:14.330Z' });

    await service.generateMarketingResponse(
      'create the ad set again',
      [],
      'test-user',
      service.default_model,
      'test-session',
    );

    const deckArg = (chatbotDb.updateSessionApprovalDeck as jest.Mock).mock.calls[0][1];
    expect(deckArg.items[0].question).not.toContain('already failed');
  });

  it('does NOT annotate when there is no prior failure recorded at all', async () => {
    mockSession(null);

    await service.generateMarketingResponse(
      'create the ad set',
      [],
      'test-user',
      service.default_model,
      'test-session',
    );

    const deckArg = (chatbotDb.updateSessionApprovalDeck as jest.Mock).mock.calls[0][1];
    expect(deckArg.items[0].question).not.toContain('already failed');
  });
});
