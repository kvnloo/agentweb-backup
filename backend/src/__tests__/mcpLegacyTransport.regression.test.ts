/**
 * Regression guard: the OAuth work must be PURELY ADDITIVE. The pre-existing
 * ways of connecting an MCP server — static Bearer token, no-auth, and stdio —
 * must behave exactly as before. These tests use the REAL SDK transports and
 * assert that no authProvider is attached and the Bearer header path is intact
 * for any server that is not explicitly authType: 'oauth'.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing";

// Avoid AWS/db side effects on import; createTransport never touches these.
jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null), setSetting: jest.fn() },
}));
jest.mock("../services/db", () => ({ userDb: {} }));

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { McpClientService } from "../mcp/client/mcpClientService";

const getAuthHeader = (requestInit: any): string | undefined => {
  const headers = requestInit?.headers;
  if (!headers) return undefined;
  return headers["Authorization"] || headers["authorization"];
};

describe("legacy MCP transport behavior is unchanged (additive OAuth)", () => {
  let service: McpClientService;

  beforeEach(() => {
    service = new McpClientService();
  });

  afterEach(async () => {
    // Clear the session-cleanup interval started in the constructor.
    await service.shutdown().catch(() => {});
  });

  it("streamable-http with a static token: Bearer header, NO authProvider", async () => {
    const transport: any = await service.createTransport("legacy-token", {
      transport: "streamable-http",
      url: "https://example.com/mcp",
      accessToken: "plain-token-abc",
    } as any);

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(transport._authProvider).toBeUndefined();
    expect(getAuthHeader(transport._requestInit)).toBe("Bearer plain-token-abc");
    // Token-based streamable server keeps the axios shim (custom fetch).
    expect(transport._fetch).toBeDefined();
  });

  it("streamable-http with authType 'bearer': still Bearer header, NO authProvider", async () => {
    const transport: any = await service.createTransport("bearer-server", {
      transport: "streamable-http",
      url: "https://example.com/mcp",
      accessToken: "plain-token-xyz",
      authType: "bearer",
    } as any);

    expect(transport._authProvider).toBeUndefined();
    expect(getAuthHeader(transport._requestInit)).toBe("Bearer plain-token-xyz");
  });

  it("streamable-http with no token at all: no auth header, NO authProvider", async () => {
    const transport: any = await service.createTransport("no-auth-server", {
      transport: "streamable-http",
      url: "https://example.com/mcp",
    } as any);

    expect(transport._authProvider).toBeUndefined();
    expect(getAuthHeader(transport._requestInit)).toBeUndefined();
  });

  it("streamable-http with authType 'oauth': authProvider attached, NO static Bearer", async () => {
    const transport: any = await service.createTransport("oauth-server", {
      transport: "streamable-http",
      url: "https://example.com/mcp",
      authType: "oauth",
    } as any);

    expect(transport._authProvider).toBeDefined();
    expect(getAuthHeader(transport._requestInit)).toBeUndefined();
    // OAuth streamable server MUST use native streaming fetch (no axios buffering
    // shim) — otherwise the MCP SSE stream is buffered and reconnect-loops.
    expect(transport._fetch).toBeUndefined();
  });

  it("sse with a static token: Bearer header, NO authProvider", async () => {
    const transport: any = await service.createTransport("legacy-sse", {
      transport: "sse",
      url: "https://example.com/sse",
      accessToken: "sse-token-123",
    } as any);

    expect(transport).toBeInstanceOf(SSEClientTransport);
    expect(transport._authProvider).toBeUndefined();
    expect(getAuthHeader(transport._requestInit)).toBe("Bearer sse-token-123");
  });

  it("sse with authType 'oauth': authProvider attached, NO static Bearer", async () => {
    const transport: any = await service.createTransport("oauth-sse", {
      transport: "sse",
      url: "https://example.com/sse",
      authType: "oauth",
    } as any);

    expect(transport).toBeInstanceOf(SSEClientTransport);
    expect(transport._authProvider).toBeDefined();
    expect(getAuthHeader(transport._requestInit)).toBeUndefined();
  });

  it("legacy config (no transport field) still defaults to SSE with Bearer header", async () => {
    const transport: any = await service.createTransport("legacy-default", {
      url: "https://example.com/sse",
      accessToken: "legacy-token-999",
    } as any);

    expect(transport).toBeInstanceOf(SSEClientTransport);
    expect(transport._authProvider).toBeUndefined();
    expect(getAuthHeader(transport._requestInit)).toBe("Bearer legacy-token-999");
  });

  it("stdio servers are entirely unaffected (no HTTP auth concept)", async () => {
    const transport: any = await service.createTransport("stdio-server", {
      transport: "stdio",
      command: "echo",
      args: ["hello"],
    } as any);

    // A stdio transport has no _authProvider / _requestInit at all.
    expect(transport._authProvider).toBeUndefined();
    expect(transport).toBeDefined();
  });
});
