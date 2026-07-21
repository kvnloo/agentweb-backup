// ENG-351 Phase 1 — structured citation registry for Emma chat messages.
//
// Emma's web-search tools (you_search_web / you_search_news / google_search_web) return
// structured results ({title, url, snippet, publishedDate}). This module accumulates the
// sources a single assistant message actually consulted into a de-duplicated, stably-numbered
// `Citation[]` that rides on the message metadata, so the frontend can render the ChatGPT-style
// "Sources" pill + panel from real data (not text the model typed).
//
// IMPORTANT: web-search results are trimmed to `{}` by extractMinimalToolResult before they
// reach `metadata.toolCalls` (storage minimization), so the registry CANNOT be rebuilt from
// toolCalls after the fact. It must be fed the full results at tool-dispatch time — hence the
// stateful `CitationRegistry` accumulated across a message's search calls.
//
// The stable per-message `id` is also the anchor Phase 2 uses: Emma cites a figure with that id
// (e.g. {{cite:2}}) and the frontend maps it back to the source.

export interface Citation {
  /** Stable 1-based id within this message; the anchor Phase 2 inline markers reference. */
  id: number;
  url: string;
  /** Bare host (no leading www.) — used for the favicon and as a fallback label. */
  domain: string;
  /** Best-effort human-readable source name derived from the domain. */
  siteName: string;
  title?: string;
  snippet?: string;
  publishedDate?: string;
}

/** The web-search tools whose results carry citable web sources. */
export const WEB_SEARCH_TOOL_NAMES = new Set(['you_search_web', 'you_search_news', 'google_search_web']);

/**
 * ENG-351 Phase 2: a compact id→source map prepended to a web-search tool result so the model
 * can cite each figure inline with a {{cite:N}} marker whose N matches the message's registry id.
 * Prepended (not appended) so it survives any downstream truncation of large search results.
 */
export function buildCitationIndexBlock(batch: Citation[]): string {
  if (!batch.length) return '';
  const lines = batch.map((c) => `  {{cite:${c.id}}} = ${c.siteName || c.domain} (${c.domain})`).join('\n');
  return (
    `[INLINE CITATIONS — for every quoted number, statistic, or data point you take from a source below, ` +
    `place its marker immediately after the figure, e.g. "$5.2B {{cite:${batch[0].id}}}". ` +
    `Use ONLY these exact ids; never invent one:\n${lines}\n]\n\n`
  );
}

// Matches a {{cite:N}} / {{cite:N,M}} inline-citation marker (tolerant of internal whitespace),
// together with any run of spaces/tabs immediately preceding it, so removing the marker collapses
// "$5.2B {{cite:2}}." cleanly to "$5.2B." instead of leaving a dangling space before punctuation.
const CITE_MARKER_STRIP = /[ \t]*\{\{\s*cite\s*:\s*\d+(?:\s*,\s*\d+)*\s*\}\}/gi;

/**
 * ENG-351: strip {{cite:N}} inline-citation markers out of assistant text for any surface that is
 * NOT the customer-portal React chat (emails, Slack, digests, plain-text copies, etc.). The markers
 * are only meaningful to the frontend rehypeCite renderer, which turns them into source chips;
 * everywhere else they must be removed so readers never see literal "{{cite:2}}" garbage. No-ops on
 * text without markers, so it is safe to call on any string (including hardcoded/system messages).
 */
export function stripCitationMarkers(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(CITE_MARKER_STRIP, '');
}

/** Extract the bare host (lowercased, no leading `www.`) from a URL; '' if unparseable. */
export function domainFromUrl(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

/**
 * Best-effort readable site name from a domain: drop the TLD, split the registrable label on
 * separators, and Title-Case it. e.g. "grandviewresearch.com" -> "Grandviewresearch",
 * "search-console.google.com" -> "Search Console Google". Falls back to the raw domain.
 */
export function prettySiteName(domain: string): string {
  if (!domain) return '';
  const labels = domain.split('.');
  const meaningful = labels.length > 2 && labels[labels.length - 1].length <= 3 && labels[labels.length - 2].length <= 3
    ? labels.slice(0, -2)
    : labels.slice(0, -1);
  const base = (meaningful.length ? meaningful : labels).join(' ');
  const words = base
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
  return words.join(' ') || domain;
}

// Normalize a URL for de-duplication: strip the hash and any trailing slash so the same page
// cited twice collapses to one entry. The URL parser already lowercases the scheme and host
// (which are case-insensitive); the path and query are left untouched because they ARE
// case-sensitive — lowercasing them would wrongly merge distinct pages like /report/US and
// /report/us into one citation id. Falls back to the trimmed raw string.
function dedupeKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Accumulates the de-duplicated, stably-numbered web sources consulted across ONE assistant
 * message's search calls. Fed the full search results at tool-dispatch time (before they are
 * trimmed for storage). First-seen order; entries without a usable http(s) url are skipped.
 */
export class CitationRegistry {
  private byKey = new Map<string, Citation>();
  private nextId = 1;

  /**
   * Register the `results` array of ONE web-search tool call. Returns the batch's citations
   * (with their stable global ids, whether newly assigned or previously seen) so the caller
   * can show the model the id→source map for THIS search. Non-arrays yield an empty batch.
   */
  registerSearchResults(results: unknown): Citation[] {
    if (!Array.isArray(results)) return [];

    const batch: Citation[] = [];
    const seenInBatch = new Set<string>();

    for (const r of results) {
      const url = typeof r?.url === 'string' ? r.url.trim() : '';
      if (!url || !/^https?:\/\//i.test(url)) continue;

      const domain = domainFromUrl(url);
      if (!domain) continue; // unparseable host (e.g. "https://") — skip rather than show an empty pill

      const key = dedupeKey(url);
      let cit = this.byKey.get(key);
      if (!cit) {
        cit = {
          id: this.nextId++,
          url,
          domain,
          siteName: prettySiteName(domain),
          ...(typeof r.title === 'string' && r.title.trim() ? { title: r.title.trim() } : {}),
          ...(typeof r.snippet === 'string' && r.snippet.trim() ? { snippet: r.snippet.trim() } : {}),
          ...(typeof r.publishedDate === 'string' && r.publishedDate ? { publishedDate: r.publishedDate } : {}),
        };
        this.byKey.set(key, cit);
      }
      if (!seenInBatch.has(key)) {
        seenInBatch.add(key);
        batch.push(cit);
      }
    }

    return batch;
  }

  /** The de-duplicated citations, in first-seen order. */
  list(): Citation[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }
}
