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
import { withMetaToolkitBackoff } from '../utils/metaToolkitBackoff';
import { agentApiKeyService } from '../services/agentApiKeyService';
import { mcpOAuthService } from './oauth/oauthService';
import {
  getAccountsByUserIdIncludingOrgShared,
  type ConnectedAccount,
} from '../services/connectedAccountsDb';
import { recordMcpToolUse, recordMcpWriteExecuted, type McpAuthMethod } from '../services/mcpUsageEventsService';
import { executeMetaToolkitCall, getMetaToolkitManifest, MetaToolkitRefusal } from './metaToolkitManifest';
import { isSignalsRead } from './metaToolkitSignals';
import { RateLimiter } from '../middleware/rateLimiter';
import { effectiveApiKeyScopes, findScopeDenial } from './server/apiKeyScopes';
import { AUDIENCE_TOOL_NAME, isAudienceWriteRequest, isZomaTool } from './zomaToolDefinitions';
import { isExperimentRead } from './metaToolkitExperiments';
import { explainMetaError, isDiagnosticsRead } from './metaToolkitDiagnostics';
import { getMetaHelpArticles } from './metaToolkitHelp';
import { executeMetaToolkitWrite, isGuardedWriteRequest } from './metaToolkitWrites';
import { runZomaTool, ZomaNotReadyError } from './zomaOnboarding';
import { googleToolkitEnabled, META_PROVIDER, resolveProviderAccount } from './zomaProviders';
import { validateZomaToken, ZOMA_TOKEN_PREFIX } from './zomaDeviceFlow';
import { isMetaHealthTool, runMetaHealthTool } from './metaToolkitHealth';
import { isMetaCatalogTool, runMetaCatalogTool } from './metaToolkitCatalogs';
import { EXPERIMENT_WRITE_KIND, isMetaExperimentWrite, isMetaExperimentWriteTool, runMetaExperimentWriteTool } from './metaToolkitExperimentWrites';
import { MetaToolkitForbidden } from './metaToolkitErrors';
import { EVENT_SOURCE_WRITE_KIND, isMetaEventSourceTool, isMetaEventSourceWrite, runMetaEventSourceTool } from './metaToolkitEventSources';
import { CATALOG_FEED_WRITE_KIND, isMetaCatalogFeedTool, isMetaCatalogFeedWrite, runMetaCatalogFeedTool } from './metaToolkitCatalogFeeds';
import { CATALOG_WRITE_KIND, isMetaCatalogWrite, isMetaCatalogWriteTool, runMetaCatalogWriteTool } from './metaToolkitCatalogWrites';
import { isMetaPagesTool, runMetaPagesTool } from './metaToolkitPages';
import { executeMetaToolkitCreative, isCreativeAssetRequest, prepareZomaUpload } from './metaToolkitCreatives';
import { isLifecycleWriteRequest } from './metaToolkitWriteSurface';
import { executeMetaToolkitLifecycle } from './metaToolkitLifecycle';
import { executeMetaToolkitAudience } from './metaToolkitAudiences';
import { DATABRICKS_READ_ONLY_MESSAGE, isDatabricksAllowedCall, isDatabricksClient } from './zomaDatabricksReadOnly';
import { noteProductUse, zomaMilestone } from '../services/journeyMilestones';
import { zomaWriteKindFor } from '../services/zomaWriteKind';

/**
 * ENG-2906: every toolkit surface (Meta, Google, zoma_ tokens) is the Zoma product. The first
 * successful read / executed write moves the user's zomaStage and emits first_read /
 * first_write once. Fire-and-forget: journey capture never delays or fails a tool call.
 */
const TOOLKIT_PRODUCT = 'zoma' as const;
function journeyAfterCall(userId: string, event: 'first_read' | 'first_write', props: Record<string, unknown>) {
  void zomaMilestone(userId, event, { emit: 'if_advanced', props: { product: TOOLKIT_PRODUCT, ...props } });
}

export class MetaToolkitAuthError extends Error {
  readonly status: 401 | 403 | 429 | 503;
  readonly retryAfterSeconds?: number;
  constructor(message: string, status: 401 | 403 | 429 | 503, retryAfterSeconds?: number) {
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
  /** ENG-2865: effective scopes of the aw_ key (api_key callers only). */
  apiKeyScopes?: string[];
  clientId?: string;
  /** ENG-2496 device-flow Zoma token id (never the token). */
  zomaTokenId?: string;
  /** ENG-2747: OAuth client registered from a Databricks workspace; Zoma is read-only for it. */
  databricksOrigin?: boolean;
}

export interface MetaToolkitGatewayDeps {
  validateApiKey: (raw: string) => Promise<{ userId: string; keyId: string; expiresAt?: string; rateLimitPerMin?: number; scopes?: string[] } | null>;
  validateOAuthToken: (raw: string) => Promise<{ userId: string; clientId: string } | null>;
  /** ENG-2496 per-user Zoma token from device-flow onboarding; defaults to validateZomaToken. */
  validateZomaToken?: (raw: string) => Promise<{ userId: string; tokenId: string } | null>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  execute: typeof executeMetaToolkitCall;
  recordUsage: typeof recordMcpToolUse;
  /** Injectable bounded BUC backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
  now: () => number;
  rateLimiter?: Pick<RateLimiter, 'check'>;
  /** ENG-2303 toolkit-local Zoma tools; defaults to runZomaTool. */
  runZomaTool?: typeof runZomaTool;
  /** ENG-2303 P3 guarded writes; defaults to executeMetaToolkitWrite. */
  executeWrite?: (userId: string, args: any) => Promise<any>;
  /** ENG-2303 P4 distinct write metering; defaults to recordMcpWriteExecuted. */
  recordWrite?: typeof recordMcpWriteExecuted;
  /** Creative assets (AD_CREATIVE UPLOAD_IMAGE/UPLOAD_VIDEO/CREATE); defaults to executeMetaToolkitCreative. */
  executeCreative?: (userId: string, args: any) => Promise<any>;
  /** ENG-2922 ARCHIVE/DELETE/COPY; defaults to executeMetaToolkitLifecycle. */
  executeLifecycle?: (userId: string, args: any) => Promise<any>;
  /** ENG-2916 read-only health tools; defaults to runMetaHealthTool. */
  runHealthTool?: typeof runMetaHealthTool;
  /** ENG-2918 read-only catalog tools; defaults to runMetaCatalogTool. */
  runCatalogTool?: typeof runMetaCatalogTool;
  /** ENG-2925 catalog product / product-set writes; defaults to runMetaCatalogWriteTool. */
  runCatalogWriteTool?: typeof runMetaCatalogWriteTool;
  /** ENG-2927 catalog event sources; defaults to runMetaEventSourceTool. */
  runEventSourceTool?: typeof runMetaEventSourceTool;
  /** ENG-2980 experiment eligibility + A/B / lift writes; defaults to runMetaExperimentWriteTool. */
  runExperimentWriteTool?: typeof runMetaExperimentWriteTool;
  /** ENG-2926 catalog create/update, feeds, upload sessions, feed rules; defaults to runMetaCatalogFeedTool. */
  runCatalogFeedTool?: typeof runMetaCatalogFeedTool;
  /** ENG-2920 read-only Pages/Instagram/Ad Library tools; defaults to runMetaPagesTool. */
  runPagesTool?: typeof runMetaPagesTool;
  /** zoma_prepare_upload; defaults to prepareZomaUpload. */
  prepareUpload?: (userId: string, args: any) => Promise<any>;
  /** ENG-2914 zoma_custom_audiences; defaults to executeMetaToolkitAudience. */
  executeAudience?: (userId: string, args: any) => Promise<any>;
  /** ENG-2747: redirect URIs of an OAuth client (null when unknown); defaults to mcpOAuthService.getClient. */
  getOAuthClientRedirectUris?: (clientId: string) => Promise<string[] | null>;
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
    return { userId: key.userId, authMethod: 'api_key', apiKeyId: key.keyId, apiKeyScopes: effectiveApiKeyScopes(key.scopes) };
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
  // ENG-2747 (option B): a client registered from a Databricks workspace gets read-only Zoma.
  // Fail closed: if the client lookup fails, the call is refused (retryable), never let through.
  let databricksOrigin: boolean;
  try {
    databricksOrigin = await isDatabricksOAuthClient(oauth.clientId, deps);
  } catch (error) {
    console.error('[meta-toolkit] OAuth client lookup failed:', error instanceof Error ? error.message : error);
    throw new MetaToolkitAuthError('Could not verify this connection right now. Try again shortly.', 503, 5);
  }
  return { userId: oauth.userId, authMethod: 'oauth', clientId: oauth.clientId, databricksOrigin };
}

/**
 * ENG-2747: whether an OAuth client was registered from a Databricks workspace. Redirect URIs are
 * only ever appended, so a positive answer is cached for the process lifetime; a negative one for
 * a few minutes. Not cached when a test injects its own lookup.
 */
const DATABRICKS_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const databricksClientCache = new Map<string, { databricks: boolean; until: number }>();

async function isDatabricksOAuthClient(clientId: string, deps: MetaToolkitGatewayDeps): Promise<boolean> {
  if (deps.getOAuthClientRedirectUris) return isDatabricksClient(await deps.getOAuthClientRedirectUris(clientId));
  const now = Date.now();
  const hit = databricksClientCache.get(clientId);
  if (hit && hit.until > now) return hit.databricks;
  const databricks = isDatabricksClient((await mcpOAuthService.getClient(clientId))?.redirectUris ?? null);
  if (databricksClientCache.size > 10_000) databricksClientCache.clear();
  databricksClientCache.set(clientId, { databricks, until: databricks ? Number.POSITIVE_INFINITY : now + DATABRICKS_NEGATIVE_TTL_MS });
  return databricks;
}

/**
 * ENG-2865: aw_ keys carry the same tools:read / tools:execute boundary here as on the main
 * MCP server (ENG-1083), via the same scope helper. A write-classified call needs
 * tools:execute; a read needs tools:read. Checked before any upstream platform call.
 * OAuth and Zoma-token callers are unchanged.
 */
export function assertMetaToolkitScope(caller: MetaToolkitCaller, toolName: string, write: boolean): void {
  if (caller.authMethod !== 'api_key') return;
  const denial = findScopeDenial(
    { method: 'tools/call', params: { name: toolName } },
    caller.apiKeyScopes ?? effectiveApiKeyScopes(undefined),
    () => ({ readOnly: !write }),
  );
  if (denial) {
    throw new MetaToolkitAuthError(
      `This API key lacks the ${denial.requiredScope} scope required for ${write ? 'write' : 'read'} call ${toolName}.`,
      403,
    );
  }
}

/**
 * Resolve the Meta ad account this call runs against. A requested account must be one the
 * caller can see; without a request, exactly one usable connection must exist.
 * ENG-2823: the rule itself is the provider-neutral resolveProviderAccount (Meta = provider #1).
 */
export async function resolveMetaToolkitAdAccount(
  userId: string,
  requestedAccountId: unknown,
  deps: MetaToolkitGatewayDeps = defaultDeps,
): Promise<string> {
  const resolved = resolveProviderAccount(META_PROVIDER, await deps.listAccounts(userId), requestedAccountId, deps.now());
  if (resolved.ok) return resolved.accountId;
  if (resolved.kind === 'ambiguous') throw new MetaToolkitRefusal(resolved.message);
  throw new MetaToolkitAuthError(resolved.message, 403);
}

// Fail closed: if the manifest cannot be read, let the error propagate so the call is
// refused (and not metered) rather than executing without the resolved account binding.
function toolAcceptsAccountId(name: string): boolean {
  const def = getMetaToolkitManifest().find((d: any) => d.name === name);
  return !!def?.inputSchema?.properties?.account_id;
}

const SECRET_KEYS = new Set(['access_token', 'page_access_token', 'accessToken', 'pageAccessToken', 'refresh_token', 'refreshToken']);

/**
 * Remove credential fields from anything returned to an external agent. Shared Emma
 * readers (e.g. PAGE LIST) return the Page access token for internal use; an external
 * caller must never receive it (found in the 2026-10-26 Zoma creative-upload E2E).
 */
// ENG-2917: Graph paging URLs (paging.next / previous) embed the caller's access token as a
// query parameter, so strings are scrubbed too, not only credential-named keys.
const TOKEN_IN_URL = /([?&](?:access_token|appsecret_proof|input_token)=)[^&#\s"']*/gi;

export function stripCredentials<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return value.replace(TOKEN_IN_URL, '$1[redacted]') as unknown as T;
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripCredentials(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = stripCredentials(v, depth + 1);
  }
  return out as T;
}

/**
 * Full external call: authenticate → resolve account → execute → meter once on success.
 * A refused or failed call is not metered.
 */
export async function handleMetaToolkitCall(
  request: { authorization?: string | null; toolName: string; args?: any; sessionId?: string; userAgent?: string; ref?: string },
  deps: MetaToolkitGatewayDeps = defaultDeps,
) {
  const caller = await authenticateMetaToolkitCaller(request.authorization, deps);
  // ENG-2747 (option B): refused before any upstream call or metering.
  if (caller.databricksOrigin && !isDatabricksAllowedCall(request.toolName, request.args)) {
    throw new MetaToolkitRefusal(DATABRICKS_READ_ONLY_MESSAGE);
  }
  const meter = (platform?: string) => {
    void noteProductUse(caller.userId, TOOLKIT_PRODUCT);
    return deps.recordUsage({
      product: TOOLKIT_PRODUCT,
      userId: caller.userId,
      toolName: request.toolName,
      ...(platform ? { platform } : {}),
      authMethod: caller.authMethod,
      apiKeyId: caller.apiKeyId,
      clientId: caller.clientId,
      // ENG-2747: the gateway has no client name; tag Databricks-origin OAuth callers directly.
      ...(caller.databricksOrigin ? { clientType: 'databricks' as const } : {}),
      sessionId: request.sessionId,
      userAgent: request.userAgent,
      ref: request.ref,
    });
  };

  // ENG-2303 P4: a write that reached Meta (it has a read-back verdict) is metered as its
  // own event kind. Previews, mismatched confirms and refused/failed writes are not.
  // A metering failure must not make an executed write look failed (that invites a retry
  // and a duplicate), so it is logged and surfaced on the result instead of thrown.
  const recordExecutedWrite = async (entityType: string, action: string, result: any, params?: unknown) => {
    if (typeof result?.verification !== 'string') return;
    await (deps.recordWrite ?? recordMcpWriteExecuted)({
      product: TOOLKIT_PRODUCT,
      userId: caller.userId,
      toolName: request.toolName,
      authMethod: caller.authMethod,
      apiKeyId: caller.apiKeyId,
      clientId: caller.clientId,
      sessionId: request.sessionId,
      userAgent: request.userAgent,
      platform: 'meta',
      entityType,
      action,
      verification: result.verification,
      objectId: result.id ?? result.creative_id ?? result.image_hash ?? result.video_id ?? undefined,
      writeKind: zomaWriteKindFor(action, params),
    }).then(() => {
      journeyAfterCall(caller.userId, 'first_write', { platform: 'meta', toolName: request.toolName });
    }).catch((error) => {
      console.error('[meta-toolkit] write metering failed:', error instanceof Error ? error.message : error);
      result.metering = 'failed: this write executed but was not recorded in usage';
    });
  };

  // Creative upload staging needs no Meta account (it only mints an S3 PUT for the caller's own prefix).
  if (request.toolName === 'zoma_prepare_upload') {
    assertMetaToolkitScope(caller, request.toolName, true);
    const result = await (deps.prepareUpload ?? prepareZomaUpload)(caller.userId, request.args ?? {});
    await meter();
    return result;
  }

  // ENG-2914: custom audiences run against the resolved Meta ad account. Reads need
  // tools:read; every write (and any unknown action) needs tools:execute.
  const audienceTool = request.toolName === AUDIENCE_TOOL_NAME;

  // ENG-2303: onboarding tools must work before Meta is connected, so they skip account resolution.
  if (isZomaTool(request.toolName) && !audienceTool) {
    assertMetaToolkitScope(caller, request.toolName, false);
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

  // ENG-2823: Google Ads provider (dark until ZOMA_GOOGLE_ADS_ENABLED=true). Loaded lazily so
  // the Meta path never imports the Google stack.
  if (googleToolkitEnabled()) {
    const google = await import('./googleToolkitGateway');
    if (google.isGoogleToolkitTool(request.toolName)) {
      const googleWrite = google.isGoogleToolkitWrite(request.toolName, request.args ?? {});
      assertMetaToolkitScope(caller, request.toolName, googleWrite);
      const recordWrite = deps.recordWrite ?? recordMcpWriteExecuted;
      const googleResult = await google.handleGoogleToolkitCall(caller, request, {
        listAccounts: deps.listAccounts,
        now: deps.now,
        meter: () => meter('google_ads'),
        recordWrite: async (input) => {
          const recorded = await recordWrite({ ...input, product: TOOLKIT_PRODUCT });
          journeyAfterCall(caller.userId, 'first_write', { platform: 'google_ads', toolName: request.toolName });
          return recorded;
        },
        accessError: (message) => new MetaToolkitAuthError(message, 403),
      });
      if (!googleWrite) journeyAfterCall(caller.userId, 'first_read', { platform: 'google_ads', toolName: request.toolName });
      return stripCredentials(googleResult);
    }
  }

  const args = { ...(request.args ?? {}) };
  assertMetaToolkitScope(
    caller,
    request.toolName,
    audienceTool
      ? isAudienceWriteRequest(args)
      : isCreativeAssetRequest(request.toolName, args) || isGuardedWriteRequest(request.toolName, args)
        || isLifecycleWriteRequest(request.toolName, args) || isMetaCatalogWrite(request.toolName)
        || isMetaEventSourceWrite(request.toolName) || isMetaCatalogFeedWrite(request.toolName)
        || isMetaExperimentWrite(request.toolName),
  );
  // ENG-2921: the error explainer is pure (static table) and needs no ad account.
  if (request.toolName === 'ads_get_errors' || request.toolName === 'ads_get_help_article') {
    const result = request.toolName === 'ads_get_errors' ? explainMetaError(args) : getMetaHelpArticles(args);
    await meter('meta');
    return result;
  }
  const metaWrite = audienceTool ? isAudienceWriteRequest(args)
    : isCreativeAssetRequest(request.toolName, args) || isGuardedWriteRequest(request.toolName, args)
      || isLifecycleWriteRequest(request.toolName, args) || isMetaCatalogWrite(request.toolName)
      || isMetaEventSourceWrite(request.toolName) || isMetaCatalogFeedWrite(request.toolName)
        || isMetaExperimentWrite(request.toolName);
  return withMetaToolkitBackoff(metaWrite, deps.sleep, async () => {
  const accountId = await resolveMetaToolkitAdAccount(caller.userId, args.account_id, deps);
  if (audienceTool || toolAcceptsAccountId(request.toolName)) args.account_id = accountId;

  if (isSignalsRead(request.toolName)) {
    const { agentModeService } = await import('../services/agentModeService');
    const result = await agentModeService.readToolkitMetaSignals(caller.userId, request.toolName, args);
    // A Meta failure comes back as success:false (not thrown); like a refusal, it is not metered.
    if ((result as any)?.success !== false) await meter('meta');
    return stripCredentials(result);
  }

  // ENG-2916: read-only account health / learning phase on the resolved (owned) account.
  if (isMetaHealthTool(request.toolName)) {
    const health = await (deps.runHealthTool ?? runMetaHealthTool)(request.toolName, caller.userId, accountId, args);
    await meter('meta');
    return stripCredentials(health);
  }

  // ENG-2918: read-only catalog tools, scoped to the resolved account's business catalogs.
  if (isMetaCatalogTool(request.toolName)) {
    const catalogs = await (deps.runCatalogTool ?? runMetaCatalogTool)(request.toolName, caller.userId, accountId, args);
    await meter('meta');
    return stripCredentials(catalogs);
  }

  // ENG-2925: catalog product / product-set writes (+ the read-only filter helper), scoped to
  // the resolved account's business catalogs; executed writes are metered like other writes.
  if (isMetaCatalogWriteTool(request.toolName)) {
    const result: any = await (deps.runCatalogWriteTool ?? runMetaCatalogWriteTool)(request.toolName, caller.userId, accountId, args);
    const kind = CATALOG_WRITE_KIND[request.toolName];
    if (kind) await recordExecutedWrite(kind.entityType, kind.action, result);
    await meter('meta');
    return stripCredentials(result);
  }

  // ENG-2927: catalog event sources (reads + preview-confirmed connect/disconnect).
  if (isMetaEventSourceTool(request.toolName)) {
    const result: any = await (deps.runEventSourceTool ?? runMetaEventSourceTool)(request.toolName, caller.userId, accountId, args)
      // ENG-3060: an object outside the selected account is a 403, not a 400 argument error.
      .catch((error: unknown) => { throw error instanceof MetaToolkitForbidden ? new MetaToolkitAuthError(error.message, 403) : error; });
    const kind = EVENT_SOURCE_WRITE_KIND[request.toolName];
    if (kind) await recordExecutedWrite(kind.entityType, kind.action, result);
    await meter('meta');
    return stripCredentials(result);
  }

  // ENG-2926: catalog create/update, product feeds, upload sessions, feed rules.
  if (isMetaCatalogFeedTool(request.toolName)) {
    const result: any = await (deps.runCatalogFeedTool ?? runMetaCatalogFeedTool)(request.toolName, caller.userId, accountId, args);
    const kind = CATALOG_FEED_WRITE_KIND[request.toolName];
    if (kind) await recordExecutedWrite(kind.entityType, kind.action, result);
    await meter('meta');
    return stripCredentials(result);
  }

  // ENG-2920: read-only Pages / Instagram / Ad Library tools, scoped to the resolved account.
  if (isMetaPagesTool(request.toolName)) {
    const pages = await (deps.runPagesTool ?? runMetaPagesTool)(request.toolName, caller.userId, accountId, args);
    await meter('meta');
    return stripCredentials(pages);
  }

  // ENG-2980: experiment eligibility (read) + preview-confirmed A/B and lift writes.
  if (isMetaExperimentWriteTool(request.toolName)) {
    const result: any = await (deps.runExperimentWriteTool ?? runMetaExperimentWriteTool)(request.toolName, caller.userId, accountId, args);
    const kind = EXPERIMENT_WRITE_KIND[request.toolName];
    if (kind) await recordExecutedWrite(kind.entityType, kind.action, result);
    await meter('meta');
    return stripCredentials(result);
  }

  // ENG-2919: read-only experiment (ad study) tools; tools:read scope, no write metering.
  if (isExperimentRead(request.toolName)) {
    const { agentModeService } = await import('../services/agentModeService');
    const result = await agentModeService.readToolkitMetaExperiments(caller.userId, request.toolName, args);
    // A Meta failure comes back as success:false (not thrown); like a refusal, it is not metered.
    if ((result as any)?.success !== false) await meter('meta');
    return stripCredentials(result);
  }

  // ENG-2921: read-only account activity log; tools:read scope, no write metering.
  if (isDiagnosticsRead(request.toolName)) {
    const { agentModeService } = await import('../services/agentModeService');
    const result = await agentModeService.readToolkitMetaActivityLog(caller.userId, args);
    await meter('meta');
    return stripCredentials(result);
  }

  // ENG-2303 P3: CAMPAIGN/AD_SET/AD CREATE + status/budget UPDATE go through the guarded
  // preview→confirm path; every other write stays refused by assertMetaToolkitV1Call.
  // ENG-2922: ARCHIVE/DELETE/COPY use the same preview→confirm guard (metaToolkitLifecycle.ts).
  const creativeAsset = isCreativeAssetRequest(request.toolName, args);
  const lifecycle = !audienceTool && isLifecycleWriteRequest(request.toolName, args);
  const guardedWrite = audienceTool || creativeAsset || lifecycle || isGuardedWriteRequest(request.toolName, args);
  let result: any;
  if (audienceTool) result = await (deps.executeAudience ?? executeMetaToolkitAudience)(caller.userId, args);
  else if (creativeAsset) result = await (deps.executeCreative ?? executeMetaToolkitCreative)(caller.userId, args);
  else if (lifecycle) result = await (deps.executeLifecycle ?? executeMetaToolkitLifecycle)(caller.userId, args);
  else if (guardedWrite) result = await (deps.executeWrite ?? executeMetaToolkitWrite)(caller.userId, args);
  else result = await deps.execute(request.toolName, args, { userId: caller.userId, sessionId: request.sessionId });

  // ENG-2915: a BULK_CREATE result carries one verdict per creative; each is its own write event.
  if (guardedWrite) {
    const entityType = audienceTool ? 'CUSTOM_AUDIENCE' : String(args.entity_type);
    const executedWrites: any[] = Array.isArray((result as any)?.results) ? (result as any).results : [result];
    for (const write of executedWrites) await recordExecutedWrite(entityType, String(args.action), write, args.params);
  }

  await meter('meta');
  if (!guardedWrite) journeyAfterCall(caller.userId, 'first_read', { platform: 'meta', toolName: request.toolName });
  return stripCredentials(result);
  });
}
