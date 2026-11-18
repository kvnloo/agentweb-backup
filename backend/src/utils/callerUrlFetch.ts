/**
 * Fetching a URL that a caller (an agent, or an outside agent through the MCP) chose.
 *
 * Several agent tools take a URL as an argument and read it with the server's own network position: the HTML template and
 * `update_html_file` tools, `generate_book_content`, and the HTTP branch of `perform_data_analysis`. With a bare `fetch(url)` or
 * `axios.get(url)` the caller picks where the server connects, so a private address, a cloud metadata address, or a public URL that
 * redirects to one is reachable from the backend host, and the body comes back to the caller (as tool output, a saved template, or an
 * edited file).
 *
 * The tools named above fetch a caller URL only through this file. (Other tools that still fetch a caller URL with a bare client are not
 * covered by it; they are listed as follow-up work, so do not read "uses this wrapper" as "every URL tool is guarded".) It sits over the
 * existing guarded helpers in `ssrfGuard.ts` (DNS pinned to a public address, every redirect hop checked again, size and total time
 * bounded) and adds three things the tools need:
 *   - only http(s) is fetched;
 *   - a blocked URL becomes ONE generic error that carries no address, no DNS answer and no reason, so the answer cannot be used to
 *     map the internal network (a host that does not resolve and a host that resolves to a private address look the same);
 *   - the refusal is logged with the caller and the host only, never the path or query (they can hold tokens).
 *
 * No special case for our own bucket: a plain GET of one of our own public object URLs uses no server privilege, so it takes the same
 * guarded fetch (S3 resolves publicly) and needs no ownership check. Reads made with the server's credentials (SDK reads, presigned
 * URLs, writes) are a different rule: see `emma/impl/toolStorageAccess.ts`.
 *
 * Kept out of `ssrfGuard.ts` on purpose: that file stays free of anything that logs or knows about tools.
 */
import {
  DEFAULT_MAX_REDIRECTS,
  RedirectFetchDeps,
  SsrfBlockedError,
  fetchBufferFollowingRedirects,
} from './ssrfGuard';

/** Default cap for a caller URL whose body is text we hand to a model or edit (HTML pages, research text). */
export const CALLER_URL_MAX_TEXT_BYTES = 20 * 1024 * 1024;

/** Default total time for one caller URL, redirects included. */
export const CALLER_URL_TIMEOUT_MS = 30_000;

/** What a caller is told when the URL cannot be fetched for any safety reason. Deliberately says nothing about why. */
export const CALLER_URL_BLOCKED_MESSAGE = 'That URL cannot be fetched. Use a public https link.';

/** The URL was refused before or while fetching (not http(s), private or internal target, did not resolve, bad redirect). */
export class CallerUrlBlockedError extends Error {
  constructor() {
    super(CALLER_URL_BLOCKED_MESSAGE);
    this.name = 'CallerUrlBlockedError';
  }
}

/** The body is larger than the cap the tool allows. The limit is not secret, so it is part of the message. */
export class CallerUrlTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`The file is larger than the ${maxBytes}-byte limit for this tool.`);
    this.name = 'CallerUrlTooLargeError';
  }
}

export interface CallerUrlFetchOptions {
  /** Tool name, for the log line only. */
  tool: string;
  /** The caller, for the log line only. */
  userId?: string | null;
  /** Largest body accepted. */
  maxBytes: number;
  /** Total time for the whole fetch, redirects included. */
  timeoutMs?: number;
  /** Test seam for the resolver and the transport (same as the underlying helper). */
  deps?: RedirectFetchDeps;
}

/** Messages the transport and the helper use when a body is over the cap. */
const TOO_LARGE = /too large|maxContentLength|maxBodyLength/i;

/** The helper's plain error for a redirect to a non-http(s) scheme. A refusal like any other: it gets the same generic answer. */
const NON_HTTP_REDIRECT = /non-http\(s\) redirect/i;

function refuse(opts: CallerUrlFetchOptions, host: string): never {
  // Host only: a path or query can carry a token, and the rest is chosen by the caller.
  console.warn(JSON.stringify({ event: 'caller_url_blocked', tool: opts.tool, userId: opts.userId ?? null, host: host.slice(0, 100) }));
  throw new CallerUrlBlockedError();
}

/**
 * Fetch `rawUrl` as bytes. Throws `CallerUrlBlockedError` for anything the SSRF guard refuses (one generic message),
 * `CallerUrlTooLargeError` over the cap, and the underlying error unchanged for everything else (a 404, a timeout), so a tool keeps
 * telling those apart as it did before.
 */
export async function fetchCallerUrlBuffer(
  rawUrl: string,
  opts: CallerUrlFetchOptions,
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return refuse(opts, 'invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return refuse(opts, 'not-http');

  try {
    return await fetchBufferFollowingRedirects(
      rawUrl,
      opts.deps ?? {},
      DEFAULT_MAX_REDIRECTS,
      opts.timeoutMs ?? CALLER_URL_TIMEOUT_MS,
      opts.maxBytes,
    );
  } catch (error: any) {
    if (error instanceof SsrfBlockedError || NON_HTTP_REDIRECT.test(String(error?.message || ''))) return refuse(opts, parsed.hostname);
    if (TOO_LARGE.test(String(error?.message || ''))) throw new CallerUrlTooLargeError(opts.maxBytes);
    throw error;
  }
}

/** Same as `fetchCallerUrlBuffer`, decoded as UTF-8 text. */
export async function fetchCallerUrlText(rawUrl: string, opts: CallerUrlFetchOptions): Promise<string> {
  const { buffer } = await fetchCallerUrlBuffer(rawUrl, opts);
  return buffer.toString('utf8');
}
