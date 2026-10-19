/**
 * ENG-2283 — External-agent auth + per-call metering for Meta Toolkit calls (ENG-2268 child 3).
 *
 * The call path an external agent (e.g. Claude) uses to invoke the ENG-2282 manifest:
 *   1. authenticate with an account-scoped credential (aw_ agent API key, MCP OAuth access
 *      token, or — ENG-2496 — a zoma_ device-flow token),
 *   2. resolve the caller's connected Meta ad account (own or org-shared, same visibility
 *      Emma uses) and refuse a foreign account or a revoked/expired connection,
 *   3. execute through executeMetaToolkitCall (ENG-2268 refuses all external v1 writes),
 *   4. emit exactly ONE usage event per successful call via recordMcpToolUse.
 *
 * Storage: reuses agent API keys, MCP OAuth tokens, connected accounts and MCP usage events
 * only. No new table, key or persistence model (data-plane gate respected).
 */
import { agentApiKeyService } from '../services/agentApiKeyService';
import { mcpOAuthService } from './oauth/oauthService';
import {
  getAccountsByUserIdIncludingOrgShared,
  type ConnectedAccount,
} from '../services/connectedAccountsDb';
import { isMetaAdAccount } from '../services/metaTokenRefresh';
import { recordMcpToolUse, recordMcpWriteExecuted, type McpAuthMethod } from '../services/mcpUsageEventsService';
import { executeMetaToolkitCall, getMetaToolkitManifest, MetaToolkitRefusal } from './metaToolkitManifest';
import { RateLimiter } from '../middleware/rateLimiter';
import { isZomaTool } from './zomaToolDefinitions';
import { executeMetaToolkitWrite, isGuardedWriteRequest } from './metaToolkitWrites';
import { metaConnectionIsUsable, runZomaTool, ZomaNotReadyError } from './zomaOnboarding';
import { validateZomaToken, ZOMA_TOKEN_PREFIX } from './zomaDeviceFlow';

export class MetaToolkitAuthError extends Error {
  readonly status: 401 | 403 | 429;
  readonly retryAfterSeconds?: number;
  constructor(message: string, status: 401 | 403 | 429, retryAfterSeconds?: number) {
    super(message);
    this.name = 'MetaToolkitAuthError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** OAuth callers get the same 60/min ceiling as the MCP server; API keys use their own rateLimitPerMin. */
export const META_TOOLKIT_OAUTH_MAX_PER_MINUTE = 60;
const credentialRateLimiter = new RateLimiter();

export interface MetaToolkitCaller {
  userId: string;
  authMethod: McpAuthMethod;
  apiKeyId?: string;
  clientId?: string;
  /** ENG-2496 device-flow Zoma token id (never the token). */
  zomaTokenId?: string;
}

export interface MetaToolkitGatewayDeps {
  validateApiKey: (raw: string) => Promise<{ userId: string; keyId: string; expiresAt?: string; rateLimitPerMin?: number } | null>;
  validateOAuthToken: (raw: string) => Promise<{ userId: string; clientId: string } | null>;
  /** ENG-2496 per-user Zoma token from device-flow onboarding; defaults to validateZomaToken. */
  validateZomaToken?: (raw: string) => Promise<{ userId: string; tokenId: string } | null>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  execute: typeof executeMetaToolkitCall;
  recordUsage: typeof recordMcpToolUse;
  now: () => number;
  rateLimiter?: Pick<RateLimiter, 'check'>;
  /** ENG-2303 toolkit-local Zoma tools; defaults to runZomaTool. */
  runZomaTool?: typeof runZomaTool;
  /** ENG-2303 P3 guarded writes; defaults to executeMetaToolkitWrite. */
  executeWrite?: (userId: string, args: any) => Promise<any>;
  /** ENG-2303 P4 distinct write metering; defaults to recordMcpWriteExecuted. */
  recordWrite?: typeof recordMcpWriteExecuted;
}

/** Per-credential ceiling, so one key/token cannot exceed its limit by spreading calls across IPs. */
function enforceCredentialLimit(deps: MetaToolkitGatewayDeps, key: string, limit: number) {
  const result = (deps.rateLimiter ?? credentialRateLimiter).check(`meta-toolkit:${key}`, limit);
  if (!result.allowed) {
    throw new MetaToolkitAuthError(
      'Rate limit exceeded for this credential. Try again shortly.',
      429,
      Math.max(1, Math.ceil(result.resetInMs / 1000)),
    );
  }
}

const defaultDeps: MetaToolkitGatewayDeps = {
  validateApiKey: (raw) => agentApiKeyService.validateKey(raw),
  validateOAuthToken: (raw) => mcpOAuthService.validateAccessToken(raw),
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  execute: executeMetaToolkitCall,
  recordUsage: recordMcpToolUse,
  now: () => Date.now(),
};

function bearerToken(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/** Authenticate an external caller. Only account-scoped credentials; the internal static token is refused. */
export async function authenticateMetaToolkitCaller(
  authorization: string | undefined | null,
  deps: MetaToolkitGatewayDeps = defaultDeps,
): Promise<MetaToolkitCaller> {
  const token = bearerToken(authorization);
  if (!token) throw new MetaToolkitAuthError('Missing access token.', 401);

  if (token.startsWith('aw_')) {
    const key = await deps.validateApiKey(token);
    if (!key?.userId) throw new MetaToolkitAuthError('Invalid or revoked API key.', 401);
    if (key.expiresAt && Date.parse(key.expiresAt) <= deps.now()) {
      throw new MetaToolkitAuthError('API key has expired.', 401);
    }
    enforceCredentialLimit(deps, `key:${key.keyId}`, key.rateLimitPerMin ?? META_TOOLKIT_OAUTH_MAX_PER_MINUTE);
    return { userId: key.userId, authMethod: 'api_key', apiKeyId: key.keyId };
  }

  if (token.startsWith(ZOMA_TOKEN_PREFIX)) {
    const zoma = await (deps.validateZomaToken ?? ((raw: string) => validateZomaToken(raw)))(token);
    if (!zoma?.userId) throw new MetaToolkitAuthError('Invalid or revoked Zoma token.', 401);
    enforceCredentialLimit(deps, `zoma:${zoma.tokenId}`, META_TOOLKIT_OAUTH_MAX_PER_MINUTE);
    return { userId: zoma.userId, authMethod: 'zoma_token', zomaTokenId: zoma.tokenId };
  }

  const oauth = await deps.validateOAuthToken(token);
  if (!oauth?.userId) throw new MetaToolkitAuthError('Invalid access token.', 401);
  enforceCredentialLimit(deps, `oauth:${oauth.userId}`, META_TOOLKIT_OAUTH_MAX_PER_MINUTE);
  return { userId: oauth.userId, authMethod: 'oauth', clientId: oauth.clientId };
}

function normalizeAdAccountId(id: unknown): string {
  return String(id ?? '').trim().replace(/^act_/, '');
}

const connectionIsUsable = metaConnectionIsUsable;

/**
 * Resolve the Meta ad account this call runs against. A requested account must be one the
 * caller can see; without a request, exactly one usable connection must exist.
 */
export async function resolveMetaToolkitAdAccount(
  userId: string,
  requestedAccountId: unknown,
  deps: MetaToolkitGatewayDeps = defaultDeps,
): Promise<string> {
  const metaAccounts = (await deps.listAccounts(userId)).filter(isMetaAdAccount);
  const requested = normalizeAdAccountId(requestedAccountId);
  const now = deps.now();

  if (requested) {
    const match = metaAccounts.find((a) => {
      const cfg: any = a.config;
      return normalizeAdAccountId(cfg?.ad_account_id) === requested || normalizeAdAccountId(a.account_id) === requested;
    });
    if (!match) throw new MetaToolkitAuthError('That Meta ad account is not connected to this account.', 403);
    if (!connectionIsUsable(match, now)) {
      throw new MetaToolkitAuthError('The Meta connection for this ad account was revoked or expired. Reconnect Meta.', 403);
    }
    return requested;
  }

  const usable = metaAccounts.filter((a) => connectionIsUsable(a, now));
  if (usable.length === 0) {
    throw new MetaToolkitAuthError('No usable Meta ad account is connected. Connect or reconnect Meta.', 403);
  }
  if (usable.length > 1) {
    throw new MetaToolkitRefusal('Multiple Meta ad accounts are connected; pass account_id.');
  }
  const cfg: any = usable[0].config;
  return normalizeAdAccountId(cfg?.ad_account_id || usable[0].account_id);
}

// Fail closed: if the manifest cannot be read, let the error propagate so the call is
// refused (and not metered) rather than executing without the resolved account binding.
function toolAcceptsAccountId(name: string): boolean {
  const def = getMetaToolkitManifest().find((d: any) => d.name === name);
  return !!def?.inputSchema?.properties?.account_id;
}

/**
 * Full external call: authenticate → resolve account → execute → meter once on success.
 * A refused or failed call is not metered.
 */
export async function handleMetaToolkitCall(
  request: { authorization?: string | null; toolName: string; args?: any; sessionId?: string; userAgent?: string },
  deps: MetaToolkitGatewayDeps = defaultDeps,
) {
  const caller = await authenticateMetaToolkitCaller(request.authorization, deps);
  const meter = () =>
    deps.recordUsage({
      userId: caller.userId,
      toolName: request.toolName,
      authMethod: caller.authMethod,
      apiKeyId: caller.apiKeyId,
      clientId: caller.clientId,
      sessionId: request.sessionId,
      userAgent: request.userAgent,
    });

  // ENG-2303: onboarding tools must work before Meta is connected, so they skip account resolution.
  if (isZomaTool(request.toolName)) {
    let result;
    try {
      result = await (deps.runZomaTool ?? runZomaTool)(request.toolName, request.args ?? {}, { userId: caller.userId });
    } catch (error) {
      if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
      throw error;
    }
    await meter();
    return result;
  }

  const args = { ...(request.args ?? {}) };
  const accountId = await resolveMetaToolkitAdAccount(caller.userId, args.account_id, deps);
  if (toolAcceptsAccountId(request.toolName)) args.account_id = accountId;

  // ENG-2303 P3: CAMPAIGN/AD_SET/AD CREATE + status/budget UPDATE go through the guarded
  // preview→confirm path; every other write stays refused by assertMetaToolkitV1Call.
  const guardedWrite = isGuardedWriteRequest(request.toolName, args);
  const result = guardedWrite
    ? await (deps.executeWrite ?? executeMetaToolkitWrite)(caller.userId, args)
    : await deps.execute(request.toolName, args, {
        userId: caller.userId,
        sessionId: request.sessionId,
      });

  // ENG-2303 P4: a write that reached Meta (it has a read-back verdict) is metered as its
  // own event kind. Previews, mismatched confirms and refused/failed writes are not.
  // A metering failure must not make an executed write look failed (that invites a retry
  // and a duplicate), so it is logged and surfaced on the result instead of thrown.
  if (guardedWrite && typeof (result as any)?.verification === 'string') {
    await (deps.recordWrite ?? recordMcpWriteExecuted)({
      userId: caller.userId,
      toolName: request.toolName,
      authMethod: caller.authMethod,
      apiKeyId: caller.apiKeyId,
      clientId: caller.clientId,
      sessionId: request.sessionId,
      userAgent: request.userAgent,
      entityType: String(args.entity_type),
      action: String(args.action),
      verification: (result as any).verification,
      objectId: (result as any).id ?? undefined,
    }).catch((error) => {
      console.error('[meta-toolkit] write metering failed:', error instanceof Error ? error.message : error);
      (result as any).metering = 'failed: this write executed but was not recorded in usage';
    });
  }

  await meter();
  return result;
}
