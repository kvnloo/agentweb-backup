import { timingSafeEqual } from 'crypto';
/**
 * App-scoped REST client for Agentic Fabriq's DEVELOPER-edition B2B2C surface.
 *
 * Every method here hits an app-scoped endpoint (X-App-Id + X-App-Secret,
 * optional X-App-Assertion) — nothing here is console-scoped (triggers use a
 * different bearer-token surface entirely and are out of scope for this spike).
 *
 * RULES enforced structurally, not just by convention:
 *  - Never retries a request under a different identity on an auth error —
 *    every method either succeeds or throws; callers decide what to do next.
 *  - `?tool=` is always sent on delete, because AF's `connection_id` defaults
 *    to "default" for every provider — omitting it is genuinely ambiguous
 *    (422 from AF), not just a lint nit.
 *  - Provider name validation is NEVER hardcoded here — getProviderCapabilities()
 *    is a live call, and callers are expected to use its result rather than a
 *    baked-in list, because which providers are connectable is deployment
 *    state that "changed twice while this integration was built."
 */

import { getAgenticFabriqApiBaseUrl, getAgenticFabriqAppCredentials, getAgenticFabriqPrivateKeyPem } from './config';
import { signAgenticFabriqAssertion } from './assertion';
import { AgenticFabriqApiError, AgenticFabriqError } from './errors';
import { boundedJsonRequest, record, boundedString, invalidShape, httpsOrigin, httpsUrl } from './transport';
import { resolveMcpExternalUrl } from './mcpBridge';
import type {
  AgenticFabriqCapabilitiesResponse,
  AgenticFabriqConnectionRow,
  AgenticFabriqCredentialsInitiateResponse,
  AgenticFabriqOAuthInitiateResponse,
  AgenticFabriqTokenResponse,
} from './types';

/** Injectable fetch so tests never touch the network. Defaults to the global fetch. */
export type FetchLike = typeof fetch;

export interface AgenticFabriqClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export class AgenticFabriqClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  /** Creates a client with injectable transport and hard request bounds. */
  constructor(options: AgenticFabriqClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /** Builds the app-scoped auth headers, signing an assertion when a private key is configured. */
  private async appHeaders(rawUserIdForAssertion?: string): Promise<Record<string, string>> {
    const { appId, appSecret } = await getAgenticFabriqAppCredentials();
    const headers: Record<string, string> = {
      'X-App-Id': appId,
      'X-App-Secret': appSecret,
      'Content-Type': 'application/json',
    };
    const privateKeyPem = await getAgenticFabriqPrivateKeyPem();
    if (privateKeyPem && rawUserIdForAssertion) {
      headers['X-App-Assertion'] = signAgenticFabriqAssertion({
        appId,
        rawUserId: rawUserIdForAssertion,
        privateKeyPem,
      });
    }
    return headers;
  }

  /** Sends one bounded app-authenticated request and sanitizes all failures. */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { body?: unknown; rawUserIdForAssertion?: string } = {},
  ): Promise<T> {
    const base = httpsOrigin(getAgenticFabriqApiBaseUrl());
    let headers: Record<string, string>;
    try { headers = await this.appHeaders(opts.rawUserIdForAssertion); }
    catch { throw new AgenticFabriqError('Vendor authentication setup failed'); }
    return await boundedJsonRequest(this.fetchImpl, `${base}${path}`, {
      method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }, this.timeoutMs, this.maxResponseBytes, 'rest') as T;
  }

  /**
   * Idempotent by design: AF documents 409 = "exists, fine". Also matches the
   * "Create users automatically" console toggle's failure mode — calling this
   * unconditionally means the integration survives that toggle either way.
   */
  async ensureExternalUser(appId: string, rawUserId: string): Promise<void> {
    try {
      const result = await this.request('POST', `/api/v1/apps/${encodeURIComponent(appId)}/external-users`, {
        body: { external_user_id: rawUserId },
      });
      if (result !== undefined && (!record(result) || 'error' in result || result.success === false)) invalidShape();
    } catch (err) {
      if (err instanceof AgenticFabriqApiError && err.status === 409) return; // documented "exists, fine"
      throw err;
    }
  }

  /** Mints a short-lived token scoped to one external user. */
  async mintUserToken(appId: string, rawUserId: string): Promise<AgenticFabriqTokenResponse> {
    const result = await this.request<AgenticFabriqTokenResponse>(
      'POST',
      `/api/v1/apps/${encodeURIComponent(appId)}/external-users/${encodeURIComponent(rawUserId)}/token`,
      { body: {}, rawUserIdForAssertion: rawUserId },
    );
    if (!record(result) || !boundedString(result.access_token, 16_384) || !/^[A-Za-z0-9._~+\/-]+=*$/.test(result.access_token) ||
        !Number.isInteger(result.expires_in) || result.expires_in <= 60 || result.expires_in > 900 ||
        result.mcp_url !== undefined && result.mcp_url !== null && !boundedString(result.mcp_url, 4096)) invalidShape();
    resolveMcpExternalUrl(getAgenticFabriqApiBaseUrl(), result.mcp_url);
    return result;
  }

  /** Lists the named external user's provider connections. */
  async listConnections(appId: string, rawUserId: string): Promise<AgenticFabriqConnectionRow[]> {
    const result = await this.request<AgenticFabriqConnectionRow[] | { connections: AgenticFabriqConnectionRow[] }>(
      'GET',
      `/api/v1/apps/${encodeURIComponent(appId)}/external-users/${encodeURIComponent(rawUserId)}/connections`,
      { rawUserIdForAssertion: rawUserId },
    );
    const rows = Array.isArray(result) ? result : record(result) ? result.connections : null;
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !record(row) ||
        !boundedString(row.tool) || !boundedString(row.connection_id) ||
        !['configured', 'connected', 'disconnected', 'needs_reauth', 'error'].includes(row.status as string) ||
        row.granted_scopes !== undefined && (!Array.isArray(row.granted_scopes) || row.granted_scopes.length > 100 ||
          row.granted_scopes.some(scope => !boundedString(scope, 500))))) invalidShape();
    return rows;
  }

  /**
   * `tool` is REQUIRED (not optional) — see module doc. TypeScript enforces it
   * at the call site; there is no overload that omits it.
   */
  async deleteConnection(
    appId: string,
    rawUserId: string,
    connectionId: string,
    tool: string,
  ): Promise<void> {
    if (!tool) {
      throw new TypeError('deleteConnection: `tool` is required — AF 422s without it (ambiguous connection_id).');
    }
    const result = await this.request(
      'DELETE',
      `/api/v1/apps/${encodeURIComponent(appId)}/external-users/${encodeURIComponent(rawUserId)}/connections/${encodeURIComponent(connectionId)}?tool=${encodeURIComponent(tool)}`,
      { rawUserIdForAssertion: rawUserId },
    );
    if (result !== undefined && (!record(result) || 'error' in result || result.success === false)) invalidShape();
  }

  /** Starts OAuth with an explicit caller-owned connection binding. */
  async initiateOAuth(
    appId: string,
    rawUserId: string,
    provider: string,
    opts: { connectionId?: string; scopes?: string[]; state?: string } = {},
  ): Promise<AgenticFabriqOAuthInitiateResponse> {
    if (!opts.state || !/^[a-f0-9]{64}$/.test(opts.state)) invalidShape();
    const result = await this.request<AgenticFabriqOAuthInitiateResponse>(
      'POST',
      `/api/v1/apps/${encodeURIComponent(appId)}/external-users/${encodeURIComponent(rawUserId)}/oauth/${encodeURIComponent(provider)}/initiate`,
      {
        body: { connection_id: opts.connectionId ?? 'default', ...(opts.scopes ? { scopes: opts.scopes } : {}), ...(opts.state ? { state: opts.state } : {}) },
        rawUserIdForAssertion: rawUserId,
      },
    );
    if (!record(result) || !boundedString(result.oauth_url, 4096) || !boundedString(result.state, 512) ||
        result.connection_id !== (opts.connectionId ?? 'default') || !/^[a-f0-9]{64}$/.test(result.state) ||
        !timingSafeEqual(Buffer.from(result.state, 'hex'), Buffer.from(opts.state, 'hex'))) invalidShape();
    httpsUrl(result.oauth_url);
    return result;
  }

  /** Starts the vendor's credential-entry flow for non-OAuth providers. */
  async initiateCredentials(
    appId: string,
    rawUserId: string,
    provider: string,
    opts: { connectionId?: string } = {},
  ): Promise<AgenticFabriqCredentialsInitiateResponse> {
    const result = await this.request<AgenticFabriqCredentialsInitiateResponse>(
      'POST',
      `/api/v1/apps/${encodeURIComponent(appId)}/external-users/${encodeURIComponent(rawUserId)}/credentials/${encodeURIComponent(provider)}/initiate`,
      { body: { connection_id: opts.connectionId ?? 'default' }, rawUserIdForAssertion: rawUserId },
    );
    if (!record(result) || !boundedString(result.connect_url, 4096) || result.connection_id !== (opts.connectionId ?? 'default') ||
        !Number.isInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 900) invalidShape();
    httpsUrl(result.connect_url);
    return result;
  }

  /**
   * Deliberately NOT cached beyond the process-level fetch itself — capabilities
   * are deployment state that changes without notice, per the vendor's own
   * warning, and this is a low-traffic admin-y call for a single-connector spike.
   */
  async getProviderCapabilities(appId: string): Promise<AgenticFabriqCapabilitiesResponse> {
    const result = await this.request<AgenticFabriqCapabilitiesResponse>(
      'GET',
      `/api/v1/apps/${encodeURIComponent(appId)}/external-users/providers/capabilities`,
    );
    if (!record(result) || Object.keys(result).length > 100 || Object.entries(result).some(([name, value]) =>
      !boundedString(name) || !record(value) || ['oauth', 'af_app_configured', 'org_app_supported', 'key_connect', 'instance_required']
        .some(key => typeof value[key] !== 'boolean'))) invalidShape();
    return result;
  }
}

export const agenticFabriqClient = new AgenticFabriqClient();
