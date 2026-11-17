/**
 * Google Ads OAuth connect URL — the same URL `GET /api/oauth/google-ads/init` returns,
 * extracted (ENG-2823, mirroring metaConnectUrl.ts) so the Zoma onboarding tool hands the
 * user the existing connect flow instead of building a second one. The callback / finalize
 * / connect steps still run in the customer portal unless the state carries `zoma`.
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGoogleAdsConfig } from '../config/integrations';
import { getJwtSecret } from '../config/jwt';

const STATE_EXPIRATION = '15m';

export const generateGoogleAdsOAuthState = (userId: string, extra: Record<string, string> = {}): string =>
  jwt.sign({ userId, ...extra, nonce: crypto.randomBytes(16).toString('hex') }, getJwtSecret(), { expiresIn: STATE_EXPIRATION });

/**
 * `stateExtra` adds signed claims to the OAuth state (ENG-3135: `{ zoma: 'mcp' }` routes the
 * callback to Zoma's server-side finalize instead of the portal, as the Meta link does).
 * Only `access_type`/`prompt` are sent beyond the standard params — no locale, country or
 * account-creation hint — so nothing here can influence a Google-hosted signup.
 */
export async function buildGoogleAdsConnectUrl(userId: string, stateExtra: Record<string, string> = {}): Promise<string> {
  const config = await getGoogleAdsConfig();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    state: generateGoogleAdsOAuthState(userId, stateExtra),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${config.authorizationUrl}?${params.toString()}`;
}
