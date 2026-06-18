/**
 * Covers the OAuth-related behavioral changes to the existing MCP server routes:
 * authType assignment on add, OAuth-field preservation on edit, secret stripping
 * on list, and initiate validation branches.
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
jest.mock("../services/agentModeService", () => ({
  agentModeService: { refreshMcpTools: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../services/generateMarketingResponseWorkerService", () => ({
  generateMarketingResponseWorkerService: { shutdown: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../mcp/client/mcpClientService", () => ({ McpClientService: class {} }));

import express from "express";
import request from "supertest";
import mcpServersRoutes from "../routes/mcpServers";
import { decryptPassword } from "../utils/crypto";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).user = { userId: "admin" };
  next();
});
app.use("/api/admin/mcp-servers", mcpServersRoutes);

const readStored = () => JSON.parse(store.get("mcp_servers") || "[]");

beforeEach(() => store.clear());

describe("POST /api/admin/mcp-servers — authType assignment", () => {
  it("assigns authType 'none' for an HTTP server with no token", async () => {
    const res = await request(app)
      .post("/api/admin/mcp-servers")
      .send({ name: "noauth", transport: "streamable-http", url: "https://x.example/mcp" });
    expect(res.status).toBe(201);
    expect(readStored()[0].authType).toBe("none");
  });

  it("assigns authType 'bearer' and encrypts the token when one is provided", async () => {
    const res = await request(app)
      .post("/api/admin/mcp-servers")
      .send({ name: "tokserver", transport: "streamable-http", url: "https://x.example/mcp", accessToken: "tok-123" });
    expect(res.status).toBe(201);
    const stored = readStored()[0];
    expect(stored.authType).toBe("bearer");
    expect(stored.accessToken).not.toBe("tok-123");
    expect(decryptPassword(stored.accessToken).password).toBe("tok-123");
  });

  it("does not assign authType for stdio servers", async () => {
    const res = await request(app)
      .post("/api/admin/mcp-servers")
      .send({ name: "stdiosrv", transport: "stdio", command: "npx" });
    expect(res.status).toBe(201);
    expect(readStored()[0].authType).toBeUndefined();
  });
});

describe("GET /api/admin/mcp-servers — secret stripping", () => {
  it("strips oauth blobs but keeps accessToken and authType", async () => {
    store.set(
      "mcp_servers",
      JSON.stringify([
        {
          name: "s1",
          transport: "streamable-http",
          url: "https://x/mcp",
          authType: "oauth",
          accessToken: "enc-token",
          oauthClientInfo: "enc-client",
          oauthTokens: "enc-tokens",
        },
      ])
    );
    const res = await request(app).get("/api/admin/mcp-servers");
    expect(res.status).toBe(200);
    const s = res.body[0];
    expect(s.authType).toBe("oauth");
    expect(s.accessToken).toBe("enc-token");
    expect(s.oauthClientInfo).toBeUndefined();
    expect(s.oauthTokens).toBeUndefined();
  });
});

describe("PUT /api/admin/mcp-servers/:name — OAuth field preservation", () => {
  it("preserves authType + oauth blobs across an unrelated edit", async () => {
    store.set(
      "mcp_servers",
      JSON.stringify([
        {
          name: "oauthsrv",
          transport: "streamable-http",
          url: "https://old/mcp",
          authType: "oauth",
          oauthClientInfo: "enc-client",
          oauthTokens: "enc-tokens",
        },
      ])
    );
    const res = await request(app)
      .put("/api/admin/mcp-servers/oauthsrv")
      .send({ url: "https://new/mcp" });
    expect(res.status).toBe(200);
    const stored = readStored()[0];
    expect(stored.url).toBe("https://new/mcp");
    expect(stored.authType).toBe("oauth");
    expect(stored.oauthClientInfo).toBe("enc-client");
    expect(stored.oauthTokens).toBe("enc-tokens");
  });

  it("does not inject authType/oauth fields when editing a legacy server", async () => {
    store.set(
      "mcp_servers",
      JSON.stringify([{ name: "legacy", transport: "streamable-http", url: "https://old/mcp" }])
    );
    const res = await request(app)
      .put("/api/admin/mcp-servers/legacy")
      .send({ url: "https://new/mcp" });
    expect(res.status).toBe(200);
    const stored = readStored()[0];
    expect(stored.authType).toBeUndefined();
    expect(stored.oauthClientInfo).toBeUndefined();
    expect(stored.oauthTokens).toBeUndefined();
  });
});

describe("POST /:name/oauth/initiate — validation", () => {
  it("returns 404 for an unknown server", async () => {
    store.set("mcp_servers", JSON.stringify([]));
    const res = await request(app).post("/api/admin/mcp-servers/ghost/oauth/initiate").send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 for a stdio server", async () => {
    store.set("mcp_servers", JSON.stringify([{ name: "stdiosrv", transport: "stdio", command: "npx" }]));
    const res = await request(app).post("/api/admin/mcp-servers/stdiosrv/oauth/initiate").send({});
    expect(res.status).toBe(400);
  });
});
