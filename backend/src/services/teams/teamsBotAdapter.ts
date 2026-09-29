/**
 * Azure Bot Service adapter for the Teams channel (ENG-272).
 *
 * Why the SDK rather than hand-rolled JWT checks: authenticating Bot Connector traffic
 * requires seven separate verifications (issuer, audience, the serviceUrl claim matching the
 * activity, an RS256 signature against a rotating JWKS, a five-minute skew window, and
 * per-channel endorsements), plus an entirely separate validation path for the Bot Framework
 * Emulator. Microsoft's own guidance is explicit that implementing this yourself risks
 * "an attacker being able to read messages that are sent to your bot, send messages that
 * impersonate your bot, and steal secret keys". CloudAdapter does all of it.
 *
 * The bots are SingleTenant because Azure refused MultiTenant creation as deprecated
 * (2025-07-31). That is not cosmetic: a single-tenant bot must acquire its Connector token
 * from its own tenant's endpoint, which is what MicrosoftAppType tells the SDK.
 */

import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
  TurnContext,
} from 'botbuilder';
import { createHash } from 'crypto';
import { getTeamsBotCredentials } from '../../utils/secretsManager';

let cachedAdapter: CloudAdapter | null = null;
let cachedForKey: string | null = null;

/**
 * Cache key over the whole credential triple, not just appId.
 *
 * CodeRabbit, PR #3139: a client-secret rotation keeps the same appId. Keying on appId alone
 * meant that once the credentials cache expired and returned the NEW password, this still
 * handed back the adapter built with the OLD one — every outbound reply failing to
 * authenticate until the process restarted.
 *
 * Hashed rather than concatenated so the secret does not sit in a second plaintext copy in a
 * module-level variable for the life of the process.
 */
function credentialKey(appId: string, appPassword: string, tenantId: string): string {
  return createHash('sha256').update(`${appId}\u0000${tenantId}\u0000${appPassword}`).digest('hex');
}

/** Test hook: drop the memoized adapter so credentials are re-read. */
export function __resetTeamsBotAdapter(): void {
  cachedAdapter = null;
  cachedForKey = null;
}

/**
 * Build (or reuse) the CloudAdapter for the configured bot.
 *
 * Memoized rather than rebuilt per request: the adapter holds the SDK's token cache, so
 * rebuilding it every time would discard a valid Connector token and re-authenticate on every
 * inbound activity. The key covers appId, tenantId AND appPassword, so a rotated secret
 * produces a fresh adapter instead of one that authenticates with the retired password.
 *
 * Throws when credentials are unavailable. Callers must treat that as fail-closed — an
 * unauthenticated endpoint is strictly worse than an unavailable one.
 */
export async function getTeamsBotAdapter(): Promise<CloudAdapter> {
  const { appId, appPassword, tenantId } = await getTeamsBotCredentials();

  const key = credentialKey(appId, appPassword, tenantId);
  if (cachedAdapter && cachedForKey === key) return cachedAdapter;

  const authConfig = {
    MicrosoftAppType: 'SingleTenant',
    MicrosoftAppId: appId,
    MicrosoftAppPassword: appPassword,
    MicrosoftAppTenantId: tenantId,
  } as ConfigurationBotFrameworkAuthenticationOptions;

  const adapter = new CloudAdapter(new ConfigurationBotFrameworkAuthentication(authConfig));

  // Without this the SDK rethrows, Express's default handler answers the Connector with a
  // stack trace, and Microsoft retries a request that will never succeed. Log and absorb.
  adapter.onTurnError = async (context: TurnContext, error: Error) => {
    console.error('❌ [teams] unhandled error in turn handler:', error);
  };

  cachedAdapter = adapter;
  cachedForKey = key;
  return adapter;
}
