import { adsMetricsDb } from './adsMetricsDb';

export const textValue = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const fieldKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

export function normalizeLandingUrl(value: string): string {
  if (!value || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

/** Preferred touch wins per field; malformed values never hide a valid fallback. */
export function attributionValues(lead: Record<string, any>, repeat: boolean): Map<string, string> {
  const values = new Map<string, string>();
  const put = (key: string, value: unknown) => {
    if (textValue(value)) values.set(fieldKey(key), textValue(value));
  };
  if (isRecord(lead.customFields)) Object.entries(lead.customFields).forEach(([k, v]) => put(k, v));
  put('utm_source', lead.utmSource);
  put('utm_medium', lead.utmMedium);
  if (isRecord(lead.clickIds)) Object.entries(lead.clickIds).forEach(([k, v]) => put(k, v));
  const touches = repeat ? [lead.firstTouch, lead.lastTouch] : [lead.lastTouch, lead.firstTouch];
  for (const touch of touches) {
    if (!isRecord(touch)) continue;
    for (const bag of ['extraParams', 'clickIds', 'utm']) {
      if (!isRecord(touch[bag])) continue;
      Object.entries(touch[bag]).forEach(([k, v]) => put(bag === 'utm' ? `utm_${k}` : k, v));
    }
    for (const key of ['landingUrl', 'referrer']) put(key, touch[key]);
  }
  return values;
}

/** Read-only enrichment. Misses, ambiguity, and unavailable storage retain submitted values. */
export async function resolveNotificationNames(userId: string, values: Map<string, string>, submittedAt: string, accounts?: unknown) {
  const get = (...keys: string[]) => keys.map(k => values.get(fieldKey(k)) || '').find(Boolean) || '';
  const result = { landingName: get('landingPageName', 'landingPageTitle'),
    landingUrl: normalizeLandingUrl(get('landingUrl', 'landingPageUrl')),
    campaign: get('campaignName', 'utm_campaign', 'campaignId', 'campaign', 'utm_id'),
    adSet: get('adSetName', 'adSetId', 'utm_term'),
    ad: get('adName', 'adId', 'utm_content') };
  const adIds = [...new Set(['adId', 'utm_content', 'utm_term'].map(k => get(k)).filter(id => /^\d+$/.test(id)))];
  const campaignIds = [get('campaignId'), get('utm_campaign'), get('utm_id')].filter(Boolean);
  const deadline = Date.now() + 2000;
  const enrich = async () => {
    await Promise.all([
      (async () => {
        if (!result.landingUrl && !get('landingPageId', 'lpId')) return;
        try {
          const { getLandingPagesByOwner } = await import('./v0Service');
          const raw: unknown = await getLandingPagesByOwner(userId);
          const pages = Array.isArray(raw) ? raw.filter(isRecord).filter(p => p.userId === userId) : [];
          const pageId = get('landingPageId', 'lpId');
          const urlPath = (url: string) => {
            try { const u = new URL(url); return u.origin + u.pathname.replace(/\/$/, ''); } catch { return ''; }
          };
          const matches = pages.filter(p => pageId ? p.id === pageId :
            ['customDomainUrl', 'deployedUrl'].some(k => {
              const url = normalizeLandingUrl(textValue(p[k]));
              return url && urlPath(url) === urlPath(result.landingUrl);
            }));
          if (matches.length === 1) {
            result.landingName = textValue(matches[0].name) || result.landingName;
            result.landingUrl ||= normalizeLandingUrl(textValue(matches[0].customDomainUrl) || textValue(matches[0].deployedUrl));
          }
        } catch { /* Enrichment must not drop a notification. */ }
      })(),
      (async () => {
        if (!campaignIds.length) return;
        const at = new Date(submittedAt);
        if (!Number.isFinite(at.getTime())) return;
        try {
          const since = new Date(at.getTime() - 30 * 86400000).toISOString().slice(0, 10);
          const raw: unknown = await adsMetricsDb.getSnapshotsByUserDateRange(userId, since, at.toISOString().slice(0, 10));
          if (!isRecord(raw) || raw.truncated !== false || !Array.isArray(raw.rows)) return;
          const rows = raw.rows.filter(isRecord).filter(r => r.userId === userId && r.rowType === 'campaign' &&
            campaignIds.some(id => id === textValue(r.campaignId) || id === textValue(r.campaignName)) &&
            textValue(r.entityKey) && textValue(r.campaignName));
          // The same name/UTM may identify campaigns in multiple ad accounts. Never guess.
          if (new Set(rows.map(r => r.entityKey)).size !== 1) return;
          rows.sort((a, b) => textValue(b.date).localeCompare(textValue(a.date)));
          result.campaign = textValue(rows[0].campaignName);
        } catch { /* Keep the original campaign identifier. */ }
      })(),
    ]);
    // Ads are provider-owned records (there is no AW-Ads name directory). Only
    // the persisted org's unambiguous ad-account connection may enrich these IDs.
    const candidates = Array.isArray(accounts) ? accounts.filter(isRecord).filter(a =>
      ['meta', 'facebook'].includes(textValue(a.platform)) && isRecord(a.config) &&
      a.config.account_type === 'ad_account' && textValue(a.config.access_token) &&
      /^(act_)?\d+$/.test(textValue(a.account_id))) : [];
    if (adIds.length && candidates.length === 1) {
      const account = candidates[0];
      const accountId = textValue(account.account_id).replace(/^act_/, '');
      for (const id of adIds) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          const fields = 'id,name,account_id,campaign{id,name},adset{id,name}';
          const response = await fetch(`https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}/${id}?fields=${encodeURIComponent(fields)}`, {
            headers: { Authorization: `Bearer ${textValue((account.config as Record<string, unknown>).access_token)}` },
            signal: AbortSignal.timeout(Math.min(1500, remaining)),
          });
          if (!response.ok) continue;
          const ad: unknown = await response.json();
          if (!isRecord(ad) || ad.id !== id || ad.account_id !== accountId || !textValue(ad.name)) continue;
          // An explicit campaign ID must agree before adopting the ad's parent names.
          const campaign = isRecord(ad.campaign) ? ad.campaign : {};
          const explicitCampaign = get('campaignId') || (/^\d+$/.test(get('utm_campaign')) ? get('utm_campaign') : '');
          if (explicitCampaign && textValue(campaign.id) !== explicitCampaign) continue;
          result.ad = textValue(ad.name);
          result.campaign = textValue(campaign.name) || result.campaign;
          if (isRecord(ad.adset)) result.adSet = textValue(ad.adset.name) || result.adSet;
          break;
        } catch { /* Provider lookup is optional and bounded; retain raw identifiers. */ }
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([enrich(), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
  } finally { clearTimeout(timer); }
  // Snapshot the result: late read completions cannot mutate a delivered message.
  const resolved = { ...result };
  // Click IDs are opaque, not ad IDs. There is no persisted click-to-ad index.
  const clicks = ['fbclid', 'gclid'].map(k => get(k) ? `${k}=${get(k)}` : '').filter(Boolean);
  if (clicks.length) resolved.ad = [resolved.ad, ...clicks].filter(Boolean).join('; ');
  return resolved;
}

export function humanizeField(key: string): string {
  const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function submittedPacific(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date) + ' PT';
}
