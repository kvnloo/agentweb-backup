process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-testing";

// In-memory settings store (empty → no pending sessions exist).
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

// Avoid pulling in the heavy agent/worker/MCP-client modules during import.
jest.mock("../services/agentModeService", () => ({
  agentModeService: { refreshMcpTools: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../services/generateMarketingResponseWorkerService", () => ({
  generateMarketingResponseWorkerService: { shutdown: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock("../mcp/client/mcpClientService", () => ({ McpClientService: class {} }));

import express from "express";
import request from "supertest";
import { mcpOAuthPublicRouter } from "../routes/mcpServers";

const app = express();
app.use("/api/mcp-oauth", mcpOAuthPublicRouter);

describe("GET /api/mcp-oauth/callback", () => {
  beforeEach(() => store.clear());

  it("returns a failure page when the provider reports an error", async () => {
    const res = await request(app)
      .get("/api/mcp-oauth/callback")
      .query({ error: "access_denied", error_description: "User denied" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Authorization failed");
    expect(res.text).toContain("User denied");
    expect(res.text).toContain('"success":false');
  });

  it("rejects requests missing code or state", async () => {
    const res = await request(app).get("/api/mcp-oauth/callback").query({ code: "abc" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Missing authorization code or state");
  });

  it("reports an expired/unknown session when state has no pending record", async () => {
    const res = await request(app)
      .get("/api/mcp-oauth/callback")
      .query({ code: "abc", state: "unknown-state" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Authorization session expired");
  });

  it("posts a message to window.opener so the portal can react", async () => {
    const res = await request(app).get("/api/mcp-oauth/callback").query({ code: "abc" });
    expect(res.text).toContain("window.opener.postMessage");
    expect(res.text).toContain('"source":"mcp-oauth"');
  });
});
