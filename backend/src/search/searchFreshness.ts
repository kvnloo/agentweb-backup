import { SearchRequest } from './searchProvider';

type SearchFreshness = NonNullable<SearchRequest['freshness']>;

const DAY_SIGNALS = [
  /\btoday\b/i,
  /\bbreaking\b/i,
  /\bright now\b/i,
  /\blast\s+24\s+hours?\b/i,
  /\bpast\s+24\s+hours?\b/i,
];

const WEEK_SIGNALS = [
  /\blatest\b/i,
  /\bcurrent\b/i,
  /\brecent\b/i,
  /\bthis\s+week\b/i,
  /\bnews\b/i,
  /\bupdates?\b/i,
  /\brelease\s+notes?\b/i,
  /\bchangelog\b/i,
];

export function inferSearchFreshness(query: string): SearchFreshness | undefined {
  const normalized = query.trim();
  if (!normalized) return undefined;

  if (DAY_SIGNALS.some((pattern) => pattern.test(normalized))) {
    return 'day';
  }

  if (WEEK_SIGNALS.some((pattern) => pattern.test(normalized))) {
    return 'week';
  }

  return undefined;
}
