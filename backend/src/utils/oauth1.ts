/**
 * ENG-3142 — OAuth 1.0a request signing (HMAC-SHA1, RFC 5849), used by the X Ads API, which
 * accepts OAuth 1.0a user context only (OAuth2 tokens from routes/twitterAuth.ts do not work).
 *
 * Pure apart from the default nonce/timestamp; both are injectable so a signature is
 * reproducible in tests against RFC/X reference vectors.
 */
import crypto from 'crypto';

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  /** Request token (temporary) or access token; omitted for /oauth/request_token. */
  token?: string;
  tokenSecret?: string;
}

/** RFC 3986 percent-encoding (encodeURIComponent leaves !'()* unescaped). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Signature base string: METHOD&encoded(base URL)&encoded(sorted, encoded params).
 * `params` holds the query string + form body params + oauth_* params (never a JSON body).
 */
export function signatureBaseString(method: string, url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  const baseUrl = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`;
  const all: Array<[string, string]> = Object.entries(params).map(([k, v]) => [percentEncode(k), percentEncode(v)]);
  parsed.searchParams.forEach((v, k) => all.push([percentEncode(k), percentEncode(v)]));
  all.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join('&');
  return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');
}

export function hmacSha1Signature(baseString: string, consumerSecret: string, tokenSecret = ''): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(baseString).digest('base64');
}

export interface OAuth1SignOptions {
  method: string;
  /** Full URL including any query string. */
  url: string;
  credentials: OAuth1Credentials;
  /** Form-encoded body params (application/x-www-form-urlencoded), if any. */
  bodyParams?: Record<string, string>;
  /** Extra oauth_* params, e.g. oauth_callback or oauth_verifier. */
  extraOAuthParams?: Record<string, string>;
  nonce?: string;
  timestamp?: number;
}

/** The value of the Authorization header for one request. */
export function buildOAuth1Header(opts: OAuth1SignOptions): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: opts.credentials.consumerKey,
    oauth_nonce: opts.nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(opts.credentials.token ? { oauth_token: opts.credentials.token } : {}),
    ...(opts.extraOAuthParams ?? {}),
  };
  const base = signatureBaseString(opts.method, opts.url, { ...oauth, ...(opts.bodyParams ?? {}) });
  oauth.oauth_signature = hmacSha1Signature(base, opts.credentials.consumerSecret, opts.credentials.tokenSecret);
  return `OAuth ${Object.keys(oauth).sort().map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`).join(', ')}`;
}
