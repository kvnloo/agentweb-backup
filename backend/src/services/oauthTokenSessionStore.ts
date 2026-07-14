/**
 * Short-lived, one-time-use store for OAuth tokens between /finalize and /connect.
 *
 * The OAuth popup flow is four steps (/init → /callback → /finalize → /connect) and the
 * tokens must be held server-side between the last two — they are never exposed to the
 * frontend. gmailAuth originally held them in a process-local `Map`, which breaks on
 * multi-instance Elastic Beanstalk: /connect can land on a different instance than
 * /finalize and the session simply isn't there (ENG-301).
 *
 * Storage design — why the key is deterministic:
 *
 * The obvious approach is to key each session by its random id. But then a user who
 * abandons the popup after /finalize (never calling /connect) leaves a row behind
 * containing an ACCESS TOKEN and a REFRESH TOKEN, forever — AW-Settings has no DynamoDB
 * TTL, and the in-memory version's sweeper does not survive the move. Every abandoned
 * attempt would add another row of live token material. That is unbounded secret-at-rest
 * growth, and it would be a regression against the code this replaces.
 *
 * So the row is keyed by `userId + provider` instead, and the random session id is stored
 * *inside* it and checked on read. The row is therefore self-overwriting: a user can leave
 * at most ONE stale session per provider, and their next attempt overwrites it. The random
 * id still does the security work — it is the bearer secret that /connect must present, and
 * it is compared in constant time.
 */

import crypto from 'crypto';
import { settingsService } from './settingsService';

const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type OAuthProvider = 'gmail' | 'outlook';

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
  sessionId: string; // the bearer secret /connect must present
  userId: string;
  provider: OAuthProvider;
  tokens: OAuthTokens;
  profile: OAuthProfile;
  expires: number;
}

/** Deterministic — one row per user per provider, overwritten on each attempt. */
const settingName = (userId: string, provider: OAuthProvider) =>
  `oauth_token_session_${provider}_${userId}`;

/** Constant-time compare so a session id cannot be recovered by timing the endpoint. */
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
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session: StoredSession = {
    sessionId,
    userId,
    provider,
    tokens,
    profile,
    expires: Date.now() + TOKEN_SESSION_TTL_MS,
  };

  // Overwrites any previous attempt by this user for this provider — which is what keeps
  // abandoned popups from accumulating live tokens.
  await settingsService.setSetting(
    settingName(userId, provider),
    JSON.stringify(session),
    `Transient ${provider} OAuth token session`,
    'system',
  );

  return sessionId;
}

/**
 * Retrieve and burn a session. Returns null if it is unknown, expired, or does not match
 * the presented session id — and deletes it in every one of those cases, so a guessed id
 * cannot be retried.
 */
export async function retrieveTokenSession(
  sessionId: string,
  userId: string,
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; profile: OAuthProfile } | null> {
  const name = settingName(userId, provider);
  const setting = await settingsService.getSetting(name);
  if (!setting?.settingValue) {
    return null;
  }

  const burn = () => settingsService.deleteSetting(name).catch(() => undefined);

  let session: StoredSession;
  try {
    session = JSON.parse(setting.settingValue);
  } catch {
    await burn();
    return null;
  }

  const valid =
    !!sessionId &&
    !!session.sessionId &&
    secretsMatch(session.sessionId, sessionId) &&
    session.userId === userId &&
    session.provider === provider &&
    Date.now() <= session.expires;

  // One-time use: burn it whether or not it validated.
  await burn();

  if (!valid) {
    return null;
  }

  return { tokens: session.tokens, profile: session.profile };
}
