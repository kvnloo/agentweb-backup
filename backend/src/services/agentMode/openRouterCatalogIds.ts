/**
 * Live OpenRouter catalog ids, used ONLY to tighten Compare's served-model identity check.
 *
 * `isSameServedModel` accepts the dated canonical slug of a bare id (`openai/gpt-5.5` ->
 * `openai/gpt-5.5-20260423`). The same slug is also what an MMDD-suffixed SIBLING looks like
 * (`deepseek/deepseek-v4-flash-0731` -> `...-20260731`), which is a different model with its own
 * price. The registry only protects siblings it knows about, but the daily catalog monitor adds a new
 * sibling only after a human merges it, so for that window an unregistered sibling would be accepted
 * if OpenRouter repointed the bare id. The catalog lists the sibling the moment it exists, so its ids
 * close the window.
 *
 * Public, unauthenticated `GET /api/v1/models` (the same call the monitor makes). Cached per process;
 * an expired list is served immediately while one background refresh runs, a failed refresh keeps the last good list, and with no list at all the caller falls back to the
 * registered ids alone (the previous behaviour), never to a looser one.
 */
const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
export const CATALOG_IDS_TTL_MS = 10 * 60 * 1000;
export const CATALOG_IDS_TIMEOUT_MS = 3_000;
/** After a failed refresh, wait this long before trying again so an outage cannot add latency per column. */
export const CATALOG_IDS_RETRY_MS = 60 * 1000;

export interface CatalogIdsDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface CatalogIdsSource {
  /** Catalog model ids (`vendor/name`), possibly stale, possibly empty. Never throws. */
  getIds(): Promise<string[]>;
}

/** Distinct class names so a log line says WHY a refresh failed without carrying any upstream text. */
class CatalogHttpError extends Error {
  override name = 'CatalogHttpError';
}
class CatalogShapeError extends Error {
  override name = 'CatalogShapeError';
}
class CatalogEmptyError extends Error {
  override name = 'CatalogEmptyError';
}

function parseIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) throw new CatalogShapeError('catalog response has no data array');
  return data.flatMap((row) => {
    const id = (row as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' && id.includes('/') ? [id] : [];
  });
}

export function createCatalogIdsSource(deps: CatalogIdsDeps = {}): CatalogIdsSource {
  const now = deps.now ?? Date.now;
  let ids: string[] = [];
  let nextRefreshAt = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = async (): Promise<void> => {
    // AbortController + timer (not AbortSignal.timeout) so the deadline is testable with fake timers.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_IDS_TIMEOUT_MS);
    try {
      const res = await (deps.fetch ?? fetch)(CATALOG_URL, { signal: controller.signal });
      if (!res.ok) throw new CatalogHttpError('non-OK catalog response');
      const parsed = parseIds(await res.json());
      // An empty list is a broken response, not a catalog with no models: keep what we had.
      if (parsed.length === 0) throw new CatalogEmptyError('catalog response was empty');
      ids = parsed;
      nextRefreshAt = now() + CATALOG_IDS_TTL_MS;
    } catch (error) {
      // Class name only: never the message, URL, headers or body, which can carry upstream text.
      console.error('OpenRouterCatalogIds: refresh failed; keeping last list', error instanceof Error ? error.name : 'unknown');
      nextRefreshAt = now() + CATALOG_IDS_RETRY_MS;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async getIds() {
      if (now() >= nextRefreshAt) {
        // Single flight: parallel Compare columns share one request.
        inFlight ??= refresh().finally(() => {
          inFlight = null;
        });
        // Stale-while-revalidate: with a last-good list, never make a Compare column wait on the refresh.
        if (ids.length === 0) await inFlight;
      }
      return ids;
    },
  };
}

export const openRouterCatalogIds: CatalogIdsSource = createCatalogIdsSource();
