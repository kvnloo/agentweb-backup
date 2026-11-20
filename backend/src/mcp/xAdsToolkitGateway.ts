/**
 * ENG-3142 — X (Twitter) Ads branch of the Zoma toolkit gateway (provider #3). Reached from
 * handleMetaToolkitCall after authentication, only while ZOMA_X_ADS_ENABLED=true.
 *
 *   1. refuse anything outside the curated surface (xAdsToolkitManifest) before any lookup;
 *   2. resolve the caller's X Ads account (own or org-shared, the provider-neutral
 *      resolveProviderAccount) and refuse a foreign or unusable one;
 *   3. decrypt that connection's OAuth 1.0a token pair and attach the app consumer key/secret;
 *   4. reads → executeXAdsRead; writes → executeXAdsWrite (preview → confirm → apply → read-back);
 *   5. meter: one tool-use event per call, plus one write event per write that reached X —
 *      both with platform 'x_ads'.
 */
import type { ConnectedAccount } from '../services/connectedAccountsDb';
import type { McpAuthMethod, recordMcpWriteExecuted } from '../services/mcpUsageEventsService';
import type { XAdsCredentials } from '../utils/secretsManager';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import {
  assertXAdsToolkitCall, executeXAdsRead, isXAdsToolkitTool, isXAdsToolkitWrite, X_ADS_READ_TOOL, type XAdsSession,
} from './xAdsToolkitManifest';
import { resolveProviderAccount, X_ADS_PROVIDER } from './zomaProviders';

export { isXAdsToolkitTool, isXAdsToolkitWrite };

export interface XAdsToolkitCaller {
  userId: string;
  authMethod: McpAuthMethod;
  apiKeyId?: string;
  clientId?: string;
}

export interface XAdsToolkitGatewayDeps {
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  now: () => number;
  meter: (result?: unknown) => Promise<unknown>;
  recordWrite: typeof recordMcpWriteExecuted;
  accessError: (message: string) => Error;
  getAppCredentials?: () => Promise<XAdsCredentials>;
  /** Encrypted stored value → plaintext (utils/crypto decryptPassword). */
  decrypt?: (ciphertext: string) => string;
  executeRead?: typeof executeXAdsRead;
  executeWrite?: (userId: string, args: any, session: XAdsSession, currency: string) => Promise<any>;
}

const defaultDecrypt = (ciphertext: string) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { decryptPassword } = require('../utils/crypto') as typeof import('../utils/crypto');
  return decryptPassword(ciphertext).password;
};

const defaultAppCredentials = async () => (await import('../utils/secretsManager')).getXAdsCredentials();

const defaultWrite = async (userId: string, args: any, session: XAdsSession, currency: string) =>
  (await import('./xAdsToolkitWrites')).executeXAdsWrite(userId, args, session, currency);

export async function handleXAdsToolkitCall(
  caller: XAdsToolkitCaller,
  request: { toolName: string; args?: any; sessionId?: string; userAgent?: string },
  deps: XAdsToolkitGatewayDeps,
) {
  const args = { ...(request.args ?? {}) };
  assertXAdsToolkitCall(request.toolName, args);

  const resolved = resolveProviderAccount(X_ADS_PROVIDER, await deps.listAccounts(caller.userId), args.account_id, deps.now());
  if (!resolved.ok) {
    if (resolved.kind === 'ambiguous') throw new MetaToolkitRefusal(resolved.message);
    throw deps.accessError(resolved.message);
  }
  const cfg: any = resolved.account.config;
  const decrypt = deps.decrypt ?? defaultDecrypt;
  let token: string;
  let tokenSecret: string;
  try {
    token = decrypt(String(cfg.access_token));
    tokenSecret = decrypt(String(cfg.access_token_secret));
  } catch {
    throw deps.accessError('The X Ads connection could not be read. Reconnect X Ads.');
  }
  const app = await (deps.getAppCredentials ?? defaultAppCredentials)();
  const session: XAdsSession = {
    accountId: resolved.accountId,
    credentials: { consumerKey: app.consumerKey, consumerSecret: app.consumerSecret, token, tokenSecret },
  };
  const currency = String(cfg.currency || 'USD');

  const write = isXAdsToolkitWrite(request.toolName);
  const result = write
    ? await (deps.executeWrite ?? defaultWrite)(caller.userId, args, session, currency)
    : await (deps.executeRead ?? executeXAdsRead)(args, session);

  // Only a write with a read-back verdict reached X (same rule as Meta/Google).
  if (write && typeof result?.verification === 'string') {
    await deps.recordWrite({
      product: 'zoma',
      userId: caller.userId,
      toolName: request.toolName,
      authMethod: caller.authMethod,
      apiKeyId: caller.apiKeyId,
      clientId: caller.clientId,
      sessionId: request.sessionId,
      userAgent: request.userAgent,
      platform: 'x_ads',
      entityType: String(args.entity_type),
      action: String(args.action),
      verification: result.verification,
      objectId: result.id ?? undefined,
    }).catch((error) => {
      console.error('[x-ads-toolkit] write metering failed:', error instanceof Error ? error.message : error);
      result.metering = 'failed: this write executed but was not recorded in usage';
    });
  }

  await deps.meter(result);
  return result;
}

export { X_ADS_READ_TOOL };
