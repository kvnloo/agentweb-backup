/**
 * Zoma LinkedIn Ads branch of the toolkit gateway (provider #4). Reached from handleMetaToolkitCall
 * after authentication, only while ZOMA_LINKEDIN_ADS_ENABLED is "read" or "true"; linkedin_ads_write
 * only while it is "true".
 *
 *   1. refuse anything outside the curated surface (linkedInAdsToolkitManifest) before any lookup;
 *   2. in read mode, refuse linkedin_ads_write here, before any account lookup or LinkedIn call;
 *   3. Zoma's own per-user throttle (a structured rate_limited answer, LinkedIn never called);
 *   4. resolve the caller's LinkedIn Ads account (own or org-shared, the provider-neutral
 *      resolveProviderAccount): an account_id that is not connected is a tool error listing the
 *      connected ids; no usable connection is a 403;
 *   5. a fresh access token for that connection (single-flight refresh, saved before use);
 *   6. reads → executeLinkedInAdsRead; writes → executeLinkedInAdsWrite (preview → confirm → apply → read-back);
 *   7. meter: one tool-use event per call, plus one write event per write that reached LinkedIn —
 *      both with platform 'linkedin_ads'.
 *
 * Nothing in this file puts a token in a result or a message: the session (which holds the access
 * token) is passed to the executors and never returned.
 */
import type { ConnectedAccount } from '../services/connectedAccountsDb';
import type { McpAuthMethod, recordMcpWriteExecuted } from '../services/mcpUsageEventsService';
import { getFreshLinkedInAdsToken, LinkedInConnectionError } from '../services/linkedInAdsCredentials';
import { rateLimiter } from '../middleware/rateLimiter';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import {
  assertLinkedInAdsToolkitCall, executeLinkedInAdsRead, isLinkedInAdsToolkitTool, isLinkedInAdsToolkitWrite, LINKEDIN_ADS_WRITE_TOOL,
} from './linkedInAdsToolkitManifest';
import { LINKEDIN_WRITES_NOT_AVAILABLE, linkedInThrottledResult, type LinkedInAdsSession } from './linkedInAdsCall';
import { LINKEDIN_ADS_PROVIDER, resolveProviderAccount } from './zomaProviders';
import { linkedInAdsWritesEnabled } from './zomaToolDefinitions';

export { assertLinkedInAdsToolkitCall, isLinkedInAdsToolkitTool, isLinkedInAdsToolkitWrite };

/** Per-user calls per minute against LinkedIn, all of Zoma's LinkedIn tools together; writes have their own, lower, limit. */
export const LINKEDIN_ADS_CALLS_PER_MINUTE = 30;
export const LINKEDIN_ADS_WRITES_PER_MINUTE = 10;

export interface LinkedInAdsToolkitCaller {
  userId: string;
  authMethod: McpAuthMethod;
  apiKeyId?: string;
  clientId?: string;
}

export interface LinkedInAdsToolkitGatewayDeps {
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  now: () => number;
  /** Records the single mcp_tool_used event (platform linkedin_ads); skips (ENG-3130) a result that reports failure. */
  meter: (result?: unknown) => Promise<unknown>;
  recordWrite: typeof recordMcpWriteExecuted;
  /** A foreign/unusable account (403); the gateway passes its MetaToolkitAuthError so HTTP maps it the same way. */
  accessError: (message: string) => Error;
  /** Defaults to full mode only (ZOMA_LINKEDIN_ADS_ENABLED=true). */
  writesEnabled?: () => boolean;
  /** Defaults to the shared in-process limiter. */
  throttle?: { check: (key: string, maxPerMinute: number) => { allowed: boolean; resetInMs: number } };
  getToken?: typeof getFreshLinkedInAdsToken;
  executeRead?: typeof executeLinkedInAdsRead;
  executeWrite?: (userId: string, args: any, session: LinkedInAdsSession) => Promise<any>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultWrite = async (userId: string, args: any, session: LinkedInAdsSession) =>
  (await import('./linkedInAdsToolkitWrites')).executeLinkedInAdsWrite(userId, args, session);

/**
 * Read mode: the write tool is not offered. metaToolkitGateway calls this first, BEFORE the API-key
 * scope check and the paywall, so a user who is not offered the tool can neither trigger a Stripe link
 * nor leave a funnel row for it.
 */
export function refuseLinkedInWriteWhenNotOffered(toolName: string, writesEnabled: () => boolean = linkedInAdsWritesEnabled): void {
  if (isLinkedInAdsToolkitWrite(toolName) && !writesEnabled()) throw new MetaToolkitRefusal(LINKEDIN_WRITES_NOT_AVAILABLE);
}

export async function handleLinkedInAdsToolkitCall(
  caller: LinkedInAdsToolkitCaller,
  request: { toolName: string; args?: any; sessionId?: string; userAgent?: string },
  deps: LinkedInAdsToolkitGatewayDeps,
) {
  const args = { ...(request.args ?? {}) };
  // Surface check first: nothing outside the curated list touches accounts or LinkedIn.
  assertLinkedInAdsToolkitCall(request.toolName, args);

  const write = isLinkedInAdsToolkitWrite(request.toolName);
  // Read mode: the write tool is neither advertised nor reachable. Refused before any lookup.
  if (write && !(deps.writesEnabled ?? linkedInAdsWritesEnabled)()) throw new MetaToolkitRefusal(LINKEDIN_WRITES_NOT_AVAILABLE);

  const throttle = deps.throttle ?? rateLimiter;
  const blocked = [
    throttle.check(`zoma-linkedin:${caller.userId}`, LINKEDIN_ADS_CALLS_PER_MINUTE),
    ...(write ? [throttle.check(`zoma-linkedin-write:${caller.userId}`, LINKEDIN_ADS_WRITES_PER_MINUTE)] : []),
  ].find((r) => !r.allowed);
  if (blocked) {
    const throttled = linkedInThrottledResult(Math.max(1, Math.ceil(blocked.resetInMs / 1000)));
    await deps.meter(throttled); // not billable (success false): leaves a failed-call audit row only
    return throttled;
  }

  const accounts = await deps.listAccounts(caller.userId);
  const resolved = resolveProviderAccount(LINKEDIN_ADS_PROVIDER, accounts, args.account_id, deps.now());
  if (!resolved.ok) {
    if (resolved.kind === 'ambiguous') throw new MetaToolkitRefusal(resolved.message);
    // A wrong account_id is an argument mistake the model can fix, so it is a tool error naming the
    // connected ids, not a transport-level 403. No usable connection at all stays the 403.
    const requested = LINKEDIN_ADS_PROVIDER.normalizeId(args.account_id);
    const connected = accounts.filter(LINKEDIN_ADS_PROVIDER.isAdAccount).flatMap(LINKEDIN_ADS_PROVIDER.accountIds);
    if (requested && !connected.includes(requested)) {
      throw new MetaToolkitRefusal(`LinkedIn Ads account ${requested} isn't connected; connected: ${connected.length ? connected.join(', ') : 'none'}.`);
    }
    throw deps.accessError(resolved.message);
  }
  const cfg: any = resolved.account.config;
  // An org-shared account belongs to a teammate: its tokens are refreshed and saved on the owner's record.
  const ownerUserId = String((resolved.account as { userId?: string }).userId ?? caller.userId);

  let auth: Awaited<ReturnType<typeof getFreshLinkedInAdsToken>>;
  try {
    auth = await (deps.getToken ?? getFreshLinkedInAdsToken)(ownerUserId, resolved.account);
  } catch (error) {
    if (error instanceof LinkedInConnectionError) throw deps.accessError(error.message);
    throw error;
  }
  const session: LinkedInAdsSession = {
    accountId: resolved.accountId,
    accessToken: auth.accessToken,
    currency: typeof cfg?.currency === 'string' ? cfg.currency.trim().toUpperCase() : '',
    freshToken: auth.fresh,
    connectedAccountIds: accounts.filter(LINKEDIN_ADS_PROVIDER.isAdAccount).flatMap(LINKEDIN_ADS_PROVIDER.accountIds),
    scopes: Array.isArray(cfg?.scopes) ? cfg.scopes.map(String) : undefined,
    sleep: deps.sleep,
  };

  let result: any;
  if (write) {
    result = await (deps.executeWrite ?? defaultWrite)(caller.userId, args, session);
  } else {
    result = await (deps.executeRead ?? executeLinkedInAdsRead)(args, session);
  }

  // Only a write with a read-back verdict reached LinkedIn (same rule as Meta/Google/X).
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
      platform: 'linkedin_ads',
      entityType: String(args.entity_type),
      action: String(args.action),
      verification: result.verification,
      objectId: result.id ?? undefined,
    }).catch((error) => {
      console.error('[linkedin-ads-toolkit] write metering failed:', error instanceof Error ? error.message : error);
      result.metering = 'failed: this write executed but was not recorded in usage';
    });
  }

  await deps.meter(result);
  return result;
}

export { LINKEDIN_ADS_WRITE_TOOL };
