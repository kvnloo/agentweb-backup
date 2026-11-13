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

/**
 * Launches that put NO PRE-EXISTING AD live, so the completeness of the campaign's ad list
 * cannot change their verdict.
 *
 * A CAMPAIGN or AD_SET CREATE makes an empty container: whatever it is created as, it holds
 * zero ads at the moment it is created and can send traffic nowhere. The two ENG-600 launch
 * flows are the same shape — `executeAudienceCampaignLaunch` creates an audience, optionally a
 * lookalike, and one ad set, and no ads at all.
 *
 * They are listed here because the ad-list truncation block below is about ads this launch
 * would ACTIVATE, and these activate none. Blocking them on a truncated read refused a launch
 * over ads it was never going to touch, and the remedy the block offers — "narrow the launch to
 * a single ad" — cannot be followed for an entity that does not exist yet. An AD CREATE is
 * deliberately NOT here: it does create something that serves, and when its destination is not
 * on the request the campaign's ad list is what the check falls back on.
 *
 * Scope boundary, stated rather than implied: this only lifts the TRUNCATION block. These
 * launches are still checked against the campaign's readable destinations, which is the
 * pre-existing (and separately arguable) behaviour, unchanged here.
 */
/*
 * Actions that activate no PRE-EXISTING ad, so the completeness of the ad list says nothing
 * about them and must not block them (see the truncation check below).
 *
 * ⚠ `CAMPAIGN_CREATE` looks dead and is not. The usual CAMPAIGN CREATE never reaches that check:
 * `resolveMetaActivationCampaignId` returns the caller's `campaignId` untouched for a CAMPAIGN
 * entity, so a create arrives with it undefined and is blocked earlier by the no-campaign guard.
 * But nothing rejects a `campaign_id` supplied alongside a CAMPAIGN CREATE — and when one is,
 * the check IS reached, and this entry is what correctly lets it through. Removing it on a
 * reachability argument would turn a stray-but-harmless argument into a blocked launch.
 */
/**
 * The ad-list read budget for a LAUNCH, as opposed to an ordinary list read.
 *
 * metaService's 45s ceiling is right for a background read, where stopping early costs a warning
 * and nothing else. Here an incomplete read REFUSES the action, and a campaign large enough to
 * cross the bound crosses it every time — so that campaign could not be launched at all without
 * waving away a safety warning on every attempt. A toll booth, not a guard.
 *
 * A launch is precisely where waiting is worth it: the user asked for it, is waiting on it, and
 * it is about to spend their money. Lives here rather than in metaService because it is a policy
 * of this gate, not a property of the read.
 */
export const META_LAUNCH_READ_MAX_MS = 240_000;

/**
 * Budget for the destination pre-flight, kept SEPARATE from the read budget above.
 *
 * The two phases must not share one wall. Sharing it bounds the total correctly and then starves
 * whichever phase runs second: a 200s ad read left the pre-flight 40s, so a launch with a dozen
 * destinations came back mostly `unverifiable` and was BLOCKED — a launch that would have
 * succeeded before any of this, because the pre-flight simply took the time it needed. Trading a
 * request that might overrun for a launch that certainly fails is the wrong trade.
 *
 * Separate budgets bound the total by construction instead: 240s of reads + 240s of pre-flight
 * = 480s worst case, inside the 600s nginx `proxy_read_timeout` / ALB `IdleTimeout`, with margin.
 * Neither phase can starve the other, and neither can run away. The optional server-side hint
 * carries a third, small budget (META_LAUNCH_HINT_MAX_MS) so the totals stay 240 + 240 + 60 =
 * 540s — still inside 600s once every phase is counted, which the original two-phase arithmetic
 * did not do.
 */
export const META_LAUNCH_PREFLIGHT_MAX_MS = 240_000;

/**
 * Budget for the optional server-side-activity hint appended to a block.
 *
 * Deliberately small: it explains a decision that has already been made and can never change the
 * outcome, so it is the first thing that should be given up. Keeps the gate's worst case at
 * 240 + 240 + 60 = 540s, inside the 600s nginx/ALB ceiling.
 */
export const META_LAUNCH_HINT_MAX_MS = 60_000;

const NO_EXISTING_ADS_ACTIONS = new Set([
  'CAMPAIGN_CREATE',
  'AD_SET_CREATE',
  'TARGETED_AUDIENCE_LAUNCH',
  'RETARGETING_LAUNCH',
]);

export interface MetaGateCredentials {
  accountId: string;
  accessToken: string;
}

export interface MetaGateDeps {
  /**
   * Does this pixel show recent activity in Meta's own stats? Injectable for tests.
   * Used ONLY to explain a block, never to lift one — see serverSideHint below.
   */
  pixelHasRecentActivity?: (pixelId: string, accessToken: string, deadlineAt?: number) => Promise<boolean>;
  /**
   * Read the click destinations off an existing ad creative. Injectable for tests.
   * Must throw (never return empty) when the creative cannot be read — an unreadable
   * destination has to reach the caller as a failure to verify, not as "nothing there".
   */
  resolveCreativeDestinations?: (creativeId: string, accessToken: string) => Promise<string[]>;
  /**
   * Fetch the served HTML for a destination pre-flight check. Threaded straight through to
   * `preflightMetaTrackingGate`'s own `MetaPreflightDeps.fetchHtml` (ENG-1909) — this gate
   * used to call it with a hardcoded `{}`, so there was no way for a caller to override it.
   * A sandbox (evaluation) account's ads point at fictional/example.invalid destinations, so
   * the default real outbound fetch is meaningless for them; the caller injects a
   * dataset-backed answer instead. Left undefined, the destination check is byte-for-byte
   * unchanged from before this field existed — the real `defaultFetchHtml` runs.
   */
  fetchHtml?: (url: string, deadlineAt?: number) => Promise<string>;
}

/** How far back counts as "recent" when explaining a block. */
const ACTIVITY_WINDOW_DAYS = 7;

/**
 * Per-call ceiling for the gate's own Graph reads.
 *
 * 10s was too tight for the same reason 45s was too tight on the ad list: a timeout here does not
 * degrade an answer, it REFUSES a launch. A creative that Graph is merely slow to return is
 * indistinguishable, at the call site, from one that cannot be read at all — so a slow response
 * blocked a launch over latency, on an action about to spend the user's money.
 *
 * Matched to `metaService`'s META_READ_CALL_TIMEOUT_MS so every Graph read in the launch path
 * has the same patience. Still far inside the 600s nginx/ALB ceiling.
 */
const GATE_GRAPH_CALL_TIMEOUT_MS = 30_000;

/**
 * Transport failures worth one retry. `econnaborted`/`etimedout` are the axios and Node spellings
 * of a timeout and must be here explicitly — matching only the word "timeout" misses both.
 */
export const TRANSIENT_NETWORK_RE =
  /timeout|etimedout|econnaborted|econnreset|econnrefused|enotfound|eai_again|socket hang up|network/i;

/**
 * True for a failure worth one more attempt — a transport blip, not an answer from Graph.
 *
 * ⚠ `[code, message]` joined, NOT `code || message`. axios sets `code = 'ECONNABORTED'` on a
 * timeout, so a `||` short-circuits and the message ("timeout of 30000ms exceeded") is never
 * inspected — and 'ECONNABORTED' matches none of the alternations below. The result was a retry
 * that fired for a connection reset and never for a timeout, which is the failure it was added
 * for. Verified against the installed axios.
 */
function isTransientGraphFailure(err: any): boolean {
  const status = err?.response?.status;
  if (typeof status === 'number') return status >= 500;   // 4xx is Graph answering
  return TRANSIENT_NETWORK_RE.test([err?.code, err?.message].join(' '));
}

/**
 * One retry for a transient failure, then give up.
 *
 * Deliberately not a general retry policy: a 4xx is Graph telling us the creative cannot be
 * read, and asking twice does not change that. Only a blip gets a second chance — which is the
 * difference between "we could not see this destination" (a real reason to block a launch) and
 * "the network hiccuped" (not a reason to block anything).
 */
async function withOneTransientRetry<T>(run: () => Promise<T>, deadlineAt?: number): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    if (!isTransientGraphFailure(err)) throw err;
    // Same discipline as withDriveRetry: a retry only if a full second attempt still fits.
    if (deadlineAt !== undefined && Date.now() + GATE_GRAPH_CALL_TIMEOUT_MS >= deadlineAt) throw err;
    console.log('[META GATE] retrying a transient Graph failure once:', err?.message);
    return await run();
  }
}

/* istanbul ignore next — network boundary; tests inject resolveCreativeDestinations. */
async function defaultResolveCreativeDestinations(creativeId: string, accessToken: string): Promise<string[]> {
  const axios = (await import('axios')).default;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  /*
   * ENG-1742: `effective_object_story_spec` is NOT a valid field on an AdCreative node — it is
   * an Ad-level concept (the object story spec as actually delivered, accounting for ad-level
   * overrides), and Meta refuses the whole request with a hard error when it's asked for here:
   * "(#100) Tried accessing nonexisting field (effective_object_story_spec)" — confirmed live
   * against a real production creative and ad account on 2026-09-04. That is a REQUEST failure,
   * not a "field absent from the response" one: Graph rejects the entire fields= list, so every
   * other field this call needed (including the ones that DO carry the real destination) was
   * lost with it. A creative built from a page post carrying its link only on the effective view
   * is a real case (see `object_story_spec` below), but the fix for it is not requesting a field
   * this node type does not have.
   *
   * `getAdCreative` (metaService.ts) reads this exact node type successfully with `link_url` +
   * `object_story_spec` + `asset_feed_spec` + `url_tags` — no `effective_object_story_spec`, no
   * `template_url`. Dropped both here to match: `template_url` was never separately confirmed
   * bad (Graph reports only the first invalid field in a request, so a second one can hide
   * behind it), but it is equally absent from that known-working list, and this function has no
   * documented reason of its own to need it.
   */
  /*
   * `object_story_id` requested alongside the inline shapes: a creative built by REFERENCING an
   * existing page post (as opposed to carrying `object_story_spec` inline) has no destination
   * anywhere in the fields above — the post itself, not the creative, carries the link. Without
   * following that reference this read a real creative as having no destination at all, which
   * the gate then blocked exactly like an unreadable one: correct behavior on wrong information.
   */
  const fields = 'link_url,object_story_spec,object_story_id,asset_feed_spec,url_tags';
  const url =
    `https://graph.facebook.com/${apiVersion}/${creativeId}` +
    `?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`;
  const res = await withOneTransientRetry(async () => axios.get(url, { timeout: GATE_GRAPH_CALL_TIMEOUT_MS }));
  const urls = extractDestinationUrls(res.data);
  if (urls.length > 0) return [...new Set(urls)];

  /*
   * No destination found inline, but the creative points at an existing post (format
   * "{page_id}_{post_id}") — follow it. A link-type post's destination lives on its
   * `attachments` edge, not the `link` field: `link` is deprecated for post reads —
   * confirmed live on 2026-09-04, Graph refuses it outright with
   * "(#12) deprecate_post_aggregated_fields_for_attachement" on every post, not just
   * malformed ones. `attachments{url}` is the field Meta's own News Feed / Ads rendering
   * uses for this, and it returns the real target (wrapped in an l.facebook.com redirect,
   * same shape Meta already uses elsewhere — confirmed live against a real page post).
   *
   * Not a fallback for every unreadable creative: only fires when `object_story_id` is present,
   * so a creative that truly has no destination (or genuinely fails the primary read — that
   * throws above, never reaches here) is not silently retried against the wrong node.
   */
  const objectStoryId = (res.data as any)?.object_story_id;
  if (typeof objectStoryId === 'string' && objectStoryId.trim()) {
    /*
     * The unencoded `{url}` sub-field selector is silently mangled by Graph into a flat
     * "attachmentsurl" field name and rejected — confirmed live 2026-09-04. Every other fields=
     * value in this file is a flat comma list with no braces, so this is the first place that
     * needed encoding; encodeURIComponent the whole selector rather than hand-escaping braces.
     */
    const postUrl =
      `https://graph.facebook.com/${apiVersion}/${objectStoryId}` +
      `?fields=${encodeURIComponent('attachments{url}')}&access_token=${encodeURIComponent(accessToken)}`;
    const postRes = await withOneTransientRetry(async () => axios.get(postUrl, { timeout: GATE_GRAPH_CALL_TIMEOUT_MS }));
    const attachmentUrls: string[] = ((postRes.data as any)?.attachments?.data ?? [])
      .map((a: any) => a?.url)
      .filter((u: any): u is string => typeof u === 'string' && u.trim().length > 0);
    return [...new Set(attachmentUrls)];
  }

  return [];
}

/* istanbul ignore next — network boundary; tests inject pixelHasRecentActivity. */
async function defaultPixelHasRecentActivity(pixelId: string, accessToken: string, deadlineAt?: number): Promise<boolean> {
  const axios = (await import('axios')).default;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  const since = Math.floor(Date.now() / 1000) - ACTIVITY_WINDOW_DAYS * 86400;
  const url =
    `https://graph.facebook.com/${apiVersion}/${pixelId}/stats` +
    `?aggregation=event&start_time=${since}&access_token=${encodeURIComponent(accessToken)}`;
  /*
   * Clamped to whatever remains of the CALLER's budget, not the flat GATE_GRAPH_CALL_TIMEOUT_MS.
   * This is optional explanatory text on a launch that has already been blocked — it must never
   * be the reason the request overruns the loop's own deadline. Without this, a probe starting
   * 1ms inside the deadline still ran to its own full 30s (60s with a retry).
   */
  const timeout = deadlineAt !== undefined
    ? Math.max(1_000, Math.min(GATE_GRAPH_CALL_TIMEOUT_MS, deadlineAt - Date.now()))
    : GATE_GRAPH_CALL_TIMEOUT_MS;
  const res = await withOneTransientRetry(
    async () => axios.get<{ data?: unknown[] }>(url, { timeout }),
    deadlineAt,
  );
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
/**
 * @param deadlineAt Wall-clock bound for the whole loop, not per probe.
 *
 * This is an EXPLANATION appended to a block that has already been decided — it can never
 * approve a launch — so it must never be the reason a request dies. Each probe is bounded
 * (30s, plus one retry on a transient failure = 60s) but the loop over `pixelIds` was not, and
 * `pixelIds` is bounded only by `drainCursor`'s 2,500. It also runs AFTER both the read and
 * pre-flight budgets, and only on the blocked path — where the pixels are by definition inactive,
 * so it cannot exit early.
 *
 * ~270s of reads + 240s of pre-flight + three pixels at 60s = 690s, past the 600s nginx/ALB
 * ceiling: a bare 504 instead of the block message this text was being added to. Bounding the
 * loop costs only the hint, which is optional by construction.
 */
async function serverSideHint(
  pixelIds: string[],
  accessToken: string,
  deps: MetaGateDeps,
  deadlineAt?: number,
): Promise<string> {
  const probe = deps.pixelHasRecentActivity ?? defaultPixelHasRecentActivity;
  for (const pixelId of pixelIds) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) return '';
    try {
      if (await probe(pixelId, accessToken, deadlineAt)) {
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
  /**
   * The ad an AD-entity gate decision was about.
   *
   * Added when the block messages stopped naming ids: those sentences are relayed to the user,
   * so the id had to come out of them — but it was the ONLY place the ad was ever recorded, and
   * removing it left every ad-level block in a campaign writing an identical ledger row,
   * indistinguishable even from the campaign-wide truncation block. "Emma refused to activate my
   * ad" became unanswerable. The id belongs here, server-side, not in text a customer reads.
   */
  adId?: string;
  /** The creative a creative-resolution block was about — same reasoning as `adId`. */
  creativeId?: string;
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

/**
 * Canonical identity for one Meta write approved by a manifest (ENG-1642).
 *
 * A manifest authorizes the write Meta receives, not the control-plane flags used
 * to reach it.  `confirm` and the tracking-override token are therefore removed
 * before signing; every target, action, and actual Meta parameter remains bound.
 * Child ENG-1644 uses this same digest as its pending-approval store key.
 */
export function computeMetaWriteManifestDigest(secret: string, payload: Record<string, any>): string {
  const { params, ...call } = payload;
  const { confirm: _confirm, tracking_override_token: _trackingOverrideToken, ...metaParams } =
    params && typeof params === 'object' ? params : {};
  return computeTrackingOverrideDigest(secret, { ...call, params: metaParams });
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
   * ONE launch budget for the whole gate, not one per read.
   *
   * This gate can issue TWO ad reads in a single call: the campaign-scoped one, and — when the
   * named ad is not in that campaign — an account-wide fallback. Each was given its own
   * META_LAUNCH_READ_MAX_MS, so the pair could spend 480s before creative resolution and the
   * destination pre-flight had even started. Past the 600s nginx/ALB ceiling the request is
   * killed mid-flight and the user gets a bare timeout with no message at all — strictly worse
   * than the block this budget was raised to avoid.
   *
   * At the old 45s the same shape cost 90s and stayed clear, so raising the budget is what made
   * the overrun reachable. Sharing a deadline keeps the gate's Meta reads inside one budget: the
   * fallback gets whatever the first read left, and if that is nothing it reports truncated,
   * which the block messages already handle.
   */
  const gateDeadlineAt = Date.now() + META_LAUNCH_READ_MAX_MS;
  /** Budget still available to a Meta read in this gate call; floored so it is never <= 0. */
  const remainingLaunchBudgetMs = () => Math.max(1_000, gateDeadlineAt - Date.now());

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
      /*
       * Each resolve is bounded (30s, plus one retry on a transient failure) but the LOOP was
       * not: a launch referencing several creatives multiplied that budget by however many there
       * were, on top of whatever the ad reads had already spent. Same composition problem as the
       * two ad reads. (This loop runs BEFORE the ad reads, not after — the earlier wording said
       * "one phase later", which described the order wrongly even though the hazard is the same.)
       *
       * Out of budget is treated exactly as an unreadable creative, because that is what it is:
       * we did not read it. The existing block message and the override both apply unchanged.
       */
      if (Date.now() >= gateDeadlineAt) {
        failure = 'the launch pre-flight ran out of its time budget before this creative could be read';
      } else {
        try {
          urls = (await resolve(creativeId, accessToken)) ?? [];
        } catch (err: any) {
          /*
           * ENG-1742: `err.message` on a raw axios failure is Axios's own generic text
           * ("Request failed with status code 400") — never Meta's actual reason. Meta's real
           * error body lives at `err.response.data.error` (message/code/error_subcode/
           * error_user_msg), and nothing here ever read it: neither the user-facing block
           * message nor the server log. A creative that reads back fine through every other
           * path but 400s here was, at investigation time, undiagnosable — even server-side.
           * Log the full body so a future occurrence is diagnosable, and prefer Meta's own
           * words for the user-facing reason when it has any to give.
           */
          const metaErr = err?.response?.data?.error;
          if (metaErr) {
            console.error(`[META GATE] creative destination resolve failed for ${creativeId}:`, {
              status: err?.response?.status,
              message: metaErr.message,
              type: metaErr.type,
              code: metaErr.code,
              error_subcode: metaErr.error_subcode,
              error_user_msg: metaErr.error_user_msg,
              fbtrace_id: metaErr.fbtrace_id,
            });
          } else {
            console.error(`[META GATE] creative destination resolve failed for ${creativeId}:`, err?.message || err);
          }
          failure = metaErr?.error_user_msg || metaErr?.message || err?.message || String(err);
        }
      }
      if (failure || urls.length === 0) {
        const message =
          // No raw id: same rule as the sibling blocks in this function, which had theirs
          // removed. The creative is the one named in this request, so "the ad creative" is
          // unambiguous; the id goes to the ledger row below.
          `Launch blocked: could not verify where the requested ad creative sends people` +
          // Graph's own error text, masked: it can name the object ("Object with ID '120...'
          // does not exist"), and it is relayed to the user like everything else here.
          `${failure ? ` (${failure.replace(/\d{8,}/g, '[id]')})` : ' — the creative reported no destination URL'}. ` +
          `An ad whose destination cannot be read is treated as unmeasured, never as measured. ` +
          `Retry once the creative can be read, inline the destination on the request, or use an ` +
          `explicit tracking-check override if you accept the risk.`;
        await record(sessionId, {
          accountId, campaignId, ...(adId && { adId }), creativeId, action,
          outcome: override ? 'overridden' : 'blocked',
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
      accountId, campaignId, ...(adId && { adId }), action, outcome: override ? 'overridden' : 'blocked',
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
  /*
   * Whether the ad read that fed `destinationUrls` covered the whole campaign. A bounded read
   * (page cap or wall-clock) returns a PARTIAL ad list, and this gate's whole job is deciding
   * from that list what a launch would send traffic to. Concluding "nothing to measure" — or
   * "everything I measured was fine" — from a list that stopped early is inferring safety from
   * an incomplete lookup, the move AC4 forbids everywhere else here.
   */
  let adsTruncated = false;
  let accountWideTruncated = false;
  let destinationCameFromRequest = false;
  try {
    const [{ items: ads, truncated: adsListTruncated }, { pixels }] = await Promise.all([
      /*
       * The LAUNCH budget, not the ordinary read budget.
       *
       * A truncated read here refuses the launch rather than degrading an answer, and a campaign
       * big enough to cross the 45s ceiling crosses it on every attempt — so the user could not
       * launch that campaign at all without overriding a safety warning every single time. The
       * campaign is not too big to read; we were not giving it long enough. Reading it takes
       * longer than a list call should, and for an action that spends the user's money and that
       * they are actively waiting on, that is the right trade.
       */
      metaService.listAdsForUtmAudit(accountId, accessToken, campaignId, { maxMs: remainingLaunchBudgetMs() }),
      metaService.listPixels(accountId, accessToken),
    ]);
    adsTruncated = !!adsListTruncated;
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
    // Recorded for the truncation check below: when the destination came from the REQUEST, the
    // ad list did not decide anything and its completeness is irrelevant.
    destinationCameFromRequest = fromRequest.length > 0;
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
      accountId, campaignId, ...(adId && { adId }), action, outcome: override ? 'overridden' : 'blocked',
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
      const { items: accountWide, truncated: accountWideListTruncated } =
        await metaService.listAdsForUtmAudit(accountId, accessToken, undefined as any, { maxMs: remainingLaunchBudgetMs() });
      accountWideTruncated = !!accountWideListTruncated;
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
    /*
     * "Not found in a partial search" is not "not there". But the two reads that could have
     * stopped short answer DIFFERENT questions, so a single `adsTruncated || accountWideTruncated`
     * flag made the message describe a read that had not stopped at all — the ENG-1636 failure
     * again, a pre-flight naming a remedy that does not match the real reason.
     *
     * `adsTruncated` is the CAMPAIGN-scoped list. When that stops short, nothing here knows the
     * ad is absent from the campaign, and narrowing to the containing ad set is a real remedy —
     * a smaller read can finish where the campaign-wide one could not.
     *
     * `accountWideTruncated` is the fallback that looks for the ad anywhere in the account, and
     * it only runs when the campaign-scoped read already came back WITHOUT the ad. So when the
     * campaign read was complete (`truncated: false`) and only the fallback truncated, the
     * collapsed flag reported "the ad list for campaign X was too large to read completely" about
     * a read that completed, told the user to narrow to an ad set that does not contain the ad,
     * and suppressed the one accurate sentence — that the ad may belong to a different campaign.
     * Narrowing the request cannot help when the ad is not in this campaign at all.
     */
    /*
     * No raw Meta ids in this text.
     *
     * `error` is read by the model and relayed to the user, so an id interpolated here surfaces
     * in the product as `ad 120210000000000000` — which the user cannot act on and should not be
     * shown. The ad and campaign are the ones the caller named in this very request, so "the ad"
     * and "this campaign" are unambiguous without them.
     *
     * Nothing is lost for debugging — but only because `adId` was ADDED to the ledger record in
     * the same change. It was not there before: `MetaMeasurementCheckRecord` carried only
     * `accountId`/`campaignId`, and `blockResult` carries no ids at all, so taking the id out of
     * the prose without adding it here would have erased the ad from every trace we keep.
     */
    const message = adsTruncated
      ? `Launch blocked: could not verify Meta tracking for the requested ad. The ad list for this ` +
        `campaign could not be read completely — it may have hit a size bound, a time bound, or a ` +
        `failed page — so the ad was not necessarily absent; it may simply not have been reached. ` +
        `Supply the destination on the request, retry if the read failed transiently, or use an ` +
        `explicit tracking-check override.`
      : accountWideTruncated
        ? `Launch blocked: could not verify Meta tracking because the requested ad was not found in ` +
          `this campaign, and the account-wide search for it was too large to read completely, so where ` +
          `it does live could not be established. The ad this launch would activate may belong to a ` +
          `different campaign. Retry with the campaign that actually contains the ad, supply the ` +
          `destination on the request, or use an explicit tracking-check override.`
        : `Launch blocked: could not verify Meta tracking because the requested ad was not found in ` +
          `this campaign. The ad this launch would activate may belong to a different campaign, so the ` +
          `check cannot tell where it sends people. Retry with the campaign that actually contains the ad, ` +
          `supply the destination on the request, or use an explicit tracking-check override.`;
    await record(sessionId, {
      accountId, campaignId, ...(adId && { adId }), action, outcome: override ? 'overridden' : 'blocked',
      urlResults: [], checkedAt: new Date().toISOString(),
    });
    if (override) return { proceed: true };
    return {
      proceed: false,
      blockResult: { success: false, blocked: true, reason: 'tracking_preflight', error: message, trackingCheck: { measured: false, urlResults: [] } },
    };
  }
  /*
   * Campaign/ad-set-level activation puts EVERY ad in scope live at once, so it is judged on
   * the whole campaign's destinations. A truncated ad list means some of those ads were never
   * read: passing here would clear a launch whose unread ads may point at unmeasurable pages,
   * and an empty `destinationUrls` may just be the pages we never fetched. Ad-level activation
   * is unaffected — it is judged on that ad's own destination, which was either found or
   * handled by the not-found branch above.
   */
  /*
   * `adId` is supplied only for an AD-entity write, so it is undefined for EVERY create — including
   * an AD CREATE that carries its own destination in the request, and the audience/ad-set launch
   * path that passes no adId at all. Gating on `!adId` alone therefore blocked creates whose
   * destination was fully checkable, and told them to "activate a single ad instead", which cannot
   * be done for an entity that does not exist yet.
   *
   * The completeness of the ad list only matters when the ad list is what the decision rests on.
   * It does not when the destination came from the request (`destinationCameFromRequest`), and it
   * does not when the launch activates no pre-existing ad at all (`NO_EXISTING_ADS_ACTIONS`) —
   * the audience-launch path and a plain AD_SET/CAMPAIGN CREATE, which the paragraph above named
   * as victims but which the `destinationCameFromRequest` escape does not actually cover, because
   * `executeAudienceCampaignLaunch` passes no `pendingDestinations` argument at all.
   */
  if (!adId && adsTruncated && !destinationCameFromRequest && !NO_EXISTING_ADS_ACTIONS.has(action)) {
    const message =
      `Launch blocked: could not verify Meta tracking because the ad list for this campaign could ` +
      `not be read completely, even with the extended launch read budget (${Math.round(META_LAUNCH_READ_MAX_MS / 1000)}s), ` +
      `so some ads in this launch were never checked. Tell the user the campaign is unusually ` +
      `large or Meta is responding slowly, and that this is why it is taking longer than normal. ` +
      `Retry once — a slow or failed page often succeeds on a second attempt. If it blocks again, ` +
      `the remaining options are: supply the destination on the request (link_url) for an AD ` +
      `CREATE, so the check runs against it instead of the ad list; or an explicit tracking-check ` +
      `override, accepting that some ads have not been checked. Activating a single ad does not ` +
      `start a campaign or ad set, and campaign/ad-set UPDATEs carry no destination of their own.`;
    // No `adId` spread here: this branch is guarded by `!adId`, so it could only ever be absent.
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

  /*
   * Its OWN budget, started here — deliberately not `gateDeadlineAt`.
   *
   * Sharing the read budget meant a slow ad read starved the pre-flight and turned "we could not
   * check in time" into a block on a launch that was fine. See META_LAUNCH_PREFLIGHT_MAX_MS: the
   * two budgets are sized so their sum stays inside the infra ceiling, so bounding each phase
   * separately costs nothing and removes the starvation.
   *
   * Destinations still not reached within THIS budget come back `unverifiable`, which is honest
   * and blocks as any other unverifiable does — but that now takes a genuinely pathological
   * number of distinct destinations rather than merely a slow ad list.
   */
  const gate = await preflightMetaTrackingGate(
    destinationUrls, pixelIds, { fetchHtml: deps.fetchHtml }, Date.now() + META_LAUNCH_PREFLIGHT_MAX_MS,
  );
  const urlResults = gate.results.map(r => ({ url: r.url, status: r.status, mechanisms: r.mechanisms, error: r.error }));

  if (gate.ok) {
    await record(sessionId, { accountId, campaignId, ...(adId && { adId }), action, outcome: 'passed', urlResults, checkedAt: new Date().toISOString() });
    return { proceed: true };
  }
  if (override) {
    await record(sessionId, { accountId, campaignId, ...(adId && { adId }), action, outcome: 'overridden', urlResults, checkedAt: new Date().toISOString() });
    return { proceed: true };
  }
  await record(sessionId, { accountId, campaignId, ...(adId && { adId }), action, outcome: 'blocked', urlResults, checkedAt: new Date().toISOString() });
  /*
   * A small, explicit budget of its own — this is explanatory text on an already-decided block,
   * and the request must reach the user with that block rather than dying while we embellish it.
   * Sized so the gate's worst case stays inside the infra ceiling: 240s reads + 240s pre-flight
   * + 60s hint = 540s, under 600s.
   */
  const hint = await serverSideHint(pixelIds, accessToken, deps, Date.now() + META_LAUNCH_HINT_MAX_MS);
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
