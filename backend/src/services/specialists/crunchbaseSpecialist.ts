/**
 * Funding-news specialist (SERP-parse).
 *
 * Originally targeted `site:crunchbase.com` but Crunchbase's SERP snippets are
 * descriptive ("Acme - Crunchbase Company Profile"), not numerical. Real
 * funding info lives in news articles: company press releases, TheSaaSNews,
 * Tracxn, TechCrunch. So we drop the site filter and search the open web for
 * news patterns like "Acme closes $50M Series C" — those snippets do contain
 * the round + amount inline.
 *
 * Three FieldSpecialist instances share a single search per company via an
 * in-memory dedup cache keyed by (company, emailDomain) with a 5-minute TTL.
 *
 * Precision safety: results that don't mention the company name in title or
 * snippet are filtered out, so a "Series A" in a blog post about a different
 * company doesn't bleed in.
 *
 * Each specialist returns a sourceContext (the matched snippets) so the
 * pipeline's citation-verification step can validate the value.
 */

import { agentModeService } from '../agentModeService';
import type { FieldSpecialist, SpecialistResult } from '../enrichmentSpecialists';
import type { LeadRecord } from '../crmEnrichmentService';

interface CrunchbaseSnippet {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Build a token-set for matching the company name against snippet/title text.
 * Strips common corp suffixes and lowercases. Returns the longest token plus
 * the full normalized name. Both must be checked because some snippets may
 * use just the brand ("Acme") without "Acme Inc."
 */
function companyMatchTokens(company: string): string[] {
  const cleaned = company
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|plc|gmbh|pty|limited|incorporated)\b\.?/g, '')
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(' ').filter(t => t.length >= 3);
  // Use the full cleaned name plus the longest individual token (often the brand)
  const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a), '');
  const out = [cleaned];
  if (longest && longest !== cleaned) out.push(longest);
  return out;
}

// Companies whose names contain these tokens are likely investors, not portfolio
// companies. The specialist returns null for them — they're filtered later
// anyway by is_vc_firm logic, and this prevents portfolio-company news from
// being misattributed.
const VC_NAME_TOKENS = /\b(ventures?|capital|partners|fund|equity)\b/i;

// Mega-cap public companies whose names are common English words and produce
// massive false-positive rates in funding searches. Not exhaustive.
const PUBLIC_DENYLIST = new Set([
  'target', 'apple', 'google', 'microsoft', 'amazon', 'meta', 'facebook',
  'nvidia', 'oracle', 'salesforce', 'adobe', 'intel', 'cisco', 'tesla',
  'netflix', 'uber', 'lyft', 'airbnb', 'spotify', 'zoom', 'shopify',
  'paypal', 'stripe',  // stripe excluded since it's mid-funding-cycle as a private co — but rare in practice
]);

async function fetchCrunchbaseResults(lead: LeadRecord): Promise<CrunchbaseSnippet[]> {
  const company = (lead.company || '').trim();
  const emailDomain = lead.email ? (String(lead.email).split('@')[1] || '') : '';
  const term = company || emailDomain;
  if (!term) return [];

  // Skip likely-VC companies and mega-cap public companies — both produce
  // overwhelming false-positive matches in funding searches.
  if (VC_NAME_TOKENS.test(term)) {
    console.log(`[fundingSpec] skipping VC-named company: "${term}"`);
    return [];
  }
  if (PUBLIC_DENYLIST.has(term.toLowerCase())) {
    console.log(`[fundingSpec] skipping mega-cap public company: "${term}"`);
    return [];
  }

  // Open-web query — news articles + Tracxn / SaaSNews / press releases all
  // surface "{{company}} closed $X Series Y" in their snippets.
  let result;
  try {
    result = await agentModeService.searchWeb(`${term} funding round Series`, 8);
  } catch {
    return [];
  }
  if (!result?.success || !Array.isArray(result.results)) return [];

  // Precision filter: company name must appear NEAR a funding verb in title or
  // snippet — i.e., be the SUBJECT of the funding action. Without this, an
  // article about "Acme Capital led PortfolioCo's Series B" gets misattributed
  // to Acme Capital.
  const tokens = companyMatchTokens(term);
  const FUNDING_VERBS = /(raise[ds]?|raising|closed?|closes|closing|secures?|secured|announces?|announced|completes?|completed|nets|gets?|received|got|lands?|landed)/i;
  const PROXIMITY_RADIUS = 40;  // chars on each side of company token
  const matched: CrunchbaseSnippet[] = (result.results as CrunchbaseSnippet[])
    .filter(r => {
      // Combine title + snippet for proximity check — press releases often have
      // the company in the title and the verb/amount in the snippet body.
      const combined = `${(r.title || '').toLowerCase()} ${(r.snippet || '').toLowerCase()}`;
      // Search EVERY occurrence of every token; for each occurrence, check a
      // 80-char window around it for a funding verb. If no occurrence has a
      // verb nearby, the snippet is talking about the company in some other
      // context (e.g., listing it among others, or as an investor).
      for (const tok of tokens) {
        let idx = combined.indexOf(tok);
        while (idx >= 0) {
          const start = Math.max(0, idx - PROXIMITY_RADIUS);
          const end = Math.min(combined.length, idx + tok.length + PROXIMITY_RADIUS);
          if (FUNDING_VERBS.test(combined.slice(start, end))) return true;
          idx = combined.indexOf(tok, idx + 1);
        }
      }
      return false;
    })
    .slice(0, 5);

  console.log(`[fundingSpec] term="${term}" returned=${result.results.length} matched=${matched.length}`);
  return matched;
}

// ── In-memory dedup cache (LRU + TTL) ────────────────────────────────────────
//
// Within a single enrichment job, three specialists (funding_round,
// total_funding_usd, hq_city) all need the same Crunchbase snippets. This
// dedups them so we make one search per company instead of three.
//
// Bounded with both an LRU cap (so a long-running process can't accumulate an
// unbounded number of entries when many distinct companies pass through) and a
// per-entry TTL (so stale snippets eventually drop).

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  promise: Promise<CrunchbaseSnippet[]>;
  expiresAt: number;
}

// Map preserves insertion order; we re-insert on hit to mark as most-recent and
// evict from the front (oldest) when over capacity.
const cbCache = new Map<string, CacheEntry>();

function cacheKey(lead: LeadRecord): string {
  return ((lead.company || '').toLowerCase().trim() + '|' + (lead.email?.split('@')[1] || '').toLowerCase());
}

function evictExpired(now: number): void {
  for (const [k, entry] of cbCache) {
    if (entry.expiresAt <= now) cbCache.delete(k);
    // Map iteration is insertion-ordered; once we hit a non-expired entry the
    // rest are also non-expired *iff* TTL is uniform. It is, so break.
    else break;
  }
}

function evictOldest(): void {
  while (cbCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cbCache.keys().next().value;
    if (oldestKey === undefined) break;
    cbCache.delete(oldestKey);
  }
}

export function getCrunchbaseSnippets(lead: LeadRecord): Promise<CrunchbaseSnippet[]> {
  const key = cacheKey(lead);
  const now = Date.now();
  evictExpired(now);

  const existing = cbCache.get(key);
  if (existing && existing.expiresAt > now) {
    // Re-insert so this key becomes most-recent in iteration order (LRU touch).
    cbCache.delete(key);
    cbCache.set(key, existing);
    return existing.promise;
  }

  const promise = fetchCrunchbaseResults(lead);
  cbCache.set(key, { promise, expiresAt: now + CACHE_TTL_MS });
  evictOldest();
  return promise;
}

export function clearCrunchbaseCache(): void {
  cbCache.clear();
}

/** Test-only: number of live entries (post-expiry sweep). */
export function _crunchbaseCacheSize(): number {
  evictExpired(Date.now());
  return cbCache.size;
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/** Extract a short context window around a regex match for sourceQuote. */
function extractContextWindow(text: string, idx: number, radius = 60): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** Build the combined source-context string for citation verification. */
export function buildCrunchbaseSourceContext(snippets: CrunchbaseSnippet[]): string {
  return snippets.map(s => `${s.title}\n${s.snippet}\n${s.url}`).join('\n\n');
}

const FUNDING_STAGES: Array<{ re: RegExp; value: string }> = [
  { re: /\bIPO\b|\bpublic(ly)? listed\b|\bNASDAQ:|\bNYSE:/i,    value: 'Public' },
  { re: /\bacquired by\b|\bacquisition by\b/i,                  value: 'Acquired' },
  { re: /\bSeries\s*[E-Z]\b/i,                                  value: 'Series D+' },
  { re: /\bSeries\s*D[-\s]?\d?\b/i,                             value: 'Series D+' },
  { re: /\bSeries\s*C[-\s]?\d?\b/i,                             value: 'Series C' },
  { re: /\bSeries\s*B[-\s]?\d?\b/i,                             value: 'Series B' },
  { re: /\bSeries\s*A[-\s]?\d?\b/i,                             value: 'Series A' },
  { re: /\bpre-?seed\b/i,                                       value: 'Pre-seed' },
  { re: /\bseed\b/i,                                            value: 'Seed' },
];

export function parseFundingRound(snippets: CrunchbaseSnippet[]): SpecialistResult | null {
  for (const snip of snippets) {
    const haystack = `${snip.title}\n${snip.snippet}`;
    for (const stage of FUNDING_STAGES) {
      const m = haystack.match(stage.re);
      if (m && m.index !== undefined) {
        return {
          value: stage.value,
          confidence: 'high',
          source: 'web_search', provider: 'crunchbase',
          sourceUrl: snip.url,
          sourceQuote: extractContextWindow(haystack, m.index, 60),
        };
      }
    }
  }
  return null;
}

export function parseTotalFunding(snippets: CrunchbaseSnippet[]): SpecialistResult | null {
  for (const snip of snippets) {
    const haystack = `${snip.title}\n${snip.snippet}`;
    const m = haystack.match(/\$\s*([\d.]+)\s*(K|M|MM|B|million|billion|thousand)\b/i);
    if (m && m.index !== undefined) {
      const num = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const mult =
        unit === 'b' || unit === 'billion'      ? 1e9 :
        unit === 'm' || unit === 'mm' || unit === 'million' ? 1e6 :
        unit === 'k' || unit === 'thousand'     ? 1e3 :
                                                   1;
      if (isNaN(num)) continue;
      return {
        value: String(Math.round(num * mult)),
        // Snippets often show last-round amount, not total — use medium confidence
        confidence: 'medium',
        source: 'web_search', provider: 'crunchbase',
        sourceUrl: snip.url,
        sourceQuote: extractContextWindow(haystack, m.index, 40),
      };
    }
  }
  return null;
}

const HQ_CITY_RES: RegExp[] = [
  // Crunchbase title format: "Stripe - San Francisco, California, US"
  /[-—•|]\s*([A-Z][A-Za-z][A-Za-z\s]*?),\s*[A-Z][A-Za-z\s]+,\s*(?:US|USA|United States|UK|United Kingdom|Canada|India)\b/,
  // "Headquarters: Palo Alto"
  /\bheadquart(?:er|ered) (?:in|at|:)\s*([A-Z][A-Za-z][A-Za-z\s]+?)(?:,|\s+(?:CA|California|United States))/i,
  // "Based in San Francisco"
  /\bbased in\s+([A-Z][A-Za-z][A-Za-z\s]+?)(?:,|\s+(?:CA|California))/i,
];

export function parseHqCity(snippets: CrunchbaseSnippet[]): SpecialistResult | null {
  for (const snip of snippets) {
    const haystack = `${snip.title}\n${snip.snippet}`;
    for (const re of HQ_CITY_RES) {
      const m = haystack.match(re);
      if (m && m.index !== undefined && m[1]) {
        return {
          value: m[1].trim(),
          confidence: 'high',
          source: 'web_search', provider: 'crunchbase',
          sourceUrl: snip.url,
          sourceQuote: extractContextWindow(haystack, m.index, 50),
        };
      }
    }
  }
  return null;
}

// ── FieldSpecialist exports ──────────────────────────────────────────────────

async function resolveFunding(lead: LeadRecord): Promise<SpecialistResult | null> {
  return parseFundingRound(await getCrunchbaseSnippets(lead));
}
async function resolveTotalFunding(lead: LeadRecord): Promise<SpecialistResult | null> {
  return parseTotalFunding(await getCrunchbaseSnippets(lead));
}
async function resolveHqCity(lead: LeadRecord): Promise<SpecialistResult | null> {
  return parseHqCity(await getCrunchbaseSnippets(lead));
}

export const crunchbaseFundingRound: FieldSpecialist = {
  fieldName: 'funding_round',
  label: 'crunchbase-serp',
  resolve: resolveFunding,
};

export const crunchbaseTotalFunding: FieldSpecialist = {
  fieldName: 'total_funding_usd',
  label: 'crunchbase-serp',
  resolve: resolveTotalFunding,
};

export const crunchbaseHqCity: FieldSpecialist = {
  fieldName: 'hq_city',
  label: 'crunchbase-serp',
  resolve: resolveHqCity,
};

/**
 * Returns the source-context string for the Crunchbase snippets that powered
 * the current cached lookup, so the pipeline can append it to combinedSource
 * for citation verification. Returns empty string if no fetch happened.
 */
export async function getCrunchbaseSourceContext(lead: LeadRecord): Promise<string> {
  const snips = await getCrunchbaseSnippets(lead);
  return buildCrunchbaseSourceContext(snips);
}
