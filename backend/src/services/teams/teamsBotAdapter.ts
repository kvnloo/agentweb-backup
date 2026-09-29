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
import { getTeamsBotCredentials } from '../../utils/secretsManager';

let cachedAdapter: CloudAdapter | null = null;
let cachedForAppId: string | null = null;

/** Test hook: drop the memoized adapter so credentials are re-read. */
export function __resetTeamsBotAdapter(): void {
  cachedAdapter = null;
  cachedForAppId = null;
}

/**
 * Build (or reuse) the CloudAdapter for the configured bot.
 *
 * Memoized on appId rather than unconditionally: the adapter holds the SDK's token cache, so
 * rebuilding it per request would discard a valid Connector token and re-authenticate on every
 * inbound activity. Keying on appId means a credential rotation that changes the bot identity
 * still produces a fresh adapter.
 *
 * Throws when credentials are unavailable. Callers must treat that as fail-closed — an
 * unauthenticated endpoint is strictly worse than an unavailable one.
 */
export async function getTeamsBotAdapter(): Promise<CloudAdapter> {
  const { appId, appPassword, tenantId } = await getTeamsBotCredentials();

  if (cachedAdapter && cachedForAppId === appId) return cachedAdapter;

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
  cachedForAppId = appId;
  return adapter;
}
