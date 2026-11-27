import crypto from 'crypto';
import { oauthSessionDb, PendingOAuthSession } from './db';

export const OAUTH_FLOW_SESSION_TTL_MS = 10 * 60 * 1000;

export interface LocalOAuthFlowSession {
  userId: string;
  expires: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

// Validate every provider payload at the shared persistence boundary before route use.
function isValidPayload(value: unknown, provider: PendingOAuthSession['provider'], userId: string): boolean {
  if (!isRecord(value) || value.userId !== userId ||
      typeof value.expires !== 'number' || !Number.isFinite(value.expires) || value.expires <= Date.now() ||
      !isRecord(value.tokens)) return false;
  const tokens = value.tokens;
  if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim() ||
      typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) ||
      (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== 'string')) return false;
  if (provider === 'fathom') return true;
  if (provider === 'linkedin' || provider === 'linkedin_ads') {
    if (!isStrings(tokens.scopes)) return false;
    return provider === 'linkedin' || (isRecord(value.adAccountRefs) &&
      Object.values(value.adAccountRefs).every(ref => typeof ref === 'string') &&
      (tokens.personUrn === undefined || typeof tokens.personUrn === 'string'));
  }
  return isRecord(value.hubInfo) && typeof value.hubInfo.hub_id === 'number' &&
    Number.isFinite(value.hubInfo.hub_id) && typeof value.hubInfo.hub_domain === 'string' &&
    typeof value.hubInfo.user === 'string' && (value.accountType === 'crm' || value.accountType === 'marketing') &&
    isStrings(value.grantedScopes) && isStrings(value.missingScopes);
}

/** Shared AW-OAuthSessions row is the only store: any instance may finalize or connect. */
export async function storeOAuthFlowSession<T extends LocalOAuthFlowSession>(
  provider: PendingOAuthSession['provider'],
  session: T,
): Promise<string> {
  const sessionId = crypto.randomBytes(32).toString('hex');
  await oauthSessionDb.save({ sessionId, userId: session.userId, provider, payload: session });
  return sessionId;
}

export async function consumeOAuthFlowSession<T extends LocalOAuthFlowSession>(
  provider: PendingOAuthSession['provider'],
  sessionId: string,
  userId: string,
): Promise<T | null> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  // Errors propagate to the route's 500 handler; an outage is not a missing row.
  const stored = await oauthSessionDb.consume(sessionId, userId, provider);
  if (!stored || !isValidPayload(stored.payload, provider, userId)) return null;
  return stored.payload as T;
}
