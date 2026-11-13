/**
 * ENG-2961 — external (out-of-chat) sequence activation bound to the ENG-2958 digest.
 * Exercised through the real registry; mcpFetch and the session store are the mocked boundaries.
 */
jest.mock("../mcp/server/httpClient", () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn(() => "mock-token"),
  clearUserCache: jest.fn(),
}));
jest.mock("../services/chatbotService", () => ({
  chatbotDb: { getChatSession: jest.fn(), getMessagesFromMessagesTable: jest.fn() },
}));
jest.mock("../services/skillService", () => ({ skillService: { getPublishedSkills: jest.fn(async () => []) } }));
jest.mock("../services/subscriptionService", () => ({ getAllowedSkills: jest.fn(async () => ["*"]) }));
jest.mock("../services/agentModeService", () => ({
  agentModeService: { getUnassociatedToolNames: jest.fn(() => []), sendMessage: jest.fn() },
}));

import { mcpToolRegistry } from "../mcp/server/registry";
import { mcpFetch } from "../mcp/server/httpClient";
import { chatbotDb } from "../services/chatbotService";
import { findScopeDenial, API_KEY_SCOPE_READ } from "../mcp/server/apiKeyScopes";
import "../mcp/server/apiTools";

const mockFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const USER_ID = "tenant-1";
const extCtx = { userId: USER_ID, agentUserId: USER_ID, externalMcp: true, authMethod: "api_key" };
const APPROVER = "slack:U123";

const parse = (r: any) => (r && Array.isArray(r.content) ? JSON.parse(r.content[0].text) : r);
const run = async (args: any, ctx: any = extCtx) =>
  parse(await mcpToolRegistry.execute("manage_crm_sequence", { sequence_id: "seq-1", ...args }, ctx));

let stored: any;
let puts: any[];

beforeEach(() => {
  jest.clearAllMocks();
  puts = [];
  stored = {
    sequenceId: "seq-1",
    userId: USER_ID,
    name: "Trial nurture",
    status: "draft",
    autoEnrollListIds: ["list-1"],
    steps: [{ name: "Welcome", delayDays: 0, channel: "email", subject: "Hi", bodyHtml: "<p>Hello</p>" }],
    updatedAt: "2026-11-01T00:00:00Z",
  };
  mockFetch.mockImplementation(async (opts: any) => {
    if (opts.method === "GET" && opts.path === "/api/crm/sequences/seq-1") return { sequence: stored };
    if (opts.method === "PUT" && opts.path === "/api/crm/sequences/seq-1") {
      puts.push(opts.body);
      const { expectedUpdatedAt, requireStatusNot, ...fields } = opts.body;
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== stored.updatedAt) throw new Error("API error (409): changed");
      stored = { ...stored, ...fields };
      return { sequence: stored };
    }
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
});

afterEach(() => {
  // No Emma chat/agent path is ever touched.
  expect((chatbotDb as any).getChatSession).not.toHaveBeenCalled();
  expect((chatbotDb as any).getMessagesFromMessagesTable).not.toHaveBeenCalled();
});

describe("ENG-2961 external activation", () => {
  it("preview is side-effect free and returns a digest", async () => {
    const r = await run({ action: "external_activation_preview", approver: APPROVER });
    expect(r.success).toBe(true);
    expect(r.digest.sequenceId).toBe("seq-1");
    expect(r.digest.approverPrincipal).toBe(APPROVER);
    expect(puts).toHaveLength(0);
    expect(mockFetch.mock.calls.every(([o]: any) => o.method === "GET")).toBe(true);
  });

  it("confirm with a fresh digest activates via the atomic guarded write", async () => {
    const { digest } = await run({ action: "external_activation_preview", approver: APPROVER });
    const r = await run({ action: "external_activate_confirm", approver: APPROVER, digest });
    expect(r).toMatchObject({ success: true, status: "active" });
    expect(puts).toEqual([{ status: "active", expectedUpdatedAt: "2026-11-01T00:00:00Z", requireStatusNot: "active" }]);
  });

  it("confirm with a stale digest (sequence edited after preview) is refused; nothing activates", async () => {
    const { digest } = await run({ action: "external_activation_preview", approver: APPROVER });
    stored = { ...stored, steps: [{ ...stored.steps[0], subject: "Changed" }], updatedAt: "2026-11-02T00:00:00Z" };
    const r = await run({ action: "external_activate_confirm", approver: APPROVER, digest });
    expect(r).toMatchObject({ success: false, blocked: true, code: "stale_preview" });
    expect(puts).toHaveLength(0);
  });

  it("confirm with a different approver or tampered digest is refused", async () => {
    const { digest } = await run({ action: "external_activation_preview", approver: APPROVER });
    expect((await run({ action: "external_activate_confirm", approver: "slack:U999", digest })).code).toBe("principal_mismatch");
    expect((await run({ action: "external_activate_confirm", approver: APPROVER, digest: { ...digest, versionHash: "x" } })).code).toBe("malformed");
    expect(puts).toHaveLength(0);
  });

  it("confirm without a digest keeps the blanket refusal", async () => {
    const r = await run({ action: "external_activate_confirm", approver: APPROVER });
    expect(r).toMatchObject({ blocked: true, code: "missing_digest" });
    expect(puts).toHaveLength(0);
  });

  it("refuses a foreign account's sequence and any client_id override", async () => {
    const { digest } = await run({ action: "external_activation_preview", approver: APPROVER });
    stored = { ...stored, userId: "someone-else" };
    expect((await run({ action: "external_activate_confirm", approver: APPROVER, digest })).code).toBe("own_account_only");
    expect((await run({ action: "external_activation_preview", approver: APPROVER, client_id: "x@y.com" })).code).toBe("own_account_only");
    expect(puts).toHaveLength(0);
  });

  it("is unreachable from Emma sessions (non-external context)", async () => {
    const r = await run({ action: "external_activation_preview", approver: APPROVER }, { userId: USER_ID, sessionId: "s" });
    expect(r.code).toBe("external_only");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a tools:read-only aw_ key cannot call manage_crm_sequence", () => {
    const body = { method: "tools/call", params: { name: "manage_crm_sequence", arguments: { action: "external_activate_confirm" } } };
    const denial = findScopeDenial(body, [API_KEY_SCOPE_READ], (n) => mcpToolRegistry.getTool(n) as any);
    expect(denial).toEqual({ tool: "manage_crm_sequence", requiredScope: "tools:execute" });
  });
});
