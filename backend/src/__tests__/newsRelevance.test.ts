/**
 * ENG-1050 — relevance guard for You.com news results.
 *
 * You.com's /v1//search `news` bucket is a loosely-matched trending feed rather
 * than a query-scoped news index: an entity query such as
 * "Guesty vacation rental software company news" comes back with headlines about
 * King Charles' Scottish castle and Zelenskyy visiting Serbia. These helpers
 * decide whether a returned article has any lexical connection to the query.
 */
import { extractSignificantTerms, isRelevantToQuery } from '../search/newsRelevance';

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

describe('isRelevantToQuery (ENG-1050)', () => {
  const terms = extractSignificantTerms('Guesty vacation rental software company news');

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
      isRelevantToQuery(result('Stripe launches Tempo'), extractSignificantTerms('Stripe payments news')),
    ).toBe(true);
    expect(
      isRelevantToQuery(
        result('UpKeep raises $50M Series C'),
        extractSignificantTerms('UpKeep CMMS maintenance management software company'),
      ),
    ).toBe(true);
    expect(
      isRelevantToQuery(result('Surfer acquires ContentGecko'), extractSignificantTerms('Surfer SEO tool')),
    ).toBe(true);
    expect(
      isRelevantToQuery(
        result('Zenoti names new CFO'),
        extractSignificantTerms('Zenoti spa salon med-spa software funding OR acquisition OR launch'),
      ),
    ).toBe(true);
  });

  it('rejects trending-feed noise that matches only descriptor terms', () => {
    // Same digest queries as above, with the entity term absent.
    expect(
      isRelevantToQuery(
        result('Fire department buys new ladder', 'Santa Rosa approves the purchase.'),
        extractSignificantTerms('Zenoti spa salon med-spa software funding OR acquisition OR launch'),
      ),
    ).toBe(false);
    expect(
      isRelevantToQuery(
        result('Maintenance backlog grows at city facilities', 'Management weighs software options.'),
        extractSignificantTerms('UpKeep CMMS maintenance management software company'),
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
    const zenoti = extractSignificantTerms('Zenoti');
    expect(isRelevantToQuery(result('Zenoti raises a new round'), zenoti)).toBe(true);
    expect(isRelevantToQuery(result('Zendaya en EL PAIS'), zenoti)).toBe(false);
  });

  it('does not treat a longer word that merely starts with a term as a match', () => {
    const stripe = extractSignificantTerms('Stripe payments');
    expect(isRelevantToQuery(result('Maryland closes bay for striped bass fishing'), stripe)).toBe(false);
    expect(isRelevantToQuery(result('Set Up Stripe Payments: A Comprehensive Guide'), stripe)).toBe(true);
  });

  it('keeps everything when the query has no significant terms to judge against', () => {
    expect(isRelevantToQuery(result('AI CEOs are in their manifesto era'), [])).toBe(true);
  });
});
