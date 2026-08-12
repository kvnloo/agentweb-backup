/**
 * ENG-1050 — relevance guard for You.com news results.
 *
 * You.com's /v1//search `news` bucket is a loosely-matched trending feed rather
 * than a query-scoped news index: an entity query such as
 * "Guesty vacation rental software company news" comes back with headlines about
 * King Charles' Scottish castle and Zelenskyy visiting Serbia. These helpers
 * decide whether a returned article has any lexical connection to the query.
 */
import {
  extractAnchorTerms,
  extractSignificantTerms,
  extractSupportTerms,
  hasNewsIntent,
  isCoverageCandidate,
  isRelevantToQuery,
} from '../search/newsRelevance';

describe('extractSignificantTerms (ENG-1050)', () => {
  it('keeps entity/topic terms and drops boilerplate + news-intent words', () => {
    expect(extractSignificantTerms('Guesty vacation rental software company news'))
      .toEqual(['guesty', 'vacation', 'rental']);
  });

  it('drops boolean operators and short tokens from digest-style queries', () => {
    expect(extractSignificantTerms('Zenoti spa salon software funding OR acquisition OR launch'))
      .toEqual(['zenoti', 'spa', 'salon', 'funding', 'acquisition', 'launch']);
  });

  it('normalizes plurals so "payments" and "payment" are the same term', () => {
    expect(extractSignificantTerms('Stripe payments')).toEqual(['stripe', 'payment']);
  });

  it('returns no terms for a purely generic news query', () => {
    expect(extractSignificantTerms('latest breaking news today')).toEqual([]);
  });

  it('returns no terms for an empty query', () => {
    expect(extractSignificantTerms('   ')).toEqual([]);
  });
});

describe('extractAnchorTerms (ENG-1050)', () => {
  it('anchors on the capitalised entity, not on whatever comes first', () => {
    // Verified against the live You.com API: anchoring on query order picks
    // "startup"/"enterprise" and lets Zenity, Zeni AI and "Top Tech Companies in
    // Hyderabad" through for a Zenoti query — the reported bug, unfixed.
    expect(extractAnchorTerms('AI startup Zenoti funding')).toEqual(['zenoti']);
    expect(extractAnchorTerms('enterprise software company Zenoti')).toEqual(['zenoti']);
  });

  it('anchors on every capitalised entity when a query names more than one', () => {
    expect(extractAnchorTerms('Grammarly Superhuman email')).toEqual(['grammarly', 'superhuman']);
  });

  it('falls back to the first term when capitalisation carries no signal', () => {
    // all-lowercase, and title case where everything is capitalised: treating
    // "Payments" as an entity would readmit the noise the guard exists to block.
    expect(extractAnchorTerms('stripe payments news')).toEqual(['stripe']);
    expect(extractAnchorTerms('Stripe Payments')).toEqual(['stripe']);
    expect(extractAnchorTerms('Surfer SEO tool')).toEqual(['surfer']);
  });

  it('prefers a Title-Cased entity over a capitalised category acronym', () => {
    // Live failure: anchoring on CMMS as well as UpKeep kept "Best CMMS Software
    // for 2026" and "Top 10 CMMS software in Australia", which name no company.
    expect(extractAnchorTerms('UpKeep CMMS maintenance management software company')).toEqual(['upkeep']);
  });

  it('still uses an acronym when the query Title-Cases nothing else', () => {
    expect(extractAnchorTerms('IBM quarterly earnings')).toEqual(['ibm']);
  });

  it('keeps the entity of the digest-style queries from the report', () => {
    expect(extractAnchorTerms('Guesty vacation rental software company news')).toEqual(['guesty']);
    expect(extractAnchorTerms('Zenoti')).toEqual(['zenoti']);
    expect(extractAnchorTerms('Zzyxwqq Holdings')).toEqual(['zzyxwqq']);
  });

  it('returns nothing for a generic query, so nothing gets filtered', () => {
    expect(extractAnchorTerms('latest breaking news today')).toEqual([]);
    expect(extractAnchorTerms('   ')).toEqual([]);
  });
});

describe('isRelevantToQuery (ENG-1050)', () => {
  const terms = extractAnchorTerms('Guesty vacation rental software company news');

  const result = (title: string, snippet = '', url = 'https://example.com/a') => ({
    title,
    url,
    snippet,
    snippets: undefined as string[] | undefined,
  });

  it('rejects world/celebrity news that shares nothing with the query', () => {
    expect(isRelevantToQuery(result("King Charles makes new addition to summer home"), terms)).toBe(false);
    expect(isRelevantToQuery(result("Ukraine's Zelenskyy arrives for first visit to Serbia"), terms)).toBe(false);
  });

  it('rejects a single generic-token coincidence', () => {
    // "guest" must not satisfy the "guesty" entity term.
    expect(isRelevantToQuery(result('Woman Who Went Viral for Her Boutique Guest Room'), terms)).toBe(false);
    // one term out of several is keyword noise, not a topical match
    expect(isRelevantToQuery(result('Best Southern California vacation resorts'), terms)).toBe(false);
  });

  it('keeps a headline that names only the entity, with no descriptor word', () => {
    // The headlines a competitor digest exists to find name the company and
    // nothing else — requiring a second term match would drop every one of them.
    expect(isRelevantToQuery(result('Guesty acquires Rentals United'), terms)).toBe(true);
    expect(
      isRelevantToQuery(result('Stripe launches Tempo'), extractAnchorTerms('Stripe payments news')),
    ).toBe(true);
    expect(
      isRelevantToQuery(
        result('UpKeep raises $50M Series C'),
        extractAnchorTerms('UpKeep CMMS maintenance management software company'),
      ),
    ).toBe(true);
    expect(
      isRelevantToQuery(result('Surfer acquires ContentGecko'), extractAnchorTerms('Surfer SEO tool')),
    ).toBe(true);
    expect(
      isRelevantToQuery(
        result('Zenoti names new CFO'),
        extractAnchorTerms('Zenoti spa salon med-spa software funding OR acquisition OR launch'),
      ),
    ).toBe(true);
  });

  it('rejects trending-feed noise that matches only descriptor terms', () => {
    // Same digest queries as above, with the entity term absent.
    expect(
      isRelevantToQuery(
        result('Fire department buys new ladder', 'Santa Rosa approves the purchase.'),
        extractAnchorTerms('Zenoti spa salon med-spa software funding OR acquisition OR launch'),
      ),
    ).toBe(false);
    expect(
      isRelevantToQuery(
        result('Maintenance backlog grows at city facilities', 'Management weighs software options.'),
        extractAnchorTerms('UpKeep CMMS maintenance management software company'),
      ),
    ).toBe(false);
  });

  it('accepts an article that matches several query terms', () => {
    expect(
      isRelevantToQuery(
        result('Guesty vs Hostaway', 'Vacation rental software comparison for 2026'),
        terms,
      ),
    ).toBe(true);
  });

  it('matches terms found only in the URL', () => {
    expect(
      isRelevantToQuery(result('Funding round announced', 'A software maker raised a round.', 'https://guesty.com/vacation-news'), terms),
    ).toBe(true);
  });

  it('requires the single term of a one-entity query', () => {
    const zenoti = extractAnchorTerms('Zenoti');
    expect(isRelevantToQuery(result('Zenoti raises a new round'), zenoti)).toBe(true);
    expect(isRelevantToQuery(result('Zendaya en EL PAIS'), zenoti)).toBe(false);
  });

  it('does not treat a longer word that merely starts with a term as a match', () => {
    const stripe = extractAnchorTerms('Stripe payments');
    expect(isRelevantToQuery(result('Maryland closes bay for striped bass fishing'), stripe)).toBe(false);
    expect(isRelevantToQuery(result('Set Up Stripe Payments: A Comprehensive Guide'), stripe)).toBe(true);
  });

  it('keeps everything when the query has no significant terms to judge against', () => {
    expect(isRelevantToQuery(result('AI CEOs are in their manifesto era'), [])).toBe(true);
  });
});

describe('non-Latin queries (ENG-1050)', () => {
  const result = (title: string, snippet = '', url = 'https://example.com/a') => ({ title, url, snippet });

  it('extracts terms from a Cyrillic query instead of silently disabling the guard', () => {
    // Tokenizing on [a-z0-9] produced no terms at all here, so nothing could be
    // filtered: a live "Сбербанк новости" search returned pulasan fruit, an
    // indie band and the NHL, untouched.
    expect(extractSignificantTerms('Сбербанк новости')).toEqual(['сбербанк', 'новости']);
    expect(extractAnchorTerms('Сбербанк новости')).toEqual(['сбербанк']);
  });

  it('filters Cyrillic results on the Cyrillic entity', () => {
    const anchors = extractAnchorTerms('Сбербанк новости');
    expect(isRelevantToQuery(result('Сбербанк повысил ставки по вкладам'), anchors)).toBe(true);
    expect(isRelevantToQuery(result('Пуласан — экзотический фрукт'), anchors)).toBe(false);
  });

  it('matches a CJK entity by containment, since the script has no word boundaries', () => {
    // "ソニー" is not a separate token inside "ソニーグループ", so whole-token
    // equality can never match and only containment works here.
    const anchors = extractAnchorTerms('ソニー 決算');
    expect(anchors).toEqual(['ソニー']);
    expect(isRelevantToQuery(result('ソニーグループの決算発表'), anchors)).toBe(true);
    expect(isRelevantToQuery(result('任天堂の新型ハード'), anchors)).toBe(false);
  });

  it('keeps two-character CJK company names, which the 3-character floor discarded', () => {
    expect(extractSignificantTerms('索尼 財報')).toEqual(['索尼', '財報']);
  });
});

describe('extractSupportTerms (ENG-1050)', () => {
  it('returns the descriptors left over once the entity is removed', () => {
    expect(extractSupportTerms('Guesty vacation rental software company news')).toEqual(['vacation', 'rental']);
    expect(extractSupportTerms('Stripe payments')).toEqual(['payment']);
  });

  it('returns nothing for a bare entity query, which has nothing to corroborate with', () => {
    expect(extractSupportTerms('Zenoti')).toEqual([]);
  });
});

describe('isRelevantToQuery match strength (ENG-1050)', () => {
  const result = (title: string, snippet = '', url = 'https://example.com/a') => ({ title, url, snippet });

  it('rejects a common-noun anchor coincidence when the query offers corroboration', () => {
    // Live "Stripe payments news" trending feed. "stripes" singularizes onto the
    // "stripe" anchor, so the anchor alone is not enough for this bucket.
    const anchors = extractAnchorTerms('Stripe payments');
    const supportTerms = extractSupportTerms('Stripe payments');
    expect(isRelevantToQuery(result('Ohio State running backs earn black stripe removal at camp'), anchors)).toBe(true);
    expect(isRelevantToQuery(result('Ohio State running backs earn black stripe removal at camp'), anchors, { supportTerms })).toBe(false);
    expect(isRelevantToQuery(result('These beaches in Sierra Leone are a surfer\'s dream'), extractAnchorTerms('Surfer SEO tool'), {
      supportTerms: extractSupportTerms('Surfer SEO tool'),
    })).toBe(false);
  });

  it('keeps real coverage that names the descriptor anywhere in the body', () => {
    const anchors = extractAnchorTerms('Stripe payments');
    const supportTerms = extractSupportTerms('Stripe payments');
    expect(
      isRelevantToQuery(result('Stripe-PayPal deal would face a regulatory test', 'over payment scale'), anchors, { supportTerms }),
    ).toBe(true);
  });

  it('still accepts an entity-only match when the query has no descriptors', () => {
    expect(
      isRelevantToQuery(result('Zenoti names new CFO'), extractAnchorTerms('Zenoti'), {
        supportTerms: extractSupportTerms('Zenoti'),
      }),
    ).toBe(true);
  });

  it('headline scope rejects a page that only mentions the entity in its body', () => {
    // The residual web-bucket false positives were all of this shape: a YC company
    // index, a Lodgify review page, a Tracxn profile of a different company.
    const anchors = extractAnchorTerms('Zenoti');
    const listing = result('Top 40 salon management startups', 'Includes Booksy, Zenoti and Phorest.', 'https://example.com/list');
    expect(isRelevantToQuery(listing, anchors)).toBe(true);
    expect(isRelevantToQuery(listing, anchors, { scope: 'headline' })).toBe(false);
    expect(isRelevantToQuery(result('Zenoti names new CFO'), anchors, { scope: 'headline' })).toBe(true);
    expect(isRelevantToQuery(result('New CFO appointed', '', 'https://news.example.com/zenoti-cfo'), anchors, { scope: 'headline' })).toBe(true);
  });
});

describe('isCoverageCandidate (ENG-1050)', () => {
  it('rejects evergreen reference and directory hosts', () => {
    expect(isCoverageCandidate('https://en.wikipedia.org/wiki/Stripe,_Inc.')).toBe(false);
    expect(isCoverageCandidate('https://tracxn.com/d/companies/stripe/abc')).toBe(false);
    expect(isCoverageCandidate('https://www.trustpilot.com/review/stripe.com')).toBe(false);
    expect(isCoverageCandidate('https://apkpure.net/zenoti-mobile/com.zenoti.mpos')).toBe(false);
    expect(isCoverageCandidate('https://app.dealroom.co/companies/stripe')).toBe(false);
  });

  it('rejects vendor product surfaces rather than the vendor domain itself', () => {
    expect(isCoverageCandidate('https://support.stripe.com/questions/payment-card-transactions')).toBe(false);
    expect(isCoverageCandidate('https://trust.zenoti.com/')).toBe(false);
    expect(isCoverageCandidate('https://www.guesty.com/pricing/')).toBe(false);
    // ...but the same company's newsroom is exactly what a digest wants.
    expect(isCoverageCandidate('https://stripe.com/newsroom/news/tempo')).toBe(true);
    expect(isCoverageCandidate('https://www.guesty.com/blog/series-f/')).toBe(true);
  });

  it('rejects evergreen commercial listicles that rank for a company name', () => {
    expect(isCoverageCandidate('https://www.forbes.com/advisor/business/software/top-stripe-alternatives/')).toBe(false);
    expect(isCoverageCandidate('https://surferseo.vectortemplates.com/coupons')).toBe(false);
  });

  it('rejects the vendor-comparison genre, which is most of what a company query returns', () => {
    expect(isCoverageCandidate('https://eworkorders.com/learn/maintainx-vs-upkeep/')).toBe(false);
    expect(isCoverageCandidate('https://hoteltechreport.com/compare/guesty-vs-hostaway')).toBe(false);
    expect(isCoverageCandidate('https://contentpen.ai/blog/surfer-seo-review')).toBe(false);
    expect(isCoverageCandidate('https://www.saasworthy.com/list/best-cmms-software')).toBe(false);
  });

  it('rejects reference works, wikis and extension galleries', () => {
    // Live "UpKeep maintenance" over a month returned three dictionary entries
    // for the common noun; "Guesty" returned a fan wiki.
    expect(isCoverageCandidate('https://www.merriam-webster.com/dictionary/upkeep')).toBe(false);
    expect(isCoverageCandidate('https://darkesthours.miraheze.org/wiki/Guesty')).toBe(false);
    expect(isCoverageCandidate('https://microsoftedge.microsoft.com/addons/detail/grammarly-ai/abc')).toBe(false);
    expect(isCoverageCandidate('https://www.zenoti.com/lp/spa-management-software-uk')).toBe(false);
  });

  it('keeps ordinary articles, and anything it cannot parse', () => {
    expect(isCoverageCandidate('https://www.pymnts.com/news/banking/2026/stripe-first-employee-built-bank/')).toBe(true);
    expect(isCoverageCandidate('not a url')).toBe(true);
  });

  it('keeps a dated or news-sectioned article whose slug happens to contain an evergreen word', () => {
    // The evergreen markers are substring matches over the whole path, which is
    // right for a listicle slug and wrong for a story that merely uses the word.
    // An article signal in the path wins over them (Greptile review, PR #2364).
    expect(isCoverageCandidate('https://techcrunch.com/2026/08/11/stripe-pricing-overhaul-for-platforms/')).toBe(true);
    expect(isCoverageCandidate('https://www.reuters.com/technology/2026-08-11-upkeep-raises-series-c-after-strategic-review/')).toBe(true);
    expect(isCoverageCandidate('https://www.zdnet.com/article/surfer-seo-review-tool-acquires-contentgecko/')).toBe(true);
    expect(isCoverageCandidate('https://www.guesty.com/press-release/guesty-vs-market-expansion/')).toBe(true);
  });
});

describe('hasNewsIntent (ENG-1050)', () => {
  it('detects a query that already asks for news', () => {
    expect(hasNewsIntent('Guesty vacation rental software company news')).toBe(true);
    expect(hasNewsIntent('latest AI headlines')).toBe(true);
  });

  it('is false for a bare entity query, which You.com ranks navigationally', () => {
    expect(hasNewsIntent('Stripe payments')).toBe(false);
    expect(hasNewsIntent('Zenoti')).toBe(false);
  });
});
