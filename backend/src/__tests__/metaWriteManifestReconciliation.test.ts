/**
 * ENG-1635 — read back, reconcile, one result: replays the Vincent Hu / Smart
 * Water Heater regression (2026-09-10, session 6a320867…) — a 20-ad-set batch
 * got ONE display-batched confirmation prompt, one "yes," then all 20
 * individually-gated writes failed identically (a CBO bid-strategy default
 * conflict), Meta rate-limited mid-diagnosis, and there was no persisted-state
 * resume: Emma had to manually rebuild the ad set from scratch. This proves a
 * manifest-granted batch with a MIX of success and failure now produces ONE
 * reconciled result (partially_applied, naming every exact failure) instead of
 * N scattered, unreconciled pass/fail tool messages.
 *
 * Uses a stateful session double (not a one-shot mock) because reconciliation
 * genuinely depends on outcomes accumulating across calls — recordMetaWriteManifestOutcome
 * writes into it, getChatSession reads it back, exactly like the real DynamoDB row.
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
    },
  };
});

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { computeMetaWriteManifestDigest } from '../services/metaLaunchGate';
import { getJwtSecret } from '../config/jwt';
import { applyAnswer, buildPendingUserQuestion } from '../services/agentMode/core/askUserQuestion';

const ACCOUNT = '2041725529929988'; // Vincent Hu's TriCityAI ad account id
const CAMPAIGN = '120249715770410073';
const SESSION_ID = 'sess-vincent-manifest';

let service: AgentModeService;
/** In-memory stand-in for the DynamoDB session row's manifest fields. */
let sessionOutcomes: Record<string, any>;
let manifestQuestion: any;

function zipCallParams(zip: string) {
  return { entity_type: 'AD_SET', action: 'CREATE', account_id: ACCOUNT, campaign_id: CAMPAIGN, ad_set_id: undefined, ad_id: undefined, params: { name: `AS_${zip}`, optimization_goal: 'OFFSITE_CONVERSIONS' } };
}

function digestFor(zip: string) {
  const c = zipCallParams(zip);
  return computeMetaWriteManifestDigest(getJwtSecret(), { entity_type: c.entity_type, action: c.action, account_id: ACCOUNT, campaign_id: c.campaign_id, ad_set_id: c.ad_set_id, ad_id: c.ad_id, params: c.params });
}

async function createAdSet(zip: string) {
  const c = zipCallParams(zip);
  return service.callMetaMarketingApi('user-1', c.entity_type as any, c.action, c.account_id, c.campaign_id, c.ad_set_id, c.ad_id, c.params, SESSION_ID);
}

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'tok' });

  sessionOutcomes = {};
  const digests = ['94041', '94043', '94536'].map(digestFor);
  manifestQuestion = applyAnswer(
    buildPendingUserQuestion({
      questionId: 'q-manifest-vincent',
      question: 'Approve 3 ad sets?',
      kind: 'meta_write_manifest',
      immutable: true,
      allowEmmaDecide: false,
      createdAt: new Date().toISOString(),
      options: [
        { id: 'approve', label: 'Approve all 3', consequence: 'x', recommended: true, why: 'x', payload: { digests } },
        { id: 'reject', label: 'Reject', consequence: 'x', payload: {} },
      ],
    }),
    { optionId: 'approve', delegated: false, answeredBy: 'user', at: new Date().toISOString() },
  );

  (chatbotDb.getChatSession as jest.Mock).mockImplementation(async () => ({
    sessionId: SESSION_ID,
    pendingUserQuestion: manifestQuestion,
    metaWriteManifestOutcomes: { ...sessionOutcomes },
  }));
  (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValue(true);
  (chatbotDb.recordMetaWriteManifestOutcome as jest.Mock).mockImplementation(async (_sessionId: string, digest: string, outcome: any) => {
    sessionOutcomes[digest] = outcome;
  });
});

describe('ENG-1635 reconciliation — Vincent Hu partial-failure regression', () => {
  it('a batch with one real Meta-side failure reconciles to partially_applied, naming the exact failure, on whichever write finishes last', async () => {
    // Mirrors the actual session: Meta accepted 94041 and 94536, but rejected
    // 94043 with "Invalid parameter" the way the CBO bid-strategy conflict did.
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      if (params?.name === 'AS_94043') {
        return { success: false, error: 'Invalid parameter', message: 'Invalid parameter' };
      }
      return { success: true, message: `Ad set "${params?.name}" created successfully`, adSet: { id: `id-${params?.name}` }, readBackVerified: true };
    }) as any);

    const results = [];
    for (const zip of ['94041', '94043', '94536']) {
      results.push(await createAdSet(zip));
    }

    // Every one of the 3 executed (no halts) — the grant covered all of them.
    for (const r of results) expect(r.awaitingUserConfirmation).toBeUndefined();

    // Reconciliation must appear on exactly one of the three results (the last
    // one to complete), never on none and never duplicated on more than one.
    const withReconciliation = results.filter((r) => r.manifestReconciliation);
    expect(withReconciliation).toHaveLength(1);

    const recon = withReconciliation[0].manifestReconciliation;
    expect(recon.manifestStatus).toBe('partially_applied');
    expect(recon.items).toHaveLength(3);

    const failed = recon.items.filter((i: any) => i.status === 'failed');
    const applied = recon.items.filter((i: any) => i.status === 'applied');
    expect(failed).toHaveLength(1);
    expect(applied).toHaveLength(2);
    expect(failed[0].error).toBe('Invalid parameter');
    // Both successful creates are individually named with their real object ids —
    // the "exact accounting" ENG-1635 requires instead of Vincent Hu's scattered mess.
    expect(applied.map((i: any) => i.appliedObjectId).sort()).toEqual(['id-AS_94041', 'id-AS_94536'].sort());
  });

  it('all writes failing reconciles to unapplied, not partially_applied', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: false, error: 'Invalid parameter' });

    const results = [];
    for (const zip of ['94041', '94043', '94536']) {
      results.push(await createAdSet(zip));
    }
    const recon = results.find((r) => r.manifestReconciliation)?.manifestReconciliation;
    expect(recon.manifestStatus).toBe('unapplied');
    expect(recon.items.every((i: any) => i.status === 'failed')).toBe(true);
  });

  it('all writes succeeding reconciles to fully_applied', async () => {
    jest.spyOn(service as any, 'manageMetaAdsAdSets').mockImplementation((async (..._args: unknown[]) => {
      const params: any = _args[5];
      return { success: true, message: 'created', adSet: { id: `id-${params?.name}` } };
    }) as any);

    const results = [];
    for (const zip of ['94041', '94043', '94536']) {
      results.push(await createAdSet(zip));
    }
    const recon = results.find((r) => r.manifestReconciliation)?.manifestReconciliation;
    expect(recon.manifestStatus).toBe('fully_applied');
    expect(recon.items.every((i: any) => i.status === 'applied')).toBe(true);
  });
});
