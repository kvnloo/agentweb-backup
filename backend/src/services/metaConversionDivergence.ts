/**
 * ENG-926 §F — CRM conversions against Meta-attributed conversions.
 *
 * The card: "Daily job comparing CRM conversions against Meta-attributed conversions;
 * alert on divergence… this becomes straightforward once the relay in C exists, because we
 * finally have two independent counts to compare. Today we have one number and no way to
 * know whether it is real."
 *
 * The two counts are what §C recorded itself as having SENT (`metaConversionsSentLog` on
 * the lead) and what Meta's pixel says it RECEIVED (`/{pixel}/stats?aggregation=event`).
 * Neither derives from the other, which is what makes the comparison worth anything.
 *
 * ─── Scope, stated plainly ──────────────────────────────────────────────────────────
 *
 * This is silent for every customer today, by construction rather than by accident: it
 * only evaluates accounts with the §C relay actually enabled, and that is nobody. It is
 * built now so that the FIRST customer to opt in is measured from their first day rather
 * than from whenever someone remembers to add monitoring — the failure this whole card
 * exists to end was a gap that ran for weeks because nobody was counting.
 *
 * ─── Two decisions that look like details and are not ───────────────────────────────
 *
 * TOTALS over a window, never per-day buckets. `/stats` returns hourly buckets stamped in
 * the AD ACCOUNT's timezone — a live probe came back `+0530` — while our own timestamps
 * are UTC. Bucketing per day across that offset would manufacture a divergence every day
 * out of pure arithmetic. Totals sidestep it and still answer the real question.
 *
 * ONE rule, not a tuned ratio: a meaningful number sent, and NONE received. A partial
 * shortfall is what reporting lag, timezone offset and Meta's own sampling all look like,
 * so alerting on it would be alerting on noise. §C's post-mortem is explicit that tuning
 * this class of threshold was the wrong move three times running, and that stating the
 * invariant was the right one. Zero-arrival cannot be produced by lag or slop.
 */

const TAG = '[CAPI Divergence]';

/** Below this many relayed conversions the comparison says nothing. One conversion that
 *  has not appeared yet is a coin flip, not a signal. */
export const DIVERGENCE_MIN_SAMPLE = 3;

/** Meta reports with a lag (§10 records 30–45 minutes observed). The window ends a full
 *  day back so lag and any timezone offset are both comfortably absorbed rather than
 *  tuned around. */
export const DIVERGENCE_LAG_HOURS = 24;

/** How far back the comparison looks, ending at the lag boundary above. */
export const DIVERGENCE_WINDOW_DAYS = 7;

export interface DivergenceVerdict {
  /**
   * `not-arriving` — we sent a meaningful number and Meta received none of them.
   * `insufficient-data` — too few sent to conclude anything, including none at all.
   * `ok` — Meta received some. Deliberately includes a partial shortfall.
   */
  status: 'ok' | 'not-arriving' | 'insufficient-data';
  crmSent: number;
  metaSeen: number;
}

export function evaluateDivergence(crmSent: number, metaSeen: number): DivergenceVerdict {
  if (crmSent < DIVERGENCE_MIN_SAMPLE) {
    return { status: 'insufficient-data', crmSent, metaSeen };
  }
  // Meta's count being LARGER is normal: the same pixel carries browser events we never
  // relayed. Only a total absence is evidence.
  if (metaSeen === 0) {
    return { status: 'not-arriving', crmSent, metaSeen };
  }
  return { status: 'ok', crmSent, metaSeen };
}

export interface DivergenceFetchDeps {
  fetchImpl: typeof fetch;
}

/** Bounded so a pathological paging loop cannot run forever. Seven days of hourly buckets
 *  is ~168 entries, which Meta returns in very few pages. */
const MAX_STATS_PAGES = 20;

/**
 * How many of OUR relay events this pixel received.
 *
 * Counts only the named events, because the same pixel carries `PageView` and browser
 * `Lead` traffic — a real probe showed 200 PageViews alongside a single relayed Purchase.
 * Counting those would hide a total relay failure behind unrelated volume.
 *
 * The names are passed in rather than hardcoded: the per-account override means a customer
 * may emit `CRMPurchase`, and comparing against a fixed `Purchase` would report a
 * permanent blackout for exactly the accounts that configured themselves correctly.
 *
 * Returns null — never 0 — when the pixel could not be read. Zero means "Meta received
 * nothing", which is an alert; "we could not ask" is not, and collapsing the two would
 * fire a blackout alert every time a token expired.
 */
export async function countPixelRelayEvents(
  pixelId: string,
  accessToken: string,
  eventNames: string[],
  window: { sinceMs: number; untilMs: number },
  deps?: DivergenceFetchDeps,
): Promise<number | null> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  const wanted = new Set(eventNames);

  // BOTH sides of the comparison must cover the same period. Left unbounded, /stats
  // returns its own default range while the CRM side is bounded to seven days ending at
  // the lag boundary — comparing those is meaningless in both directions, able to hide a
  // real blackout behind older traffic or to invent one outright (Greptile on #2413).
  //
  // `start_time`/`end_time`, in unix SECONDS, are the parameters that work. Probed live
  // against pixel 1012387921717047 on 2026-08-15: they returned 17 hourly buckets across
  // the requested seven days, whereas `since`/`until` returned the same buckets as passing
  // nothing at all — silently ignored, indistinguishable from a bogus parameter name.
  const params = new URLSearchParams({
    aggregation: 'event',
    start_time: String(Math.floor(window.sinceMs / 1000)),
    end_time: String(Math.floor(window.untilMs / 1000)),
  });

  let url =
    `https://graph.facebook.com/${apiVersion}/${pixelId}/stats?${params}` +
    `&access_token=${encodeURIComponent(accessToken)}`;
  let total = 0;

  for (let page = 0; page < MAX_STATS_PAGES && url; page++) {
    let body: any;
    try {
      const response = await fetchImpl(url);
      body = await response.json();
      if (!response.ok || body?.error) {
        console.warn(`${TAG} pixel ${pixelId} stats unavailable: ${body?.error?.message}`);
        return null;
      }
    } catch (error: any) {
      console.warn(`${TAG} pixel ${pixelId} stats request failed: ${error?.message}`);
      return null;
    }

    for (const bucket of Array.isArray(body?.data) ? body.data : []) {
      for (const entry of Array.isArray(bucket?.data) ? bucket.data : []) {
        if (!wanted.has(entry?.value)) continue;
        const count = Number.parseInt(entry?.count, 10);
        if (Number.isFinite(count)) total += count;
      }
    }

    url = typeof body?.paging?.next === 'string' ? body.paging.next : '';
  }

  return total;
}

/**
 * How many conversions §C recorded itself as relaying in the window.
 *
 * Read from `metaConversionsSentLog`, which exists precisely because
 * `metaConversionsSent` carries no timestamp and therefore cannot answer a question with
 * "last week" in it.
 */
export function countLoggedRelaysInWindow(
  lead: any,
  sinceMs: number,
  untilMs: number,
  /** Only sends that reached THIS pixel count. Both sides of the comparison have to refer
   *  to the same destination: a customer who connects a second ad account, or changes
   *  which one resolves by default, would otherwise have history measured against a pixel
   *  it never reached — reported as a blackout on a perfectly healthy relay. */
  expectedPixelId?: string,
): number {
  const log = lead?.metaConversionsSentLog;
  if (!Array.isArray(log)) return 0;

  let count = 0;
  for (const entry of log) {
    const at = Date.parse(entry?.at ?? '');
    if (!Number.isFinite(at)) continue;
    if (at < sinceMs || at >= untilMs) continue;
    // An entry with NO recorded pixel predates the destination being stored. It is counted
    // rather than dropped: none exist in production (the relay is enabled for nobody), and
    // dropping them would undercount silently, which is precisely what manufactures a
    // false blackout.
    if (expectedPixelId && entry?.pixel && entry.pixel !== expectedPixelId) continue;
    count++;
  }
  return count;
}

/** The window the comparison runs over: `DIVERGENCE_WINDOW_DAYS` ending
 *  `DIVERGENCE_LAG_HOURS` before now, so Meta has had time to report. */
export function divergenceWindow(now: number): { sinceMs: number; untilMs: number } {
  const untilMs = now - DIVERGENCE_LAG_HOURS * 60 * 60 * 1000;
  return { sinceMs: untilMs - DIVERGENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000, untilMs };
}

// ── Orchestration ────────────────────────────────────────────────────────────────────

/** Stable dedupe class for the intake gate (ENG-358), so a persistent divergence clusters
 *  onto one canonical issue instead of filing a fresh one every day. */
export const DIVERGENCE_ALERT_CLASS = 'meta-conversion-divergence';

/** Re-alert at most once per user per day. Still-broken tomorrow still matters. */
export const DIVERGENCE_REALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

const lastAlertAtByUser = new Map<string, number>();

export function __resetDivergenceAlertStateForTests(): void {
  lastAlertAtByUser.clear();
}

export interface DivergenceDeps {
  getLeadLists: (userId: string) => Promise<any[]>;
  getLeads: (listId: string, limit: number, startKey: any) => Promise<any>;
  resolvePixel: (owner: any, userId: string) => Promise<any>;
  getCredentials: (owner: any, userId: string, accountId: string) => Promise<any>;
  countPixelEvents: (
    pixelId: string,
    accessToken: string,
    eventNames: string[],
    window: { sinceMs: number; untilMs: number },
  ) => Promise<number | null>;
  alertTransport: (subject: string, message: string, context?: Record<string, any>) => Promise<void>;
  /**
   * ⚠ A DRY RUN MUST NEITHER READ NOR WRITE THE RE-ALERT MAP, and the two halves fail in
   * opposite directions:
   *   - WRITING it would make a diagnostic run SILENCE the next real 09:00 sweep for 24h.
   *   - READING it would make a dry run report "no alert" for a user the real sweep is
   *     actively alerting on — clean output for a broken account.
   * So on a dry run the window is bypassed entirely: always evaluate, always hand the
   * verdict to the transport (which is capturing, not sending).
   */
  dryRun?: boolean;
  now?: number;
}

export interface DivergenceResult {
  /** `skipped` — not applicable (relay off, or no pixel to read).
   *  `unknown` — one side could not be counted, so no conclusion is possible. */
  status: 'skipped' | 'unknown' | DivergenceVerdict['status'];
  crmSent?: number;
  metaSeen?: number | null;
}

const LEAD_PAGE_SIZE = 200;

/**
 * Compare what §C relayed against what Meta received, for one customer.
 *
 * Gated on the relay being ENABLED, which is what makes this silent by construction rather
 * than by accident: a customer who has never relayed a conversion has nothing to compare,
 * and a comparison against events we never sent would be noise on every run. That is
 * everyone today.
 *
 * Never throws — it runs inside a cron sweep over the whole fleet.
 */
export async function checkUserConversionDivergence(
  user: any,
  deps: DivergenceDeps,
): Promise<DivergenceResult> {
  const now = deps.now ?? Date.now();
  const { isConversionRelayEnabled, getEventNameOverrides, resolveEventName } = await import(
    './metaConversionRelay'
  );

  if (!user?.userId || !isConversionRelayEnabled(user)) return { status: 'skipped' };

  let resolution: any;
  try {
    resolution = await deps.resolvePixel(user, user.userId);
  } catch (error: any) {
    console.warn(`${TAG} pixel resolution failed for ${user.userId}: ${error?.message}`);
    return { status: 'skipped' };
  }
  // No pixel means §C could not have sent anything either, so there is nothing to compare.
  if (!resolution || 'unresolved' in resolution) return { status: 'skipped' };

  const { sinceMs, untilMs } = divergenceWindow(now);

  // ── Our side ──
  // A partial read is worse than none: an undercount compared against Meta's full count is
  // a manufactured divergence, and this alert's whole value is that it does not cry wolf.
  let crmSent = 0;
  try {
    const lists = (await deps.getLeadLists(user.userId)) || [];
    for (const list of lists) {
      let startKey: any = undefined;
      do {
        const page = await deps.getLeads(list.listId, LEAD_PAGE_SIZE, startKey);
        for (const lead of (page?.items || []) as any[]) {
          crmSent += countLoggedRelaysInWindow(lead, sinceMs, untilMs, resolution.pixelId);
        }
        startKey = page?.lastEvaluatedKey;
      } while (startKey);
    }
  } catch (error: any) {
    console.warn(`${TAG} could not count relayed conversions for ${user.userId}: ${error?.message}`);
    return { status: 'unknown' };
  }

  // Nothing to compare, and no Meta call worth making for it.
  if (crmSent < DIVERGENCE_MIN_SAMPLE) {
    return { status: 'insufficient-data', crmSent };
  }

  // ── Meta's side ──
  // The account's OWN event names. Comparing against a hardcoded `Purchase` would report a
  // permanent blackout for precisely the accounts that configured an override correctly.
  const overrides = getEventNameOverrides(user, resolution.accountId);
  const eventNames = [
    resolveEventName('won', true, overrides),
    resolveEventName('won', false, overrides),
    resolveEventName('qualified', false, overrides),
  ];

  let metaSeen: number | null;
  try {
    const creds = await deps.getCredentials(user, user.userId, resolution.accountId);
    // Same window object the CRM count above used — not a recomputed one, so the two can
    // never drift apart.
    metaSeen = await deps.countPixelEvents(resolution.pixelId, creds?.accessToken, eventNames, {
      sinceMs,
      untilMs,
    });
  } catch (error: any) {
    console.warn(`${TAG} could not read pixel stats for ${user.userId}: ${error?.message}`);
    return { status: 'unknown', crmSent };
  }

  // null is "we could not ask", not "Meta received nothing". Collapsing them would fire a
  // blackout alert every time a token expired.
  if (metaSeen === null) return { status: 'unknown', crmSent, metaSeen };

  const verdict = evaluateDivergence(crmSent, metaSeen);
  if (verdict.status !== 'not-arriving') {
    return { status: verdict.status, crmSent, metaSeen };
  }

  // See DivergenceDeps.dryRun — the re-alert window is per-PROCESS alerting state, so a
  // diagnostic run must not participate in it in either direction.
  const last = deps.dryRun ? undefined : lastAlertAtByUser.get(user.userId);
  if (last === undefined || now - last >= DIVERGENCE_REALERT_WINDOW_MS) {
    if (!deps.dryRun) lastAlertAtByUser.set(user.userId, now);
    try {
      await deps.alertTransport(
        `CRM conversions are not reaching Meta for pixel ${resolution.pixelId}`,
        [
          `We recorded ${crmSent} CRM conversion(s) relayed to Meta in the last`,
          `${DIVERGENCE_WINDOW_DAYS} days, and Meta's pixel reports receiving none of them.`,
          '',
          `Pixel: ${resolution.pixelId}   Ad account: ${resolution.accountId}`,
          `Events looked for: ${eventNames.join(', ')}`,
          '',
          'These are two independent counts — what the relay recorded sending, and what',
          'Meta says it received — so a total mismatch means the events are not landing.',
          'This is the check that did not exist when a tracking failure was reported fixed',
          'three times without anyone verifying it end to end.',
        ].join('\n'),
        {
          'Alert Class': DIVERGENCE_ALERT_CLASS,
          'Alert Priority': 'high',
          'Owner User Id': user.userId,
          'Owner Email': user.email,
          Pixel: resolution.pixelId,
          'CRM Conversions Relayed': crmSent,
          'Meta Conversions Received': metaSeen,
        },
      );
    } catch (error: any) {
      console.error(`${TAG} failed to send divergence alert: ${error?.message}`);
    }
  }

  return { status: 'not-arriving', crmSent, metaSeen };
}

/**
 * Production wiring. Kept separate from the computation so the unit tests never pull in
 * DynamoDB, the Meta SDK, or the email service — the same split `metaAttributionCoverage`
 * and `metaConversionRelay` both use.
 */
/**
 * Build the real dependency set for a divergence check.
 *
 * ⚠ EXTRACTED AND EXPORTED SO THE WIRING CAN BE TESTED AT ALL. Both derivations below were
 * previously inline in the wrapper, where NO test could reach them: the cron suite
 * `jest.mock`s this whole module, and every test here calls the injectable
 * `checkUserConversionDivergence` with explicit deps. Two separate mutations survived the
 * full suite because of that — one ignoring the transport override (dry runs would send REAL
 * oncall alerts) and one dropping the dry-run flag (dry runs would WRITE the re-alert map and
 * silence the next real sweep). Both are load-bearing and neither was pinned.
 *
 * ⚠ `dryRun` is DERIVED from the override rather than taken as a second argument, so the two
 * can never disagree. An override is only ever supplied by a diagnostic run; a real sweep
 * supplies none and keeps today's production behaviour.
 *
 * ⚠ The transport defaults to the REAL oncall email, never a no-op — a caller that forgets
 * the argument must keep alerting, not go quiet.
 */
export async function buildDivergenceDeps(
  alertTransport?: DivergenceDeps['alertTransport'],
): Promise<DivergenceDeps> {
  const [{ crmDb }, { metaService }, { getMetaAccountCredentials }] = await Promise.all([
    import('./db'),
    import('./metaService'),
    import('./metaAccountCredentials'),
  ]);

  return {
    getLeadLists: (userId) => crmDb.getLeadListsByUserId(userId),
    getLeads: (listId, limit, startKey) => crmDb.getLeadsByListId(listId, limit, startKey),
    // The SAME resolver §C sends through, so the pixel read back from is the pixel written
    // to. Reading a different one would compare two unrelated numbers.
    // `stored` is explicitly undefined: there is no per-surface pixel override for the CRM
    // relay, so this resolves the same default §C sends through.
    resolvePixel: (owner, userId) => metaService.resolveMetaPixelWithDefault(owner, userId, undefined),
    getCredentials: (owner, userId, accountId) =>
      getMetaAccountCredentials(owner, userId, accountId),
    countPixelEvents: (pixelId, accessToken, eventNames, window) =>
      countPixelRelayEvents(pixelId, accessToken, eventNames, window),
    alertTransport:
      alertTransport ??
      (async (subject, message, context) => {
        const { emailService } = await import('./emailService');
        await emailService.sendOncallAlert(subject, message, context);
      }),
    dryRun: alertTransport !== undefined,
  };
}

export async function checkConversionDivergenceForUser(
  user: any,
  /**
   * Supplying a transport marks this as a DIAGNOSTIC run: alerts are handed to the caller
   * instead of sent, and the per-process re-alert window is bypassed in both directions.
   * See buildDivergenceDeps.
   */
  alertTransport?: DivergenceDeps['alertTransport'],
): Promise<DivergenceResult> {
  return checkUserConversionDivergence(user, await buildDivergenceDeps(alertTransport));
}
