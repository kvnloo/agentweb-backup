/**
 * Tests the proactive OAuth token refresh: refreshExpiringOAuthTokens refreshes
 * servers within the lead window against a mock auth server, skips servers that
 * are not due or lack a refresh token, and the scheduler timer fires.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing";

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

import express from "express";
import http from "http";
import { encryptPassword, decryptPassword } from "../utils/crypto";
import {
  refreshExpiringOAuthTokens,
  startMcpOAuthRefreshScheduler,
  stopMcpOAuthRefreshScheduler,
  OAUTH_REFRESH_LEAD_MS,
} from "../mcp/client/mcpOAuthRefreshService";
import { getServerConfig } from "../mcp/client/mcpOAuthClientProvider";

let mockServer: http.Server;
let mockBase: string;
let tokenCalls = 0;
// When true, the mock /token endpoint rejects the refresh (simulates a rotated/expired
// refresh_token) so the failure path can be exercised.
let tokenFailMode = false;

const buildMockAuthServer = (): Promise<void> =>
  new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.get(
      ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
      (_req, res) => res.json({ resource: `${mockBase}/mcp`, authorization_servers: [mockBase] })
    );
    app.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"], (_req, res) =>
      res.json({
        issuer: mockBase,
        authorization_endpoint: `${mockBase}/authorize`,
        token_endpoint: `${mockBase}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    );
    app.post("/token", (_req, res) => {
      tokenCalls++;
      if (tokenFailMode) {
        return res.status(400).json({ error: "invalid_grant", error_description: "refresh token expired" });
      }
      res.json({
        access_token: "refreshed-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
      });
    });
    mockServer = app.listen(0, () => {
      const addr = mockServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      mockBase = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

const seedServer = (overrides: Record<string, any>) => {
  store.clear();
  store.set(
    "mcp_servers",
    JSON.stringify([
      {
        name: "oauthsrv",
        transport: "streamable-http",
        url: `${mockBase}/mcp`,
        authType: "oauth",
        oauthHasRefreshToken: true,
        oauthClientInfo: encryptPassword(JSON.stringify({ client_id: "mock-client-id" }), "system"),
        oauthTokens: encryptPassword(
          JSON.stringify({ access_token: "old", token_type: "Bearer", refresh_token: "old-refresh" }),
          "system"
        ),
        ...overrides,
      },
    ])
  );
};

beforeAll(async () => {
  await buildMockAuthServer();
});
afterAll((done) => {
  stopMcpOAuthRefreshScheduler();
  mockServer.close(() => done());
});
beforeEach(() => {
  tokenCalls = 0;
  tokenFailMode = false;
});

describe("refreshExpiringOAuthTokens", () => {
  it("refreshes a server whose token is within the lead window", async () => {
    const now = Date.now();
    seedServer({ oauthExpiresAt: now + 60 * 1000 }); // 1 min left → due

    const result = await refreshExpiringOAuthTokens(now);

    expect(result.refreshed).toEqual(["oauthsrv"]);
    expect(tokenCalls).toBe(1);
    const server = await getServerConfig("oauthsrv");
    // New expiry is ~1h out (refreshed), well beyond the original 1-min window.
    expect(server!.oauthExpiresAt!).toBeGreaterThan(now + OAUTH_REFRESH_LEAD_MS);
    // The rotated tokens were persisted (encrypted) — proves saveTokens ran with the new token.
    const persisted = JSON.parse(decryptPassword(server!.oauthTokens!).password);
    expect(persisted.access_token).toBe("refreshed-access-token");
    expect(persisted.refresh_token).toBe("rotated-refresh-token");
    expect(server!.oauthHasRefreshToken).toBe(true);
  });

  it("skips a server that is not near expiry", async () => {
    const now = Date.now();
    seedServer({ oauthExpiresAt: now + 60 * 60 * 1000 }); // 1h left → not due
    const result = await refreshExpiringOAuthTokens(now);
    expect(result.refreshed).toEqual([]);
    expect(tokenCalls).toBe(0);
  });

  it("skips a server without a refresh token", async () => {
    const now = Date.now();
    seedServer({ oauthExpiresAt: now + 60 * 1000, oauthHasRefreshToken: false });
    const result = await refreshExpiringOAuthTokens(now);
    expect(result.refreshed).toEqual([]);
    expect(tokenCalls).toBe(0);
  });

  it("marks a server as failed (needs re-auth) when the refresh token is rejected", async () => {
    const now = Date.now();
    seedServer({ oauthExpiresAt: now + 60 * 1000 }); // due
    tokenFailMode = true; // /token returns 400 invalid_grant

    const result = await refreshExpiringOAuthTokens(now);

    expect(result.refreshed).toEqual([]);
    expect(result.failed).toEqual(["oauthsrv"]);
    expect(tokenCalls).toBeGreaterThanOrEqual(1);
    // The valid stored tokens are NOT overwritten by a failed refresh.
    const server = await getServerConfig("oauthsrv");
    const persisted = JSON.parse(decryptPassword(server!.oauthTokens!).password);
    expect(persisted.access_token).toBe("old");
  });

  it("returns empty (no throw) when the server list cannot be loaded", async () => {
    const getSetting = require("../services/settingsService").settingsService.getSetting as jest.Mock;
    getSetting.mockRejectedValueOnce(new Error("dynamo down"));

    const result = await refreshExpiringOAuthTokens(Date.now());

    expect(result).toEqual({ refreshed: [], failed: [] });
  });

  it("ignores non-oauth servers entirely", async () => {
    store.clear();
    store.set(
      "mcp_servers",
      JSON.stringify([{ name: "tok", transport: "streamable-http", url: `${mockBase}/mcp`, authType: "bearer" }])
    );
    const result = await refreshExpiringOAuthTokens(Date.now());
    expect(result.refreshed).toEqual([]);
    expect(tokenCalls).toBe(0);
  });
});

describe("refresh scheduler", () => {
  it("start is idempotent and the timer triggers a refresh pass", async () => {
    jest.useFakeTimers();
    const getSetting = require("../services/settingsService").settingsService.getSetting as jest.Mock;
    store.clear();
    store.set("mcp_servers", JSON.stringify([]));
    getSetting.mockClear();

    startMcpOAuthRefreshScheduler();
    startMcpOAuthRefreshScheduler(); // idempotent — no second timer

    jest.advanceTimersByTime(60 * 1000); // one tick
    await Promise.resolve();

    expect(getSetting).toHaveBeenCalled(); // the tick loaded servers
    stopMcpOAuthRefreshScheduler();
    jest.useRealTimers();
  });
});
