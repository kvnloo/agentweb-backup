/**
 * Dependency-free so route/test mocks of linkedInOutreachService can't hide it.
 *
 * True when a LinkedIn/Unipile failure is about the INFRASTRUCTURE being unreachable
 * (credential fetch, gateway/5xx, timeout, transport) rather than a business answer
 * from LinkedIn. resolveAccountId* can now hand back an account whose liveness was only
 * indeterminate (ENG-2205), so callers that make the real call must not surface these
 * raw internal messages as a 500.
 */
export const LINKEDIN_UNAVAILABLE_MESSAGE =
  'LinkedIn is temporarily unavailable. Please try again in a few minutes.';

const TRANSPORT_CODE = /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)$/;

// 502/503/504 from nginx, plus Cloudflare-style 520-524 (unknown error, down, timed out, no TCP, no TLS).
const GATEWAY_STATUSES = [502, 503, 504, 520, 521, 522, 523, 524];

export function isLinkedInInfraError(error: any): boolean {
  const msg = String(error?.message ?? '');
  if (/Failed to fetch Unipile credentials/i.test(msg)) return true;
  if (/<html|502 Bad Gateway|503 Service|504 Gateway/i.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up/i.test(msg)) return true;
  // undici surfaces a dropped connection as a bare "terminated" with the real code on .cause.
  if (msg.trim().toLowerCase() === 'terminated') return true;
  if (error?.name === 'AbortError') return true;
  for (const code of [error?.code, error?.cause?.code]) {
    if (typeof code === 'string' && (TRANSPORT_CODE.test(code) || code.startsWith('UND_ERR_'))) return true;
  }
  const classification = error?.structuredError?.classification;
  if (classification === 'TIMEOUT_ERROR') return true;
  // Only gateway-style 5xx (see GATEWAY_STATUSES) mean "Unipile is unreachable". A plain 500 can be request-specific
  // (retrying will never help), so it keeps its normal error handling.
  if (classification === 'SERVER_ERROR') return GATEWAY_STATUSES.includes(Number(error?.structuredError?.status));
  return error?.isTimeout === true;
}
