/**
 * Short-lived, one-time-use store for OAuth tokens between /finalize and /connect.
 *
 * The OAuth popup flow is four steps (/init → /callback → /finalize → /connect) and
 * the tokens must be held server-side between the last two — they are never exposed
 * to the frontend. gmailAuth originally held them in a process-local `Map`, which
 * breaks on multi-instance Elastic Beanstalk: /connect can land on a different
 * instance than /finalize and the session simply isn't there (ENG-301).
 *
 * Backing it with the shared settings table fixes that with no new infrastructure.
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
  userId: string;
  provider: OAuthProvider;
  tokens: OAuthTokens;
  profile: OAuthProfile;
  expires: number;
}

const settingName = (sessionId: string) => `oauth_token_session_${sessionId}`;

export async function storeTokenSession(
  userId: string,
  provider: OAuthProvider,
  tokens: OAuthTokens,
  profile: OAuthProfile,
): Promise<string> {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session: StoredSession = {
    userId,
    provider,
    tokens,
    profile,
    expires: Date.now() + TOKEN_SESSION_TTL_MS,
  };

  await settingsService.setSetting(
    settingName(sessionId),
    JSON.stringify(session),
    `Transient ${provider} OAuth token session`,
    'system',
  );

  return sessionId;
}

/**
 * Retrieve and burn a session. Returns null if it is unknown, expired, or belongs
 * to a different user or provider — and deletes it in every one of those cases, so
 * a guessed or stolen id cannot be retried.
 */
export async function retrieveTokenSession(
  sessionId: string,
  userId: string,
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; profile: OAuthProfile } | null> {
  const setting = await settingsService.getSetting(settingName(sessionId));
  if (!setting?.settingValue) {
    return null;
  }

  const burn = () => settingsService.deleteSetting(settingName(sessionId)).catch(() => undefined);

  let session: StoredSession;
  try {
    session = JSON.parse(setting.settingValue);
  } catch {
    await burn();
    return null;
  }

  const valid =
    session.userId === userId &&
    session.provider === provider &&
    Date.now() <= session.expires;

  // One-time use: burn it whether or not it was valid.
  await burn();

  if (!valid) {
    return null;
  }

  return { tokens: session.tokens, profile: session.profile };
}
