/**
 * ENG-962 — `list_crm_sequences` tool contract tests.
 *
 * Pins the read-only behavioral contract: list, status filter, empty-account
 * answer, inspect-one with enrollment counts, cross-account fail-closed at
 * the API boundary (mcpFetch throws on 403), and safe-to-call from an
 * unattended run (nothing here can send).
 */
jest.mock("../mcp/server/httpClient", () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn(() => "mock-token"),
  clearUserCache: jest.fn(),
}));

jest.mock("../services/skillService", () => ({
  skillService: { getPublishedSkills: jest.fn(async () => []) },
}));

jest.mock("../services/subscriptionService", () => ({
  getAllowedSkills: jest.fn(async () => ["*"]),
}));

jest.mock("../services/agentModeService", () => ({
  agentModeService: { getUnassociatedToolNames: jest.fn(() => []) },
}));

import { mcpToolRegistry } from "../mcp/server/registry";
import { mcpFetch } from "../mcp/server/httpClient";
import "../mcp/server/apiTools";

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

const USER_ID = "tenant-1";
const interactiveCtx = { userId: USER_ID, agentUserId: USER_ID, sessionId: "sess-1" };
const scheduledCtx = { userId: USER_ID, agentUserId: USER_ID, sessionId: "sess-cron", unattended: true };

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

const SEQ_ACTIVE = {
  sequenceId: "seq-active",
  userId: USER_ID,
  name: "Trial nurture",
  status: "active",
  campaignType: "nurture",
  enrollmentTrigger: { type: "list_membership", listId: "list-9" },
  autoEnrollListIds: ["list-1"],
  steps: [{ stepId: "a" }, { stepId: "b" }],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};
const SEQ_DRAFT = {
  sequenceId: "seq-draft",
  userId: USER_ID,
  name: "Winback",
  status: "draft",
  campaignType: "reengagement",
  enrollmentTrigger: { type: "manual" },
  autoEnrollListIds: [],
  steps: [{ stepId: "a" }],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  mockMcpFetch.mockReset();
});

describe("list_crm_sequences (ENG-962)", () => {
  it("is registered with a read-only schema", () => {
    const handler = mcpToolRegistry.getTool("list_crm_sequences");
    expect(handler).toBeDefined();
    expect(handler?.definition.inputSchema.required).toEqual([]);
    expect(handler?.definition.description).toContain("Read-only");
    expect(handler?.definition.description).not.toMatch(/start sending/i);
  });

  it("lists sequences with honest is_sending and worker-read audience", async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [SEQ_ACTIVE, SEQ_DRAFT] });
    const parsed = parse(await mcpToolRegistry.execute("list_crm_sequences", {}, interactiveCtx));
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/crm/sequences" }),
    );
    expect(parsed.total).toBe(2);
    expect(parsed.active_count).toBe(1);
    expect(parsed.sequences[0]).toMatchObject({
      sequence_id: "seq-active",
      status: "active",
      step_count: 2,
      is_sending: true,
    });
    expect(parsed.sequences[0].audience).toContain("list-1");
    expect(parsed.sequences[1]).toMatchObject({ status: "draft", is_sending: false });
  });

  it("returns a clean empty answer for an account with zero sequences", async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [] });
    const parsed = parse(await mcpToolRegistry.execute("list_crm_sequences", {}, interactiveCtx));
    expect(parsed.total).toBe(0);
    expect(parsed.sequences).toEqual([]);
    expect(parsed.error).toBeUndefined();
    expect(typeof parsed.summary).toBe("string");
  });

  it("filters by status when asked", async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [SEQ_ACTIVE, SEQ_DRAFT] });
    const parsed = parse(
      await mcpToolRegistry.execute("list_crm_sequences", { status: "active" }, interactiveCtx),
    );
    expect(parsed.total).toBe(1);
    expect(parsed.sequences[0].sequence_id).toBe("seq-active");
  });

  it("inspects one sequence with enrollment counts", async () => {
    mockMcpFetch.mockImplementation(async (opts: any) => {
      if (opts.path === "/api/crm/sequences/seq-active") return { sequence: SEQ_ACTIVE };
      if (opts.path === "/api/crm/sequences/seq-active/enrollments")
        return { enrollments: [{}, {}, {}], stats: { total: 3 } };
      throw new Error(`unexpected path ${opts.path}`);
    });
    const parsed = parse(
      await mcpToolRegistry.execute(
        "list_crm_sequences",
        { sequence_id: "seq-active" },
        interactiveCtx,
      ),
    );
    expect(parsed.sequence_id).toBe("seq-active");
    expect(parsed.is_sending).toBe(true);
    expect(parsed.enrollment_count).toMatchObject({ total: 3 });
  });

  it("fails closed on another user's sequence (API 403 surfaces as error)", async () => {
    mockMcpFetch.mockRejectedValue(new Error("Forbidden"));
    const parsed = parse(
      await mcpToolRegistry.execute(
        "list_crm_sequences",
        { sequence_id: "seq-other-tenant" },
        interactiveCtx,
      ),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Forbidden");
  });

  it("is read-only — safe to call from an unattended run", async () => {
    mockMcpFetch.mockResolvedValue({ sequences: [] });
    const parsed = parse(await mcpToolRegistry.execute("list_crm_sequences", {}, scheduledCtx));
    expect(parsed.total).toBe(0);
  });
});
