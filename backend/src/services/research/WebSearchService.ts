
import { google } from 'googleapis';
import { getSecret } from '../../utils/secretsManager';
import { ToolService } from '../../tools/ServiceRegistry';

/**
 * Web Search Service
 * Handles Google Custom Search integration
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string;
  thumbnail: string | null;
}

export interface WebSearchResponse {
  success: boolean;
  message?: string;
  results?: SearchResult[];
  formattedContent?: string;
  error?: string;
}

export class WebSearchService implements ToolService {
  readonly serviceName = 'web_search';
  
  private credentialsPromise: Promise<{ apiKey: string; searchEngineId: string }> | null = null;

  /**
   * Get Google Search credentials (lazy-loaded)
   */
  private async getGoogleSearchCredentials(): Promise<{ apiKey: string; searchEngineId: string }> {
    if (!this.credentialsPromise) {
      this.credentialsPromise = (async () => {
        // Try environment variables first (development)
        if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID) {
          return {
            apiKey: process.env.GOOGLE_SEARCH_API_KEY,
            searchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID
          };
        }

        // Try Secrets Manager
        try {
          const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
          const secretName = `${environment}/AgentWeb/GoogleSearch`;
          const secret = await getSecret(secretName);
          
          if (secret) {
            const parsed = typeof secret === 'string' ? JSON.parse(secret) : secret;
            return {
              apiKey: parsed.api_key || parsed.API_KEY,
              searchEngineId: parsed.search_engine_id || parsed.SEARCH_ENGINE_ID
            };
          }
        } catch (e) {
          console.warn('WebSearchService: Failed to fetch secrets:', e);
        }

        throw new Error('Google Search credentials not found');
      })();
    }
    return this.credentialsPromise;
  }

  /**
   * Search the web using Google Custom Search
   */
  async searchWeb(query: string, maxResults: number = 10): Promise<any> {
    try {
      console.log('WebSearchService: Searching web for:', query);

      const limitedMaxResults = Math.min(maxResults, 10);
      const credentials = await this.getGoogleSearchCredentials();

      const customsearch = google.customsearch('v1');
      const response = await customsearch.cse.list({
        auth: credentials.apiKey,
        cx: credentials.searchEngineId,
        q: query,
        num: limitedMaxResults,
        safe: 'medium',
        fields: 'items(title,link,snippet,pagemap/metatags,pagemap/cse_thumbnail)'
      });

      if (!response.data.items || response.data.items.length === 0) {
        return {
          success: true,
          message: 'No results found',
          results: [],
          formattedContent: 'No search results found.'
        };
      }

      const searchResults = response.data.items.map((item: any) => ({
        title: item.title || 'No title',
        url: item.link || '#',
        snippet: item.snippet || 'No description available',
        publishedDate: this.extractPublishedDate(item.pagemap?.metatags?.[0]) || new Date().toISOString().split('T')[0],
        thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || null
      }));

      const formattedContent = this.formatWebSearchResults({
        query,
        results: searchResults,
        totalResults: searchResults.length
      });

      return {
        success: true,
        message: `Found ${searchResults.length} results for: "${query}"`,
        results: searchResults,
        formattedContent
      };

    } catch (error: any) {
      console.error('WebSearchService: Error searching:', error);
      return {
        success: false,
        message: 'Web search failed. Please try again.',
        error: error.message
      };
    }
  }

  /**
   * Extract published date from metadata
   */
  private extractPublishedDate(metatags: any): string | null {
    if (!metatags) return null;

    const dateFields = [
      'article:published_time', 'pubdate', 'date', 'dc.date', 
      'dc.date.issued', 'og:article:published_time', 'article:published'
    ];

    for (const field of dateFields) {
      if (metatags[field]) {
        try {
          return new Date(metatags[field]).toISOString().split('T')[0];
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
    return null;
  }

  /**
   * Format results for LLM
   */
  private formatWebSearchResults(data: { query: string; results: any[]; totalResults: number }): string {
    let output = `🔍 **Search Results** for "${data.query}"\n\n`;
    
    data.results.forEach((result, index) => {
      output += `${index + 1}. **[${result.title}](${result.url})**\n`;
      output += `   ${result.snippet}\n`;
      output += `   *Source: ${new URL(result.url).hostname} | Date: ${result.publishedDate}*\n\n`;
    });

    return output;
  }
}

export const webSearchService = new WebSearchService();
