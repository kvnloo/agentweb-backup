/**
 * ENG-926 §G — fetch each destination URL at most ONCE per sweep.
 *
 * Two §G checks now read customer pages: destination coverage (#2448, every ACTIVE ad's
 * landing page) and generated-landing-page coverage (every deployed site we built). They
 * overlap heavily — a generated lander that an ad points at is in BOTH sets — so without
 * this the daily sweep hits the same customer site twice.
 *
 * That matters beyond politeness. #2456 had just finished removing the duplicate-account
 * sweep for exactly this reason: an ad account held by three user records was fetching the
 * customer's pages three times a day. Adding a second checker would have quietly reinstated
 * the same cost by a different route.
 *
 * ⚠ This is a CACHE, not a deduplicator over a URL list. The distinction is deliberate: a
 * dedupe pass compares two lists and can drift the moment either side normalises differently
 * (trailing slash, `www.`, uppercase host, an added query param). A shared cache makes
 * fetch-once-per-URL a property of the mechanism instead of a comparison someone has to keep
 * correct — the "change mechanism rather than tune the pattern" lesson §23 paid sixteen
 * review rounds for.
 *
 * FAILURES ARE CACHED TOO. A site answering 403 must be asked once per sweep, not once per
 * checker; re-throwing the recorded error keeps every caller's own error handling intact.
 */

/**
 * Canonical key for one page fetch.
 *
 * Only the parts that are genuinely case- or format-insensitive per the URL spec are
 * normalised: scheme, host, default port, and the empty fragment. Path and query are left
 * EXACTLY as given — `/a` and `/a/` can legitimately be different pages, and `www.` is a real
 * hostname that can serve different content from the apex. Over-normalising here would make
 * two different pages share one verdict, which is a worse failure than fetching twice.
 */
export function normaliseUrlForCache(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    return u.toString();
  } catch {
    // Not parseable as a URL. Keyed verbatim rather than dropped: the caller still gets
    // fetch-once behaviour, and whatever error the fetcher raises is theirs to interpret.
    return trimmed;
  }
}

/**
 * Entries retained before the oldest are evicted.
 *
 * The gate caps a single page at 5MB, and a sweep reads both every ACTIVE ad destination and
 * every generated site — so an unbounded cache would hold the whole fleet's HTML for the
 * duration of the run, in a process that also serves the API. 200 entries bounds the worst
 * case at ~1GB and the realistic case far below, while still comfortably covering the overlap
 * this cache exists for: the destination and landing-page checks for one user run adjacently,
 * so the hit lands long before eviction.
 */
export const MAX_CACHE_ENTRIES = 200;

export interface UrlFetchCache {
  /** Same shape as `MetaPreflightDeps.fetchHtml`: resolves to HTML, throws on failure. */
  fetchHtml: (url: string) => Promise<string>;
  stats: () => { fetches: number; hits: number; distinct: number; evicted: number };
}

type Entry = { ok: true; html: string } | { ok: false; error: unknown };

/**
 * One cache per sweep run. NEVER module-level: a process-lifetime cache would serve a page
 * captured hours ago, and the whole point of these checks is what a site is serving NOW.
 *
 * @param underlying the real fetcher. Callers pass the SSRF-guarded one; tests pass a stub.
 */
export function createUrlFetchCache(underlying: (url: string) => Promise<string>): UrlFetchCache {
  // Stores the PROMISE, not the settled value, so two checks racing the same URL in the same
  // tick share one request rather than both missing an empty cache and firing.
  const inflight = new Map<string, Promise<Entry>>();
  let fetches = 0;
  let hits = 0;
  let evicted = 0;

  const fetchHtml = async (url: string): Promise<string> => {
    const key = normaliseUrlForCache(url);
    let pending = inflight.get(key);
    if (pending) {
      hits++;
    } else {
      fetches++;
      pending = underlying(url).then(
        (html): Entry => ({ ok: true, html }),
        (error): Entry => ({ ok: false, error }),
      );
      inflight.set(key, pending);
      // Insertion-ordered, so the first key is the oldest. Evicting it costs at most a repeat
      // fetch later; NOT evicting costs the whole fleet's HTML resident for the entire sweep.
      while (inflight.size > MAX_CACHE_ENTRIES) {
        const oldest = inflight.keys().next().value;
        if (oldest === undefined) break;
        inflight.delete(oldest);
        evicted++;
      }
    }
    const entry = await pending;
    // Re-thrown rather than returned as a value, so a cached failure is indistinguishable
    // from a live one to the caller and their existing error handling still runs.
    if (!entry.ok) throw entry.error;
    return entry.html;
  };

  return { fetchHtml, stats: () => ({ fetches, hits, distinct: inflight.size, evicted }) };
}
