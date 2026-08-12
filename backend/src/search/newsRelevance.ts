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

/**
 * Minimum length for a term written in a script without spaces between words.
 * Two characters is a complete company name there (索尼, 楽天), where three
 * would discard the entity the query is about.
 */
const MIN_UNSEGMENTED_TERM_LENGTH = 2;

/** Han, Hiragana, Katakana — the scripts that do not delimit words with spaces. */
const UNSEGMENTED_SCRIPT = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * Tokenizing on `[a-z0-9]` alone silently disabled this whole guard for any
 * non-Latin query: "Сбербанк новости" produced no terms at all, so nothing could
 * be filtered and the trending feed came back untouched. Matching on Unicode
 * letters/numbers instead covers every alphabetic script.
 */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

/** Tokens of the query with their original casing preserved. */
function tokenizeWithCase(text: string): string[] {
  return (text.match(/[\p{L}\p{N}]+/gu) || []);
}

/**
 * True for a term in a script that writes without word boundaries. Chinese and
 * Japanese text tokenizes into one long run rather than into words, so whole-token
 * equality can never match there ("ソニー" would not match "ソニーグループ") and such
 * terms have to be matched by containment instead.
 */
function isUnsegmented(term: string): boolean {
  return UNSEGMENTED_SCRIPT.test(term);
}

function minLengthFor(token: string): number {
  return isUnsegmented(token) ? MIN_UNSEGMENTED_TERM_LENGTH : MIN_TERM_LENGTH;
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
    if (rawToken.length < minLengthFor(rawToken)) continue;
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
 * An ALL-CAPS token is weaker evidence than a Title-Cased one, because the
 * category is capitalised that way too: "UpKeep CMMS maintenance management"
 * anchored on CMMS as well as UpKeep and so kept "Best CMMS Software for 2026"
 * and "Top 10 CMMS software in Australia", which name no company at all. So
 * acronyms only count when the query Title-Cases nothing ("IBM earnings").
 *
 * Two fallbacks to the first significant term, both meaning "capitalisation told
 * us nothing here": an all-lowercase query, and a query where every significant
 * term is capitalised (title case, e.g. "Stripe Payments" — treating "Payments"
 * as an entity would readmit the noise this exists to block).
 */
export function extractAnchorTerms(query: string): string[] {
  const significantTerms = extractSignificantTerms(query);
  if (!significantTerms.length) return [];

  const capitalizedTokens = tokenizeWithCase(query || '').filter((token) => /^\p{Lu}/u.test(token));
  const titleCased = capitalizedTokens.filter((token) => /\p{Ll}/u.test(token));
  const preferred = titleCased.length ? titleCased : capitalizedTokens;

  const capitalized = new Set(preferred.map((token) => singularize(token.toLowerCase())));
  const anchors = significantTerms.filter((term) => capitalized.has(term));

  return anchors.length && anchors.length < significantTerms.length
    ? anchors
    : significantTerms.slice(0, 1);
}

/**
 * The remaining significant terms once the anchors are removed — the descriptors
 * that say which sense of the anchor the query means ("SEO" for Surfer, "vacation
 * rental" for Guesty, "payments" for Stripe). Used to corroborate a match in the
 * untrusted news bucket; empty for a bare entity query, which then has nothing to
 * corroborate with.
 */
export function extractSupportTerms(query: string): string[] {
  const anchors = new Set(extractAnchorTerms(query));
  return extractSignificantTerms(query).filter((term) => !anchors.has(term));
}

export interface RelevanceCandidate {
  title?: string;
  url?: string;
  snippet?: string;
  snippets?: string[];
}

export interface RelevanceOptions {
  /**
   * Where the anchor has to appear. 'headline' means the title or URL — a passing
   * mention in the body does not count.
   */
  scope?: 'anywhere' | 'headline';
  /**
   * When non-empty, at least one of these must also appear somewhere in the
   * result for it to count as relevant.
   */
  supportTerms?: string[];
}

function haystackFor(result: RelevanceCandidate, scope: 'anywhere' | 'headline'): string {
  const parts = scope === 'headline'
    ? [result.title || '', result.url || '']
    : [result.title || '', result.snippet || '', ...(result.snippets || []), result.url || ''];
  return parts.join(' ').toLowerCase();
}

function mentions(haystack: string, terms: string[]): boolean {
  const tokens = new Set(tokenize(haystack).map(singularize));
  // Unsegmented scripts have no token boundaries to match on, so containment is
  // the only workable test there; everything else stays whole-token.
  return terms.some((term) => (isUnsegmented(term) ? haystack.includes(term) : tokens.has(term)));
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
 *
 * `options` tunes how much evidence a bucket has to supply, because the two
 * You.com buckets are not equally trustworthy:
 *  - `supportTerms` (used for the news bucket) demands corroboration from the rest
 *    of the query. A one-word anchor that is also a common noun otherwise readmits
 *    exactly the reported noise — "stripe" matches "black stripes removed after
 *    camp practice", "surfer" matches "these beaches are a surfer's dream". A real
 *    article about the company names the domain somewhere too.
 *  - `scope: 'headline'` (used for the web bucket) demands the anchor in the title
 *    or URL. Every residual false positive traced there was a page merely listing
 *    the company in its body — a YC company index, a Lodgify review, a Tracxn
 *    profile, a video with a sponsor plug.
 * The news bucket deliberately keeps the wider 'anywhere' scope: real coverage does
 * put the company in the lede rather than the headline.
 */
export function isRelevantToQuery(
  result: RelevanceCandidate,
  anchorTerms: string[],
  options: RelevanceOptions = {},
): boolean {
  if (!anchorTerms.length) return true;

  if (!mentions(haystackFor(result, options.scope || 'anywhere'), anchorTerms)) return false;

  const supportTerms = options.supportTerms || [];
  if (!supportTerms.length) return true;

  return mentions(haystackFor(result, 'anywhere'), supportTerms);
}

/**
 * Hosts that only ever serve evergreen reference material: encyclopaedias,
 * company-profile databases, software review directories, app stores. They rank
 * well for a company name and are never this week's news about it.
 */
const NON_COVERAGE_HOSTS = [
  // Reference works. "UpKeep maintenance" over a month returns three Merriam-Webster
  // entries for the noun; "Guesty" returns a fan wiki.
  'wikipedia.org', 'wikiwand.com', 'wiktionary.org', 'britannica.com', 'fandom.com',
  'miraheze.org', 'merriam-webster.com', 'dictionary.com', 'thesaurus.com',
  'dictionary.cambridge.org', 'collinsdictionary.com', 'vocabulary.com', 'urbandictionary.com',
  // Company-profile and software-review directories.
  'crunchbase.com', 'tracxn.com', 'pitchbook.com', 'dealroom.co', 'zoominfo.com', 'owler.com',
  'g2.com', 'capterra.com', 'getapp.com', 'softwareadvice.com', 'trustpilot.com',
  'glassdoor.com', 'indeed.com',
  // App stores and extension galleries.
  'apkpure.com', 'apkpure.net', 'apkcombo.com', 'apps.apple.com', 'play.google.com',
  'podcasts.apple.com', 'chromewebstore.google.com', 'chrome.google.com',
  'microsoftedge.microsoft.com', 'addons.mozilla.org',
];

/**
 * Subdomains that host a product surface rather than editorial content —
 * `support.stripe.com`, `trust.zenoti.com`, `docs.*`, `status.*`.
 */
const NON_COVERAGE_HOST_PREFIXES = [
  'support.', 'help.', 'docs.', 'doc.', 'developer.', 'developers.', 'api.',
  'status.', 'trust.', 'careers.', 'jobs.', 'login.', 'account.', 'dashboard.', 'app.',
];

/** Path segments that identify a product/marketing surface rather than an article. */
const NON_COVERAGE_PATH_SEGMENTS = new Set([
  'help', 'support', 'docs', 'documentation', 'faq', 'faqs', 'pricing', 'plans',
  'careers', 'jobs', 'legal', 'terms', 'privacy', 'login', 'signin', 'signup',
  'register', 'contact', 'about', 'status', 'integrations', 'api', 'developer',
  'developers', 'download', 'downloads',
  // Reference and marketing-collateral surfaces: wiki articles, dictionary
  // entries, landing pages, extension listings.
  'wiki', 'dictionary', 'thesaurus', 'definition', 'meaning', 'lp', 'addons', 'add-ons',
]);

/**
 * Evergreen commercial-content shapes, matched anywhere in the path because they
 * are usually part of a slug ("/top-stripe-alternatives/", "/surfer-seo-coupons").
 *
 * The vendor-comparison genre is the bulk of what a company-name query returns
 * and none of it is news: "maintainx-vs-upkeep", "guesty-vs-hostaway",
 * "surfer-seo-review", "best-cmms-software", "top-cmms-solutions-uk".
 */
const NON_COVERAGE_PATH_MARKERS = [
  'alternative', 'coupon', 'promo-code', 'discount-code', 'pricing',
  '-vs-', '/vs-', '/compare', 'comparison', 'review', 'best-', '/top-', '-guide',
];

/**
 * Whether a web-bucket URL could be coverage at all.
 *
 * You.com's `page_age` is a crawl/refresh timestamp, not a publication date, so a
 * freshness window does not exclude evergreen pages: "Stripe payments" over the
 * last week returns Stripe's Wikipedia entry, five `support.stripe.com` help
 * articles, a Trustpilot profile and a "Best Stripe Alternatives" listicle — every
 * one of them genuinely about Stripe, none of them news. Left in, a weekly
 * competitor digest gets padded with vendor documentation instead of reporting
 * that there was no news; the point of the fallback is coverage the news bucket
 * missed, so pages that cannot be coverage are dropped.
 *
 * Deliberately narrow: it excludes surfaces, not domains. A company's own
 * newsroom, blog or press release still counts as coverage.
 */
export function isCoverageCandidate(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // Not parseable — no grounds to exclude it.
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (NON_COVERAGE_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
  if (NON_COVERAGE_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))) return false;

  const path = parsed.pathname.toLowerCase();
  const segments = path.split('/').filter(Boolean);
  if (segments.some((segment) => NON_COVERAGE_PATH_SEGMENTS.has(segment))) return false;
  if (NON_COVERAGE_PATH_MARKERS.some((marker) => path.includes(marker))) return false;

  return true;
}

/** Words that make You.com treat a query as a news query and populate its news bucket. */
const NEWS_INTENT_TERMS = new Set([
  'news', 'headline', 'headlines', 'breaking', 'announcement', 'announcements',
  'press', 'latest', 'update', 'updates', 'story', 'stories', 'report', 'reports',
]);

/** True when the query itself asks for news, so You.com will rank for recency. */
export function hasNewsIntent(query: string): boolean {
  return tokenize(query || '').some((token) => NEWS_INTENT_TERMS.has(token));
}
