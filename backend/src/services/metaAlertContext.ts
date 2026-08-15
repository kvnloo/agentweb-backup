/**
 * ENG-926 §F follow-up — the context a tracking alert carries.
 *
 * The first alert this system ever filed said, in full: *"Meta ad account 1358071355944019
 * spent with zero attributed conversions."* True and worth knowing — and answering the
 * three questions it immediately raises took about ten API calls. Who is that account?
 * Why is nothing attributed? What should someone open first? Every answer was available at
 * the moment the alert fired.
 *
 * ─── What goes in, and what deliberately does not ───────────────────────────────────
 *
 * IN: things that are EXPENSIVE to derive. Mapping an ad-account id to a customer means
 * scanning users. Click-ID coverage means walking every lead. Meta's match keys require
 * knowing `/stats?aggregation=match_keys` exists at all, which is not in the obvious docs.
 *
 * OUT: things the reader already has. Code pointers, the ENG-926 card text, Meta's
 * documentation, our own architecture. Anyone opening the ticket can read the repository;
 * padding the alert with that buries the three facts that matter.
 *
 * ─── The hard constraint ────────────────────────────────────────────────────────────
 *
 * Enrichment is BEST EFFORT and must never prevent an alert. Every lookup here is wrapped
 * so that a failure drops one field rather than the whole notification. An account burning
 * money with no measurement must be reported even if every enrichment call fails — the
 * degraded alert is exactly the alert we send today, and silence is the failure mode this
 * entire card exists to eliminate.
 */

const TAG = '[Alert Context]';

/**
 * Per-lookup deadline.
 *
 * A try/catch protects against an enrichment that FAILS. It does nothing about one that
 * never settles — and `fetch` carries no default timeout, while the coverage walk paginates
 * every lead a customer has. The sweep is sequential, so one hung request would stall not
 * just this alert but every later account and every later user, silently. That is a worse
 * outcome than the missing field, and worse than the original un-enriched alert.
 */
export const ENRICHMENT_TIMEOUT_MS = 15_000;

/** How many pixels are worth diagnosing on one account. Real accounts carry one or two;
 *  the cap exists so a misconfigured account cannot turn one alert into a Graph fan-out. */
export const MAX_PIXELS_DIAGNOSED = 3;

/** Meta's own UI, deep-linked so the ticket is one click from the evidence rather than an
 *  id to copy-paste into a search box. */
export const metaDeepLinks = {
  adsManager: (adAccountId: string) =>
    `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(adAccountId)}`,
  eventsManager: (pixelId: string) =>
    `https://business.facebook.com/events_manager2/list/dataset/${encodeURIComponent(pixelId)}/overview`,
};

export interface AlertContextDeps {
  /** Click-ID coverage for this customer. Reuses §F's own AC5 computation. */
  getCoverage: (userId: string) => Promise<any>;
  /** Pixels attached to the ad account, with `last_fired_time` when Meta reports one. */
  getPixels: (adAccountId: string) => Promise<any[]>;
  /** `/stats?aggregation=match_keys` folded to `{ [event]: { [key]: count } }`. */
  getMatchKeys: (pixelId: string) => Promise<Record<string, Record<string, number>>>;
}

/** Identity parameters WE supply on an event. Everything else Meta reports as a match key
 *  is one of its own browser cookies (`fr_cookie`, `c_user_cookie`, …), which means Meta
 *  recognised a logged-in browser rather than us telling it who converted. The distinction
 *  is the whole diagnosis: it separates "Meta had nothing to match on" from "Meta matched
 *  fine and the ads simply are not converting" — two problems with opposite fixes. */
const SUPPLIED_MATCH_KEYS = new Set([
  'email', 'phone', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'db', 'ge',
  'fbc', 'fbp', 'external_id', 'client_ip_address', 'client_user_agent',
]);

/** Run one enrichment, swallowing failure. A missing field is a smaller loss than a
 *  missing alert, every time. */
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Raced against a deadline, not merely caught. A hang is the dangerous case: it stalls
    // the whole sequential sweep rather than losing one field.
    return await Promise.race([
      fn(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`${TAG} ${label} timed out after ${ENRICHMENT_TIMEOUT_MS}ms — omitting it`);
          resolve(undefined);
        }, ENRICHMENT_TIMEOUT_MS);
      }),
    ]);
  } catch (error: any) {
    console.warn(`${TAG} could not resolve ${label}: ${error?.message}`);
    return undefined;
  } finally {
    // Without this an abandoned timer keeps the event loop alive for its full duration.
    if (timer) clearTimeout(timer);
  }
}

export async function buildAlertContext(
  owner: any,
  adAccountId: string,
  days: Array<{ date: string; spend: number; conversions: number }>,
  deps: AlertContextDeps,
): Promise<Record<string, any>> {
  const context: Record<string, any> = {
    'Ad Account': adAccountId,
    'Meta Ads Manager': metaDeepLinks.adsManager(adAccountId),
  };

  // ── Who ──
  // Never spread the owner object: it carries connected_accounts, and those carry access
  // tokens. Only named fields are copied across.
  if (owner?.userId) context['Owner User Id'] = owner.userId;
  if (owner?.email) context['Owner Email'] = owner.email;
  if (owner?.company) context['Customer'] = owner.company;
  const site = owner?.website || owner?.domain;
  if (site) context['Customer Site'] = site;

  // ── The spend that triggered it ──
  if (Array.isArray(days) && days.length > 0) {
    context['Spend By Day'] = days
      .filter((d) => Number(d?.spend) > 0)
      .map((d) => `${d.date}: ${Number(d.spend).toFixed(2)} spend, ${d.conversions} conversions`)
      .join('\n');
  }

  // ── Why: the single most diagnostic number ──
  const coverage = await attempt('click-id coverage', () => deps.getCoverage(owner?.userId));
  if (coverage?.totals) {
    const { leads, withClickId } = coverage.totals;
    const pct = leads > 0 ? ((withClickId / leads) * 100).toFixed(1) : '—';
    context['Lead Click-ID Coverage'] =
      `${withClickId} of ${leads} leads carry a click ID (${pct}%)` +
      (leads > 0 && withClickId === 0
        ? ' — NO LEAD CARRIES A CLICK ID, so Meta has nothing to attribute a conversion to. ' +
          'This is the RankAI failure shape and is usually a capture problem on the lander, ' +
          'not a problem with the ads.'
        : '');
  }

  // ── What to open first ──
  const pixels = await attempt('pixels', () => deps.getPixels(adAccountId));
  if (Array.isArray(pixels) && pixels.length > 0) {
    context['Pixels On Account'] = pixels
      .map((p) =>
        `${p.id}${p.name ? ` (${p.name})` : ''} — ` +
        (p.last_fired_time ? `last fired ${p.last_fired_time}` : 'NEVER FIRED'),
      )
      .join('\n') +
      (pixels.length > 1
        ? '\nMore than one pixel on this account: if the ads are configured against one ' +
          'while events land on another, attribution fails completely and silently.'
        : '');

    // Diagnose EVERY pixel that has fired, each labelled with its id.
    //
    // Picking one — "the first with a last_fired_time" — attaches match keys and an Events
    // Manager link from a pixel that may have nothing to do with these ads. On an account
    // carrying an old site pixel alongside the campaign's, that produces a confidently
    // wrong diagnosis, which is worse than no diagnosis at all. A pixel that has NEVER
    // fired is skipped: it has nothing to report.
    const fired = pixels.filter((p) => p?.id && p.last_fired_time).slice(0, MAX_PIXELS_DIAGNOSED);
    const mostRecent = [...fired].sort((a, b) =>
      String(b.last_fired_time).localeCompare(String(a.last_fired_time)),
    )[0];
    if (mostRecent?.id) context['Meta Events Manager'] = metaDeepLinks.eventsManager(mostRecent.id);

    const sections: string[] = [];
    let anySupplied = false;
    for (const pixel of fired) {
      const matchKeys = await attempt(`match keys for ${pixel.id}`, () => deps.getMatchKeys(pixel.id));
      if (!matchKeys || Object.keys(matchKeys).length === 0) continue;
      sections.push(
        `pixel ${pixel.id}${pixel.name ? ` (${pixel.name})` : ''}:\n` +
        Object.entries(matchKeys)
          .map(([event, keys]) =>
            `  ${event}: ${Object.entries(keys).map(([k, n]) => `${k}=${n}`).join(', ')}`)
          .join('\n'),
      );
      if (Object.values(matchKeys).some((keys) => Object.keys(keys).some((k) => SUPPLIED_MATCH_KEYS.has(k)))) {
        anySupplied = true;
      }
    }

    if (sections.length > 0) {
      context['Meta Match Keys'] =
        sections.join('\n') +
        // Only claimed when NO fired pixel received identity. Asserting it off one pixel
        // while another contradicts it would be the same confident-wrong failure.
        (anySupplied
          ? ''
          : '\nNO IDENTITY WE SUPPLIED reached Meta on these events — only Meta\'s own ' +
            'browser cookies. Without fbc/fbp/email an event cannot be tied back to an ad ' +
            'click, which is why spend can show zero attributed conversions while the ' +
            'pixel still counts the event.');
    }
  }

  return context;
}

/**
 * Production wiring. Separate from the builder so its unit tests pull in neither DynamoDB
 * nor the Graph API — the same split every other §F module uses.
 */
export async function buildAlertContextForAccount(
  owner: any,
  adAccountId: string,
  accessToken: string,
  days: Array<{ date: string; spend: number; conversions: number }>,
): Promise<Record<string, any>> {
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  const graph = async (path: string, params: Record<string, string>) => {
    const qs = new URLSearchParams({ ...params, access_token: accessToken });
    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${path}?${qs}`);
    const body: any = await response.json();
    if (!response.ok || body?.error) throw new Error(body?.error?.message || `HTTP ${response.status}`);
    return body;
  };

  return buildAlertContext(owner, adAccountId, days, {
    getCoverage: async (userId: string) => {
      const { computeClickIdCoverageForUser } = await import('./metaAttributionCoverage');
      return computeClickIdCoverageForUser(userId, 30);
    },
    getPixels: async (id: string) =>
      (await graph(`act_${id}/adspixels`, { fields: 'id,name,last_fired_time' }))?.data || [],
    getMatchKeys: async (pixelId: string) => {
      const body = await graph(`${pixelId}/stats`, { aggregation: 'match_keys' });
      const folded: Record<string, Record<string, number>> = {};
      for (const bucket of body?.data || []) {
        for (const entry of bucket?.data || []) {
          const event = entry?.event || 'event';
          folded[event] = folded[event] || {};
          folded[event][entry.value] = (folded[event][entry.value] || 0) + Number(entry.count || 0);
        }
      }
      return folded;
    },
  });
}
