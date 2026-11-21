/**
 * ENG-3142 — minimal X (Twitter) Ads API client, OAuth 1.0a user context (utils/oauth1.ts).
 *
 *   - 3-legged connect: requestToken → authorize URL → accessToken (api.x.com/oauth/*).
 *   - xAdsRequest: one signed call to https://ads-api.x.com/<version>/..., query params signed,
 *     JSON body (POST/PUT) is not part of the signature (per X's OAuth 1.0a rules).
 *
 * The transport is injectable; nothing here reads secrets or storage.
 */
import { buildOAuth1Header, type OAuth1Credentials } from '../utils/oauth1';

export const X_ADS_API_VERSION = '12';
export const X_ADS_API_BASE = `https://ads-api.x.com/${X_ADS_API_VERSION}`;
export const X_OAUTH_BASE = 'https://api.x.com/oauth';

export type XFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

const defaultFetch: XFetch = (url, init) => fetch(url, init as any) as any;

/** A failed Ads API call. `status` 0 = no response (network/timeout): the outcome is unknown. */
export class XAdsApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'XAdsApiError';
  }
}

function toQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)] as [string, string]);
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

/** X Ads error body → one readable message. */
function errorMessage(status: number, text: string): { message: string; code?: string } {
  try {
    const body = JSON.parse(text);
    const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
    if (!first && Array.isArray(body?.operation_errors)) {
      // Batch endpoints: item-level errors, one array per input item (X preserves order).
      const items = (body.operation_errors as any[]).flatMap((errs, i) => (Array.isArray(errs) ? errs : []).map((e: any) => `item ${i + 1}: ${e?.code ?? ''} ${e?.message ?? ''}`.trim()));
      if (items.length) return { message: `X Ads API ${status}: ${items.join('; ')}`.replace(/\s+/g, ' ').slice(0, 600), code: 'OPERATION_ERRORS' };
    }
    if (first) return { message: `X Ads API ${status}: ${first.code ?? ''} ${first.message ?? ''}`.replace(/\s+/g, ' ').trim(), code: first.code };
  } catch {
    /* not JSON */
  }
  return { message: `X Ads API ${status}: ${text.slice(0, 200)}` };
}

export interface XAdsRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path below the versioned base, e.g. "/accounts/abc/campaigns". */
  path: string;
  query?: Record<string, unknown>;
  /** JSON body (batch endpoints / PUT); not signed. */
  json?: unknown;
  credentials: OAuth1Credentials;
  fetchImpl?: XFetch;
}

export async function xAdsRequest<T = any>(opts: XAdsRequestOptions): Promise<T> {
  const method = opts.method ?? 'GET';
  const url = `${X_ADS_API_BASE}${opts.path}${toQuery(opts.query)}`;
  const headers: Record<string, string> = {
    Authorization: buildOAuth1Header({ method, url, credentials: opts.credentials }),
  };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await (opts.fetchImpl ?? defaultFetch)(url, { method, headers, ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}) });
  } catch (error) {
    throw new XAdsApiError(`X Ads API: no response was received (${error instanceof Error ? error.message : String(error)})`, 0);
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    const { message, code } = errorMessage(res.status, text);
    throw new XAdsApiError(message, res.status, code);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new XAdsApiError('X Ads API returned a response that is not JSON.', res.status);
  }
}

/** Follow `next_cursor` up to `maxPages` (X caps count at 1000 per page). */
export async function xAdsListAll(opts: XAdsRequestOptions, maxPages = 5): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const body = await xAdsRequest({ ...opts, query: { count: 200, ...(opts.query ?? {}), ...(cursor ? { cursor } : {}) } });
    if (Array.isArray(body?.data)) rows.push(...body.data);
    cursor = body?.next_cursor || undefined;
    if (!cursor) break;
  }
  return rows;
}

const parseForm = (text: string): Record<string, string> => Object.fromEntries(new URLSearchParams(text).entries());

async function oauthStep(url: string, credentials: OAuth1Credentials, extra: Record<string, string>, fetchImpl?: XFetch) {
  let res;
  try {
    res = await (fetchImpl ?? defaultFetch)(url, {
      method: 'POST',
      headers: { Authorization: buildOAuth1Header({ method: 'POST', url, credentials, extraOAuthParams: extra }) },
    });
  } catch (error) {
    throw new XAdsApiError(`X OAuth: no response was received (${error instanceof Error ? error.message : String(error)})`, 0);
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) throw new XAdsApiError(`X OAuth ${res.status}: ${text.slice(0, 200)}`, res.status);
  return parseForm(text);
}

/** Step 1: a temporary request token bound to our callback URL. */
export async function xRequestToken(
  app: { consumerKey: string; consumerSecret: string },
  callbackUrl: string,
  fetchImpl?: XFetch,
): Promise<{ token: string; tokenSecret: string }> {
  const form = await oauthStep(`${X_OAUTH_BASE}/request_token`, app, { oauth_callback: callbackUrl }, fetchImpl);
  if (form.oauth_callback_confirmed !== 'true' || !form.oauth_token || !form.oauth_token_secret) {
    throw new XAdsApiError('X OAuth: request_token was not confirmed. Is the callback URL registered on the X app?', 400);
  }
  return { token: form.oauth_token, tokenSecret: form.oauth_token_secret };
}

/** Step 2: where the user approves access. */
export function xAuthorizeUrl(requestToken: string): string {
  return `${X_OAUTH_BASE}/authorize?oauth_token=${encodeURIComponent(requestToken)}`;
}

/** Step 3: exchange the approved request token + verifier for the user's access token. */
export async function xAccessToken(
  app: { consumerKey: string; consumerSecret: string },
  requestToken: { token: string; tokenSecret: string },
  verifier: string,
  fetchImpl?: XFetch,
): Promise<{ token: string; tokenSecret: string; userId?: string; screenName?: string }> {
  const form = await oauthStep(
    `${X_OAUTH_BASE}/access_token`,
    { ...app, token: requestToken.token, tokenSecret: requestToken.tokenSecret },
    { oauth_verifier: verifier },
    fetchImpl,
  );
  if (!form.oauth_token || !form.oauth_token_secret) throw new XAdsApiError('X OAuth: access_token response had no token.', 400);
  return { token: form.oauth_token, tokenSecret: form.oauth_token_secret, userId: form.user_id, screenName: form.screen_name };
}
