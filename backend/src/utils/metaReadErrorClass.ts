/**
 * ENG-1890 — classify a failed Meta Graph READ into the tool-error taxonomy
 * (utils/toolErrorClassifier.ts KNOWN_TOOL_ERROR_CLASSES) so the Agent Mode
 * reliability loop can tell a credential/permission problem from a code bug.
 *
 * Graph business codes (error.code) are NOT HTTP statuses — they are read from
 * the structuredError metaService.handleError attaches, or the raw SDK shapes.
 */

export type MetaReadFailureKind = 'credential' | 'transient' | 'handler';

export interface MetaReadFailure {
  kind: MetaReadFailureKind;
  /** A KNOWN_TOOL_ERROR_CLASSES member. */
  errorClass: 'auth' | 'rate_limit' | 'timeout' | 'upstream_5xx' | 'invalid_output' | 'upstream_rejected';
  /** credential only: true when the token itself is bad (reconnect fixes it). */
  tokenInvalid?: boolean;
}

/** Graph codes Meta documents as throttling. */
const RATE_LIMIT_CODES = new Set([
  4, 17, 32, 341, 613,
  // Marketing API business-use-case throttles (Ads Management, Insights, etc.).
  80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014,
]);
/** Graph codes Meta documents as transient/unknown server errors. */
const TRANSIENT_CODES = new Set([1, 2]);
/** Permission subcodes that ride code 10/200 but also appear alone. */
const PERMISSION_CODES = new Set([10, 190, 272]);

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function metaGraphCode(error: any): number | undefined {
  return num(error?.structuredError?.code)
    ?? num(error?.response?.error?.code)
    ?? num(error?.response?.data?.error?.code)
    ?? num(error?.error?.code)
    ?? (typeof error?.code === 'number' || /^\d+$/.test(String(error?.code ?? '')) ? num(error?.code) : undefined);
}

function httpStatus(error: any): number | undefined {
  const s = num(error?.status) ?? num(error?.response?.status) ?? num(error?.statusCode);
  return s !== undefined && s >= 100 && s <= 599 ? s : undefined;
}

export function classifyMetaReadFailure(error: any): MetaReadFailure {
  if (error?.isMetaAuthError) return { kind: 'credential', errorClass: 'auth' };
  const code = metaGraphCode(error);
  const status = httpStatus(error);
  const message = String(error?.message ?? '').toLowerCase();

  if (code === 190 || status === 401 || /access token (expired|invalid)/.test(message)) {
    return { kind: 'credential', errorClass: 'auth', tokenInvalid: true };
  }
  if (code !== undefined && (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299))) {
    return { kind: 'credential', errorClass: 'auth' };
  }
  if (error?.name === 'OAuthException' || error?.structuredError?.type === 'OAuthException') {
    // Meta reuses OAuthException for invalid params (100) and ads throttles
    // (80000-80014), so the type alone is not token evidence. Only a codeless
    // OAuthException is treated as a credential problem — and even then a
    // reconnect is not claimed to fix it (token-specific evidence is code 190
    // or the access-token message, handled above).
    if (code === undefined) return { kind: 'credential', errorClass: 'auth' };
  }
  if (status === 403 || /permission denied/.test(message)) {
    return { kind: 'credential', errorClass: 'auth' };
  }
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || status === 429 || /rate limit/.test(message)) {
    return { kind: 'transient', errorClass: 'rate_limit' };
  }
  if (/did not respond within|timed? ?out|etimedout|esockettimedout/.test(message)) {
    return { kind: 'transient', errorClass: 'timeout' };
  }
  if ((code !== undefined && TRANSIENT_CODES.has(code)) || (status !== undefined && status >= 500)
    || /econnreset|socket hang up/.test(message)) {
    return { kind: 'transient', errorClass: 'upstream_5xx' };
  }
  if (/cursor|paging|unexpected response/.test(message)) {
    return { kind: 'handler', errorClass: 'invalid_output' };
  }
  return { kind: 'handler', errorClass: 'upstream_rejected' };
}

export const META_RECONNECT_MESSAGE =
  'The Meta access token is expired or invalid. Ask the user to reconnect Meta in Connected Accounts, then retry.';

/** Permission gaps live on the ad account/business, which reconnecting cannot fix. */
export const META_PERMISSION_MESSAGE =
  'Meta refused this read for a permission reason. The connected user needs the named permission or an ad-account role '
  + '(Meta Business Settings); a configuration fix, not a retry.';
