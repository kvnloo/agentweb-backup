/**
 * ENG-3142 — X (Twitter) Ads connect for a Zoma user (OAuth 1.0a, 3-legged).
 *
 *   zoma_status → signed start link (15 min, bound to the user, purpose x_ads_connect)
 *   GET /api/oauth/x-ads/start?t=…   → request_token (our callback) → redirect to X authorize
 *   GET /api/oauth/x-ads/callback    → access_token → list the ad accounts this X login can
 *                                      manage → one connected_accounts row (platform x_ads) per
 *                                      account, token + secret encrypted → "return to your agent".
 *
 * Like the Google/Meta Zoma links, the start link is a bearer link: whoever approves on X with it
 * connects THEIR X login to that user. The pending request-token secret lives in memory for 15
 * minutes and is single use (same pattern as routes/twitterAuth.ts PKCE sessions).
 *
 * Connecting is read-only toward X: it lists accounts; it creates no campaign or funding instrument.
 * Everything here 404s while ZOMA_X_ADS_ENABLED is off.
 */
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';
import type { CreateAccountInput, PlatformType } from '../services/connectedAccountsDb';
import { xAccessToken, xAdsListAll, xAuthorizeUrl, xRequestToken, type XFetch } from '../services/xAdsClient';
import type { XAdsCredentials } from '../utils/secretsManager';
import { xAdsToolkitEnabled } from './zomaToolDefinitions';

export const X_ADS_START_PATH = '/api/oauth/x-ads/start';
export const X_ADS_CALLBACK_PATH = '/api/oauth/x-ads/callback';
const LINK_TTL_S = 15 * 60;
const PENDING_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_USER = 5;
const PURPOSE = 'x_ads_connect';

export function buildXAdsConnectLink(userId: string, backendUrl: string, secret: string = getJwtSecret()): string {
  const t = jwt.sign({ sub: userId, purpose: PURPOSE }, secret, { expiresIn: LINK_TTL_S });
  return `${backendUrl.replace(/\/+$/, '')}${X_ADS_START_PATH}?t=${encodeURIComponent(t)}`;
}

export function verifyXAdsConnectLink(t: unknown, secret: string = getJwtSecret()): string | null {
  if (typeof t !== 'string' || !t) return null;
  try {
    const payload = jwt.verify(t, secret) as any;
    return payload?.purpose === PURPOSE && typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

interface PendingConnect { userId: string; tokenSecret: string; expires: number }

/** In-memory, single-use, per-user-capped store of request-token secrets keyed by oauth_token. */
export class PendingXConnects {
  private readonly pending = new Map<string, PendingConnect>();

  add(token: string, userId: string, tokenSecret: string, now: number): boolean {
    for (const [k, v] of this.pending) if (v.expires <= now) this.pending.delete(k);
    if ([...this.pending.values()].filter((p) => p.userId === userId).length >= MAX_PENDING_PER_USER) return false;
    this.pending.set(token, { userId, tokenSecret, expires: now + PENDING_TTL_MS });
    return true;
  }

  take(token: string, now: number): PendingConnect | null {
    const hit = this.pending.get(token);
    this.pending.delete(token);
    return hit && hit.expires > now ? hit : null;
  }
}

export interface ZomaXAdsConnectDeps {
  enabled: () => boolean;
  backendUrl: () => string;
  getAppCredentials: () => Promise<XAdsCredentials>;
  encrypt: (plaintext: string, userId: string) => string;
  saveAccount: (userId: string, platform: PlatformType, input: CreateAccountInput) => Promise<unknown>;
  pending: PendingXConnects;
  now: () => number;
  fetchImpl?: XFetch;
}

export type XConnectStep =
  | { kind: 'redirect'; url: string }
  | { kind: 'page'; status: number; title: string; body: string };

const BACK = 'Go back to your agent and ask it to check Zoma status again.';
const page = (status: number, title: string, body: string): XConnectStep => ({ kind: 'page', status, title, body });

export async function startXAdsConnect(t: unknown, deps: ZomaXAdsConnectDeps): Promise<XConnectStep> {
  if (!deps.enabled()) return page(404, 'Not found', 'Not found.');
  const userId = verifyXAdsConnectLink(t);
  if (!userId) return page(400, 'Link expired', `This X Ads connect link is invalid or expired. ${BACK}`);
  const app = await deps.getAppCredentials();
  const callback = `${deps.backendUrl().replace(/\/+$/, '')}${X_ADS_CALLBACK_PATH}`;
  const requestToken = await xRequestToken(app, callback, deps.fetchImpl);
  if (!deps.pending.add(requestToken.token, userId, requestToken.tokenSecret, deps.now())) {
    return page(429, 'Too many attempts', `Too many pending X Ads connects. Wait 15 minutes, then ${BACK.toLowerCase()}`);
  }
  return { kind: 'redirect', url: xAuthorizeUrl(requestToken.token) };
}

export async function completeXAdsConnect(query: { oauth_token?: unknown; oauth_verifier?: unknown; denied?: unknown }, deps: ZomaXAdsConnectDeps): Promise<XConnectStep> {
  if (!deps.enabled()) return page(404, 'Not found', 'Not found.');
  if (typeof query.denied === 'string') {
    deps.pending.take(query.denied, deps.now());
    return page(200, 'X Ads not connected', `You declined access on X, so nothing was connected. ${BACK}`);
  }
  if (typeof query.oauth_token !== 'string' || typeof query.oauth_verifier !== 'string') {
    return page(400, 'Missing parameters', `X did not return the expected parameters. ${BACK}`);
  }
  const pending = deps.pending.take(query.oauth_token, deps.now());
  if (!pending) return page(400, 'Link expired', `This X Ads connect attempt expired or was already used. ${BACK}`);

  const app = await deps.getAppCredentials();
  const access = await xAccessToken(app, { token: query.oauth_token, tokenSecret: pending.tokenSecret }, query.oauth_verifier, deps.fetchImpl);
  const accounts = await xAdsListAll({
    path: '/accounts',
    credentials: { ...app, token: access.token, tokenSecret: access.tokenSecret },
    fetchImpl: deps.fetchImpl,
  });
  const usable = accounts.filter((a) => a && a.id && !a.deleted);
  if (!usable.length) {
    return page(200, 'No X Ads account', `This X login (@${access.screenName ?? 'unknown'}) cannot manage any X Ads account. Create one at https://ads.x.com (or ask its owner to add you), then ${BACK.toLowerCase()}`);
  }
  for (const a of usable) {
    await deps.saveAccount(pending.userId, 'x_ads', {
      account_id: String(a.id),
      account_name: String(a.name ?? a.id),
      config: {
        account_type: 'x_ads',
        ad_account_id: String(a.id),
        access_token: deps.encrypt(access.token, pending.userId),
        access_token_secret: deps.encrypt(access.tokenSecret, pending.userId),
        token_expires_at: 0,
        x_user_id: access.userId,
        screen_name: access.screenName,
        currency: a.currency,
        timezone: a.timezone,
      },
    });
  }
  return page(200, 'X Ads connected', `Connected ${usable.length} X Ads account(s): ${usable.map((a) => a.name ?? a.id).join(', ')}. ${BACK}`);
}

export function defaultZomaXAdsConnectDeps(): ZomaXAdsConnectDeps {
  return {
    enabled: () => xAdsToolkitEnabled(),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    backendUrl: () => (require('./oauth/authChallenge') as typeof import('./oauth/authChallenge')).getBackendUrl(),
    getAppCredentials: async () => (await import('../utils/secretsManager')).getXAdsCredentials(),
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    encrypt: (plaintext, userId) => (require('../utils/crypto') as typeof import('../utils/crypto')).encryptPassword(plaintext, userId),
    saveAccount: async (userId, platform, input) => (await import('../services/connectedAccountsDb')).createAccount(userId, platform, input, { resetSharing: true }),
    pending: defaultPendingXConnects,
    now: () => Date.now(),
  };
}

export const defaultPendingXConnects = new PendingXConnects();
