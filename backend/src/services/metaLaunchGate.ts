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
import { createHmac, timingSafeEqual } from 'crypto';
import { metaService } from './metaService';
import { chatbotDb } from './chatbotService';
import { preflightMetaTrackingGate } from './metaTrackingPreflight';

/** Entity types whose activation actually starts (or resumes) paid delivery. */
const SPEND_ENTITIES = new Set(['CAMPAIGN', 'AD_SET', 'AD']);
/**
 * Actions that can carry a status transition.
 *
 * COPY_AD belongs here even though it reads as a duplication: `copyMetaAdsAd` ends in
 * `status: params.status || 'PAUSED'`, so a copy requested as ACTIVE starts paid delivery
 * exactly like a CREATE does. Leaving it out made "copy this ad, live" a way past the gate.
 */
const SPEND_ACTIONS = new Set(['CREATE', 'UPDATE', 'COPY_AD']);

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
  /**
   * Read the click destinations off an existing ad creative. Injectable for tests.
   * Must throw (never return empty) when the creative cannot be read — an unreadable
   * destination has to reach the caller as a failure to verify, not as "nothing there".
   */
  resolveCreativeDestinations?: (creativeId: string, accessToken: string) => Promise<string[]>;
}

/** How far back counts as "recent" when explaining a block. */
const ACTIVITY_WINDOW_DAYS = 7;

/* istanbul ignore next — network boundary; tests inject resolveCreativeDestinations. */
async function defaultResolveCreativeDestinations(creativeId: string, accessToken: string): Promise<string[]> {
  const axios = (await import('axios')).default;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  /*
   * `effective_object_story_spec` is requested alongside the raw spec because a creative
   * built from a page post carries its link only on the effective view. `asset_feed_spec`
   * covers dynamic creatives, whose destinations are a list rather than a single link.
   */
  const fields = 'link_url,object_story_spec,effective_object_story_spec,asset_feed_spec,template_url,url_tags';
  const url =
    `https://graph.facebook.com/${apiVersion}/${creativeId}` +
    `?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await axios.get(url, { timeout: 10_000 });
  return [...new Set(extractDestinationUrls(res.data))];
}

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
/**
 * Destinations carried by the request itself, for an entity that does not exist yet.
 *
 * A CREATE cannot be checked against the ad list — there is no ad to list. Meta keeps the
 * destination on the creative, and callers reach it by several shapes depending on whether
 * they inline the creative or reference one, so all the common ones are collected. Anything
 * unrecognised simply yields nothing, and the usual rules then apply.
 */
/**
 * Keys that name a click destination on a Meta creative, anywhere in its tree.
 *
 * Enumerating whole PATHS (`object_story_spec.link_data.link`, the video CTA, the asset
 * feed…) was the previous approach and it fails silently: Meta keeps adding creative
 * shapes, and a shape nobody enumerated yields no destination, which the gate then reads
 * as "nothing to check". Matching on the KEY at any depth covers a new shape the day it
 * ships. Asset keys (`image_url`, `thumbnail_url`, `video_id`) are deliberately NOT here —
 * fetching a CDN asset would produce a block against a URL nobody is buying traffic to.
 */
const DESTINATION_KEYS = new Set([
  'link', 'link_url', 'website_url', 'destination_url', 'object_url', 'template_url',
]);

/** Every destination-shaped URL anywhere in a creative object, de-duplicated. */
function extractDestinationUrls(node: any, depth = 0): string[] {
  if (!node || typeof node !== 'object' || depth > 8) return [];
  const out: string[] = [];
  if (Array.isArray(node)) {
    for (const item of node) out.push(...extractDestinationUrls(item, depth + 1));
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (DESTINATION_KEYS.has(key.toLowerCase()) && value.trim()) out.push(value.trim());
    } else {
      out.push(...extractDestinationUrls(value, depth + 1));
    }
  }
  return out;
}

export function collectPendingDestinations(entityType: string, action: string, params: any): string[] {
  if (!params || typeof params !== 'object') return [];
  if (action !== 'CREATE' && action !== 'UPDATE' && action !== 'COPY_AD') return [];

  /*
   * A copy can retarget the new ad: `copyMetaAdsAd` reads
   * `params.link_url || params.destination || params.url` (agentModeService.ts:16191).
   * Those two aliases are read ONLY there, so they are collected only here — elsewhere the
   * write path drops them, and checking a URL the ad can never point at would block a
   * launch over a page nobody is buying traffic to.
   *
   * With no override the copy inherits the source creative's destination, and the source ad
   * IS in the ad list — so returning nothing here is correct, not a gap.
   */
  if (action === 'COPY_AD' && entityType !== 'AD') return [];
  /*
   * UPDATE is included for AD because an ad update carrying creative content (`link_url`,
   * a creative object) makes Meta build and swap in a NEW creative — so the ad list still
   * holds the destination that is about to be replaced. Checking that one answers a
   * question nobody asked. AD_SET carries no creative, so only its CREATE can introduce a
   * destination; campaigns never carry one at all.
   */
  if (entityType === 'AD_SET' && action !== 'CREATE') return [];
  if (entityType !== 'AD' && entityType !== 'AD_SET') return [];

  const out: string[] = [];
  const push = (v: any) => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };

  push(params.link_url);
  push(params.destination_url);
  /*
   * `destination` and `url` are aliases, not decoration: AgentModeService.CREATIVE_CONTENT_KEYS
   * is ['link_url', 'destination', 'url', …], so either one both TRIGGERS the creative swap
   * (agentModeService.ts:17255) and becomes the new link (17324), and copyMetaAdsAd reads the
   * same three (16191). Collected for every AD write rather than only the paths known to read
   * them today — the cost of an extra URL here is a false block on a page nobody is buying
   * traffic to, while the cost of a missing one is spend against a page never checked.
   */
  if (entityType === 'AD') {
    push(params.destination);
    push(params.url);
  }
  out.push(...extractDestinationUrls(params.creative ?? params.ad_creative));
  return [...new Set(out)];
}

/**
 * Creative ids a pending CREATE only *references* — the destination lives on the creative,
 * not in the request, and the ad does not exist yet to be listed.
 *
 * This is the documented ad-create path (`creative: { creative_id }`), so leaving it
 * unresolved meant the most ordinary way to publish an ad was also the way past the gate.
 */
export function collectPendingCreativeIds(entityType: string, action: string, params: any): string[] {
  if (action !== 'CREATE' && action !== 'UPDATE') return [];
  if (!params || typeof params !== 'object') return [];
  if (entityType !== 'AD') return [];
  const creative = params.creative ?? params.ad_creative;
  const ids = [params.creative_id, creative?.creative_id, creative?.id]
    .filter((v: any) => v !== undefined && v !== null && String(v).trim() !== '')
    .map((v: any) => String(v).trim());
  return [...new Set(ids)];
}

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
   *
   * Scope boundary worth stating: swapping the creative on an ALREADY-active ad changes where
   * live traffic lands without starting delivery, so it is not gated here. Telling a live ad
   * from a paused one needs a read this predicate deliberately does not do (it is pure, and
   * one definition of "this spends money" is worth more than covering that case here). When
   * such an UPDATE does carry status=ACTIVE, the swapped-in destination IS what gets checked.
   */
  return entityType === 'AD_SET' && action === 'CREATE';
}

/** Gate-only flags that describe the approval itself, never the write being approved. */
const OVERRIDE_DIGEST_EXCLUDED_KEYS = new Set(['confirm', 'tracking_override_token']);

/** Key-order-independent serialization, so a re-emitted JSON object digests identically. */
function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter(k => !OVERRIDE_DIGEST_EXCLUDED_KEYS.has(k)).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Sign the exact call a tracking-override preview described (ENG-941).
 *
 * The confirmation the user approves is one call; the execution is a separate one, and
 * nothing tied them together — so a model could preview a plain activation, let the user
 * approve it, and add `override_tracking_check` to the replay. The override then skipped a
 * failed measurement check with no human ever told it would.
 *
 * Same shape as ENG-600's `preview_token`: HMAC over everything that defines the write,
 * keyed with a server-only secret so the caller cannot mint one, and key-order-independent
 * so a model re-emitting the same arguments still matches. Change any argument and the
 * token stops matching — which is the intent, since the user approved *that* launch.
 */
export function computeTrackingOverrideDigest(secret: string, payload: Record<string, any>): string {
  return createHmac('sha256', secret).update(stableStringify(payload)).digest('hex');
}

/** Constant-time compare that tolerates a caller-supplied value of any shape/length. */
export function trackingOverrideTokenMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
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
  pendingDestinations: string[] = [],
  pendingCreativeIds: string[] = [],
): Promise<{ proceed: boolean; blockResult?: any }> {
  const { accountId, accessToken } = creds;

  /*
   * A CREATE that references an existing creative by id carries its destination nowhere in
   * the request, and has no ad in the list to fall back on — so it has to be resolved
   * through Graph before anything else, or the most ordinary way to publish an ad is also
   * the way past this gate.
   *
   * Both failure shapes are treated as a failure to VERIFY, not as nothing-to-check: an
   * unreadable creative, and a creative that reads back with no destination at all (which
   * means the shape was not understood, since an ad that spends has somewhere to send
   * people). AC4 again — inability to verify never converts into permission.
   */
  const resolvedFromCreatives: string[] = [];
  if (pendingCreativeIds.length > 0) {
    const resolve = deps.resolveCreativeDestinations ?? defaultResolveCreativeDestinations;
    for (const creativeId of pendingCreativeIds) {
      let urls: string[] = [];
      let failure: string | undefined;
      try {
        urls = (await resolve(creativeId, accessToken)) ?? [];
      } catch (err: any) {
        failure = err?.message || String(err);
      }
      if (failure || urls.length === 0) {
        const message =
          `Launch blocked: could not verify where ad creative ${creativeId} sends people` +
          `${failure ? ` (${failure})` : ' — the creative reported no destination URL'}. ` +
          `An ad whose destination cannot be read is treated as unmeasured, never as measured. ` +
          `Retry once the creative can be read, inline the destination on the request, or use an ` +
          `explicit tracking-check override if you accept the risk.`;
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
      resolvedFromCreatives.push(...urls);
    }
  }

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
    /*
     * `pendingDestinations` carries the destination of an ad being CREATED. It cannot come
     * from the ad list — the ad does not exist yet — so an ad created directly as ACTIVE
     * would otherwise be checked against its siblings and ship an unchecked destination.
     * That is the bypass this closes.
     */
    const fromRequest = [...(pendingDestinations ?? []), ...resolvedFromCreatives].filter(Boolean);
    /*
     * When this write names ONE ad and carries its own destination — a creative swap, most
     * often — that destination is what will actually serve after the write, and the ad list
     * still holds the OLD one. Checking the old page answers a question nobody asked: it can
     * block a swap ONTO a tracked page, or pass a swap onto an untracked one.
     */
    destinationUrls = (adId && fromRequest.length > 0)
      ? fromRequest
      : [...scoped.flatMap((a: any) => a?.destinationUrls ?? []), ...fromRequest].filter(Boolean);
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

  /*
   * A campaign with nothing serving yet (e.g. created before its ads exist) has no
   * destination to measure. Same call ENG-335 makes for a campaign with no final URLs.
   *
   * But that reasoning only holds when the check was campaign-wide. If ONE ad was named and
   * it is not in the campaign-filtered list — a COPY_AD into an ad set in another campaign,
   * or simply a stale campaign id — then the destination was not found rather than absent.
   * Passing there would be inferring safety from a lookup that failed, which is the exact
   * move AC4 forbids everywhere else in this gate.
   */
  if (adId && destinationUrls.length === 0) {
    /*
     * Before blocking, look the ad up account-wide. A COPY_AD's SOURCE ad legitimately lives
     * in another campaign — that is what copying between campaigns means — and its
     * destination is perfectly readable, so blocking on the campaign-scoped miss alone would
     * refuse a valid launch over a page we could have checked. Only pay for this wider read
     * on the miss.
     */
    try {
      const accountWide = await metaService.listAdsForUtmAudit(accountId, accessToken, undefined as any);
      const named = (accountWide ?? []).filter((a: any) => String(a?.adId) === String(adId));
      const found = named.flatMap((a: any) => a?.destinationUrls ?? []).filter(Boolean);
      if (found.length > 0) {
        destinationUrls = found;
      }
    } catch {
      // Fall through to the block below: a lookup that failed is not a lookup that passed.
    }
  }
  if (adId && destinationUrls.length === 0) {
    const message =
      `Launch blocked: could not verify Meta tracking because ad ${adId} was not found in campaign ` +
      `${campaignId}. The ad this launch would activate may belong to a different campaign, so the ` +
      `check cannot tell where it sends people. Retry with the campaign that actually contains the ad, ` +
      `supply the destination on the request, or use an explicit tracking-check override.`;
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
