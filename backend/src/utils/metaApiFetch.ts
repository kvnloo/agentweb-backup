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
export const fetchWithRetryAndPaging = async (url: string): Promise<any> => {
  const response = await fetchWithRetry(url);
  const data = await response.json();
  
  // Check if there's a paging.next URL for more data
  if (data.paging && data.paging.next) {
    console.log(`Meta API: Fetching next page of data from ${data.paging.next.substring(0, 100)}...`);
    
    // Recursively fetch next page
    const nextPageData = await fetchWithRetryAndPaging(data.paging.next);
    
    // Merge the data arrays
    if (data.data && Array.isArray(data.data) && nextPageData.data && Array.isArray(nextPageData.data)) {
      data.data = [...data.data, ...nextPageData.data];
    }
    
    // Remove paging info since we've fetched all pages
    delete data.paging;
  }
  
  return data;
};

