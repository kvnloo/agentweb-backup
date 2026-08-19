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

export type OAuthProvider = 'gmail' | 'outlook' | 'calendly';

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
  user_uri?: string;         // Calendly
  organization_uri?: string; // Calendly
}

interface StoredSession {
  sessionId: string; // the bearer secret /connect must present
  tokens: OAuthTokens;
  profile: OAuthProfile;
  expires: number;
}

/** One row per user per provider, holding any in-flight sessions for that pair. */
interface SessionRow {
  userId: string;
  provider: OAuthProvider;
  sessions: StoredSession[];
}

/**
 * Cap on concurrent in-flight sessions per user+provider. A user can legitimately have more
 * than one popup open (connecting two Gmail accounts), but not twenty — this bounds the row
 * even if something is retrying in a loop. Oldest is evicted first.
 */
const MAX_CONCURRENT_SESSIONS = 5;

/** Deterministic — one row per user per provider. */
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
    await settingsService.deleteSetting(settingName(row.userId, row.provider)).catch(() => undefined);
    return;
  }
  // DynamoDB TTL attribute (Greptile, ENG-266 review): without this, an abandoned popup's
  // row is only pruned by our own read/write code — if the user never retries that
  // provider, the row (and its refresh token) physically outlives its own `expires` value
  // forever. Set the TTL to the furthest-out session's expiry so DynamoDB never deletes a
  // row while a still-live sibling session exists.
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
  const now = Date.now();
  const sessionId = crypto.randomBytes(32).toString('hex');

  const row = await readRow(userId, provider);

  // Drop anything already expired. This is what replaces the in-memory sweeper: every
  // write prunes, so an abandoned popup's tokens survive at most one TTL past the user's
  // next attempt, and the row can never grow without bound.
  row.sessions = row.sessions.filter((s) => live(s, now));

  row.sessions.push({
    sessionId,
    tokens,
    profile,
    expires: now + TOKEN_SESSION_TTL_MS,
  });

  // Keep the most recent few — a user may have two popups open, not twenty.
  if (row.sessions.length > MAX_CONCURRENT_SESSIONS) {
    row.sessions = row.sessions.slice(-MAX_CONCURRENT_SESSIONS);
  }

  await writeRow(row);
  return sessionId;
}

/**
 * Retrieve and burn a session. Returns null if it is unknown, expired, or does not match a
 * live session id for this user+provider.
 *
 * ENG-965 — what "one-time use" actually guarantees here: the persisted removal is
 * CONDITIONED on the exact row this call read (optimistic concurrency via
 * `settingsService.*IfValueMatches`), and token material is returned ONLY when that
 * conditional write actually applied. Concretely:
 *   - Write applies  → the removal provably happened; tokens are returned.
 *   - Conditional-check failure (another request changed the row first) → this read was
 *     stale, so the match cannot be trusted; returns null rather than risk handing out
 *     tokens for an already-superseded session.
 *   - Any other store failure → the write never applied, so the row is provably unchanged
 *     from what was read (nothing was silently consumed); this rethrows so the caller
 *     produces a deliberate error instead of pretending the session was used.
 * A session can only ever be replayed by presenting its id again before this call
 * completes successfully for it — never after, and never merely because a later
 * persistence attempt happened to fail.
 *
 * Only the matching session is removed — concurrent popups for the same provider do not
 * invalidate each other. Expired siblings are pruned on the way through, atomically with
 * the same write.
 */
export async function retrieveTokenSession(
  sessionId: string,
  userId: string,
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; profile: OAuthProfile } | null> {
  if (!sessionId) return null;

  const now = Date.now();
  const key = settingName(userId, provider);
  const setting = await settingsService.getSetting(key);
  if (!setting?.settingValue) return null;

  let sessions: StoredSession[];
  try {
    const parsed = JSON.parse(setting.settingValue) as SessionRow;
    sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return null;
  }
  if (sessions.length === 0) return null;

  const match = sessions.find(
    (s) => s.sessionId && live(s, now) && secretsMatch(s.sessionId, sessionId),
  );

  // Remove the matched session, and prune expired siblings while we're here — conditioned
  // on the exact raw value we just read, so this write can only apply if nothing else has
  // touched the row since (see doc comment above).
  const remaining = sessions.filter((s) => live(s, now) && s !== match);

  try {
    if (remaining.length === 0) {
      await settingsService.deleteSettingIfValueMatches(key, setting.settingValue);
    } else {
      const furthestExpiry = Math.max(...remaining.map((s) => s.expires));
      await settingsService.setSettingIfValueMatches(
        key,
        JSON.stringify({ userId, provider, sessions: remaining }),
        setting.settingValue,
        `Transient ${provider} OAuth token session`,
        'system',
        Math.floor(furthestExpiry / 1000),
      );
    }
  } catch (err: any) {
    if (err?.code === 'ConditionalCheckFailedException') {
      return null;
    }
    throw err;
  }

  if (!match) {
    return null;
  }

  return { tokens: match.tokens, profile: match.profile };
}
