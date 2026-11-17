/**
 * ENG-2823 — Google Ads branch of the Zoma toolkit gateway (provider #2). Reached from
 * handleMetaToolkitCall after authentication, only while ZOMA_GOOGLE_ADS_ENABLED=true.
 *
 *   1. resolve the caller's Google Ads customer (own or org-shared connection, the same
 *      visibility googleAdsService.getAccountCredentials uses) and refuse a foreign or
 *      unusable one — via the provider-neutral resolveProviderAccount;
 *   2. refuse anything outside the curated surface (googleToolkitManifest);
 *   3. reads → the same handler objects Emma registers; writes → googleToolkitWrites
 *      (preview → confirm → apply once → read-back; ENG-2928 ASSET UPLOAD is non-spending,
 *      so it applies once → read-back without a preview token);
 *   4. meter: one tool-use event per successful call, plus one write event per write that
 *      reached Google — both with platform 'google_ads'.
 */
import type { ConnectedAccount } from '../services/connectedAccountsDb';
import type { McpAuthMethod, recordMcpWriteExecuted } from '../services/mcpUsageEventsService';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import {
  assertGoogleToolkitCall, executeGoogleToolkitRead, isGoogleGuardedWrite, isGoogleToolkitTool, isGoogleToolkitWrite,
} from './googleToolkitManifest';
import { executeGoogleToolkitWrite } from './googleToolkitWrites';
import { GOOGLE_ADS_PROVIDER, resolveProviderAccount } from './zomaProviders';

export { isGoogleToolkitTool, isGoogleGuardedWrite, isGoogleToolkitWrite };

export interface GoogleToolkitCaller {
  userId: string;
  authMethod: McpAuthMethod;
  apiKeyId?: string;
  clientId?: string;
}

export interface GoogleToolkitGatewayDeps {
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  now: () => number;
  /** Records the single mcp_tool_used event (platform google_ads) once the call finishes; skips (ENG-3130) a result that reports failure. */
  meter: (result?: unknown) => Promise<unknown>;
  recordWrite: typeof recordMcpWriteExecuted;
  executeRead?: typeof executeGoogleToolkitRead;
  executeWrite?: (userId: string, args: any, currency: string) => Promise<any>;
  /** A foreign/unusable account (403); the gateway passes its MetaToolkitAuthError so HTTP maps it the same way. */
  accessError: (message: string) => Error;
}

export async function handleGoogleToolkitCall(
  caller: GoogleToolkitCaller,
  request: { toolName: string; args?: any; sessionId?: string; userAgent?: string },
  deps: GoogleToolkitGatewayDeps,
) {
  const args = { ...(request.args ?? {}) };
  // Surface check first: nothing outside the curated list touches accounts or Google.
  assertGoogleToolkitCall(request.toolName, args);

  const resolved = resolveProviderAccount(GOOGLE_ADS_PROVIDER, await deps.listAccounts(caller.userId), args.customer_id, deps.now());
  if (!resolved.ok) {
    if (resolved.kind === 'ambiguous') throw new MetaToolkitRefusal(resolved.message);
    throw deps.accessError(resolved.message);
  }
  args.customer_id = resolved.accountId;
  const currency = String((resolved.account.config as any)?.currency || 'USD');

  const write = isGoogleToolkitWrite(request.toolName, args);
  const result = write
    ? await (deps.executeWrite ?? executeGoogleToolkitWrite)(caller.userId, args, currency)
    : await (deps.executeRead ?? executeGoogleToolkitRead)(request.toolName, args, { userId: caller.userId, sessionId: request.sessionId });

  // Same rule as Meta (ENG-2303 P4): only a write with a read-back verdict reached Google.
  // A metering failure never makes an executed write look failed (that invites a retry).
  if (write && typeof result?.verification === 'string') {
    await deps.recordWrite({
      product: 'zoma', // ENG-2906: every toolkit surface is the Zoma product
      userId: caller.userId,
      toolName: request.toolName,
      authMethod: caller.authMethod,
      apiKeyId: caller.apiKeyId,
      clientId: caller.clientId,
      sessionId: request.sessionId,
      userAgent: request.userAgent,
      platform: 'google_ads',
      entityType: String(args.entity_type),
      action: String(args.action),
      verification: result.verification,
      objectId: result.id ?? undefined,
    }).catch((error) => {
      console.error('[google-toolkit] write metering failed:', error instanceof Error ? error.message : error);
      result.metering = 'failed: this write executed but was not recorded in usage';
    });
  }

  await deps.meter(result);
  return result;
}
