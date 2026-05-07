/**
 * Heuristic extractor: ICPPersona → LinkedIn search filter shape.
 *
 * Phase 2 entry-point version — regex/heuristic only, NO LLM call. The
 * full LLM parser lands in a later phase. The job here is to pre-fill
 * the Find Leads modal with sensible defaults the user can refine,
 * NOT to produce a perfect query.
 *
 * Strategy:
 *   - title:    last 2 words of persona.name (e.g., "Mid-market RevOps
 *               Leaders" → "RevOps Leaders") — names tend to encode the
 *               role + seniority at the tail.
 *   - keywords: first sentence of meta_targeting_brief, truncated to
 *               200 chars. Falls back to persona.name when brief absent.
 *   - industry/location: only extracted when the brief contains an
 *               obvious "in <region>" or "<industry> companies" idiom.
 *               Conservative on purpose — over-extraction creates worse
 *               searches than under-extraction.
 */

import type { ICPPersona } from './icpStatusService';

export interface ExtractedIcpFilters {
  keywords?: string;
  title?: string;
  industry?: string;
  location?: string;
}

const TITLE_TAIL_WORDS = 2;
const KEYWORD_MAX_LEN = 200;

/** Pull the last N words off a name (trimmed, single-spaced). */
function lastWords(name: string, n: number): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= n) return parts.join(' ');
  return parts.slice(-n).join(' ');
}

/** First sentence of a multi-sentence brief. */
function firstSentence(brief: string): string {
  const m = brief.match(/^[^.!?]+[.!?]?/);
  return (m ? m[0] : brief).trim();
}

/** "in <Region>" idiom — match common location phrases. */
function extractLocation(brief: string): string | undefined {
  // Existing regions/cities — keep first to preserve current behaviour.
  const m = brief.match(/\bin\s+(North America|United States|US|USA|Europe|EMEA|EU|APAC|Asia|UK|Canada|Australia|San Francisco Bay Area|New York|London|Berlin)\b/i);
  if (m) return m[1];
  // Additional major cities — appended so existing matches still win.
  const m2 = brief.match(/\b(?:in|based in)\s+(Tokyo|Singapore|Toronto|Sydney|Dubai|Tel Aviv|Paris|Amsterdam|Stockholm|Dublin|Boston|Seattle|Austin|Chicago|Miami|Los Angeles|Atlanta|Denver|Portland|Vancouver|Montreal)\b/i);
  if (m2) return m2[1];
  // Generic "based in <City>" idiom — capture 1-3 Capitalised words.
  const m3 = brief.match(/\bbased in\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/);
  return m3 ? m3[1] : undefined;
}

/** "<Industry> companies" or "<Industry>-focused" idiom. */
function extractIndustry(brief: string): string | undefined {
  // Multi-word industries first so they win over single-word matches like "SaaS".
  const multi = brief.match(/\b(B2B SaaS|Consumer SaaS|Climate Tech|Real Estate Tech|Machine Learning)\b/i);
  if (multi) {
    // Normalise casing to canonical form.
    const canonical: Record<string, string> = {
      'b2b saas': 'B2B SaaS',
      'consumer saas': 'Consumer SaaS',
      'climate tech': 'Climate Tech',
      'real estate tech': 'Real Estate Tech',
      'machine learning': 'Machine Learning',
    };
    return canonical[multi[1].toLowerCase()] ?? multi[1];
  }
  const m = brief.match(/\b(SaaS|FinTech|HealthTech|EdTech|MarTech|AdTech|BioTech|CleanTech|PropTech|InsurTech|E-commerce|Marketplace|DevTools|Cybersecurity|AI|Machine Learning|ClimateTech|Robotics|Logistics|Web3|Crypto|DTC|D2C)\s+(companies|startups|firms|businesses|industry|brands)\b/i);
  if (m) return m[1];
  const m2 = brief.match(/\b(SaaS|FinTech|HealthTech|EdTech|MarTech|AdTech|BioTech|CleanTech|PropTech|InsurTech|E-commerce|Marketplace|DevTools|Cybersecurity|ClimateTech|Robotics|Logistics|Web3|Crypto|DTC|D2C)\b/);
  return m2 ? m2[1] : undefined;
}

export function extractIcpFilters(persona: ICPPersona): ExtractedIcpFilters {
  const out: ExtractedIcpFilters = {};
  const name = (persona.name ?? '').trim();
  const brief = (persona.meta_targeting_brief ?? '').trim();

  if (name) {
    out.title = lastWords(name, TITLE_TAIL_WORDS);
  }

  if (brief) {
    let kw = firstSentence(brief);
    if (kw.length > KEYWORD_MAX_LEN) kw = kw.slice(0, KEYWORD_MAX_LEN - 3) + '...';
    out.keywords = kw;
    const loc = extractLocation(brief);
    if (loc) out.location = loc;
    const ind = extractIndustry(brief);
    if (ind) out.industry = ind;
  } else if (name) {
    out.keywords = name.slice(0, KEYWORD_MAX_LEN);
  }

  return out;
}
