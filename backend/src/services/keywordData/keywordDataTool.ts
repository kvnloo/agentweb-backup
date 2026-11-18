/**
 * Agent-facing keyword data entry point (ENG-3139). DARK: not registered in any
 * Emma tool registry. Enabling it requires the ENG-178 provider decision, a real
 * adapter, and registering this handler as a tool.
 */
import { MockKeywordDataProvider } from './mockProvider';
import type {
  CompetitorKeyword,
  KeywordDataCredentialResolver,
  KeywordDataProvider,
  KeywordMetrics,
} from './types';

export const MAX_KEYWORDS_PER_REQUEST = 100;
export const NOT_CONNECTED_MESSAGE = 'keyword data provider not connected';

export type KeywordDataToolInput =
  | { action: 'keyword_metrics'; keywords: string[]; locale?: string }
  | { action: 'competitor_keywords'; domain: string; locale?: string };

export type KeywordDataToolResult =
  | {
      ok: true;
      provider: string;
      metrics?: KeywordMetrics[];
      competitorKeywords?: CompetitorKeyword[];
      truncated?: boolean;
    }
  | { ok: false; error: 'not_connected' | 'invalid_input' | 'provider_error'; message: string };

export interface KeywordDataProviderFactoryDeps {
  credentialResolver: KeywordDataCredentialResolver;
}

/**
 * Registry of provider ids to factories. Real adapters are out of scope until
 * ENG-178 picks a vendor; they receive the injected credential resolver.
 */
const PROVIDER_FACTORIES: Record<string, (deps: KeywordDataProviderFactoryDeps) => KeywordDataProvider> = {
  mock: () => new MockKeywordDataProvider(),
};

/** Reads provider selection from config (env `KEYWORD_DATA_PROVIDER`). */
export function resolveKeywordDataProvider(
  deps: KeywordDataProviderFactoryDeps,
  providerId: string | undefined = process.env.KEYWORD_DATA_PROVIDER,
): KeywordDataProvider | null {
  const id = providerId?.trim().toLowerCase();
  if (!id) return null;
  const factory = PROVIDER_FACTORIES[id];
  return factory ? factory(deps) : null;
}

export async function runKeywordDataTool(
  input: KeywordDataToolInput,
  ctx: { orgId: string; provider: KeywordDataProvider | null },
): Promise<KeywordDataToolResult> {
  if (!ctx.provider) {
    return { ok: false, error: 'not_connected', message: NOT_CONNECTED_MESSAGE };
  }
  const locale = input.locale?.trim() || 'en-US';
  try {
    if (input.action === 'keyword_metrics') {
      const cleaned = Array.from(
        new Set((input.keywords ?? []).map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean)),
      );
      if (cleaned.length === 0) {
        return { ok: false, error: 'invalid_input', message: 'keywords must contain at least one non-empty keyword' };
      }
      const truncated = cleaned.length > MAX_KEYWORDS_PER_REQUEST;
      const batch = cleaned.slice(0, MAX_KEYWORDS_PER_REQUEST);
      const metrics = await ctx.provider.getKeywordMetrics(batch, locale, ctx.orgId);
      return { ok: true, provider: ctx.provider.id, metrics, ...(truncated ? { truncated } : {}) };
    }
    if (input.action === 'competitor_keywords') {
      const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
      if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        return { ok: false, error: 'invalid_input', message: 'domain must be a bare hostname like example.com' };
      }
      const competitorKeywords = await ctx.provider.getCompetitorKeywords(domain, locale, ctx.orgId);
      return { ok: true, provider: ctx.provider.id, competitorKeywords };
    }
    return { ok: false, error: 'invalid_input', message: 'unknown action' };
  } catch (err) {
    return {
      ok: false,
      error: 'provider_error',
      message: err instanceof Error ? err.message : 'keyword data provider failed',
    };
  }
}
