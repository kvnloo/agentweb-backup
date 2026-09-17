/**
 * Minimal MCP JSON-RPC bridge over Agentic Fabriq's external-user endpoint.
 *
 * TRAP #1 from the vendor's own setup notes, verified against the live API:
 * `/mcp` (internal) and `/mcp/external` both answer 200 for an external-user
 * token, so calling the wrong one fails SILENTLY — no error, just an agent
 * that can't see the tools it should have. This module NEVER defaults to
 * `/mcp`: it always resolves an explicit URL, preferring the token response's
 * own `mcp_url` field when present, falling back to `<base>/mcp/external`
 * otherwise — and a dedicated test (mcpBridge.test.ts) pins that the resolved
 * URL always ends in `/mcp/external`.
 *
 * This is a deliberately narrow, hand-written JSON-RPC client (tools/list,
 * tools/call only) rather than routing through the existing generic
 * `mcpClientService.ts` connection-pooling machinery: that pool assumes one
 * static config per server name with a token resolved once via decrypted
 * per-user secrets, not a token that must be freshly minted and swapped every
 * ~900s. Bending that machinery to fit would touch a 1900-line shared file for
 * a one-connector spike; this ~80-line bridge is genuinely simpler and touches
 * nothing else.
 */

import { randomUUID } from 'crypto';
import { AgenticFabriqAuthenticationError, AgenticFabriqResponseTooLargeError, AgenticFabriqTimeoutError } from './errors';
import type { JsonRpcRequest, JsonRpcResponse, McpToolDescriptor } from './types';

export type FetchLike = typeof fetch;

const MCP_TIMEOUT_MS = 20_000;
const MCP_MAX_RESPONSE_BYTES = 1_000_000;
const MCP_MAX_TOOLS = 100;
const MCP_MAX_TOOL_DESCRIPTOR_BYTES = 16_000;

/** Resolves only the external-user MCP endpoint, rejecting internal endpoints. */
export function resolveMcpExternalUrl(apiBaseUrl: string, tokenMcpUrl: string | undefined | null): string {
  if (tokenMcpUrl && tokenMcpUrl.trim()) {
    const trimmed = tokenMcpUrl.trim();
    if (!trimmed.endsWith('/mcp/external')) {
      throw new AgenticFabriqAuthenticationError(
        `Token response's mcp_url "${trimmed}" does not end in /mcp/external — refusing to use it ` +
        `rather than silently hitting the wrong (internal) MCP route.`,
      );
    }
    return trimmed;
  }
  return `${apiBaseUrl.replace(/\/+$/, '')}/mcp/external`;
}

export class AgenticFabriqMcpBridge {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  /** Creates a bridge with injectable transport and hard request bounds. */
  constructor(fetchImpl: FetchLike = fetch, timeoutMs = MCP_TIMEOUT_MS, maxResponseBytes = MCP_MAX_RESPONSE_BYTES) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  /** Executes one bounded JSON-RPC request without exposing provider error text. */
  private async call<T>(mcpExternalUrl: string, accessToken: string, method: string, params?: unknown): Promise<T> {
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: randomUUID(), method, params };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(mcpExternalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: ['Bearer', accessToken].join(' ') },
        signal: controller.signal,
        body: JSON.stringify(request),
      });
      if (res.status === 401 || res.status === 403) {
        throw new AgenticFabriqAuthenticationError(
          `Agentic Fabriq MCP call "${method}" got ${res.status} — token is invalid/expired; mint a new one.`,
        );
      }
      if (!res.ok) throw new Error(`Agentic Fabriq MCP call "${method}" failed: HTTP ${res.status}`);
      const declaredLength = Number(res.headers?.get('content-length') ?? 0);
      if (declaredLength > this.maxResponseBytes) throw new AgenticFabriqResponseTooLargeError(method);
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) throw new AgenticFabriqResponseTooLargeError(method);
      const body = JSON.parse(text) as JsonRpcResponse<T>;
      if (body.error) throw new Error(`Agentic Fabriq MCP call "${method}" returned a redacted RPC error`);
      return body.result as T;
    } catch (error: any) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw new AgenticFabriqTimeoutError(method);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * RULES: "Do NOT invent tool names — call get_tools() and use what returns."
   * This is that call. Callers must not hardcode AF's Gmail tool names anywhere.
   */
  async listTools(mcpExternalUrl: string, accessToken: string): Promise<McpToolDescriptor[]> {
    const result = await this.call<{ tools: McpToolDescriptor[] }>(mcpExternalUrl, accessToken, 'tools/list');
    const tools = result?.tools ?? [];
    if (!Array.isArray(tools) || tools.length > MCP_MAX_TOOLS) {
      throw new AgenticFabriqResponseTooLargeError('tools/list');
    }
    for (const tool of tools) {
      if (typeof tool?.name !== 'string' || tool.name.length > 200 || Buffer.byteLength(JSON.stringify(tool), 'utf8') > MCP_MAX_TOOL_DESCRIPTOR_BYTES) {
        throw new AgenticFabriqResponseTooLargeError('tools/list descriptor');
      }
    }
    return tools;
  }

  /** Calls one discovered tool with caller-supplied, boundary-validated args. */
  async callTool(mcpExternalUrl: string, accessToken: string, toolName: string, args: unknown): Promise<unknown> {
    return this.call(mcpExternalUrl, accessToken, 'tools/call', { name: toolName, arguments: args });
  }
}

export const agenticFabriqMcpBridge = new AgenticFabriqMcpBridge();
