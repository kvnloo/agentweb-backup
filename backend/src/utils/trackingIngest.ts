import { classifyTraffic, type TrafficClassification } from './trafficSource';
import { resolveIngestSessionIdentity, type SessionIdentity } from './sessionList';
import { isPlausibleListId } from './trackingConfig';

/**
 * ENG-2315: parsing + row-building for the PUBLIC tracker ingest (POST /api/track/event).
 *
 * The body comes straight from an anonymous visitor's browser, so nothing in it is trusted:
 *   - only a fixed allow-list of keys is ever read (an unknown key is ignored, never stored),
 *     so the set of customFields keys a list can ever acquire is fixed and bounded (createLead
 *     adds every new key to the list's `fieldNames`, a per-list schema an attacker must not grow);
 *   - every string is length-capped and character-filtered with the same `clean()` discipline as
 *     the DramaBreak LP route this productises; every number is clamped; a wrong type is dropped,
 *     not coerced into something that could surprise a downstream reader;
 *   - classification is NOT read from the body: the SDK sends the raw signals (landing URL,
 *     referrer) and the server classifies with utils/trafficSource and overwrites the result.
 * Pure: no I/O and no clock (the caller passes `nowMs`/`nowIso`).
 */

export const INGEST_EVENTS = [
  'lp_view', 'play_start', 'episode_complete', 'gate_view', 'app_cta_click', 'lead_submit', 'click', 'page_exit', 'custom',
] as const;
export type IngestEvent = (typeof INGEST_EVENTS)[number];

/** Funnel order, used only to sanity-check `furthestStage` (a client value) against known stages. */
const FUNNEL_STAGES: ReadonlySet<string> = new Set(['lp_view', 'play_start', 'episode_complete', 'gate_view', 'app_cta_click', 'lead_submit']);

const VISITOR_ID_RE = /^[a-z0-9-]{8,64}$/i;
const CUSTOM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const PROP_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Same discipline as the LP route's clean(): cap, then drop anything outside a conservative alphabet. */
export const clean = (v: unknown, n = 120): string =>
  typeof v === 'string' ? v.slice(0, n).replace(/[^\w.@+:\-/ ]/g, '') : '';

/** URLs keep their full structure (the classifier parses the query) and lose only what could break markup/logs. */
const cleanUrl = (v: unknown, n: number): string =>
  typeof v === 'string' ? v.slice(0, n).replace(/[\u0000-\u001f\u007f<>"`\\]/g, '') : '';
const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s);

const cleanFree = (v: unknown, n: number, alphabet: RegExp): string => (typeof v === 'string' ? v.slice(0, n).replace(alphabet, '') : '');

/** Integer in [min, max], or undefined when the value is not a finite number / numeric string. */
export function int(v: unknown, min: number, max: number): number | undefined {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^-?\d{1,16}(\.\d{1,6})?$/.test(v)) n = Number(v);
  else return undefined;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export interface ParsedIngest {
  listId: string;
  identity: SessionIdentity;
  event: IngestEvent;
  /** Present for event === 'custom': the slug the page chose. */
  customName?: string;
  /** Cleaned, whitelisted client scalars (no classification, no server time). */
  client: Record<string, string | number>;
  landingUrl: string;
  referrer: string;
  firstTouchLanding: string;
}

export type IngestParseResult =
  | { ok: true; value: ParsedIngest }
  | { ok: false; code: string; message: string };

const fail = (code: string, message: string): IngestParseResult => ({ ok: false, code, message });

export function parseIngestBody(body: unknown, nowMs: number): IngestParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid_body', 'JSON object body required');
  const b = body as Record<string, unknown>;

  if (!isPlausibleListId(b.listId)) return fail('invalid_list', 'listId is required');
  const event = typeof b.event === 'string' ? b.event : '';
  if (!(INGEST_EVENTS as readonly string[]).includes(event)) return fail('invalid_event', 'unknown event');

  // Same parser and 48h / +5min window as forward-lead, EXCEPT that a well-formed sessionStartMs outside it
  // is replaced by a stable server-derived one instead of rejected (ENG-2324: a skewed device clock must not
  // cost the session every event). Only a missing / malformed sessionId or sessionStartMs is still a 400.
  const identity = resolveIngestSessionIdentity({ sessionId: b.sessionId, sessionStartMs: b.sessionStartMs, clientNowMs: int(b.clientNowMs, 0, Number.MAX_SAFE_INTEGER) }, nowMs);
  if (!identity) return fail('invalid_session', 'sessionId and an integer sessionStartMs are required');

  let customName: string | undefined;
  if (event === 'custom') {
    if (typeof b.name !== 'string' || !CUSTOM_NAME_RE.test(b.name)) return fail('invalid_name', 'custom events need a name slug of up to 32 characters');
    customName = b.name.toLowerCase();
  }

  const client: Record<string, string | number> = {};
  const put = (k: string, v: string | number | undefined): void => {
    if (v !== undefined && v !== '') client[k] = v;
  };

  put('visitorId', typeof b.visitorId === 'string' && VISITOR_ID_RE.test(b.visitorId) ? b.visitorId : '');
  put('visitNo', int(b.visitNo, 1, 1_000_000));
  // The journey guard in db.mergeSessionLeadEvent compares this numerically and only moves forward.
  put('eventCount', int(b.eventCount, 0, 1_000_000));
  const stage = clean(b.furthestStage, 32);
  put('furthestStage', FUNNEL_STAGES.has(stage) ? stage : '');
  // Cumulative "last funnel event so far", like furthestStage: the server is stateless, so a click or a
  // page_exit that arrives after a later funnel event can only keep lastEvent right by carrying it.
  const le = typeof b.lastEvent === 'string' ? b.lastEvent : '';
  put('lastEvent', FUNNEL_STAGES.has(le) || /^custom:[a-z0-9][a-z0-9_-]{0,31}$/i.test(le) ? le : '');
  put('lpVariant', clean(b.lpVariant, 80));
  put('creativeId', clean(b.creativeId, 80));
  put('firstTouchChannel', clean(b.firstTouchChannel, 60));
  put('firstTouchReferrer', clean(b.firstTouchReferrer, 120));
  put('ep', int(b.ep, 0, 1000));
  put('journey', cleanFree(b.journey, 3000, /[^\w.+:>()[\]'&|, -]/g));

  if (event === 'page_exit') {
    put('dwellSec', int(b.dwellSec, 0, 86_400));
    put('activeSec', int(b.activeSec, 0, 86_400));
    put('videoWatchSec', int(b.videoWatchSec, 0, 86_400));
    put('maxScrollPct', int(b.maxScrollPct, 0, 100));
  }
  if (event === 'click') {
    put('lastClickLabel', clean(b.clickLabel, 80));
    put('lastClickSection', clean(b.clickSection, 40));
    put('lastClickUrl', cleanUrl(b.clickUrl, 300));
  }
  // Cumulative click state rides every event (see the SDK), so it is read from any of them.
  put('clickCount', int(b.clickCount, 0, 1_000_000));
  put('clickLog', cleanFree(b.clickLog, 6000, /[^\w.:+>()[\]'&|, -]/g));
  put('showsClicked', cleanFree(b.showsClicked, 2000, /[^\w.:'&|, -]/g));
  if (event === 'custom') {
    // One bounded blob, overwritten per custom event: per-property columns would let a caller
    // mint arbitrary new field names on the customer's list.
    const p = b.props;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const out: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(p as Record<string, unknown>).slice(0, 10)) {
        if (!PROP_KEY_RE.test(k)) continue;
        if (typeof v === 'string') out[k] = clean(v, 120);
        else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'boolean') out[k] = v;
      }
      const json = JSON.stringify(out);
      if (json !== '{}') put('lastCustomProps', json.slice(0, 500));
    }
  }

  const landingUrl = repairEscapedQuery(cleanUrl(b.landingUrl, 1000));
  const referrer = cleanUrl(b.referrer, 1000);
  const firstTouchLanding = repairEscapedQuery(cleanUrl(b.firstTouchLanding, 1000));
  return {
    ok: true,
    value: {
      listId: b.listId,
      identity,
      event: event as IngestEvent,
      customName,
      client,
      landingUrl: isHttpUrl(landingUrl) ? landingUrl : '',
      referrer: isHttpUrl(referrer) || /^android-app:\/\//i.test(referrer) ? referrer : '',
      firstTouchLanding: isHttpUrl(firstTouchLanding) ? firstTouchLanding : '',
    },
  };
}

/**
 * Undo HTML-entity damage to a shared link's query string. A link copied out of HTML arrives as
 * `?utm_source=x&amp;utm_medium=y`, and some apps then drop the `&`, leaving `x` + `amp;utm_medium=y`
 * as one value. Either way every UTM after the first is lost. Only `amp;` immediately followed by
 * a `name=` pair is rewritten, so a value that merely contains "amp" is left alone.
 */
export function repairEscapedQuery(url: string): string {
  const q = url.indexOf('?');
  if (q < 0 || !/amp;/i.test(url)) return url;
  const hashAt = url.indexOf('#', q);
  const end = hashAt < 0 ? url.length : hashAt;
  const query = url.slice(q + 1, end)
    .replace(/&?amp;(?=[A-Za-z_][\w.-]*=)/gi, '&')
    .replace(/^&+/, '');
  return url.slice(0, q + 1) + query + url.slice(end);
}

export function deviceFromUserAgent(ua: string): string {
  return /iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : 'desktop';
}

/** utm_* / ad ids exactly as they appeared on the landing URL (raw signals; not classification). */
function paramsFromLandingUrl(landingUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!landingUrl) return out;
  let q: URLSearchParams;
  try {
    q = new URL(landingUrl).searchParams;
  } catch {
    return out;
  }
  const take = (field: string, param: string, n: number): void => {
    const v = clean(q.get(param) ?? '', n);
    if (v) out[field] = v;
  };
  take('utmSource', 'utm_source', 80);
  take('utmMedium', 'utm_medium', 80);
  take('utmCampaign', 'utm_campaign', 200);
  take('utmContent', 'utm_content', 200);
  take('utmTerm', 'utm_term', 200);
  take('metaCampaignId', 'campaign_id', 40);
  take('metaAdsetId', 'adset_id', 40);
  take('metaAdId', 'ad_id', 40);
  take('fbclid', 'fbclid', 300);
  take('placement', 'placement', 80);
  return out;
}

export interface BuiltSessionRow {
  customFields: Record<string, any>;
  classification: TrafficClassification;
}

/**
 * The customFields written for one event. Server-owned fields (classification, device, page label,
 * `<event>_at`, classifierVersion) are applied LAST so a client can never supply them.
 */
export function buildSessionRow(
  p: ParsedIngest,
  ctx: { userAgent: string; pageLabel?: string; nowIso: string },
): BuiltSessionRow {
  const classification = classifyTraffic({ landingUrl: p.landingUrl, referrer: p.referrer, userAgent: ctx.userAgent });

  const fields: Record<string, any> = {
    ...paramsFromLandingUrl(p.landingUrl),
    ...p.client,
    sessionId: p.identity.sessionId,
    sessionStartMs: p.identity.sessionStartMs,
    source: 'tracker-sdk',
  };
  if (p.landingUrl) fields.landingUrl = p.landingUrl.slice(0, 300);
  if (p.referrer) fields.referrer = p.referrer.slice(0, 300);

  // Last funnel event the session reached. click and page_exit are engagement, not funnel steps
  // (the LP route did the same for click), so they never set it themselves; they carry the client's
  // cumulative value, if any, which the merge guards with eventCount.
  if (p.event === 'custom') {
    fields.lastEvent = `custom:${p.customName}`;
    fields.lastCustomName = p.customName;
    fields.custom_at = ctx.nowIso;
  } else {
    if (p.event !== 'click' && p.event !== 'page_exit') fields.lastEvent = p.event;
    fields[`${p.event}_at`] = ctx.nowIso;
  }

  // Server-classified first touch (ENG-2494). A creator's single UTM link is
  // shared across platforms, so the click's own referrer / in-app UA decides the channel. On the
  // visitor's first visit first touch IS this landing session, so it is derived from this request's own referrer and URL, never from SDK-stored state
  // left by earlier browser activity.
  // First touch reports the platform the click came FROM: the observed signal (in-app UA, then
  // referrer) outranks the link's claim, including an agency-<slug> link (last touch keeps Agency).
  // Paid links keep the link's channel: the ad platform in utm_source is the spend being attributed.
  const firstTouchOf = (c: TrafficClassification): string =>
    c.trafficType === 'paid' ? c.channel : c.detectedChannel || c.channel;
  if (p.landingUrl && p.client.visitNo === 1) {
    const ft = classifyTraffic({
      landingUrl: p.landingUrl,
      referrer: p.referrer,
      userAgent: ctx.userAgent,
    });
    // Only the session's opening event (or one that still carries an external signal) sets first
    // touch; a later in-session event (internal referrer, no in-app UA) must not overwrite it with
    // Direct. Dropping the keys leaves the stored value untouched (the merge is per-key SET).
    const opening = Number(p.client.eventCount ?? 0) <= 1 || Boolean(ft.referrerHost || ft.detectedChannel);
    if (opening) {
      fields.firstTouchChannel = firstTouchOf(ft);
      if (ft.referrerHost) fields.firstTouchReferrer = ft.referrerHost; else delete fields.firstTouchReferrer;
    } else {
      delete fields.firstTouchChannel;
      delete fields.firstTouchReferrer;
    }
  } else if (p.firstTouchLanding) {
    // The SDK stores only the first referrer's HOST (the platforms mostly send origin-only anyway),
    // which is all the referrer rules use.
    const ftHost = typeof p.client.firstTouchReferrer === 'string' ? p.client.firstTouchReferrer.toLowerCase() : '';
    const ft = classifyTraffic({
      landingUrl: p.firstTouchLanding,
      referrer: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ftHost) ? `https://${ftHost}/` : '',
      userAgent: ctx.userAgent,
    });
    fields.firstTouchChannel = firstTouchOf(ft);
  }

  fields.trafficType = classification.trafficType;
  fields.channel = classification.channel;
  fields.channelKey = classification.channelKey;
  fields.channelGroup = classification.channelGroup;
  fields.classifierVersion = classification.classifierVersion;
  if (classification.linkChannel) fields.linkChannel = classification.linkChannel; else delete fields.linkChannel;
  if (classification.detectedChannel) fields.detectedChannel = classification.detectedChannel; else delete fields.detectedChannel;
  fields.device = deviceFromUserAgent(ctx.userAgent);
  if (classification.referrerHost) fields.referrerHost = classification.referrerHost; else delete fields.referrerHost;
  if (classification.sourceLink) fields.sourceLink = classification.sourceLink; else delete fields.sourceLink;
  if (classification.sourceDetail) fields.sourceDetail = classification.sourceDetail; else delete fields.sourceDetail;
  if (ctx.pageLabel) fields.page = ctx.pageLabel;

  return { customFields: fields, classification };
}
