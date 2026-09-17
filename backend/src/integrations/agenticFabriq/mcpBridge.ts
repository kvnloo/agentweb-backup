/** Bounded external-user MCP client. Destinations never derive trust from a token. */
import { randomUUID } from 'crypto';
import { getAgenticFabriqApiBaseUrl } from './config';
import { AgenticFabriqAuthenticationError, AgenticFabriqApiError, AgenticFabriqError, AgenticFabriqResponseTooLargeError } from './errors';
import { boundedJsonRequest, boundedString, httpsOrigin, httpsUrl, invalidShape, record } from './transport';
import type { JsonRpcRequest, McpToolDescriptor } from './types';

export type FetchLike = typeof fetch;

export function resolveMcpExternalUrl(apiBaseUrl: string, tokenMcpUrl: string | undefined | null): string {
  const base = httpsOrigin(apiBaseUrl);
  const allowed = new Set([base]);
  const configured = process.env.AGENTIC_FABRIQ_MCP_ALLOWED_ORIGINS;
  if (configured) for (const origin of configured.split(',')) allowed.add(httpsOrigin(origin.trim()));
  const url = httpsUrl(tokenMcpUrl === undefined || tokenMcpUrl === null ? `${base}/mcp/external` : tokenMcpUrl);
  if (!allowed.has(url.origin) || url.pathname !== '/mcp/external' || url.search || url.href.includes('?')) {
    throw new AgenticFabriqAuthenticationError('Invalid vendor MCP destination');
  }
  return url.href;
}

export class AgenticFabriqMcpBridge {
  constructor(private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 20_000,
    private readonly maxResponseBytes = 1_000_000) {}

  private async call(mcpExternalUrl: string, accessToken: string, method: string, params?: unknown): Promise<unknown> {
    const url = resolveMcpExternalUrl(getAgenticFabriqApiBaseUrl(), mcpExternalUrl);
    if (!boundedString(accessToken, 16_384) || !/^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken)) invalidShape();
    const request: JsonRpcRequest = { jsonrpc: '2.0', id: randomUUID(), method, params };
    let body: unknown;
    try {
      body = await boundedJsonRequest(this.fetchImpl, url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(request),
      }, this.timeoutMs, this.maxResponseBytes, 'mcp');
    } catch (error) {
      if (error instanceof AgenticFabriqApiError && [401, 403].includes(error.status)) {
        throw new AgenticFabriqAuthenticationError('Vendor MCP authentication failed');
      }
      throw error;
    }
    if (!record(body) || body.jsonrpc !== '2.0' || body.id !== request.id ||
        Object.prototype.hasOwnProperty.call(body, 'result') === Object.prototype.hasOwnProperty.call(body, 'error')) invalidShape();
    if (Object.prototype.hasOwnProperty.call(body, 'error')) {
      if (!record(body.error) || !Number.isInteger(body.error.code) || !boundedString(body.error.message, 4096)) invalidShape();
      throw new AgenticFabriqError('Vendor returned a redacted RPC error');
    }
    if (!record(body.result)) invalidShape();
    return body.result;
  }

  async listTools(mcpExternalUrl: string, accessToken: string): Promise<McpToolDescriptor[]> {
    const result = await this.call(mcpExternalUrl, accessToken, 'tools/list');
    if (!record(result) || !Array.isArray(result.tools) || result.nextCursor !== undefined) invalidShape();
    if (result.tools.length > 100) throw new AgenticFabriqResponseTooLargeError('mcp');
    const names = new Set<string>();
    for (const tool of result.tools) {
      if (!record(tool) || !boundedString(tool.name) || !/^[a-zA-Z0-9_.-]+$/.test(tool.name) ||
          names.has(tool.name) || !record(tool.inputSchema) || tool.inputSchema.type !== 'object' ||
          tool.description !== undefined && !boundedString(tool.description, 4000)) invalidShape();
      const schema = tool.inputSchema;
      if (schema.properties !== undefined && (!record(schema.properties) ||
          Object.entries(schema.properties).some(([key, value]) => !boundedString(key) || !record(value))) ||
          schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 100 ||
            new Set(schema.required).size !== schema.required.length || schema.required.some(key =>
              !boundedString(key) || !record(schema.properties) || !Object.prototype.hasOwnProperty.call(schema.properties, key))) ||
          schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !record(schema.additionalProperties)) invalidShape();
      if (Buffer.byteLength(JSON.stringify(tool), 'utf8') > 16_000) throw new AgenticFabriqResponseTooLargeError('mcp');
      names.add(tool.name);
    }
    return result.tools as unknown as McpToolDescriptor[];
  }

  async callTool(mcpExternalUrl: string, accessToken: string, toolName: string, args: unknown): Promise<unknown> {
    if (!boundedString(toolName) || !record(args)) invalidShape();
    const result = await this.call(mcpExternalUrl, accessToken, 'tools/call', { name: toolName, arguments: args });
    if (!record(result) || !Array.isArray(result.content) || result.content.length > 100 ||
        result.isError !== undefined && typeof result.isError !== 'boolean' ||
        result.structuredContent !== undefined && !record(result.structuredContent) ||
        result.content.some(item => !record(item) || item.type !== 'text' || typeof item.text !== 'string')) invalidShape();
    if (result.isError === true) throw new AgenticFabriqError('Vendor tool failed');
    return result;
  }
}
export const agenticFabriqMcpBridge = new AgenticFabriqMcpBridge();
