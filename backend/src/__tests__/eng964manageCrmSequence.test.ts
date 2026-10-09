/**
 * ENG-964 — `manage_crm_sequence` behind the ENG-587 A1+A2 activation boundary.
 *
 * Each `AC<n>` block maps to the human-written acceptance criteria on the
 * Linear issue. The tool is exercised through the real registry; the HTTP
 * self-call (mcpFetch) and the session store are the only mocked boundaries.
 */
jest.mock("../mcp/server/httpClient", () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn(() => "mock-token"),
  clearUserCache: jest.fn(),
}));

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
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
import { chatbotDb } from "../services/chatbotService";
import { evaluateAgentToolPolicy } from "../services/agentToolGatewayService";
import { describeSequenceAudience } from "../services/crmSequenceRead";
import "../mcp/server/apiTools";

const mockFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const mockGetSession = (chatbotDb as any).getChatSession as jest.Mock;
const mockGetMessages = (chatbotDb as any).getMessagesFromMessagesTable as jest.Mock;

const USER_ID = "tenant-1";
const SESSION_ID = "sess-attended";
const attendedCtx = { userId: USER_ID, agentUserId: USER_ID, sessionId: SESSION_ID };

function parse(result: any) {
  return result && Array.isArray(result.content) ? JSON.parse(result.content[0].text) : result;
}

function baseSequence(overrides: Record<string, any> = {}) {
  return {
    sequenceId: "seq-1",
    userId: USER_ID,
    name: "Trial nurture",
    status: "draft",
    campaignType: "nurture",
    enrollmentTrigger: { type: "manual" },
    autoEnrollListIds: ["list-1"],
    exitConditions: { onUnsubscribe: true },
    steps: [
      { stepId: "s_a", stepNumber: 1, name: "Welcome", delayDays: 0, channel: "email", subject: "Hi", bodyHtml: "<p>Hello</p>" },
      { stepId: "s_b", stepNumber: 2, name: "Follow up", delayDays: 3, channel: "email", subject: "Still there?", bodyHtml: "<p>Ping</p>" },
    ],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

let storedSequence: any;
let putCalls: any[];
let postCalls: any[];

function installFetch() {
  mockFetch.mockImplementation(async (opts: any) => {
    if (opts.method === "GET" && opts.path === "/api/crm/sequences/seq-1") return { sequence: storedSequence };
    if (opts.method === "PUT" && opts.path === "/api/crm/sequences/seq-1") {
      putCalls.push(opts.body);
      // Mirror the route's atomic guards (dripSequenceDb.updateSequence ConditionExpression).
      const { expectedUpdatedAt, requireStatusNot, ...fields } = opts.body;
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== storedSequence.updatedAt) {
        throw new Error("API error (409): Sequence seq-1 changed since it was read");
      }
      if (requireStatusNot !== undefined && storedSequence.status === requireStatusNot) {
        throw new Error("API error (409): Sequence seq-1 changed since it was read");
      }
      storedSequence = { ...storedSequence, ...fields };
      return { sequence: storedSequence };
    }
    if (opts.method === "POST" && opts.path === "/api/crm/sequences") {
      postCalls.push(opts.body);
      storedSequence = baseSequence({ ...opts.body, autoEnrollListIds: undefined, status: "draft" });
      return { sequence: storedSequence };
    }
    throw new Error(`unexpected ${opts.method} ${opts.path}`);
  });
}

/** Run a preview and return the deck-of-one item it surfaced. */
async function preview() {
  const result = parse(
    await mcpToolRegistry.execute("manage_crm_sequence", { action: "preview_activation", sequence_id: "seq-1" }, attendedCtx),
  );
  expect(result.awaitingUserConfirmation).toBe(true);
  expect(Array.isArray(result.questionDeckPayload)).toBe(true);
  return result;
}

/** The persisted message pair the iteration-end seam writes for a deck-of-one + the inbound answer. */
function historyFor(kind: string, answer?: { verdict: string; answeredBy: string }) {
  const messages: any[] = [
    {
      metadata: {
        pendingApprovalDeckId: "deck-1",
        approvalDeckItems: [{ itemId: "item-1", kind, question: "Activate?", options: [] }],
      },
    },
  ];
  if (answer) {
    messages.push({
      metadata: {
        approvalDeckAnswer: {
          deckId: "deck-1",
          answers: [{ itemId: "item-1", verdict: answer.verdict, answeredBy: answer.answeredBy, at: "2026-10-06T00:00:00Z" }],
        },
      },
    });
  }
  return messages;
}

async function activate(args: Record<string, any> = {}, context: any = attendedCtx) {
  return parse(
    await mcpToolRegistry.execute("manage_crm_sequence", { action: "activate", sequence_id: "seq-1", ...args }, context),
  );
}

function wroteActive() {
  return putCalls.some((b) => b?.status === "active");
}

beforeEach(() => {
  mockFetch.mockReset();
  mockGetSession.mockReset();
  mockGetMessages.mockReset();
  storedSequence = baseSequence();
  putCalls = [];
  postCalls = [];
  installFetch();
  mockGetSession.mockResolvedValue({ sessionId: SESSION_ID, sessionType: "agent" });
  mockGetMessages.mockResolvedValue([]);
});

describe("manage_crm_sequence (ENG-964)", () => {
  it("is registered", () => {
    expect(mcpToolRegistry.getTool("manage_crm_sequence")).toBeDefined();
  });

  describe("AC1 — unattended / scheduled / external-MCP activation is refused unconditionally", () => {
    async function expectRefusedWithFullApproval(context: any, afterPreview?: () => void) {
      const p = await preview();
      afterPreview?.();
      mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind, { verdict: "activate", answeredBy: "user" }));
      const result = await activate({ confirm: true, preview_token: p.preview_token }, context);
      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(wroteActive()).toBe(false);
    }

    it("refuses an unattended context even with confirm:true and an approved preview", async () => {
      await expectRefusedWithFullApproval({ ...attendedCtx, unattended: true });
    });

    it("refuses a scheduled session even with confirm:true and an approved preview", async () => {
      await expectRefusedWithFullApproval(attendedCtx, () =>
        mockGetSession.mockResolvedValue({ sessionId: SESSION_ID, sessionType: "scheduled" }),
      );
    });

    it("refuses an external MCP client even with confirm:true and an approved preview", async () => {
      await expectRefusedWithFullApproval({ ...attendedCtx, externalMcp: true });
    });

    it("fails closed when the session cannot be read", async () => {
      const p = await preview();
      mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind, { verdict: "activate", answeredBy: "user" }));
      mockGetSession.mockResolvedValue(null);
      const result = await activate({ preview_token: p.preview_token });
      expect(result.success).toBe(false);
      expect(wroteActive()).toBe(false);
    });
  });

  it("AC1 — preview_activation is itself refused in a scheduled session", async () => {
    mockGetSession.mockResolvedValue({ sessionId: SESSION_ID, sessionType: "scheduled" });
    const result = parse(
      await mcpToolRegistry.execute("manage_crm_sequence", { action: "preview_activation", sequence_id: "seq-1" }, attendedCtx),
    );
    expect(result.blocked).toBe(true);
    expect(result.questionDeckPayload).toBeUndefined();
  });

  it("AC2 — attended activation is refused when no preview was issued", async () => {
    mockGetMessages.mockResolvedValue([]);
    const result = await activate({ confirm: true });
    expect(result.success).toBe(false);
    expect(result.code).toBe("no_preview");
    expect(wroteActive()).toBe(false);
  });

  it("AC3 — a model-authored confirm:true between preview and activation is not approval", async () => {
    const p = await preview();
    // Preview card persisted, but no human answer landed — only the model's flag.
    mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind));
    const result = await activate({ confirm: true, preview_token: p.preview_token });
    expect(result.success).toBe(false);
    expect(result.code).toBe("awaiting_approval");
    expect(wroteActive()).toBe(false);
  });

  it("AC3 — an answer not attributable to a user selection is refused", async () => {
    const p = await preview();
    mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind, { verdict: "activate", answeredBy: "model" }));
    const result = await activate({ preview_token: p.preview_token });
    expect(result.success).toBe(false);
    expect(wroteActive()).toBe(false);
  });

  it("AC4 — refused when the human answer after preview is not affirmative", async () => {
    const p = await preview();
    mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind, { verdict: "keep_draft", answeredBy: "user" }));
    const result = await activate({ preview_token: p.preview_token });
    expect(result.success).toBe(false);
    expect(result.code).toBe("not_affirmative");
    expect(wroteActive()).toBe(false);
  });

  describe("AC5 — preview token hashes content, audience and cadence", () => {
    const mutations: Array<[string, (s: any) => any]> = [
      ["content (subject)", (s) => ({ ...s, steps: [{ ...s.steps[0], subject: "Changed" }, s.steps[1]] })],
      ["content (body)", (s) => ({ ...s, steps: [{ ...s.steps[0], bodyHtml: "<p>Other</p>" }, s.steps[1]] })],
      ["audience", (s) => ({ ...s, autoEnrollListIds: ["list-1", "list-2"] })],
      ["cadence", (s) => ({ ...s, steps: [s.steps[0], { ...s.steps[1], delayDays: 1 }] })],
    ];

    it.each(mutations)("a change to %s after preview invalidates the approval", async (_label, mutate) => {
      const p = await preview();
      mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind, { verdict: "activate", answeredBy: "user" }));
      storedSequence = mutate(storedSequence);
      const result = await activate({ preview_token: p.preview_token });
      expect(result.success).toBe(false);
      expect(result.code).toBe("stale_preview");
      expect(wroteActive()).toBe(false);
    });

    it("an unchanged sequence re-previews to the same token (stable hash)", async () => {
      const a = await preview();
      storedSequence = { ...storedSequence, updatedAt: "2026-10-07T00:00:00Z", steps: storedSequence.steps.map((s: any) => ({ ...s, stepId: `new_${s.stepId}` })) };
      const b = await preview();
      expect(b.preview_token).toBe(a.preview_token);
    });
  });

  it("AC4 — a later 'keep draft' answer overrides an earlier 'activate' for the same preview", async () => {
    const p = await preview();
    const kind = p.questionDeckPayload[0].kind;
    const older = historyFor(kind, { verdict: "activate", answeredBy: "user" });
    const newer = historyFor(kind, { verdict: "keep_draft", answeredBy: "user" }).map((m: any) => {
      const md = JSON.parse(JSON.stringify(m.metadata));
      if (md.pendingApprovalDeckId) md.pendingApprovalDeckId = "deck-2";
      if (md.approvalDeckAnswer) md.approvalDeckAnswer.deckId = "deck-2";
      return { metadata: md };
    });
    mockGetMessages.mockResolvedValue([...older, ...newer]);
    const result = await activate({ preview_token: p.preview_token });
    expect(result.success).toBe(false);
    expect(result.code).toBe("not_affirmative");
    expect(wroteActive()).toBe(false);
  });

  it("AC6 — activation succeeds with preview + unchanged hash + affirmative human answer", async () => {
    const p = await preview();
    mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind, { verdict: "activate", answeredBy: "user" }));
    const result = await activate({ preview_token: p.preview_token });
    expect(result.success).toBe(true);
    expect(putCalls).toEqual([{ status: "active", expectedUpdatedAt: "2026-10-01T00:00:00Z", requireStatusNot: "active" }]);
    expect(mockGetMessages).toHaveBeenCalledWith(SESSION_ID);
  });

  it("AC6 — a concurrent edit between approval read and write refuses activation atomically", async () => {
    const p = await preview();
    mockGetMessages.mockImplementation(async () => {
      // Another writer edits the steps after activate() has read the sequence.
      storedSequence = { ...storedSequence, updatedAt: "2026-10-02T00:00:00Z", steps: [] };
      return historyFor(p.questionDeckPayload[0].kind, { verdict: "activate", answeredBy: "user" });
    });
    const result = await activate({ preview_token: p.preview_token });
    expect(result.success).toBe(false);
    expect(result.code).toBe("stale_preview");
    expect(storedSequence.status).toBe("draft");
  });

  it("update refuses atomically when the sequence went active after the status check", async () => {
    mockFetch.mockImplementationOnce(async () => ({ sequence: storedSequence }));
    mockFetch.mockImplementationOnce(async () => {
      storedSequence = { ...storedSequence, status: "active" };
      throw new Error("API error (409): Sequence seq-1 changed since it was read");
    });
    const result = parse(
      await mcpToolRegistry.execute("manage_crm_sequence", { action: "update", sequence_id: "seq-1", name: "New" }, attendedCtx),
    );
    expect(result.success).toBe(false);
    expect(result.code).toBe("active_sequence");
  });

  it("AC6 — a mismatched preview_token argument is refused even when the stored state is approved", async () => {
    const p = await preview();
    mockGetMessages.mockResolvedValue(historyFor(p.questionDeckPayload[0].kind, { verdict: "activate", answeredBy: "user" }));
    const result = await activate({ preview_token: "0".repeat(64) });
    expect(result.success).toBe(false);
    expect(wroteActive()).toBe(false);
  });

  describe("AC7 — created sequences target the field the enrollment reader uses", () => {
    it("create writes autoEnrollListIds (never enrollmentTrigger list_membership) and stays draft", async () => {
      const result = parse(
        await mcpToolRegistry.execute(
          "manage_crm_sequence",
          {
            action: "create",
            name: "Trial nurture",
            audience_list_ids: ["list-1"],
            steps: [{ name: "Welcome", delay_days: 0, subject: "Hi", body_html: "<p>Hello</p>" }],
            status: "active",
          },
          attendedCtx,
        ),
      );
      expect(result.success).toBe(true);
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].enrollmentTrigger).toBeUndefined();
      expect(postCalls[0].status).toBeUndefined();
      const audienceWrite = putCalls.find((b) => "autoEnrollListIds" in b);
      expect(audienceWrite).toEqual({ autoEnrollListIds: ["list-1"] });
      expect(wroteActive()).toBe(false);
      // getSequencesByAutoEnrollList / describeSequenceAudience read exactly this field.
      expect(Array.isArray(storedSequence.autoEnrollListIds) && storedSequence.autoEnrollListIds.includes("list-1")).toBe(true);
      expect(describeSequenceAudience(storedSequence)).toContain("list-1");
    });

    it("update never writes status, and update of an active sequence is refused", async () => {
      await mcpToolRegistry.execute(
        "manage_crm_sequence",
        { action: "update", sequence_id: "seq-1", status: "active", audience_list_ids: ["list-2"] },
        attendedCtx,
      );
      expect(wroteActive()).toBe(false);
      expect(putCalls.at(-1)).toEqual({ autoEnrollListIds: ["list-2"], requireStatusNot: "active" });

      storedSequence = baseSequence({ status: "active" });
      putCalls = [];
      const refused = parse(
        await mcpToolRegistry.execute(
          "manage_crm_sequence",
          { action: "update", sequence_id: "seq-1", name: "Renamed" },
          attendedCtx,
        ),
      );
      expect(refused.success).toBe(false);
      expect(putCalls).toEqual([]);
    });

    it("pause is always allowed, including unattended", async () => {
      storedSequence = baseSequence({ status: "active" });
      const result = parse(
        await mcpToolRegistry.execute("manage_crm_sequence", { action: "pause", sequence_id: "seq-1" }, { ...attendedCtx, unattended: true }),
      );
      expect(result.success).toBe(true);
      expect(putCalls).toEqual([{ status: "paused" }]);
    });
  });

  it("AC8 — the gateway classifies manage_crm_sequence as external_send", () => {
    const decision = evaluateAgentToolPolicy({ toolName: "manage_crm_sequence", args: { action: "create" } } as any);
    expect(decision.effect).toBe("external_send");
  });
});
