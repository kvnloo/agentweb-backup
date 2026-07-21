// ENG-351 Phase 1 — structured citation registry for Emma chat messages.
//
// Emma's web-search tool (`search_tool_response`) returns structured results
// ({title, url, snippet, publishedDate}). This module distills the sources a
// single assistant message actually consulted into a de-duplicated, stably-numbered
// `Citation[]` that rides on the message metadata, so the frontend can render the
// ChatGPT-style "Sources" pill + panel from real data (not text the model typed).
//
// The stable per-message `id` is also the anchor Phase 2 will use: Emma will cite a
// figure with that id (e.g. [[cite:2]]) and the frontend maps it back to the source.

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

// A tool-call entry as attached to assistant message metadata.
interface ToolCallLike {
  name?: string;
  result?: any;
}

// Tool names whose results carry web sources. `search_tool_response` is Emma's
// web-search tool; kept as an explicit allowlist so unrelated tools that happen to
// return a `results` array are never mistaken for citations.
const SOURCE_BEARING_TOOLS = new Set(['search_tool_response']);

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
 * Best-effort readable site name from a domain: drop the TLD, split the registrable
 * label on separators, and Title-Case it. e.g. "grandviewresearch.com" -> "Grandviewresearch",
 * "search-console.google.com" -> "Search Console Google". Falls back to the raw domain.
 */
export function prettySiteName(domain: string): string {
  if (!domain) return '';
  const labels = domain.split('.');
  // Drop a trailing TLD (and a 2-char ccTLD's SLD like .co.uk) to get the meaningful part.
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

// Normalize a URL for de-duplication: strip the hash and any trailing slash so the same
// page cited twice collapses to one entry. Falls back to the trimmed raw string.
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
 * Build the de-duplicated, stably-numbered citation registry for one assistant message
 * from its tool calls. Order is first-seen across the message's searches. Entries without a
 * usable http(s) url are skipped.
 */
export function buildCitationRegistry(toolCalls: ToolCallLike[] | undefined | null): Citation[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

  const byKey = new Map<string, Citation>();
  let nextId = 1;

  for (const call of toolCalls) {
    if (!call || !SOURCE_BEARING_TOOLS.has(call.name || '')) continue;
    const results = call.result?.results;
    if (!Array.isArray(results)) continue;

    for (const r of results) {
      const url = typeof r?.url === 'string' ? r.url.trim() : '';
      if (!url || !/^https?:\/\//i.test(url)) continue;

      const key = dedupeKey(url);
      if (byKey.has(key)) continue;

      const domain = domainFromUrl(url);
      byKey.set(key, {
        id: nextId++,
        url,
        domain,
        siteName: prettySiteName(domain),
        ...(typeof r.title === 'string' && r.title.trim() ? { title: r.title.trim() } : {}),
        ...(typeof r.snippet === 'string' && r.snippet.trim() ? { snippet: r.snippet.trim() } : {}),
        ...(typeof r.publishedDate === 'string' && r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      });
    }
  }

  return [...byKey.values()];
}
