/**
 * X (Twitter) API error surfacing.
 *
 * twitter-api-v2 throws `ApiResponseError` on a non-2xx response. Its `.message`
 * is only a terse `"Request failed with code 403"`; the *real* explanation X
 * returns lives on `.data` (`title` / `detail` / `errors` / `error`) with the
 * HTTP status on `.code`. Collapsing the failure to `error.message` (as the
 * AgentMode tool-dispatch catch used to) throws that detail away, leaving Emma —
 * and anyone debugging — with an opaque, undiagnosable 403.
 *
 * `describeXApiError` pulls the X payload back out so the surfaced error is
 * actionable. It duck-types on `.data` rather than `instanceof ApiResponseError`
 * so it works regardless of how the error crossed a module/mock boundary.
 */

interface XApiErrorLike {
  code?: unknown;
  data?: {
    title?: unknown;
    detail?: unknown;
    error?: unknown;
    type?: unknown;
    errors?: Array<{ message?: unknown; detail?: unknown; title?: unknown }>;
  };
}

/**
 * Build a human-readable message from an error thrown by an X API call.
 * When the error carries X's structured payload (title/detail/errors), those are
 * surfaced (with the HTTP status). Otherwise falls back to the error's own
 * message so nothing is ever swallowed.
 */
// HTTP 402 (Payment Required) from the X API means the workspace's X API plan is
// out of credits — every read (search/profile enrichment) and write (post/reply)
// is blocked until the plan is topped up or upgraded. This is a billing limit on
// the user's own X app, not an AgentWeb connection problem and not something a
// retry can clear, so the surfaced error must say WHERE to resolve it. (ENG-604)
const X_CREDITS_HINT =
  '. Your X (Twitter) API plan is out of credits — reads and posts are blocked ' +
  'until you top up or upgrade your X API plan in the X Developer Portal ' +
  '(developer.x.com → Products / Billing). This is a billing limit on your X app, ' +
  'not an AgentWeb connection problem.';

export function describeXApiError(error: unknown): string {
  const e = error as XApiErrorLike;
  const data = e?.data;
  const code = typeof e?.code === 'number' ? e.code : undefined;
  const creditsHint = code === 402 ? X_CREDITS_HINT : '';

  if (data && typeof data === 'object') {
    const parts: string[] = [];
    if (typeof data.title === 'string' && data.title.trim()) parts.push(data.title.trim());
    if (typeof data.detail === 'string' && data.detail.trim()) parts.push(data.detail.trim());
    if (typeof data.error === 'string' && data.error.trim()) parts.push(data.error.trim());
    if (Array.isArray(data.errors)) {
      const nested = data.errors
        .map((x) => {
          const m = x?.message ?? x?.detail ?? x?.title;
          return typeof m === 'string' ? m.trim() : '';
        })
        .filter(Boolean);
      if (nested.length) parts.push(nested.join('; '));
    }

    const detail = parts.filter(Boolean).join(' — ');
    if (detail) {
      const codeStr = code !== undefined ? ` (HTTP ${code})` : '';
      return `X API error${codeStr}${': '}${detail}${creditsHint}`;
    }
  }

  const base =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

  // A 402 with no structured payload (e.g. an empty body) must still tell the user
  // where to resolve it rather than collapsing to a bare "Request failed with code 402".
  if (creditsHint) return `X API error (HTTP 402): ${base}${creditsHint}`;
  return base;
}
