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
  /** The pixel this account's conversions are actually configured to go to, when it can be
   *  resolved. Preferred over recency because `last_fired_time` IGNORES CAPI events (§10,
   *  established during ENG-941): a pixel receiving only server-side conversions can look
   *  stale or unfired while being the one that matters. */
  getPreferredPixelId?: () => Promise<string | undefined>;
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
  /** Objectives whose spend this account also carries but which were excluded from the
   *  judgement. Named in the ticket so a reader is not surprised that the spend figure
   *  here is smaller than the one in Ads Manager. */
  excludedObjectives?: string[],
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

  if (excludedObjectives && excludedObjectives.length > 0) {
    context['Spend Excluded From Judgement'] =
      `This account also spends on ${excludedObjectives.join(', ')}, which do not optimise ` +
      'for conversions. That spend is deliberately NOT counted here, so the figure above is ' +
      'lower than Ads Manager\'s total for the account.';
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
    // Selection order: the CONFIGURED attribution pixel first, then the rest by recency.
    // `last_fired_time` IGNORES CAPI (§10, ENG-941), so the configured pixel is preferred
    // over any recency signal and is never cut by the cap.
    const preferredPixelId = await attempt('configured pixel', async () =>
      deps.getPreferredPixelId ? deps.getPreferredPixelId() : undefined,
    );

    // EVERY pixel on the account is a candidate — not only those with a `last_fired_time`.
    //
    // That field ignores CAPI, so a pixel receiving nothing but server-side conversions
    // looks unfired while being exactly the one that matters. Filtering candidacy on it
    // meant such a pixel was never examined AND never counted as missing, so completeness
    // looked satisfied while a CAPI-only dataset went unlooked-at (Greptile, seventh pass
    // on #2415). Recency now decides ORDER only, never eligibility.
    const others = pixels
      .filter((p) => p?.id && p.id !== preferredPixelId)
      .sort((a, b) => String(b.last_fired_time || '').localeCompare(String(a.last_fired_time || '')));

    const preferred = preferredPixelId ? pixels.find((p) => p?.id === preferredPixelId) : undefined;

    const candidates = [...(preferred ? [preferred] : []), ...others];
    const fired = candidates.slice(0, MAX_PIXELS_DIAGNOSED);
    const sawEveryPixel = fired.length === candidates.length;

    const linkTarget = preferred ?? fired[0];
    if (linkTarget?.id) {
      // The uncertainty rides on the VALUE, beside the link an operator is about to click,
      // rather than only in prose further down. It stays one stable key so consumers do
      // not have to know about two.
      context['Meta Events Manager'] =
        metaDeepLinks.eventsManager(linkTarget.id) +
        (preferred ? '' : '  ⚠ UNCONFIRMED dataset — this pixel was chosen by recent browser activity, not by configuration');
    }

    // Say so when the ranking is a HEURISTIC rather than the configured pixel.
    if (!preferred && fired.length > 0) {
      context['Pixel Selection'] =
        (preferredPixelId
          ? `This account's configured pixel could not be determined — the owner's default ` +
            `(${preferredPixelId}) belongs to a different ad account. `
          : `This account's configured pixel could not be determined. `) +
        'The pixels below are ordered by most recent browser activity, which IGNORES ' +
        'CAPI events — a pixel taking only server-side conversions can look stale here. ' +
        'Confirm the dataset in Events Manager before concluding anything from the match keys.';
    }

    const sections: string[] = [];
    let anySupplied = false;
    // Counts pixels whose match keys were actually READ. A lookup that fails or times out
    // leaves a pixel unexamined, and an unexamined pixel cannot support an absolute claim
    // any more than an omitted one can (Greptile, sixth pass on #2415).
    let diagnosedCount = 0;
    for (const pixel of fired) {
      const matchKeys = await attempt(`match keys for ${pixel.id}`, () => deps.getMatchKeys(pixel.id));
      // A lookup that SUCCEEDED and returned nothing is still an examination — that pixel
      // genuinely has no events. Only a failure or timeout leaves it unexamined, and only
      // that can undermine an absolute claim.
      if (matchKeys === undefined) continue;
      diagnosedCount++;
      if (Object.keys(matchKeys).length === 0) continue;
      sections.push(
        `pixel ${pixel.id}${pixel.name ? ` (${pixel.name})` : ''}` +
        (pixel.id === preferredPixelId ? ' [configured attribution pixel]' : '') + ':\n' +
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
      // The absolute claim — "no identity reached Meta on this account" — is only
      // defensible when the view was complete: every candidate pixel diagnosed, and the
      // selection confirmed rather than inferred. If the cap truncated the set, an
      // undiagnosed pixel may well carry `email`; if selection was a heuristic, the pixels
      // shown may not be the ones the ads attribute through. In either case the finding is
      // still worth reporting, but scoped to what was actually examined.
      //
      // This is the same discipline as §F's own third state: a partial view produces a
      // qualified statement, never a confident one (Greptile, fifth pass on #2415).
      // Complete means: the configured pixel was identified, every candidate was selected,
      // AND every selected pixel was successfully read. Selection alone is not examination.
      const completeView = sawEveryPixel && !!preferred && diagnosedCount === candidates.length;

      // Name the ACTUAL limitations rather than guessing one. They are independent and can
      // co-occur: the configured pixel may be unconfirmed, the cap may have truncated the
      // set, and a lookup may have failed — each undermines the claim differently, and a
      // reader deciding how far to trust this needs to know which applies.
      const limits: string[] = [];
      if (!preferred) {
        limits.push('the configured attribution pixel could not be confirmed, so these may not be the pixels the ads attribute through');
      }
      if (!sawEveryPixel) {
        limits.push(`only the ${fired.length} most recent of ${candidates.length} pixels were selected`);
      }
      if (diagnosedCount < fired.length) {
        limits.push(`only ${diagnosedCount} of ${candidates.length} pixels were examined — the rest could not be read`);
      }

      const noIdentityNote = anySupplied
        ? ''
        : completeView
          ? '\nNO IDENTITY WE SUPPLIED reached Meta on these events — only Meta\'s own ' +
            'browser cookies. Without fbc/fbp/email an event cannot be tied back to an ad ' +
            'click, which is why spend can show zero attributed conversions while the ' +
            'pixel still counts the event.'
          : '\nNone of the pixels shown above received identity we supplied — only Meta\'s ' +
            'own browser cookies, which cannot tie a conversion to an ad click. NOT an ' +
            `account-wide conclusion: ${limits.join('; ')}.`;
      context['Meta Match Keys'] = sections.join('\n') + noIdentityNote;
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
  excludedObjectives?: string[],
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
    // The SAME resolver the relay sends through, so the pixel diagnosed is the pixel
    // conversions actually target.
    getPreferredPixelId: async () => {
      const { metaService } = await import('./metaService');
      const resolved: any = await metaService.resolveMetaPixelWithDefault(owner, owner?.userId, undefined);
      return resolved && !('unresolved' in resolved) ? resolved.pixelId : undefined;
    },
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
  }, excludedObjectives);
}
