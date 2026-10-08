import { createHash, randomBytes } from 'crypto';

/**
 * The sandbox Meta credential (ENG-1908). A sandbox account carries a normal-looking
 * `connected_accounts` Meta row whose access_token is a sentinel: it is meaningless to
 * Meta and is what the process-level Graph interceptor keys on. It is URL-safe by
 * construction so it survives query strings, form bodies and paging.next verbatim.
 *
 * Shape: `sbx.<eval_userId>.<24 hex>` — the principal is recoverable from the token so
 * the simulator can resolve the account's policy and dataset without a lookup table.
 */
export const SANDBOX_TOKEN_PREFIX = 'sbx.';

const TOKEN_PATTERN = /^sbx\.(eval_[A-Za-z0-9-]+)\.([0-9a-f]{24})$/;

export function isSandboxToken(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(SANDBOX_TOKEN_PREFIX);
}

export function mintSandboxToken(userId: string): string {
  if (!/^eval_[A-Za-z0-9-]+$/.test(userId)) throw new Error('A sandbox token requires an eval_ principal');
  return `${SANDBOX_TOKEN_PREFIX}${userId}.${randomBytes(12).toString('hex')}`;
}

/** The eval_ principal encoded in a well-formed sandbox token; null for anything else. */
export function sandboxTokenUserId(token: unknown): string | null {
  if (!isSandboxToken(token)) return null;
  const match = token.match(TOKEN_PATTERN);
  return match ? match[1] : null;
}

/**
 * Deterministic numeric ad-account id per principal. Meta ids are numeric strings and the
 * product validates `/^\d+$/`; the fixed `1207` prefix keeps the space visibly distinct from
 * real account ids in logs.
 */
export function sandboxAdAccountId(userId: string): string {
  const digest = createHash('sha256').update(userId).digest();
  let digits = '';
  for (let i = 0; digits.length < 12; i++) digits += (digest[i] % 10).toString();
  return `1207${digits}`;
}
