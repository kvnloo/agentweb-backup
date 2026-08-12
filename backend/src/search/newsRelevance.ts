/**
 * ENG-1050 — relevance guard for You.com news results.
 *
 * You.com's /v1/search `news` bucket behaves as a loosely-matched trending feed
 * rather than a query-scoped news index: it routinely returns general world /
 * sports / celebrity headlines that share only a generic token with the query
 * ("payment", "guest", "launch"). A weekly competitor digest built on top of it
 * therefore reported articles about the Yemen conflict for "Zenoti" and King
 * Charles' castle for "Guesty".
 *
 * These helpers reduce a query to the terms that actually identify its subject
 * and check whether an article mentions the primary one, i.e. whether it is
 * about that subject at all.
 */

/**
 * Words that carry no identifying power in a news query: English function words,
 * news-intent words the caller is told to keep in the query, and the generic
 * company/product nouns that competitor-digest prompts always append.
 */
const NEWS_QUERY_STOPWORDS = new Set([
  'about', 'after', 'all', 'and', 'announced', 'announcement', 'any', 'app', 'apps',
  'are', 'article', 'articles', 'best', 'breaking', 'brand', 'business', 'but', 'com',
  'companies', 'company', 'competitor', 'competitors', 'corp', 'coverage', 'current',
  'currently', 'digest', 'firm', 'for', 'from', 'group', 'has', 'headline', 'headlines',
  'have', 'holdings', 'http', 'https', 'inc', 'into', 'its', 'last', 'latest', 'llc',
  'ltd', 'market', 'month', 'new', 'news', 'not', 'off', 'onto', 'organization', 'other',
  'our', 'over', 'page', 'past', 'platform', 'platforms', 'product', 'products',
  'recent', 'recently', 'report', 'reports', 'search', 'service', 'services', 'site',
  'software', 'solution', 'solutions', 'story', 'stories', 'suite', 'summary', 'systems',
  'that', 'the', 'their', 'there', 'these', 'they', 'this', 'those', 'today',
  'tool', 'tools', 'top', 'update', 'updates', 'vendor', 'was', 'website', 'week',
  'were', 'what', 'when', 'which', 'who', 'why', 'with', 'www', 'year', 'yesterday',
]);

const MIN_TERM_LENGTH = 3;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []);
}

/** Tokens of the query with their original casing preserved. */
function tokenizeWithCase(text: string): string[] {
  return (text.match(/[A-Za-z0-9]+/g) || []);
}

/**
 * Crude singularization so "payments" in the query matches "payment" in a
 * headline. Deliberately does NOT strip other suffixes: "striped" must not
 * satisfy the term "stripe".
 */
function singularize(token: string): string {
  if (token.length > MIN_TERM_LENGTH && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * The terms of a query that identify its subject, in query order, deduplicated.
 * Returns an empty list for a purely generic query ("latest news today") — there
 * is then nothing to judge relevance against, so nothing may be filtered out.
 */
export function extractSignificantTerms(query: string): string[] {
  const terms: string[] = [];
  for (const rawToken of tokenize(query || '')) {
    if (rawToken.length < MIN_TERM_LENGTH) continue;
    if (NEWS_QUERY_STOPWORDS.has(rawToken)) continue;
    const term = singularize(rawToken);
    if (NEWS_QUERY_STOPWORDS.has(term)) continue;
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}

/**
 * The terms relevance is actually anchored on: the ones naming the entity the
 * query is about, as opposed to the descriptors around it.
 *
 * Capitalisation in the query is the signal. Callers compose these queries from
 * a company name plus industry and business-signal words ("AI startup Zenoti
 * funding", "Grammarly Superhuman email"), and they capitalise the company and
 * not the descriptors. Anchoring on query order instead would pick "startup"
 * and "enterprise" as the subject and let the trending feed straight back in.
 *
 * Two fallbacks to the first significant term, both meaning "capitalisation told
 * us nothing here": an all-lowercase query, and a query where every significant
 * term is capitalised (title case, e.g. "Stripe Payments" — treating "Payments"
 * as an entity would readmit the noise this exists to block).
 */
export function extractAnchorTerms(query: string): string[] {
  const significantTerms = extractSignificantTerms(query);
  if (!significantTerms.length) return [];

  const capitalized = new Set(
    tokenizeWithCase(query || '')
      .filter((token) => /^[A-Z]/.test(token))
      .map((token) => singularize(token.toLowerCase())),
  );
  const anchors = significantTerms.filter((term) => capitalized.has(term));

  return anchors.length && anchors.length < significantTerms.length
    ? anchors
    : significantTerms.slice(0, 1);
}

export interface RelevanceCandidate {
  title?: string;
  url?: string;
  snippet?: string;
  snippets?: string[];
}

/**
 * True when the article mentions one of the query's anchor terms — the entities
 * the query is about. Counting term hits instead would cut both ways: requiring
 * two throws away the headlines a competitor digest exists to find, because a
 * real one names the company and nothing else ("Stripe launches Tempo",
 * "UpKeep raises $50M Series C"), while accepting any one term lets the trending
 * feed back in through a descriptor ("vacation resorts" for a Guesty query).
 * Anchoring on the entities keeps the first and rejects the second.
 *
 * Pass the output of {@link extractAnchorTerms}; an empty list means the query
 * named no entity to judge against, so nothing is filtered out.
 *
 * Whole-token matching only (after singularization), so "guest" does not satisfy
 * "guesty" and "striped" does not satisfy "stripe".
 */
export function isRelevantToQuery(result: RelevanceCandidate, anchorTerms: string[]): boolean {
  if (!anchorTerms.length) return true;

  const haystack = [
    result.title || '',
    result.snippet || '',
    ...(result.snippets || []),
    result.url || '',
  ].join(' ');

  const tokens = new Set(tokenize(haystack).map(singularize));
  return anchorTerms.some((term) => tokens.has(term));
}
