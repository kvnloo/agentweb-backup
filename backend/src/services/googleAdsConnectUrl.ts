/**
 * Google Ads OAuth connect URL — the same URL `GET /api/oauth/google-ads/init` returns,
 * extracted (ENG-2823, mirroring metaConnectUrl.ts) so the Zoma onboarding tool hands the
 * user the existing connect flow instead of building a second one. The callback / finalize
 * / connect steps are unchanged and still run in the customer portal.
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGoogleAdsConfig } from '../config/integrations';
import { getJwtSecret } from '../config/jwt';

const STATE_EXPIRATION = '15m';

export const generateGoogleAdsOAuthState = (userId: string): string =>
  jwt.sign({ userId, nonce: crypto.randomBytes(16).toString('hex') }, getJwtSecret(), { expiresIn: STATE_EXPIRATION });

export async function buildGoogleAdsConnectUrl(userId: string): Promise<string> {
  const config = await getGoogleAdsConfig();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    state: generateGoogleAdsOAuthState(userId),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${config.authorizationUrl}?${params.toString()}`;
}
