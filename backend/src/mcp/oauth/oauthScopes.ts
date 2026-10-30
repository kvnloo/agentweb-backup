/**
 * MCP OAuth scopes are a closed set.
 *
 *   mcp:tools  — the baseline grant every OAuth sign-in has always had.
 *   email:read — opt-in: lets the client call `read_email` (read-only, own
 *                mailbox). Granted only when the user consents to it explicitly.
 *
 * Granted scopes are stored as `grantedScopes` on the authorization code and
 * token records. The older free-text `scope` field was never validated, so it is
 * NOT trusted as a grant: a record without `grantedScopes` (issued before this
 * existed) is `mcp:tools` only, whatever its `scope` string says.
 */
import { API_KEY_SCOPE_EMAIL_READ } from '../server/apiKeyScopes';

export const OAUTH_SCOPE_TOOLS = 'mcp:tools';
export const OAUTH_SCOPE_EMAIL_READ = API_KEY_SCOPE_EMAIL_READ;
export const SUPPORTED_OAUTH_SCOPES = [OAUTH_SCOPE_TOOLS, OAUTH_SCOPE_EMAIL_READ];
export const LEGACY_OAUTH_SCOPES = [OAUTH_SCOPE_TOOLS];

/**
 * Parses a space-separated `scope` request parameter. Missing/blank means the
 * default `mcp:tools`. Returns null when any requested scope is unknown.
 * The result is deduped and in canonical order.
 */
export function parseRequestedScopes(scope: unknown): string[] | null {
  if (scope === undefined || scope === null) return [...LEGACY_OAUTH_SCOPES];
  if (typeof scope !== 'string') return null;
  const requested = scope.split(/\s+/).filter(Boolean);
  if (requested.length === 0) return [...LEGACY_OAUTH_SCOPES];
  if (requested.some((s) => !SUPPORTED_OAUTH_SCOPES.includes(s))) return null;
  return SUPPORTED_OAUTH_SCOPES.filter((s) => requested.includes(s));
}

/** The scopes a stored code/token record actually grants. Fails closed to `mcp:tools`. */
export function grantedOAuthScopes(record: { grantedScopes?: unknown } | null | undefined): string[] {
  const granted = record?.grantedScopes;
  if (!Array.isArray(granted)) return [...LEGACY_OAUTH_SCOPES];
  return SUPPORTED_OAUTH_SCOPES.filter((s) => granted.includes(s));
}

export function formatScopes(scopes: string[]): string {
  return scopes.join(' ');
}

export class InvalidScopeError extends Error {
  constructor() {
    super('invalid_scope');
    this.name = 'InvalidScopeError';
  }
}
