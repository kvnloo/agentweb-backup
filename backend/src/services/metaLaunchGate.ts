/**
 * ENG-941 — enforcement side of the Meta launch tracking gate.
 *
 * `metaTrackingPreflight` decides whether a destination is measurable; this module
 * decides *when* to ask, gathers the inputs, records the outcome, and shapes the
 * block. Kept out of agentModeService (already ~473KB) so the gate is unit-testable
 * on its own, the same separation ENG-335 uses.
 *
 * Where this hooks in matters more than the check itself. Gating only the two named
 * launch tools would leave the gate bypassable: `callMetaMarketingApi` is a typed
 * write path that can flip a campaign, ad set or ad to ACTIVE directly, so a model
 * could route around a tool-level gate simply by choosing the other tool. A safety
 * gate you can walk around is not a safety gate, so the predicate below is applied
 * at that shared write path.
 *
 * Not gateable from here, stated rather than implied: a human activating a campaign
 * directly in Meta Ads Manager. Nothing we control sees that.
 */
import { metaService } from './metaService';
import { chatbotDb } from './chatbotService';
import { preflightMetaTrackingGate } from './metaTrackingPreflight';

/** Entity types whose activation actually starts (or resumes) paid delivery. */
const SPEND_ENTITIES = new Set(['CAMPAIGN', 'AD_SET', 'AD']);
/** Actions that can carry a status transition. */
const SPEND_ACTIONS = new Set(['CREATE', 'UPDATE']);

export interface MetaGateCredentials {
  accountId: string;
  accessToken: string;
}

export interface MetaMeasurementCheckRecord {
  accountId: string;
  campaignId?: string;
  action: string;
  outcome: 'passed' | 'blocked' | 'overridden';
  urlResults: Array<{ url: string; status: string; mechanisms: string[]; error?: string }>;
  checkedAt: string;
}

/**
 * True only for a write that would put paid delivery live. All three terms are
 * required: the entity has to be one that spends, the action has to be one that can
 * carry a status, and the status being set has to be ACTIVE. Anything looser would
 * block ordinary Meta work (creative uploads, audience syncs, reads); anything
 * tighter would let spend start ungated.
 */
export function isMetaSpendStartingWrite(entityType: string, action: string, params: any): boolean {
  if (!params || typeof params !== 'object') return false;
  if (!SPEND_ENTITIES.has(entityType)) return false;
  if (!SPEND_ACTIONS.has(action)) return false;
  return String(params.status ?? '').toUpperCase() === 'ACTIVE';
}

/**
 * Run the gate for one launch.
 *
 * Failure to *verify* is not permission to proceed (AC4). If the ad list or the
 * pixel list can't be read, the launch is blocked as "could not verify" rather than
 * assumed measured — the opposite choice is how spend starts against tracking nobody
 * ever checked.
 */
export async function runMetaTrackingGate(
  creds: MetaGateCredentials,
  campaignId: string | undefined,
  action: string,
  override: boolean,
  sessionId?: string,
): Promise<{ proceed: boolean; blockResult?: any }> {
  const { accountId, accessToken } = creds;

  let destinationUrls: string[] = [];
  let pixelIds: string[] = [];
  try {
    const [ads, pixels] = await Promise.all([
      metaService.listAdsForUtmAudit(accountId, accessToken, campaignId),
      metaService.listPixels(accountId, accessToken),
    ]);
    destinationUrls = (ads ?? []).flatMap((a: any) => a?.destinationUrls ?? []).filter(Boolean);
    pixelIds = (pixels ?? []).map((p: any) => String(p?.id)).filter((id: string) => id && id !== 'undefined');
  } catch (err: any) {
    const message =
      `Launch blocked: could not verify Meta tracking for this campaign (${err?.message || err}). ` +
      `A pre-flight that cannot complete is treated as unmeasured, never as measured — relaunch once the check can run, ` +
      `or use an explicit tracking-check override if you accept the risk.`;
    await record(sessionId, {
      accountId, campaignId, action, outcome: override ? 'overridden' : 'blocked',
      urlResults: [], checkedAt: new Date().toISOString(),
    });
    if (override) return { proceed: true };
    return {
      proceed: false,
      blockResult: { success: false, blocked: true, reason: 'tracking_preflight', error: message, trackingCheck: { measured: false, urlResults: [] } },
    };
  }

  // A campaign with nothing serving yet (e.g. created before its ads exist) has no
  // destination to measure. Same call ENG-335 makes for a campaign with no final URLs.
  if (destinationUrls.length === 0) return { proceed: true };

  const gate = await preflightMetaTrackingGate(destinationUrls, pixelIds);
  const urlResults = gate.results.map(r => ({ url: r.url, status: r.status, mechanisms: r.mechanisms, error: r.error }));

  if (gate.ok) {
    await record(sessionId, { accountId, campaignId, action, outcome: 'passed', urlResults, checkedAt: new Date().toISOString() });
    return { proceed: true };
  }
  if (override) {
    await record(sessionId, { accountId, campaignId, action, outcome: 'overridden', urlResults, checkedAt: new Date().toISOString() });
    return { proceed: true };
  }
  await record(sessionId, { accountId, campaignId, action, outcome: 'blocked', urlResults, checkedAt: new Date().toISOString() });
  return {
    proceed: false,
    blockResult: {
      success: false,
      blocked: true,
      reason: 'tracking_preflight',
      error: gate.message,
      trackingCheck: { measured: false, urlResults },
    },
  };
}

/** Audit trail is best-effort: losing the record must never break or block a launch. */
async function record(sessionId: string | undefined, rec: MetaMeasurementCheckRecord): Promise<void> {
  try {
    await chatbotDb.recordMetaMeasurementCheck(sessionId || '', rec);
  } catch (err) {
    console.error('[META GATE] Failed to record measurement check:', err);
  }
}

/** Test seam — the gate is otherwise reached through agentModeService. */
export const _runMetaTrackingGateForTest = runMetaTrackingGate;
