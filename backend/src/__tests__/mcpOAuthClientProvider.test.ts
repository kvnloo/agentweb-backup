process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing";
process.env.BACKEND_URL = "https://api-test.example.com";

// In-memory settings store so the provider's DynamoDB-backed reads/writes persist within a test.
const store = new Map<string, string>();
jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) =>
      store.has(name) ? { settingName: name, settingValue: store.get(name) } : null
    ),
    setSetting: jest.fn(async (name: string, value: string) => {
      store.set(name, value);
      return { settingName: name, settingValue: value };
    }),
  },
}));

import {
  McpOAuthClientProvider,
  getMcpOAuthCallbackUrl,
  getServerConfig,
  savePendingSession,
  getPendingSession,
  deletePendingSession,
} from "../mcp/client/mcpOAuthClientProvider";

const SERVER = "higgsfield";

const seedServer = () => {
  store.clear();
  store.set(
    "mcp_servers",
    JSON.stringify([{ name: SERVER, transport: "streamable-http", url: "https://mcp.higgsfield.ai/mcp" }])
  );
};

describe("getMcpOAuthCallbackUrl", () => {
  it("derives the callback URL from BACKEND_URL", () => {
    expect(getMcpOAuthCallbackUrl()).toBe("https://api-test.example.com/api/mcp-oauth/callback");
  });
});

describe("McpOAuthClientProvider metadata", () => {
  it("advertises the callback as redirect URI with PKCE-friendly metadata", () => {
    const provider = new McpOAuthClientProvider({ serverName: SERVER });
    const meta = provider.clientMetadata;
    expect(meta.redirect_uris).toEqual(["https://api-test.example.com/api/mcp-oauth/callback"]);
    expect(meta.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.response_types).toEqual(["code"]);
    expect(provider.redirectUrl).toBe("https://api-test.example.com/api/mcp-oauth/callback");
  });

  it("captures the authorization URL instead of redirecting", () => {
    const provider = new McpOAuthClientProvider({ serverName: SERVER });
    expect(provider.authorizationUrl).toBeUndefined();
    const url = new URL("https://auth.higgsfield.ai/authorize?client_id=abc");
    provider.redirectToAuthorization(url);
    expect(provider.authorizationUrl?.toString()).toBe(url.toString());
  });

  it("generates a stable state and exposes it", () => {
    const provider = new McpOAuthClientProvider({ serverName: SERVER });
    expect(provider.state()).toBe(provider.stateValue);
    expect(provider.stateValue).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("McpOAuthClientProvider token & client storage", () => {
  beforeEach(seedServer);

  it("round-trips tokens, stores them encrypted, and flips authType to oauth", async () => {
    const provider = new McpOAuthClientProvider({ serverName: SERVER });
    expect(await provider.tokens()).toBeUndefined();

    const tokens = { access_token: "secret-access-123", token_type: "Bearer", refresh_token: "r-456" };
    await provider.saveTokens(tokens as any);

    expect(await provider.tokens()).toEqual(tokens);

    const server = await getServerConfig(SERVER);
    expect(server?.authType).toBe("oauth");
    // The raw access token must not be persisted in plaintext.
    expect(store.get("mcp_servers")).not.toContain("secret-access-123");
    expect(server?.oauthTokens).toBeDefined();
  });

  it("round-trips dynamic client information encrypted at rest", async () => {
    const provider = new McpOAuthClientProvider({ serverName: SERVER });
    expect(await provider.clientInformation()).toBeUndefined();

    const info = { client_id: "client-xyz", client_secret: "shhh-secret" };
    await provider.saveClientInformation(info as any);

    expect(await provider.clientInformation()).toEqual(info);
    expect(store.get("mcp_servers")).not.toContain("shhh-secret");
  });

  it("throws when saving against a server that does not exist", async () => {
    store.clear();
    store.set("mcp_servers", JSON.stringify([]));
    const provider = new McpOAuthClientProvider({ serverName: "ghost" });
    await expect(provider.saveTokens({ access_token: "x", token_type: "Bearer" } as any)).rejects.toThrow(
      /not found/
    );
  });
});

describe("pending OAuth sessions", () => {
  beforeEach(seedServer);

  it("persists the code verifier (encrypted) and reads it back via getPendingSession", async () => {
    const provider = new McpOAuthClientProvider({ serverName: SERVER });
    await provider.saveCodeVerifier("verifier-abc");

    // codeVerifier() returns the in-memory value.
    expect(provider.codeVerifier()).toBe("verifier-abc");

    // And it is durably stored, keyed by state, encrypted.
    const session = await getPendingSession(provider.stateValue);
    expect(session).toEqual({ serverName: SERVER, codeVerifier: "verifier-abc" });
    expect(store.get("mcp_oauth_sessions")).not.toContain("verifier-abc");
  });

  it("returns undefined for an unknown state", async () => {
    expect(await getPendingSession("nope")).toBeUndefined();
  });

  it("treats expired sessions as absent", async () => {
    await savePendingSession("state-1", SERVER, "verifier-1");
    // Age the stored record past the TTL.
    const map = JSON.parse(store.get("mcp_oauth_sessions")!);
    map["state-1"].createdAt = Date.now() - 11 * 60 * 1000;
    store.set("mcp_oauth_sessions", JSON.stringify(map));

    expect(await getPendingSession("state-1")).toBeUndefined();
  });

  it("deletes a pending session", async () => {
    await savePendingSession("state-2", SERVER, "verifier-2");
    expect(await getPendingSession("state-2")).toBeDefined();
    await deletePendingSession("state-2");
    expect(await getPendingSession("state-2")).toBeUndefined();
  });

  it("throws from codeVerifier() when none is available", () => {
    const provider = new McpOAuthClientProvider({ serverName: SERVER });
    expect(() => provider.codeVerifier()).toThrow(/code verifier/);
  });
});
