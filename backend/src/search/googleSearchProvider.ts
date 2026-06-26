import { google } from 'googleapis';
import { getSecret } from '../utils/secretsManager';
import {
  normalizeSearchCount,
  NormalizedSearchResult,
  SearchProvider,
  SearchProviderResponse,
  SearchRequest,
} from './searchProvider';

interface GoogleSearchCredentials {
  apiKey: string;
  searchEngineId: string;
}

interface GoogleSearchProviderOptions {
  credentialsProvider?: () => Promise<GoogleSearchCredentials | null>;
}

export class GoogleSearchProvider implements SearchProvider {
  readonly name = 'google' as const;

  private readonly credentialsProvider?: () => Promise<GoogleSearchCredentials | null>;

  constructor(options: GoogleSearchProviderOptions = {}) {
    this.credentialsProvider = options.credentialsProvider;
  }

  async search(request: SearchRequest): Promise<SearchProviderResponse> {
    const credentials = await this.getCredentials();
    if (!credentials) {
      throw new Error('Google Search API is not configured');
    }

    const customsearch = google.customsearch('v1');
    const response = await customsearch.cse.list({
      auth: credentials.apiKey,
      cx: credentials.searchEngineId,
      q: request.query,
      num: normalizeSearchCount(request.count, 10),
      safe: 'medium',
      fields: 'items(title,link,snippet,pagemap/metatags,pagemap/cse_thumbnail)',
    });

    const results: NormalizedSearchResult[] = (response.data.items || []).map((item: any) => ({
      title: item.title || 'No title',
      url: item.link || '#',
      snippet: item.snippet || 'No description available',
      publishedDate: extractPublishedDate(item.pagemap?.metatags?.[0]) || undefined,
      thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || null,
      sourceType: 'web',
    }));

    return {
      provider: this.name,
      query: request.query,
      results,
      metadata: {
        provider: this.name,
        resultSource: 'web',
      },
    };
  }

  private async getCredentials(): Promise<GoogleSearchCredentials | null> {
    if (this.credentialsProvider) {
      return this.credentialsProvider();
    }

    if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID) {
      return {
        apiKey: process.env.GOOGLE_SEARCH_API_KEY,
        searchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID,
      };
    }

    try {
      const secretName = process.env.NODE_ENV === 'development'
        ? 'dev/AgentWeb/Google/Search'
        : 'prod/AgentWeb/Google/Search';
      const secretJson = await getSecret(secretName);
      const credentials = JSON.parse(secretJson);

      if (!credentials.apiKey || !credentials.searchEngineId) {
        return null;
      }

      return {
        apiKey: credentials.apiKey,
        searchEngineId: credentials.searchEngineId,
      };
    } catch (error) {
      return null;
    }
  }
}

export function extractPublishedDate(metatags: any): string | null {
  if (!metatags) return null;

  const dateFields = [
    'article:published_time',
    'pubdate',
    'date',
    'dc.date',
    'dc.date.issued',
    'og:article:published_time',
    'article:published',
    'publication_date',
  ];

  for (const field of dateFields) {
    if (metatags[field]) {
      const date = new Date(metatags[field]);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }

  return null;
}
