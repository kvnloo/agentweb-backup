import axios from 'axios';
import { getSecret, secretExists } from '../utils/secretsManager';
import { extractAnchorTerms, isRelevantToQuery } from './newsRelevance';
import {
  normalizeSearchCount,
  NormalizedSearchResult,
  SearchProvider,
  SearchProviderResponse,
  SearchRequest,
} from './searchProvider';

const DEFAULT_YOU_SEARCH_ENDPOINT = 'https://ydc-index.io/v1/search';

type HttpClient = Pick<typeof axios, 'post'>;

interface YouSearchProviderOptions {
  endpoint?: string;
  apiKey?: string;
  apiKeyProvider?: () => Promise<string | null>;
  httpClient?: HttpClient;
}

export class YouSearchProvider implements SearchProvider {
  readonly name = 'you' as const;

  private readonly endpoint: string;
  private readonly explicitApiKey?: string;
  private readonly apiKeyProvider?: () => Promise<string | null>;
  private readonly httpClient: HttpClient;

  constructor(options: YouSearchProviderOptions = {}) {
    this.endpoint = options.endpoint || DEFAULT_YOU_SEARCH_ENDPOINT;
    this.explicitApiKey = options.apiKey;
    this.apiKeyProvider = options.apiKeyProvider;
    this.httpClient = options.httpClient || axios;
  }

  async search(request: SearchRequest): Promise<SearchProviderResponse> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('You.com Search API key is not configured');
    }

    const body: Record<string, unknown> = {
      query: request.query,
      count: normalizeSearchCount(request.count),
    };

    if (request.freshness) body.freshness = request.freshness;
    if (request.country) body.country = request.country;
    if (request.language) body.language = request.language;
    if (request.includeDomains?.length) body.include_domains = request.includeDomains;
    if (request.excludeDomains?.length) body.exclude_domains = request.excludeDomains;
    if (request.boostDomains?.length) body.boost_domains = request.boostDomains;
    if (request.livecrawl && request.livecrawl !== 'off') body.livecrawl = request.livecrawl;
    if (request.livecrawlFormat && request.livecrawl && request.livecrawl !== 'off') {
      body.livecrawl_formats = [request.livecrawlFormat];
    }

    const response = await this.httpClient.post(this.endpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      timeout: Number(process.env.YOU_SEARCH_TIMEOUT_MS || 15_000),
    });

    const data = response.data as any;
    const resultSource = request.resultSource || 'all';

    if (resultSource === 'news') {
      return this.buildNewsResponse(data, request);
    }

    const web = this.normalizeResults(data?.results?.web, 'web');
    const news = resultSource === 'web' ? [] : this.normalizeResults(data?.results?.news, 'news');

    return {
      provider: this.name,
      query: String(data?.metadata?.query || request.query),
      results: [...web, ...news],
      metadata: {
        ...(data?.metadata || {}),
        provider: this.name,
        resultSource,
      },
    };
  }

  /**
   * ENG-1050 — You.com's `news` bucket is not a query-scoped news index.
   *
   * It is only populated when the query itself carries news intent (a plain
   * entity query such as "Stripe payments" or "Zenoti" comes back with a `web`
   * bucket only), and when it IS populated it is a loosely-matched trending feed
   * that ranks on generic tokens rather than on the entity being asked about.
   *
   * Returning only that bucket therefore produced both reported failure modes:
   * "No results found" for companies with abundant coverage, and world/sports
   * headlines with no connection to the query. So a news search:
   *   1. drops news articles that have no lexical connection to the query, and
   *   2. falls back to the `web` bucket, which You.com scopes to the same
   *      freshness window and does rank against the query.
   * Web-sourced entries keep sourceType 'web' so callers can tell a news article
   * from a recent web page, and an empty result now genuinely means "no coverage".
   *
   * The same relevance guard applies to both buckets. The `web` bucket ranks
   * against the query but still pads thin entity queries with matches on the
   * descriptor alone — "Zenoti" also returns a Las Vegas restaurant and a
   * Zendaya page, "Guesty vacation rental software" also returns Capterra and
   * Lodgify — which is the reported irrelevance failure arriving by another
   * route. Filtering the fallback too is what makes an empty result trustworthy:
   * a query for a company nobody covered comes back empty instead of padded.
   */
  private buildNewsResponse(data: any, request: SearchRequest): SearchProviderResponse {
    const limit = normalizeSearchCount(request.count);
    const anchorTerms = extractAnchorTerms(request.query);
    const isRelevant = (result: NormalizedSearchResult) => isRelevantToQuery(result, anchorTerms);

    const rawNews = this.normalizeResults(data?.results?.news, 'news');
    const relevantNews = rawNews.filter(isRelevant);

    const rawWeb = this.normalizeResults(data?.results?.web, 'web');
    const seenUrls = new Set(relevantNews.map((result) => result.url));
    const relevantWeb = rawWeb.filter((result) => isRelevant(result) && !seenUrls.has(result.url));

    const results = [...relevantNews, ...relevantWeb].slice(0, limit);
    const newsResultCount = results.filter((result) => result.sourceType === 'news').length;

    return {
      provider: this.name,
      query: String(data?.metadata?.query || request.query),
      results,
      metadata: {
        ...(data?.metadata || {}),
        provider: this.name,
        resultSource: 'news' as const,
        newsResultCount,
        irrelevantNewsDropped: rawNews.length - relevantNews.length,
        irrelevantWebDropped: rawWeb.length - relevantWeb.length,
        webFallbackCount: results.length - newsResultCount,
      },
    };
  }

  private async getApiKey(): Promise<string | null> {
    const direct = this.explicitApiKey || process.env.YOU_API_KEY || process.env.YOUCOM_API_KEY;
    if (direct?.trim()) return direct.trim();

    if (this.apiKeyProvider) {
      const provided = await this.apiKeyProvider();
      return provided?.trim() || null;
    }

    try {
      const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
      const secretName = `${environment}/AgentWeb/YouCom/Search`;
      if (!(await secretExists(secretName))) return null;
      const secretString = await getSecret(secretName);
      const parsed = parseSecretApiKey(secretString);
      return parsed?.trim() || null;
    } catch (error) {
      return null;
    }
  }

  private normalizeResults(rawResults: unknown, sourceType: 'web' | 'news'): NormalizedSearchResult[] {
    if (!Array.isArray(rawResults)) return [];

    return rawResults
      .map((raw) => this.normalizeResult(raw, sourceType))
      .filter((result): result is NormalizedSearchResult => Boolean(result));
  }

  private normalizeResult(raw: any, sourceType: 'web' | 'news'): NormalizedSearchResult | null {
    const url = typeof raw?.url === 'string' ? raw.url : '';
    if (!url) return null;

    const snippets = Array.isArray(raw?.snippets)
      ? raw.snippets.filter((snippet: unknown): snippet is string => typeof snippet === 'string' && snippet.trim().length > 0)
      : undefined;
    const description = typeof raw?.description === 'string' ? raw.description : '';
    const snippet = description || snippets?.[0] || 'No description available';
    const publishedDate = normalizeDate(raw?.page_age);
    const fullContentMarkdown = typeof raw?.contents?.markdown === 'string'
      ? raw.contents.markdown
      : undefined;

    return {
      title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title : url,
      url,
      snippet,
      snippets,
      publishedDate,
      thumbnail: typeof raw?.thumbnail_url === 'string' ? raw.thumbnail_url : null,
      sourceType,
      fullContentMarkdown,
    };
  }
}

function parseSecretApiKey(secretString: string): string | null {
  const trimmed = secretString.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed?.apiKey === 'string') return parsed.apiKey;
    if (typeof parsed?.YOU_API_KEY === 'string') return parsed.YOU_API_KEY;
    if (typeof parsed?.youApiKey === 'string') return parsed.youApiKey;
  } catch {
    return trimmed;
  }

  return null;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
