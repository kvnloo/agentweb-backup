import { GoogleSearchProvider } from './googleSearchProvider';
import {
  SearchProvider,
  SearchProviderName,
  SearchProviderResponse,
  SearchRequest,
} from './searchProvider';
import { YouSearchProvider } from './youSearchProvider';

interface SearchProviderFactoryOptions {
  providers?: Partial<Record<SearchProviderName, SearchProvider>>;
}

export async function performConfiguredSearch(
  request: SearchRequest,
  options: SearchProviderFactoryOptions = {},
): Promise<SearchProviderResponse> {
  const providers = buildSearchProviderOrder(options.providers);
  const failures: string[] = [];

  for (const provider of providers) {
    try {
      const response = await provider.search(request);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${provider.name}: ${message}`);
      console.warn(`[search] provider ${provider.name} failed; trying fallback if available: ${message}`);
    }
  }

  throw new Error(`All search providers failed (${failures.join('; ')})`);
}

export function buildSearchProviderOrder(
  overrides: Partial<Record<SearchProviderName, SearchProvider>> = {},
): SearchProvider[] {
  const primary = normalizeProviderName(process.env.SEARCH_PROVIDER) || 'you';
  const fallbackEnabled = !isDisabled(process.env.SEARCH_PROVIDER_FALLBACK);
  const you = overrides.you || new YouSearchProvider();
  const google = overrides.google || new GoogleSearchProvider();

  if (primary === 'google') {
    return fallbackEnabled ? [google, you] : [google];
  }

  return fallbackEnabled ? [you, google] : [you];
}

function normalizeProviderName(value: string | undefined): SearchProviderName | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'you' || normalized === 'you.com' || normalized === 'youcom') return 'you';
  if (normalized === 'google' || normalized === 'google_cse') return 'google';
  return null;
}

function isDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no';
}
