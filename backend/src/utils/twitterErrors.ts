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
export function describeXApiError(error: unknown): string {
  const e = error as XApiErrorLike;
  const data = e?.data;

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
      const code = typeof e.code === 'number' ? ` (HTTP ${e.code})` : '';
      return `X API error${code}: ${detail}`;
    }
  }

  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
