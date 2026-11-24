/**
 * Zoma's LinkedIn Ads consent URL (copied from googleAdsConnectUrl.ts). The portal flow
 * (routes/linkedInAdsAuth.ts GET /init) builds its own URL with the full scope list in
 * config/integrations.ts and is not touched; Zoma asks only for what its tools need, by mode.
 *
 * Scopes (ZOMA_LINKEDIN_ADS_ENABLED):
 *   - read mode ("read"): r_ads (list ad accounts, campaign groups, campaigns, creatives, targeting,
 *     audience counts), r_ads_reporting (adAnalytics) and r_basicprofile (the member id that is
 *     stored as person_urn, exactly like a portal connection; the connect step tolerates its absence).
 *     Discovering the organization URN needs nothing more: it is the `reference` field of the ad
 *     account object that the r_ads search already returns.
 *   - full ("true"): the same plus rw_ads, which creating and editing campaign groups, campaigns and
 *     creatives needs. w_organization_social and r_organization_social are NOT requested: no Zoma
 *     write creates or reads a post (CREATIVE CREATE only references an existing post URN, or makes a
 *     text ad), so no write feature needs them.
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getLinkedInAdsConfig } from '../config/integrations';
import { getJwtSecret } from '../config/jwt';

const STATE_EXPIRATION = '15m';

export const ZOMA_LINKEDIN_READ_SCOPES: readonly string[] = ['r_basicprofile', 'r_ads', 'r_ads_reporting'];
export const ZOMA_LINKEDIN_WRITE_SCOPES: readonly string[] = ['rw_ads'];

/** Scopes to ask for: the read scopes, plus the write scope only when Zoma offers writes. */
export const zomaLinkedInScopes = (writes: boolean): string[] => [...ZOMA_LINKEDIN_READ_SCOPES, ...(writes ? ZOMA_LINKEDIN_WRITE_SCOPES : [])];

/**
 * What a Zoma link asks for: the mode's scopes PLUS the scopes already stored on the user's existing linkedin_ads
 * connections, so a reconnect never asks for (and so never records) less than a connection holds: a reconnect
 * replaces a connection's config wholesale. Only stored scopes that are STILL in the configured Ads scope list
 * (config/integrations.ts) are carried: a scope LinkedIn or AgentWeb has dropped is not requested forever.
 * Read mode never asks for rw_ads on its own: it appears only if the user's existing connection already holds it.
 * (A usable existing connection that already holds what the mode needs gets no link at all: see zomaOnboarding.ts.)
 */
export async function zomaLinkedInConsentScopes(userId: string, writes: boolean): Promise<string[]> {
  const { getAccountsByUserId } = await import('./connectedAccountsDb');
  let stored: string[] = [];
  try {
    const configured = new Set((await getLinkedInAdsConfig()).scopes);
    stored = (await getAccountsByUserId(userId))
      .filter((a) => a.platform === 'linkedin_ads')
      .flatMap((a) => ((a.config as any)?.scopes as unknown[]) ?? [])
      .filter((scope): scope is string => typeof scope === 'string' && /^[A-Za-z_]{2,60}$/.test(scope) && configured.has(scope));
  } catch {
    // Reading the stored scopes is best effort; the mode's scopes are still asked for.
  }
  return [...new Set([...zomaLinkedInScopes(writes), ...stored])];
}

/** The Zoma connect URL for `userId`, with the consent described above. */
export async function buildZomaLinkedInConnectUrl(userId: string, writes: boolean, stateExtra: Record<string, string>): Promise<string> {
  return buildLinkedInAdsConnectUrl(userId, stateExtra, await zomaLinkedInConsentScopes(userId, writes));
}

export const generateLinkedInAdsOAuthState = (userId: string, extra: Record<string, string> = {}): string =>
  jwt.sign({ ...extra, userId, nonce: crypto.randomBytes(16).toString('hex') }, getJwtSecret(), { expiresIn: STATE_EXPIRATION });

/**
 * `stateExtra` adds signed claims to the OAuth state (`{ zoma: 'mcp' }` routes the callback to
 * Zoma's server-side finalize instead of the portal, as the Google and Meta links do). The redirect
 * URI is the one already registered for the LinkedIn app (/api/oauth/linkedin-ads/callback), so no
 * LinkedIn app change is needed.
 */
export async function buildLinkedInAdsConnectUrl(userId: string, stateExtra: Record<string, string>, scopes: string[]): Promise<string> {
  const config = await getLinkedInAdsConfig();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state: generateLinkedInAdsOAuthState(userId, stateExtra),
    scope: scopes.join(' '),
  });
  return `${config.authorizationUrl}?${params.toString()}`;
}
