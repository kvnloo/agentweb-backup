/**
 * Agentic Fabriq (DEVELOPER edition) — shared types for the ENG-1685 spike.
 *
 * This whole `integrations/agenticFabriq/` package is a deliberately ISOLATED,
 * throwaway-friendly adapter (per the vendor's own setup guidance): the published
 * `agentic-fabriq-sdk` wheel does not ship the `af_sdk.b2b2c.AgenticFabriq`
 * seller-facing facade as of the version checked, and no npm package exists at
 * all, so this is a thin TypeScript adapter over the documented REST + MCP
 * surface rather than a vendored SDK. Every file in this directory can be
 * deleted as a unit if the spike (ENG-1685) is rejected, or replaced wholesale
 * if a real `@agenticfabriq/sdk` ships later — nothing outside this directory
 * (other than the one flagged branch in toolDispatch.ts) imports from it.
 */

/** Fabriq's per-app REST identity headers. Never logged. */
export interface AgenticFabriqAppCredentials {
  appId: string;
  appSecret: string;
}

/** POST .../token response shape. `mcp_url`, when present, is authoritative — see mcpBridge.ts. */
export interface AgenticFabriqTokenResponse {
  access_token: string;
  expires_in: number; // seconds; documented as 900
  mcp_url?: string | null;
  [key: string]: unknown;
}

/** A single connection row from GET .../connections. */
export interface AgenticFabriqConnectionRow {
  tool: string; // provider slug, e.g. "gmail" — field is `tool` on this endpoint, not `provider`
  connection_id: string;
  status: 'configured' | 'connected' | string; // "configured" = row exists, nothing else does (see docs above initiate())
  granted_scopes?: string[];
  [key: string]: unknown;
}

/** POST .../oauth/{provider}/initiate response. */
export interface AgenticFabriqOAuthInitiateResponse {
  oauth_url: string;
  state: string;
  connection_id: string;
  credential_source?: string;
  [key: string]: unknown;
}

/** POST .../credentials/{provider}/initiate response (paste-a-key providers). */
export interface AgenticFabriqCredentialsInitiateResponse {
  connect_url: string;
  connection_id: string;
  expires_in: number;
  [key: string]: unknown;
}

/** Per-provider entry from GET .../providers/capabilities. */
export interface AgenticFabriqProviderCapability {
  oauth: boolean;
  af_app_configured: boolean;
  org_app_supported: boolean;
  key_connect: boolean;
  instance_required: boolean;
  [key: string]: unknown;
}

export type AgenticFabriqCapabilitiesResponse = Record<string, AgenticFabriqProviderCapability>;

/** JSON-RPC 2.0 envelope, minimal subset used against POST /mcp/external. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** One tool entry from the MCP `tools/list` result. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Webhook delivery body (connection.* and trigger events share this envelope). */
export interface AgenticFabriqWebhookBody {
  event_id: string;
  org: string;
  app: string;
  provider: string;
  event_type: string;
  subject_user: string; // RAW external user id — trusted ONLY because the signature verified
  occurred_at: string;
  payload: Record<string, unknown>;
}

/** Cached per-user token, in memory only — never persisted, never logged. */
export interface CachedUserToken {
  accessToken: string;
  mcpUrl: string;
  mintedAtMs: number;
  expiresAtMs: number; // mintedAtMs + expires_in*1000
}
