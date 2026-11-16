/**
 * ENG-2823 — the provider-neutral half of the Zoma guarded-write flow, extracted unchanged
 * from metaToolkitWrites.ts (ENG-2303 P3) so every ad platform uses one guard:
 *
 *   preview (nothing sent) → single-use preview_token bound to the user, the exact
 *   arguments and what the preview showed → confirm=true + that token → apply once → read-back.
 *
 * Pure: no I/O. Each provider computes its own fingerprint object (Meta's is byte-for-byte
 * what it was before the extraction, so tokens and tests are unchanged); this module signs,
 * verifies and consumes tokens only.
 */
import crypto from 'crypto';

export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Read-back verdict of a dispatched write. Only CONFIRMED is ever reported as success. */
export type WriteVerification = 'CONFIRMED' | 'MISMATCH' | 'UNCONFIRMED';

/** Key-order-independent serialization; undefined members are dropped. */
export function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function previewFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function signPreviewToken(secret: string, userId: string, exp: number, fingerprint: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`zoma-preview:v1:${userId}:${exp}:${fingerprint}`).digest('base64url');
  return `v1.${exp}.${mac}`;
}

export function previewTokenMatches(token: unknown, secret: string, userId: string, fingerprint: string, now: number): boolean {
  if (typeof token !== 'string') return false;
  const [version, expRaw] = token.split('.');
  const exp = Number(expRaw);
  if (version !== 'v1' || !Number.isSafeInteger(exp) || exp <= now) return false;
  const expected = Buffer.from(signPreviewToken(secret, userId, exp, fingerprint));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Mark a verified token used. Returns false when it was already consumed. Single-use per
 * process: there is no durable claim store (that would be new persistence — data-plane
 * gate), so a cross-instance replay inside the TTL is the documented residual.
 */
export function consumePreviewToken(consumed: Map<string, number>, token: string, now: number): boolean {
  for (const [t, exp] of consumed) if (exp <= now) consumed.delete(t);
  if (consumed.has(token)) return false;
  consumed.set(token, Number(token.split('.')[1]));
  return true;
}

/**
 * ENG-2945: the single swap point for single-use preview-token claims. The durable,
 * cross-instance store (ENG-2862) is Requires: Me; until then every Zoma write toolkit
 * shares one in-process store so a token confirmed through one toolkit cannot be replayed
 * through another. `consume` resolves true exactly once per unexpired token.
 */
export interface ConsumedTokenStore {
  consume(token: string, expiresAt: number, now?: number): Promise<boolean>;
}

export class InMemoryConsumedTokenStore implements ConsumedTokenStore {
  private readonly consumed = new Map<string, number>();

  async consume(token: string, expiresAt: number, now: number = Date.now()): Promise<boolean> {
    for (const [t, exp] of this.consumed) if (exp <= now) this.consumed.delete(t);
    if (expiresAt <= now || this.consumed.has(token)) return false;
    this.consumed.set(token, expiresAt);
    return true;
  }
}

/** Process-wide default shared by every Meta + Google toolkit write path. */
export const defaultConsumedTokenStore: ConsumedTokenStore = new InMemoryConsumedTokenStore();

/** Toolkit deps accept the store, or a bare Map kept for existing test injection. */
export type ConsumedTokens = ConsumedTokenStore | Map<string, number>;

export async function consumeToken(store: ConsumedTokens, token: string, now: number): Promise<boolean> {
  if (store instanceof Map) return consumePreviewToken(store, token, now);
  return store.consume(token, Number(token.split('.')[1]), now);
}

/**
 * ENG-2931: a provider wrapper that caught a transport failure (no response, timeout,
 * connection reset, 5xx/408) returns a plain failure, but the write may still have been
 * applied. Those are outcome-unknown, never a definite "did not apply".
 */
export function isOutcomeUnknownFailure(result: any): boolean {
  if (!result || result.success) return false;
  const code = Number(result.code ?? result.status_code);
  if (Number.isFinite(code) && code > 0) return code >= 500 || code === 408;
  const text = `${result.error ?? ''} ${result.message ?? ''}`;
  return /no response was received|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|network error|EPIPE|EAI_AGAIN/i.test(text);
}

/**
 * ENG-2931: outcome remembered per consumed preview token, so a client that lost the answer
 * and repeats its confirm gets that outcome back instead of a bare "already used". In-process
 * and TTL-bound like the consumed-token set (no durable store — data-plane gate).
 */
export function rememberTokenOutcome(outcomes: Map<string, { exp: number; outcome: any }>, token: string, outcome: any): any {
  outcomes.set(token, { exp: Number(token.split('.')[1]), outcome });
  return outcome;
}

export function replayTokenOutcome(outcomes: Map<string, { exp: number; outcome: any }>, token: string, now: number): any | null {
  for (const [t, v] of outcomes) if (v.exp <= now) outcomes.delete(t);
  const hit = outcomes.get(token);
  return hit ? { ...hit.outcome, replayed: true, note: 'This preview_token was already confirmed; this is the outcome of that confirm. Nothing new was sent.' } : null;
}

/** The PREVIEW response every provider returns for an unconfirmed call. */
export function previewResponse(params: { secret: string; userId: string; now: number; fingerprint: string; preview: string }) {
  const exp = params.now + PREVIEW_TOKEN_TTL_MS;
  return {
    status: 'PREVIEW',
    success: false,
    preview: params.preview,
    preview_token: signPreviewToken(params.secret, params.userId, exp, params.fingerprint),
    expires_at: new Date(exp).toISOString(),
    next_step: 'Show this preview to the user. Only after they explicitly approve it, repeat this exact call with confirm=true and this preview_token (single use, 15 minutes).',
  };
}
