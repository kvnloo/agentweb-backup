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
// cited twice collapses to one entry. Falls back to the trimmed raw string.
function dedupeKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
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

  /** Register the `results` array of a web-search tool call. Non-arrays are ignored. */
  registerSearchResults(results: unknown): void {
    if (!Array.isArray(results)) return;

    for (const r of results) {
      const url = typeof r?.url === 'string' ? r.url.trim() : '';
      if (!url || !/^https?:\/\//i.test(url)) continue;

      const key = dedupeKey(url);
      if (this.byKey.has(key)) continue;

      const domain = domainFromUrl(url);
      this.byKey.set(key, {
        id: this.nextId++,
        url,
        domain,
        siteName: prettySiteName(domain),
        ...(typeof r.title === 'string' && r.title.trim() ? { title: r.title.trim() } : {}),
        ...(typeof r.snippet === 'string' && r.snippet.trim() ? { snippet: r.snippet.trim() } : {}),
        ...(typeof r.publishedDate === 'string' && r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      });
    }
  }

  /** The de-duplicated citations, in first-seen order. */
  list(): Citation[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }
}
