/**
 * Short-lived, one-time-use store for OAuth tokens between /finalize and /connect.
 *
 * Gmail and Outlook predate the canonical AW-OAuthSessions table and keep their
 * compatibility wrapper on AW-Settings. Newly migrated providers use the canonical table
 * through storeOAuthSession/retrieveOAuthSession: one random-keyed row per pending flow,
 * DynamoDB TTL for abandoned popups, and atomic delete-with-return for one-time consume.
 */

import crypto from 'crypto';
import { oauthSessionDb } from './db';
import { settingsService } from './settingsService';

const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type OAuthProvider = 'gmail' | 'outlook';
type DurableOAuthProvider = 'hubspot' | 'fathom';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  granted_scopes: string[];
}

export interface OAuthProfile {
  email: string;
  name: string;
  picture?: string;
  tenant_id?: string;
}

interface StoredSession {
  sessionId: string;
  tokens: OAuthTokens;
  profile: OAuthProfile;
  expires: number;
}

interface SessionRow {
  userId: string;
  provider: OAuthProvider;
  sessions: StoredSession[];
}

const MAX_CONCURRENT_SESSIONS = 5;

const settingName = (userId: string, provider: OAuthProvider) =>
  `oauth_token_session_${provider}_${userId}`;

const readRow = async (userId: string, provider: OAuthProvider): Promise<SessionRow> => {
  const setting = await settingsService.getSetting(settingName(userId, provider));
  if (!setting?.settingValue) {
    return { userId, provider, sessions: [] };
  }
  try {
    const row = JSON.parse(setting.settingValue) as SessionRow;
    return {
      userId,
      provider,
      sessions: Array.isArray(row?.sessions) ? row.sessions : [],
    };
  } catch {
    return { userId, provider, sessions: [] };
  }
};

const writeRow = async (row: SessionRow): Promise<void> => {
  if (row.sessions.length === 0) {
    // Fail closed: one-time use is only proven once the shared row is gone, so a failed
    // delete must not hand back a credential we could not burn.
    //
    // Scope note (ENG-162): this throw does NOT make the session unreplayable. The row is
    // still in AW-Settings and stays consumable until its TTL lapses or the user's next
    // attempt overwrites it — exactly as it was before. All this changes is that THIS
    // response no longer carries token material, at the cost of failing the legitimate
    // user's connect. Both callers (gmailAuth/outlookAuth `/connect`) invoke this outside
    // their try/catch, so the rejection escapes the route's error boundary.
    await settingsService.deleteSetting(settingName(row.userId, row.provider));
    return;
  }
  const furthestExpiry = Math.max(...row.sessions.map((s) => s.expires));
  await settingsService.setSetting(
    settingName(row.userId, row.provider),
    JSON.stringify(row),
    `Transient ${row.provider} OAuth token session`,
    'system',
    Math.floor(furthestExpiry / 1000),
  );
};

const live = (s: StoredSession, now: number) => s && s.expires > now;

const secretsMatch = (a: string, b: string): boolean => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

export async function storeTokenSession(
  userId: string,
  provider: OAuthProvider,
  tokens: OAuthTokens,
  profile: OAuthProfile,
): Promise<string> {
  const now = Date.now();
  const sessionId = crypto.randomBytes(32).toString('hex');
  const row = await readRow(userId, provider);

  row.sessions = row.sessions.filter((s) => live(s, now));
  row.sessions.push({
    sessionId,
    tokens,
    profile,
    expires: now + TOKEN_SESSION_TTL_MS,
  });

  if (row.sessions.length > MAX_CONCURRENT_SESSIONS) {
    row.sessions = row.sessions.slice(-MAX_CONCURRENT_SESSIONS);
  }

  await writeRow(row);
  return sessionId;
}

export async function retrieveTokenSession(
  sessionId: string,
  userId: string,
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; profile: OAuthProfile } | null> {
  if (!sessionId) return null;

  const now = Date.now();
  const row = await readRow(userId, provider);
  if (row.sessions.length === 0) return null;

  const match = row.sessions.find(
    (s) => s.sessionId && live(s, now) && secretsMatch(s.sessionId, sessionId),
  );
  row.sessions = row.sessions.filter((s) => live(s, now) && s !== match);
  await writeRow(row);

  return match ? { tokens: match.tokens, profile: match.profile } : null;
}

/**
 * Canonical shared primitive for newly migrated providers. AW-OAuthSessions is keyed by the
 * random bearer secret, expires abandoned rows with DynamoDB TTL, and atomically consumes a
 * matching user+provider row so concurrent /connect requests cannot replay token material.
 */
export async function storeOAuthSession<T>(
  userId: string,
  provider: DurableOAuthProvider,
  data: T,
): Promise<string> {
  const sessionId = crypto.randomBytes(32).toString('hex');
  await oauthSessionDb.savePending({ sessionId, userId, provider, data });
  return sessionId;
}

export async function retrieveOAuthSession<T>(
  sessionId: string,
  userId: string,
  provider: DurableOAuthProvider,
): Promise<T | null> {
  // `typeof` and not just falsiness: the session id is read straight off the request body and
  // then used as the DynamoDB partition key. A non-string (`{"tokenSessionId": {}}` or an
  // array) is truthy, so it would reach `consumePending` and fail the key's `S` type with a
  // ValidationException — a 500 on a malformed request. An unusable id is an invalid session,
  // so return null and let the route answer 401.
  if (!sessionId || typeof sessionId !== 'string') return null;
  return oauthSessionDb.consumePending<T>(sessionId, userId, provider);
}
