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

export interface MetaGateDeps {
  /**
   * Does this pixel show recent activity in Meta's own stats? Injectable for tests.
   * Used ONLY to explain a block, never to lift one — see serverSideHint below.
   */
  pixelHasRecentActivity?: (pixelId: string, accessToken: string) => Promise<boolean>;
}

/** How far back counts as "recent" when explaining a block. */
const ACTIVITY_WINDOW_DAYS = 7;

/* istanbul ignore next — network boundary; tests inject pixelHasRecentActivity. */
async function defaultPixelHasRecentActivity(pixelId: string, accessToken: string): Promise<boolean> {
  const axios = (await import('axios')).default;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  const since = Math.floor(Date.now() / 1000) - ACTIVITY_WINDOW_DAYS * 86400;
  const url =
    `https://graph.facebook.com/${apiVersion}/${pixelId}/stats` +
    `?aggregation=event&start_time=${since}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await axios.get<{ data?: unknown[] }>(url, { timeout: 10_000 });
  return Array.isArray(res.data?.data) && res.data.data.length > 0;
}

/**
 * Build the "your pixel IS receiving events" sentence appended to a block.
 *
 * Deliberately explanatory only. `/stats` is ACCOUNT-pixel-level, not destination-level:
 * a customer with one instrumented page and one dark lander would show activity that says
 * nothing about the destination being launched at. Letting that lift a block would wave
 * through RankAI's exact incident (~$5.2k spent, zero conversion signal on the lander while
 * the account itself was not inert). So it sharpens the message and points at the override,
 * and never changes the verdict.
 *
 * Also note `last_fired_time` is NOT usable here: verified 2026-08-14 that it tracks browser
 * fires only and does not move for Conversions API events, while `/stats` does capture them.
 */
async function serverSideHint(
  pixelIds: string[],
  accessToken: string,
  deps: MetaGateDeps,
): Promise<string> {
  const probe = deps.pixelHasRecentActivity ?? defaultPixelHasRecentActivity;
  for (const pixelId of pixelIds) {
    try {
      if (await probe(pixelId, accessToken)) {
        return (
          `\nNote: this account's pixel ${pixelId} IS receiving events server-side within the last ` +
          `${ACTIVITY_WINDOW_DAYS} days. If this destination is measured through the Conversions API rather than a ` +
          `browser pixel, this check cannot see it — relaunch with an explicit tracking-check override.`
        );
      }
    } catch {
      // Best-effort explanation only. Never let it fail, and never let it pass a launch.
    }
  }
  return '';
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

  const status = String(params.status ?? '').toUpperCase();
  if (status === 'ACTIVE') return true;
  if (status) return false; // an explicit non-ACTIVE status starts nothing

  /*
   * No status given — whether that starts delivery depends on what the layer below does,
   * and the three entities do NOT agree:
   *   createCampaign → `params.status || 'PAUSED'`
   *   createAd       → `params.status || Ad.Status.paused`
   *   createAdSet    → sets status ONLY if provided, so an omitted status falls through to
   *                    META's default, which is ACTIVE.
   * So an ad set created without a status silently starts delivering. Treating a bare
   * AD_SET CREATE as spend-starting closes that bypass; the other two genuinely default to
   * paused and must not be gated, or every ordinary draft creation would block.
   *
   * UPDATE with no status changes no status, so it can never start delivery.
   */
  return entityType === 'AD_SET' && action === 'CREATE';
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
  deps: MetaGateDeps = {},
  adId?: string,
): Promise<{ proceed: boolean; blockResult?: any }> {
  const { accountId, accessToken } = creds;

  /*
   * Without a campaign id there is nothing to scope the check to. `listAdsForUtmAudit`
   * only applies its campaign filter when one is passed, so an unscoped call returns
   * EVERY ad in the account — we would fetch dozens of unrelated destinations and block
   * this launch because some other campaign's page is untracked.
   *
   * That is not a verification, so it does not get to pass as one. Same treatment as any
   * other failure to verify (AC4): block, say precisely why, and leave the override.
   */
  if (!campaignId) {
    const message =
      `Launch blocked: could not verify Meta tracking because no campaign was identified for this ` +
      `${action}. Without a campaign the check cannot tell which destinations this launch would send ` +
      `traffic to. Retry with the campaign id, or use an explicit tracking-check override.`;
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

  let destinationUrls: string[] = [];
  let pixelIds: string[] = [];
  try {
    const [ads, pixels] = await Promise.all([
      metaService.listAdsForUtmAudit(accountId, accessToken, campaignId),
      metaService.listPixels(accountId, accessToken),
    ]);
    /*
     * Activating ONE ad is judged on that ad's own destination. Checking the whole
     * campaign would block an ad whose page is fine because a sibling ad's page is not —
     * punishing someone for a problem they are not currently causing. Ad-set and campaign
     * level still check the campaign, since either can put several ads live at once.
     */
    const scoped = adId ? (ads ?? []).filter((a: any) => String(a?.adId) === String(adId)) : (ads ?? []);
    destinationUrls = scoped.flatMap((a: any) => a?.destinationUrls ?? []).filter(Boolean);
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
  const hint = await serverSideHint(pixelIds, accessToken, deps);
  return {
    proceed: false,
    blockResult: {
      success: false,
      blocked: true,
      reason: 'tracking_preflight',
      error: gate.message + hint,
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
