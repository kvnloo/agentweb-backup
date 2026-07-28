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
// HTTP 402 (Payment Required) from the X API means AgentWeb's shared X Developer
// App has run out of X API credits/usage for the current period, so every read
// (search/profile enrichment) and write (post/reply) is blocked until AgentWeb
// tops up or upgrades that plan. Every user connects their X *account* against
// AgentWeb's single app (one clientId/clientSecret from the Twitter secret — see
// getTwitterCredentials/getAppClient), so the credit balance is AgentWeb's, NOT
// the end user's: the user has no X Developer Portal access to it and cannot
// resolve it themselves. The surfaced error must therefore point them to AgentWeb
// support rather than blame their own connection or send them to a portal they
// can't act in. This is not something a retry can clear. (ENG-604)
const X_CREDITS_HINT =
  ". AgentWeb's X (Twitter) API plan has run out of credits for the current " +
  'billing period, so X reads and posts are temporarily paused until AgentWeb ' +
  'tops up or upgrades that plan. This is a platform-side limit on AgentWeb, not ' +
  'a problem with your connected X account — please contact AgentWeb support to ' +
  'get X access restored.';

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

  // A 402 with no structured payload (e.g. an empty body) must still explain that
  // this is an AgentWeb-side credit limit rather than collapsing to a bare
  // "Request failed with code 402".
  if (creditsHint) return `X API error (HTTP 402): ${base}${creditsHint}`;
  return base;
}
