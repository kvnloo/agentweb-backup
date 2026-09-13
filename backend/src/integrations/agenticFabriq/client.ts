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
import { AgenticFabriqApiError } from './errors';
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
}

async function readJsonSafely(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class AgenticFabriqClient {
  private readonly fetchImpl: FetchLike;

  constructor(options: AgenticFabriqClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { body?: unknown; rawUserIdForAssertion?: string } = {},
  ): Promise<T> {
    const base = getAgenticFabriqApiBaseUrl();
    const url = `${base}${path}`;
    const headers = await this.appHeaders(opts.rawUserIdForAssertion);
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const body = await readJsonSafely(res);
      throw new AgenticFabriqApiError(res.status, path, body);
    }
    return (await readJsonSafely(res)) as T;
  }

  /**
   * Idempotent by design: AF documents 409 = "exists, fine". Also matches the
   * "Create users automatically" console toggle's failure mode — calling this
   * unconditionally means the integration survives that toggle either way.
   */
  async ensureExternalUser(appId: string, rawUserId: string): Promise<void> {
    try {
      await this.request('POST', `/api/v1/apps/${appId}/external-users`, {
        body: { external_user_id: rawUserId },
      });
    } catch (err) {
      if (err instanceof AgenticFabriqApiError && err.status === 409) return; // documented "exists, fine"
      throw err;
    }
  }

  async mintUserToken(appId: string, rawUserId: string): Promise<AgenticFabriqTokenResponse> {
    return this.request<AgenticFabriqTokenResponse>(
      'POST',
      `/api/v1/apps/${appId}/external-users/${encodeURIComponent(rawUserId)}/token`,
      { body: {}, rawUserIdForAssertion: rawUserId },
    );
  }

  async listConnections(appId: string, rawUserId: string): Promise<AgenticFabriqConnectionRow[]> {
    const result = await this.request<AgenticFabriqConnectionRow[] | { connections: AgenticFabriqConnectionRow[] }>(
      'GET',
      `/api/v1/apps/${appId}/external-users/${encodeURIComponent(rawUserId)}/connections`,
      { rawUserIdForAssertion: rawUserId },
    );
    return Array.isArray(result) ? result : result.connections;
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
    await this.request(
      'DELETE',
      `/api/v1/apps/${appId}/external-users/${encodeURIComponent(rawUserId)}/connections/${encodeURIComponent(connectionId)}?tool=${encodeURIComponent(tool)}`,
      { rawUserIdForAssertion: rawUserId },
    );
  }

  async initiateOAuth(
    appId: string,
    rawUserId: string,
    provider: string,
    opts: { connectionId?: string; scopes?: string[] } = {},
  ): Promise<AgenticFabriqOAuthInitiateResponse> {
    return this.request<AgenticFabriqOAuthInitiateResponse>(
      'POST',
      `/api/v1/apps/${appId}/external-users/${encodeURIComponent(rawUserId)}/oauth/${encodeURIComponent(provider)}/initiate`,
      {
        body: { connection_id: opts.connectionId ?? 'default', ...(opts.scopes ? { scopes: opts.scopes } : {}) },
        rawUserIdForAssertion: rawUserId,
      },
    );
  }

  async initiateCredentials(
    appId: string,
    rawUserId: string,
    provider: string,
    opts: { connectionId?: string } = {},
  ): Promise<AgenticFabriqCredentialsInitiateResponse> {
    return this.request<AgenticFabriqCredentialsInitiateResponse>(
      'POST',
      `/api/v1/apps/${appId}/external-users/${encodeURIComponent(rawUserId)}/credentials/${encodeURIComponent(provider)}/initiate`,
      { body: { connection_id: opts.connectionId ?? 'default' }, rawUserIdForAssertion: rawUserId },
    );
  }

  /**
   * Deliberately NOT cached beyond the process-level fetch itself — capabilities
   * are deployment state that changes without notice, per the vendor's own
   * warning, and this is a low-traffic admin-y call for a single-connector spike.
   */
  async getProviderCapabilities(appId: string): Promise<AgenticFabriqCapabilitiesResponse> {
    return this.request<AgenticFabriqCapabilitiesResponse>(
      'GET',
      `/api/v1/apps/${appId}/external-users/providers/capabilities`,
    );
  }
}

export const agenticFabriqClient = new AgenticFabriqClient();
