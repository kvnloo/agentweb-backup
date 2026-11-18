/**
 * Provider-agnostic keyword/SEO data contract for Emma (ENG-3139, slice of ENG-178).
 *
 * Ships dark: no real vendor adapter exists yet. Vendor choice and spend are
 * gated on ENG-178. Credentials never come from chat input; adapters receive
 * an injected resolver backed by Connected Accounts / secure storage.
 */

export interface KeywordMetrics {
  keyword: string;
  locale: string;
  /** Estimated monthly search volume. */
  searchVolume: number;
  /** 0-100 difficulty / competition score. */
  difficulty: number;
  /** Estimated cost per click in USD. */
  cpcUsd: number;
}

export interface CompetitorKeyword {
  keyword: string;
  /** Organic rank of the competitor domain for this keyword. */
  position: number;
  searchVolume: number;
}

export interface KeywordDataCredential {
  /** Opaque secret material resolved from Connected Accounts / secure storage. */
  apiKey: string;
}

/**
 * Resolves a provider credential for an org. Implementations must read from
 * Connected Accounts / secure storage only — never from chat or tool input.
 */
export type KeywordDataCredentialResolver = (
  orgId: string,
  providerId: string,
) => Promise<KeywordDataCredential | null>;

export interface KeywordDataProvider {
  readonly id: string;
  getKeywordMetrics(
    keywords: string[],
    locale: string,
    orgId: string,
  ): Promise<KeywordMetrics[]>;
  getCompetitorKeywords(
    domain: string,
    locale: string,
    orgId: string,
  ): Promise<CompetitorKeyword[]>;
}
