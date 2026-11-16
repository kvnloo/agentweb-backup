/**
 * Meta OAuth connect URL — the same URL `GET /api/oauth/meta/init` returns, extracted so
 * non-HTTP callers (the Zoma onboarding tool, ENG-2303) hand the user the existing connect
 * flow instead of building a second one. The callback/finalize/connect-ad-accounts steps
 * are unchanged and still run in the customer portal.
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getMetaCredentials, getInstagramCredentials } from '../utils/secretsManager';
import { getMetaFlowConfig, INTEGRATION_CONFIG, MetaFlowType } from '../config/integrations';
import { getJwtSecret } from '../config/jwt';

export function generateMetaOAuthState(userId: string, extra: Record<string, any> = {}): string {
  return jwt.sign({ userId, ...extra, timestamp: Date.now(), nonce: crypto.randomBytes(16).toString('hex') }, getJwtSecret(), { expiresIn: '10m' });
}

export function buildOAuthUrl(params: { authorizationUrl: string; clientId: string; redirectUri: string; scopes: string[]; state: string; authType?: string }): string {
  const searchParams = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    scope: params.scopes.join(','),
    response_type: 'code',
    ...(params.authType ? { auth_type: params.authType } : {}),
  });
  return `${params.authorizationUrl}?${searchParams.toString()}`;
}

/**
 * `stateExtra` adds signed claims to the OAuth state (ENG-2496: `{ zoma: deviceId }` routes the
 * callback to Zoma's server-side finalize instead of the portal).
 */
export async function buildMetaConnectUrl(userId: string, flow: MetaFlowType = 'marketing', stateExtra: Record<string, string> = {}): Promise<string> {
  // Instagram Business Login uses its own app credentials; marketing/pages use the Facebook app.
  const creds = flow === 'instagram' ? await getInstagramCredentials() : await getMetaCredentials();
  const flowCfg = getMetaFlowConfig(flow);
  return buildOAuthUrl({
    authorizationUrl: flowCfg.authorizationUrl,
    clientId: flow === 'instagram' ? creds.instagramClientId : creds.clientId,
    redirectUri: flow === 'instagram' ? INTEGRATION_CONFIG.meta.instagramRedirectUri : INTEGRATION_CONFIG.meta.redirectUri,
    scopes: flowCfg.scopes,
    state: generateMetaOAuthState(userId, { ...stateExtra, flow }),
    // Meta does not re-prompt for declined permissions during an ordinary reconnect.
    // `rerequest` is the documented path that lets a customer approve previously
    // declined Pages/permissions instead of receiving another token with the same gap.
    authType: flow === 'marketing' ? 'rerequest' : undefined,
  });
}
