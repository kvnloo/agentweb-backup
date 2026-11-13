import { inMetaToolkitBackoffContext, toolkitMetaFetch } from './metaToolkitBackoff';
/**
 * Utility functions for fetching data from Meta (Facebook) Graph API
 * with retry logic and pagination support
 */

/**
 * Deadline for a single Meta Graph request made by the tracking-monitor sweep.
 *
 * Node's `fetch` applies no default deadline. The sweep's Graph reads are awaited inside a
 * loop over every user and every connected ad account, so one connection that accepts a
 * request and never completes the response does not fail one account — it stalls every
 * account after it. That surfaces in the logs as "the cron did not run", which is close to
 * the hardest shape to diagnose, rather than as a network fault.
 *
 * Lives here, in the leaf module with no dependencies, so `metaTrackingMonitor`,
 * `metaOptimisationCoverage` and `metaDestinationCoverage` share ONE value rather than three
 * copies that drift — the ENG-683 mistake, where a duplicated map diverged across four files.
 *
 * 15s is comfortably above a healthy Graph response and far below the point where a stalled
 * read threatens the sweep's completion.
 *
 * ⚠ NOT applied to `fetchWithRetry` below, deliberately. That helper is used by `metaService`
 * across the whole backend, including insights queries that can legitimately run long, so
 * imposing this ceiling there is a separate change with a much wider blast radius.
 */
export const META_GRAPH_TIMEOUT_MS = 15_000;

/**
 * Fetch with retry logic for handling transient errors
 * @param url - The URL to fetch
 * @param retries - Number of retry attempts (default: 3)
 * @param delayMs - Initial delay in milliseconds for exponential backoff (default: 1000)
 * @returns Response object
 */
export const fetchWithRetry = async (url: string, retries: number = 3, delayMs: number = 1000): Promise<Response> => {
  if (inMetaToolkitBackoffContext()) return toolkitMetaFetch(url);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url);
      
      // If successful, return response
      if (response.ok) {
        return response;
      }
      
      // Check if it's a rate limit or server error that should be retried
      if (response.status === 429 || response.status >= 500) {
        console.log(`Meta API: Request failed with status ${response.status}, attempt ${attempt}/${retries}`);
        
        if (attempt < retries) {
          // Exponential backoff with jitter
          const backoffDelay = delayMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
          console.log(`Meta API: Retrying after ${Math.round(backoffDelay)}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          continue;
        }
      }
      
      // For other errors or if we've exhausted retries, return the response
      return response;
    } catch (error) {
      console.error(`Meta API: Request error on attempt ${attempt}/${retries}:`, error);
      
      if (attempt < retries) {
        // Exponential backoff with jitter for network errors
        const backoffDelay = delayMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
        console.log(`Meta API: Retrying after ${Math.round(backoffDelay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        continue;
      }
      
      // If all retries exhausted, rethrow the error
      throw error;
    }
  }
  
  /* istanbul ignore next */
  throw new Error('Unexpected: fetchWithRetry exhausted all attempts without returning');
};

/**
 * Fetch with retry and pagination support
 * Automatically follows paging.next URLs and merges all data
 * @param url - The URL to fetch
 * @returns Parsed JSON data with all pages merged
 */
/**
 * Hard bound on how many pages one `fetchWithRetryAndPaging` call will follow.
 *
 * This helper follows `paging.next` RECURSIVELY, so an account large enough turns "slow" into a
 * blown stack. A bound that is announced (see `pagingTruncated` below) is safe; an unannounced
 * one is the ENG-1584 defect, so the caller is told.
 *
 * ⚠ Deliberately far larger than `metaService`'s `META_LIST_MAX_PAGES` (25), and NOT a copy of
 * it. That value pairs with an explicit `limit=100`, so 25 pages is 2,500 rows. The callers
 * here — `routes/meta.ts`'s six dashboard reads — set no `limit` at all, so Meta serves its
 * default 25 per page and 25 pages would be just 625 rows. Their previous behaviour was
 * genuinely unbounded, so a tight bound would silently shrink dashboards for any account past
 * that: the exact defect this file is being changed to prevent. 500 pages is a runaway guard,
 * not a page-size policy — it sits far beyond any realistic dashboard query while still
 * bounding the recursion.
 *
 * Counts pages FOLLOWED, not pages returned: the first page is fetched before any budget is
 * spent, so a full run reads `META_PAGING_MAX_PAGES + 1` pages. Irrelevant at this magnitude,
 * but the warning below states the followed count so the log never claims a number the code
 * did not do.
 */
export const META_PAGING_MAX_PAGES = 500;

/**
 * A Graph `paging.next` URL carries the `access_token` in its query string — often first,
 * so even a truncated prefix can expose token material. This helper used to log the first 100
 * characters of that URL on every page, putting credential material into application logs.
 * `metaService`'s `drainCursor` refuses to log Meta error objects for exactly this reason; the
 * same rule applies here. Log the path only, never the query string.
 */
const redactGraphUrl = (raw: string): string => {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[unparseable Graph URL]';
  }
};

export const fetchWithRetryAndPaging = async (url: string, pagesRemaining: number = META_PAGING_MAX_PAGES): Promise<any> => {
  const response = await fetchWithRetry(url);
  let data: any;
  try {
    data = await response.json();
  } catch (parseErr) {
    // ENG-1300: a non-2xx response is sometimes a gateway/proxy error page or
    // other non-JSON body rather than Meta's usual { error: {...} } shape —
    // .json() throws in that case, and without this the real HTTP status is
    // lost entirely (the SyntaxError carries none of its own).
    const err: any = new Error(
      parseErr instanceof Error ? `Meta API returned a non-JSON response: ${parseErr.message}` : 'Meta API returned a non-JSON response'
    );
    err.status = response.status;
    throw err;
  }

  // ENG-1300: this helper returns the parsed body even on a non-2xx response
  // (existing callers — routes/meta.ts, clientHealthService.ts — already build
  // their own `data.error` checks around that contract, and getMetaAdsMetrics
  // below has its own per-section Meta-business-code classification that reading
  // this wrong would silently break) — so rather than changing that contract,
  // expose the real HTTP status as a non-enumerable field callers can opt into
  // reading. Non-enumerable so it never leaks into a JSON.stringify of the Meta
  // payload itself (logging, caching, etc.).
  if (data && typeof data === 'object') {
    // configurable: true — a later page's failure (below) needs to overwrite
    // this once the first page's own status is no longer the whole story.
    Object.defineProperty(data, '__httpStatus', { value: response.status, enumerable: false, configurable: true });
  }

  // Check if there's a paging.next URL for more data
  if (data.paging && data.paging.next) {
    if (pagesRemaining <= 0) {
      // Announce the stop. A silently short list reads as a complete one — the exact
      // failure that told a customer an ad they were protecting did not exist.
      console.warn(`Meta API: paging stopped after following the ${META_PAGING_MAX_PAGES}-page bound for ${redactGraphUrl(url)}`);
      data.pagingTruncated = true;
      delete data.paging;
      return data;
    }
    console.log(`Meta API: Fetching next page of data from ${redactGraphUrl(data.paging.next)}`);

    // Recursively fetch next page
    const nextPageData = await fetchWithRetryAndPaging(data.paging.next, pagesRemaining - 1);

    // Merge the data arrays
    if (data.data && Array.isArray(data.data) && nextPageData.data && Array.isArray(nextPageData.data)) {
      data.data = [...data.data, ...nextPageData.data];
    } else {
      /*
       * A page that could not be merged is a page that was NOT read, and the caller has to be
       * told — otherwise page 1's rows are returned as the whole list.
       *
       * `fetchWithRetry` RETURNS a non-ok Response once its retries are exhausted rather than
       * throwing, so a persistent 429/403/400 on page 2 arrives here as
       * `{ error: {...} }` — no `data`, no `paging`. The merge guard above skipped it silently,
       * `delete data.paging` then ran, and the caller (which can only see page 1's own `error`
       * field) reported page 1's rows as `Found N campaign(s) (complete list).` A branch meant
       * to add a completeness signal was upgrading a neutral count into a false guarantee.
       *
       * Reuses `pagingTruncated` rather than adding a second flag: every caller that already
       * refuses to call a truncated read complete gets this case for free, and "the list is
       * short and we know it" is the same fact whichever way the read stopped.
       */
      console.warn(`Meta API: paging stopped — a page did not return a usable data array for ${redactGraphUrl(url)}`);
      data.pagingTruncated = true;
      // The Graph error from the failed page, so a caller can say WHY rather than only that the
      // list is short. Never overwrite this page's own error, and never the whole response.
      if (nextPageData?.error !== undefined && data.pagingError === undefined) {
        data.pagingError = nextPageData.error;
      }
    }

    // A downstream page that stopped at the bound makes THIS result incomplete too.
    if (nextPageData?.pagingTruncated) data.pagingTruncated = true;
    if (nextPageData?.pagingError !== undefined && data.pagingError === undefined) {
      data.pagingError = nextPageData.pagingError;
    }

    /*
     * ENG-1300 (from main): a later page can fail (non-2xx) without this function throwing — by
     * design, per the comment above on returning-not-throwing — so that failure would otherwise
     * be hidden behind the FIRST page's success status once the arrays are merged into one
     * seemingly-complete result. The overall multi-page fetch is only as successful as its least
     * successful page.
     *
     * Kept alongside the truncation propagation above rather than instead of it: they answer
     * different questions. `pagingTruncated` says the list is SHORT; `__httpStatus` says a page
     * ERRORED. A caller can face either, or both.
     */
    const nextPageStatus = (nextPageData as any)?.__httpStatus;
    if (typeof nextPageStatus === 'number' && nextPageStatus >= 400 && data && typeof data === 'object') {
      Object.defineProperty(data, '__httpStatus', { value: nextPageStatus, enumerable: false, configurable: true });
      /*
       * ENG-1300's contract, restored deliberately: `data.error` IS set from the failed page,
       * and its test asserts exactly that. Callers that must keep partial rows handle it at
       * their own level — see listMetaAdsCampaigns — rather than this shared helper quietly
       * withholding the error from every caller to suit one of them.
       */
      if (nextPageData.error && !data.error) {
        data.error = nextPageData.error;
      }
    }

    // Remove paging info since we've fetched all pages
    delete data.paging;
  }

  return data;
};

