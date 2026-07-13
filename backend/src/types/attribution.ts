/**
 * AttributionTouch — forward-compatible shape for signup/login attribution.
 *
 * Stored as firstTouch + lastTouch JSON blobs on User today. Designed so
 * migrating to a dedicated UserTouches timeline table is pure insert, no
 * data loss: each blob becomes one row.
 */
export interface AttributionTouch {
  /** ISO timestamp of the touch */
  timestamp: string;
  /** Standard UTM params */
  utm?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
  };
  /** Ad platform click IDs */
  clickIds?: {
    gclid?: string;
    fbclid?: string;
    ttclid?: string;
    liFatId?: string;
  };
  /** document.referrer at capture time */
  referrer?: string;
  /** Full URL (incl. query string) the user first landed on */
  landingUrl?: string;
  /** Client-generated session ID (unused today, reserved for timeline upgrade) */
  sessionId?: string;
  /** Internal ref code (lead magnet, partner, etc.) */
  ref?: string;
  /** Open bag for any additional tracking params (ttclid, msclkid, custom partner params) */
  extraParams?: Record<string, string>;
}

/**
 * Normalize a raw request payload into an AttributionTouch.
 * Accepts either the new `attribution` shape or the legacy flat `utm` shape.
 *
 * ⚠️ A returned touch does NOT mean the visit was attributed. `timestamp` is
 * stamped unconditionally, so any payload at all — including one carrying no UTMs
 * and no click ids — yields a truthy AttributionTouch whose `utm` is undefined.
 * That is deliberate (a direct/organic visit is still a first touch worth
 * recording), but it means callers must NOT treat "normalizeAttribution returned
 * something" as "we know where this lead came from". Check `touch.utm?.source`.
 * See LeadAttributionFields in utils/leadSchema.ts for the full warning.
 */
export function normalizeAttribution(payload: unknown): AttributionTouch | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;

  // Legacy: flat utm_* keys at the top level
  if (
    !p.utm && !p.clickIds && !p.timestamp &&
    (p.utm_source || p.utm_medium || p.utm_campaign || p.utm_content || p.utm_term)
  ) {
    return {
      timestamp: new Date().toISOString(),
      utm: {
        source: asStr(p.utm_source),
        medium: asStr(p.utm_medium),
        campaign: asStr(p.utm_campaign),
        content: asStr(p.utm_content),
        term: asStr(p.utm_term),
      },
    };
  }

  const utm = (p.utm && typeof p.utm === 'object') ? p.utm as Record<string, unknown> : {};
  const clickIds = (p.clickIds && typeof p.clickIds === 'object') ? p.clickIds as Record<string, unknown> : {};
  const extra = (p.extraParams && typeof p.extraParams === 'object') ? p.extraParams as Record<string, unknown> : {};

  const touch: AttributionTouch = {
    timestamp: asStr(p.timestamp) || new Date().toISOString(),
  };
  const utmNorm = {
    source: asStr(utm.source) || asStr(p.utm_source),
    medium: asStr(utm.medium) || asStr(p.utm_medium),
    campaign: asStr(utm.campaign) || asStr(p.utm_campaign),
    content: asStr(utm.content) || asStr(p.utm_content),
    term: asStr(utm.term) || asStr(p.utm_term),
  };
  if (Object.values(utmNorm).some(Boolean)) touch.utm = pruneUndef(utmNorm);

  const clickNorm = {
    gclid: asStr(clickIds.gclid) || asStr(p.gclid),
    fbclid: asStr(clickIds.fbclid) || asStr(p.fbclid),
    ttclid: asStr(clickIds.ttclid) || asStr(p.ttclid),
    liFatId: asStr(clickIds.liFatId) || asStr(p.li_fat_id),
  };
  if (Object.values(clickNorm).some(Boolean)) touch.clickIds = pruneUndef(clickNorm);

  if (asStr(p.referrer)) touch.referrer = asStr(p.referrer);
  if (asStr(p.landingUrl)) touch.landingUrl = asStr(p.landingUrl);
  if (asStr(p.sessionId)) touch.sessionId = asStr(p.sessionId);
  if (asStr(p.ref)) touch.ref = asStr(p.ref);

  const extraPruned: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    const s = asStr(v);
    if (s) extraPruned[k] = s;
  }
  if (Object.keys(extraPruned).length > 0) touch.extraParams = extraPruned;

  // If we captured absolutely nothing, return undefined so callers can skip the write
  const hasAny =
    touch.utm || touch.clickIds || touch.referrer || touch.landingUrl ||
    touch.sessionId || touch.ref || touch.extraParams;
  return hasAny ? touch : undefined;
}

function asStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function pruneUndef<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
