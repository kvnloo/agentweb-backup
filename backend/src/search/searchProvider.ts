export type SearchProviderName = 'you' | 'google';

export type SearchPurpose =
  | 'agent_research'
  | 'crm_enrichment'
  | 'news'
  | 'deep_research';

export interface SearchRequest {
  query: string;
  count: number;
  freshness?: 'day' | 'week' | 'month' | 'year' | string;
  country?: string;
  language?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  boostDomains?: string[];
  livecrawl?: 'off' | 'web' | 'news' | 'all';
  livecrawlFormat?: 'markdown' | 'html';
  purpose?: SearchPurpose;
}

export interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
  snippets?: string[];
  publishedDate?: string;
  thumbnail?: string | null;
  sourceType?: 'web' | 'news';
  fullContentMarkdown?: string;
}

export interface SearchProviderResponse {
  provider: SearchProviderName;
  query: string;
  results: NormalizedSearchResult[];
  metadata?: Record<string, unknown>;
}

export interface SearchProvider {
  readonly name: SearchProviderName;
  search(request: SearchRequest): Promise<SearchProviderResponse>;
}

export function normalizeSearchCount(count: number, max = 100): number {
  if (!Number.isFinite(count)) return 10;
  return Math.max(1, Math.min(Math.floor(count), max));
}

