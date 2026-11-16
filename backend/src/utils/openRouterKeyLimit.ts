/**
 * ENG-2758: recognise OpenRouter quota exhaustion on an LLM error.
 *
 * Two shapes are the same class — "this key cannot spend until something resets":
 *  - per-key monthly limit: `403 Key limit exceeded (monthly limit) ... resets 2026-11-01T00:00:00.000Z`
 *  - credits/affordability: `402 ... can only afford N tokens` / `Insufficient credits` (ENG-2156)
 *
 * A short-interval requeue of a run that hit either is guaranteed to fail again, so the
 * scheduled-chat failure path defers to the parsed reset instead. Pure: no I/O.
 */
export type OpenRouterQuotaKind = 'key_limit' | 'credits';

export interface OpenRouterQuotaExhaustion {
  kind: OpenRouterQuotaKind;
  /** ISO timestamp of the quota reset when the provider stated one. */
  resetAt?: string;
}

export const OPENROUTER_QUOTA_ALERT_CLASS = 'openrouter-quota-exhausted';

function collectText(error: unknown): string {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  const e = error as any;
  const parts: string[] = [];
  for (const v of [e.message, e.originalMessage, e.error?.message, e.response?.data?.error?.message, e.cause?.message]) {
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join('\n');
}

function collectStatus(error: unknown, text: string): number | undefined {
  const e = error as any;
  for (const v of [e?.status, e?.statusCode, e?.code, e?.response?.status, e?.error?.code]) {
    const n = typeof v === 'string' ? Number(v) : v;
    // Preserve any explicit HTTP status (e.g. 429/500) so a transient error is not
    // misread as quota exhaustion; the text fallback applies only with no status.
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  const m = /\b(402|403)\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

const RESET_RE = /resets?\s+(?:at\s+|on\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i;

export function parseOpenRouterResetAt(text: string): string | undefined {
  const m = RESET_RE.exec(text || '');
  if (!m) return undefined;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function classifyOpenRouterQuotaExhaustion(error: unknown): OpenRouterQuotaExhaustion | null {
  const text = collectText(error);
  if (!text) return null;
  const status = collectStatus(error, text);
  const resetAt = parseOpenRouterResetAt(text);
  if (/key limit exceeded/i.test(text) && (status === 403 || status === undefined)) {
    return { kind: 'key_limit', ...(resetAt ? { resetAt } : {}) };
  }
  if (status === 402 && /(can only afford|insufficient credits|more credits|credit limit)/i.test(text)) {
    return { kind: 'credits', ...(resetAt ? { resetAt } : {}) };
  }
  return null;
}

/**
 * Longest a quota-exhausted schedule waits before re-checking. The stated reset (or the
 * schedule's next natural slot) is only an upper bound: an operator can raise the key
 * limit or top up credits at any time, so a weekly schedule or a reset days away must not
 * silently skip runs (Opslane P1s on #3841). One hour is still well above the ~30-min
 * zero-output requeue that ENG-2758 removes, and it does not consume a retry.
 */
export const QUOTA_RECHECK_MAX_MS = 60 * 60 * 1000;

/**
 * When to run next: the earliest of (parsed future reset, else the schedule's next natural
 * occurrence) and `now + QUOTA_RECHECK_MAX_MS`.
 */
export function resolveQuotaDeferral(q: OpenRouterQuotaExhaustion, now: Date, naturalNext: Date): string {
  const target = q.resetAt && Date.parse(q.resetAt) > now.getTime() ? Date.parse(q.resetAt) : naturalNext.getTime();
  const cap = now.getTime() + QUOTA_RECHECK_MAX_MS;
  return new Date(Math.min(target, cap)).toISOString();
}
