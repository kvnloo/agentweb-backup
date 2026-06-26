/**
 * End-to-end style test of the outbound MCP OAuth flow. It stands up a real
 * in-process MCP server that requires OAuth (401 + RFC 9728/8414 discovery +
 * dynamic registration + token exchange) and drives the actual `initiate` and
 * `callback` routes through the live @modelcontextprotocol/sdk auth machinery.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing";

// In-memory settings store shared by the real provider under test.
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

// Keep heavy modules out of the import graph; initiate/callback don't use them.
jest.mock("../services/agentModeService", () => ({
  agentModeService: { refreshMcpTools: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../services/generateMarketingResponseWorkerService", () => ({
  generateMarketingResponseWorkerService: { shutdown: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../mcp/client/mcpClientService", () => ({ McpClientService: class {} }));

import express from "express";
import request from "supertest";
import http from "http";
import mcpServersRoutes, { mcpOAuthPublicRouter } from "../routes/mcpServers";
import { getServerConfig } from "../mcp/client/mcpOAuthClientProvider";
import { decryptPassword } from "../utils/crypto";

const SERVER_NAME = "mockoauth";

let mockServer: http.Server;
let mockBase: string;
let tokenRequests = 0;
let registerRequests = 0;

// --- mock OAuth-protected MCP server ----------------------------------------
const buildMockServer = (): Promise<void> =>
  new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // The MCP endpoint always demands auth.
    app.all("/mcp", (_req, res) => {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${mockBase}/.well-known/oauth-protected-resource"`
        )
        .json({ error: "unauthorized" });
    });

    // RFC 9728 protected resource metadata (both path-aware and root forms).
    app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
      res.json({ resource: `${mockBase}/mcp`, authorization_servers: [mockBase] });
    });

    // RFC 8414 authorization server metadata.
    app.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (_req, res) => {
      res.json({
        issuer: mockBase,
        authorization_endpoint: `${mockBase}/authorize`,
        token_endpoint: `${mockBase}/token`,
        registration_endpoint: `${mockBase}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    });

    // RFC 7591 dynamic client registration.
    app.post("/register", (req, res) => {
      registerRequests++;
      res.status(201).json({
        client_id: "mock-client-id",
        redirect_uris: req.body.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: req.body.grant_types,
        response_types: req.body.response_types,
      });
    });

    // Token exchange.
    app.post("/token", (_req, res) => {
      tokenRequests++;
      res.json({
        access_token: "mock-access-token-XYZ",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "mock-refresh-token",
      });
    });

    mockServer = app.listen(0, () => {
      const addr = mockServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      mockBase = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

const buildApp = () => {
  const app = express();
  app.use(express.json());
  // Inject an authenticated admin (the real middleware lives in app.ts).
  app.use((req, _res, next) => {
    (req as any).user = { userId: "admin" };
    next();
  });
  app.use("/api/mcp-oauth", mcpOAuthPublicRouter);
  app.use("/api/admin/mcp-servers", mcpServersRoutes);
  return app;
};

beforeAll(async () => {
  await buildMockServer();
});

afterAll((done) => {
  mockServer.close(() => done());
});

beforeEach(() => {
  store.clear();
  tokenRequests = 0;
  registerRequests = 0;
  store.set(
    "mcp_servers",
    JSON.stringify([{ name: SERVER_NAME, transport: "streamable-http", url: `${mockBase}/mcp` }])
  );
});

describe("outbound MCP OAuth flow (integration)", () => {
  it("initiate discovers OAuth, registers a client, and returns an authorization URL", async () => {
    const app = buildApp();
    const res = await request(app).post(`/api/admin/mcp-servers/${SERVER_NAME}/oauth/initiate`).send({});

    expect(res.status).toBe(200);
    expect(res.body.authorizationRequired).toBe(true);
    expect(typeof res.body.authorizationUrl).toBe("string");
    expect(typeof res.body.state).toBe("string");

    const authUrl = new URL(res.body.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(`${mockBase}/authorize`);
    expect(authUrl.searchParams.get("client_id")).toBe("mock-client-id");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("redirect_uri")).toContain("/api/mcp-oauth/callback");
    expect(authUrl.searchParams.get("state")).toBe(res.body.state);

    // Dynamic registration ran and was persisted (encrypted) on the server config.
    expect(registerRequests).toBe(1);
    const server = await getServerConfig(SERVER_NAME);
    expect(server?.oauthClientInfo).toBeDefined();
    expect(JSON.parse(decryptPassword(server!.oauthClientInfo!).password).client_id).toBe("mock-client-id");
  });

  it("callback exchanges the code and persists tokens, flipping authType to oauth", async () => {
    const app = buildApp();

    // 1. initiate to register the client + create the pending session.
    const initRes = await request(app).post(`/api/admin/mcp-servers/${SERVER_NAME}/oauth/initiate`).send({});
    const state = initRes.body.state;
    expect(state).toBeTruthy();

    // 2. the OAuth provider would redirect the browser here with code + state.
    const cbRes = await request(app)
      .get("/api/mcp-oauth/callback")
      .query({ code: "mock-auth-code", state });

    expect(cbRes.status).toBe(200);
    expect(cbRes.text).toContain('"success":true');
    expect(tokenRequests).toBe(1);

    // 3. tokens are persisted (encrypted) and the server is now an OAuth server.
    const server = await getServerConfig(SERVER_NAME);
    expect(server?.authType).toBe("oauth");
    expect(server?.oauthTokens).toBeDefined();
    expect(store.get("mcp_servers")).not.toContain("mock-access-token-XYZ");
    const tokens = JSON.parse(decryptPassword(server!.oauthTokens!).password);
    expect(tokens.access_token).toBe("mock-access-token-XYZ");
    expect(tokens.refresh_token).toBe("mock-refresh-token");

    // 4. the pending session is consumed (re-using the state now fails cleanly).
    const replay = await request(app).get("/api/mcp-oauth/callback").query({ code: "x", state });
    expect(replay.text).toContain("Authorization session expired");
  });

  it("does not require OAuth for a server that is not protected", async () => {
    // Point at a non-OAuth endpoint: the mock returns 401 only on /mcp, so use a
    // path that 404s — connect fails without producing an authorization URL.
    store.set(
      "mcp_servers",
      JSON.stringify([{ name: SERVER_NAME, transport: "streamable-http", url: `${mockBase}/not-mcp` }])
    );
    const app = buildApp();
    const res = await request(app).post(`/api/admin/mcp-servers/${SERVER_NAME}/oauth/initiate`).send({});
    // No authorization URL captured → reported as a connection failure, not an OAuth prompt.
    expect(res.body.authorizationRequired).toBeFalsy();
  });
});
