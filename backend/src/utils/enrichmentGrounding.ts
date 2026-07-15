/**
 * Deterministic grounding + entity-identity helpers for V3 web-tier enrichment
 * (ENG-122). A web-tier value is only "verified" when the fact it states can be
 * found in the *real* fetched source text; a value whose stated company differs
 * from the lead's company is a wrong-entity match (the "Slash" vs "Slashy" bug)
 * and must be dropped, not merely flagged.
 *
 * These are pure string functions with no I/O so they can be unit-tested in
 * isolation and reused by both the extraction gate and the critic.
 */

/** Lowercase + collapse all whitespace to single spaces. */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Currency/scale words → multiplier, so "$100 million", "$100M", "$100mm" and
// "100,000,000" all canonicalize to the same numeric token ("100000000").
const SCALE_WORDS: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
};

/**
 * Extract canonical numeric tokens from a string, normalizing currency symbols,
 * thousands separators, and scale words/suffixes. "$100 million" / "$100M" /
 * "100,000,000" all yield "100000000". Bare integers yield their digit string.
 * Used so a correct figure is never dropped over formatting differences.
 */
export function extractNumericTokens(s: string): Set<string> {
  const out = new Set<string>();
  const text = s.toLowerCase();
  // Match a number (optionally with commas/decimal) followed by an optional
  // scale word/suffix (m, mm, mn, bn, k, million, billion, ...).
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|mm|mn|m|bn|b|t|thousand|million|billion|trillion)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const rawNum = match[1].replace(/,/g, '');
    if (rawNum === '' || rawNum === '.') continue;
    const base = parseFloat(rawNum);
    if (!isFinite(base)) continue;
    const scaleKey = match[2];
    const mult = scaleKey ? SCALE_WORDS[scaleKey] ?? 1 : 1;
    const value = base * mult;
    // Canonicalize as an integer string when whole, else fixed decimal.
    const canon = Number.isInteger(value) ? value.toFixed(0) : String(value);
    out.add(canon);
  }
  return out;
}

/** True when every 5-consecutive-word window logic from V2 finds `quote` in
 *  `source`. Handles minor LLM rephrasing without letting hallucinations pass. */
function softWindowMatch(normQuote: string, normSource: string): boolean {
  const MAX_QUOTE_WORDS = 60;
  const words = normQuote.split(' ').filter(Boolean).slice(0, MAX_QUOTE_WORDS);
  if (words.length < 5) return false;
  for (let i = 0; i + 5 <= words.length; i++) {
    const window = words.slice(i, i + 5).join(' ');
    if (normSource.includes(window)) return true;
  }
  return false;
}

/** True when the quote actually supports the value, rather than merely being a
 *  real sentence from the page. A numeric value must have all of its numbers in
 *  the quote; a short textual value must appear in it; a long one needs a 5-word
 *  window. Without this, any genuine quote launders any answer (ENG-122). */
function valueSupportedByQuote(
  normValue: string,
  valueNums: Set<string>,
  normQuote: string,
): boolean {
  if (valueNums.size > 0) {
    const quoteNums = extractNumericTokens(normQuote);
    return [...valueNums].every(n => quoteNums.has(n));
  }
  if (!normValue) return false;
  if (normValue.split(' ').length <= 8) return normQuote.includes(normValue);
  return softWindowMatch(normValue, normQuote);
}

/**
 * Decide whether a web-tier extracted value is grounded in the fetched source.
 *
 * Grounded when EITHER:
 *  1. every numeric token in the value appears (format-normalized) in the source
 *     — so "$100M" grounds against a page that says "$100 million"; or
 *  2. the model cited a quote that is really in the source (verbatim, or via a
 *     5-consecutive-word window for light rephrasing) AND that quote actually
 *     supports the value; or
 *  3. no quote was cited and the value itself (≤ 8 words) is a substring of the
 *     source — covers short firmographic values returned without a quote.
 *
 * A cited quote is the model's own evidence, so it is binding: if the quote is
 * absent from the source, or is present but says nothing about the value, the
 * value is NOT grounded and must not fall back to a weaker rule. Facebook's
 * funding_stage came back "Grant (prize money)" carrying the (real) quote for
 * *total_funding*; checking only quote-in-source stamped it grounded/high and
 * showed a wrong answer as verified fact.
 *
 * Formatting differences never cause a false "ungrounded": a correct figure with
 * a different currency/scale style still grounds via rule 1.
 */
export function groundWebValue(
  value: string,
  quote: string | undefined,
  source: string,
): boolean {
  const normSource = normalizeText(source);
  if (!normSource) return false;

  // Rule 1 (numeric): if the value carries numbers, they must all appear in the
  // source (in any format). This is the strongest signal for funding figures and
  // already ties the VALUE to the source, so it stands on its own.
  const valueNums = extractNumericTokens(value);
  if (valueNums.size > 0) {
    const sourceNums = extractNumericTokens(source);
    const allPresent = [...valueNums].every(n => sourceNums.has(n));
    if (allPresent) return true;
  }

  const normValue = normalizeText(value);

  // Rule 2 (quote grounding). The quote must be real AND must support the value.
  if (typeof quote === 'string' && quote.trim()) {
    const normQuote = normalizeText(quote);
    const quoteInSource =
      (!!normQuote && normSource.includes(normQuote)) || softWindowMatch(normQuote, normSource);
    if (!quoteInSource) return false;
    return valueSupportedByQuote(normValue, valueNums, normQuote);
  }

  // Rule 3 (no quote cited): a short value must appear verbatim in the source.
  return !!normValue && normValue.split(' ').length <= 8 && normSource.includes(normValue);
}

// Legal-entity suffixes stripped before comparing company names, so
// "Slash Inc" matches "Slash" but "Slash" still differs from "Slashy".
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'sa', 'ag', 'llp', 'lp', 'group', 'holdings',
]);

/** Normalize a company name to comparable tokens: lowercase, strip punctuation
 *  and legal suffixes. "Slash, Inc." → ["slash"]; "Slashy" → ["slashy"]. */
function companyTokens(name: string): string[] {
  return normalizeText(name)
    .replace(/[.,/#!$%^&*;:{}=\-_`~()"']/g, ' ')
    .split(' ')
    .filter(t => t.length > 0 && !LEGAL_SUFFIXES.has(t));
}

/**
 * True when `claimed` (the company the LLM says its answer describes) refers to
 * the SAME company as the lead's `leadCompany`. Strict on the distinguishing
 * token so "Slash" ≠ "Slashy" and "Stripe" ≠ "Stripes", tolerant of case,
 * punctuation, and legal suffixes ("Slash Inc" == "Slash").
 *
 * A missing/blank claimed name returns false: the AI-knowledge path REQUIRES a
 * confirmable entity, so an unstated one fails the gate (the anti-Slashy guard).
 */
export function companyNameMatches(
  leadCompany: string | undefined | null,
  claimed: string | undefined | null,
): boolean {
  if (!leadCompany || !claimed) return false;
  const a = companyTokens(leadCompany);
  const b = companyTokens(claimed);
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  // Exact token-set equality, order-insensitive.
  if (setA.size === setB.size && [...setA].every(t => setB.has(t))) return true;
  // Otherwise require that the shorter name's tokens are all present as WHOLE
  // tokens in the longer name (handles "Slash" vs "Slash Labs" but rejects
  // "Slash" vs "Slashy", since "slash" is not a whole token of "slashy").
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  return [...small].every(t => big.has(t));
}
