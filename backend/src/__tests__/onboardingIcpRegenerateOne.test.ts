/**
 * ENG-255 — per-persona ICP regeneration.
 *
 * `POST /api/onboarding/icp/regenerate-one` used to parse and validate its
 * `icpId`, then throw it away and regenerate the entire ICP set from brand
 * context alone (`startIcpDiscoveryForUser`). Two consequences:
 *
 *   1. Clicking "Regenerate this one" replaced all five personas.
 *   2. Any persona the user had hand-edited via `/icp/edit-one` was silently
 *      overwritten, because the regeneration prompt never read `icpResult`.
 *
 * The fix regenerates exactly one persona, and treats the user's edits as an
 * immutable *anchor* (`ICPPersona.userIntent`) that drives every subsequent
 * regeneration of that persona instead of being destroyed by it.
 *
 * These tests assert what we can prove deterministically: which personas
 * change, that the anchor survives, and what goes into the prompt. Whether
 * the model honours "preserve this meaning" is not assertable here.
 */

process.env.CASCADE_TRIGGER_DELAY_MS = "0";

jest.mock("../services/db", () => ({
  taskDb: {
    getTasksWithKnowledgeBase: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
    getUserByEmailConsistent: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../services/onboardingCompetitorService", () => ({
  startCompetitorStrategyForUser: jest.fn(),
  triggerCompetitorStrategyForUser: jest.fn(),
  generateCompetitorStrategyForUser: jest.fn(),
}));

import {
  ICP_REGEN_DISTINCT_INSTRUCTION,
  ICP_REGEN_REFINE_INSTRUCTION,
  ICP_SINGLE_REGEN_SYSTEM_PROMPT,
  regenerateSingleIcpForUser,
  triggerIcpDiscoveryForUser,
} from "../services/onboardingIcpService";
import { sanitizeICPPersonas } from "../services/icpStatusService";

const { userDb } = require("../services/db");
const competitorService = require("../services/onboardingCompetitorService");

/** Captures the prompts so we can assert what the model was actually sent. */
class FakeLlm {
  public lastSystemPrompt = "";
  public lastUserPrompt = "";
  public callCount = 0;

  constructor(private readonly response: unknown) {}

  async generateJsonRobust<T = unknown>(system: string, user: string): Promise<T> {
    this.callCount += 1;
    this.lastSystemPrompt = system;
    this.lastUserPrompt = user;
    return this.response as T;
  }
}

function persona(n: number, extra: Record<string, unknown> = {}) {
  return {
    name: `P${n}`,
    pain: `pain${n}`,
    desire: `desire${n}`,
    objection: `objection${n}`,
    meta_targeting_brief: `brief${n}`,
    ...extra,
  };
}

const FIVE = [persona(0), persona(1), persona(2), persona(3), persona(4)];

/** The persona the model returns when asked to regenerate a single card. */
const REGENERATED = {
  name: "🔬 The Regenerated One",
  pain: "new pain",
  desire: "new desire",
  objection: "new objection",
  meta_targeting_brief: "new brief",
};

function seedUser(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    email: "founder@acme.com",
    companyName: "Acme",
    productDomain: "https://acme.com",
    icpStatus: "running",
    icpStartedAt: new Date().toISOString(),
    icpResult: FIVE.map((p) => ({ ...p })),
    ...overrides,
  };
}

/** Last `icpResult` written to the DB across all updateUser calls. */
function lastWrittenIcps(): any[] | undefined {
  const calls = userDb.updateUser.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][1] && calls[i][1].icpResult) return calls[i][1].icpResult;
  }
  return undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` clears call records but NOT implementations, so a
  // `mockResolvedValue` set in one describe leaks into the next. Re-establish
  // the default explicitly: no consistent-read row, fall back to the GSI read.
  userDb.getUserById.mockReset();
  userDb.getUserByEmailConsistent.mockReset();
  userDb.getUserByEmailConsistent.mockResolvedValue(null);
  competitorService.generateCompetitorStrategyForUser.mockReset();
  competitorService.generateCompetitorStrategyForUser.mockResolvedValue({
    per_icp: [
      {
        icp_id: REGENERATED.name,
        competitor_names: ["NewCo"],
        offer_angles: ["angle"],
        meta_targeting_brief: "new brief",
      },
    ],
  });
});

// ───────────────────────── anchor persistence ─────────────────────────

describe("sanitizeICPPersonas carries the user's edit anchor", () => {
  it("round-trips userIntent instead of stripping it", () => {
    const out = sanitizeICPPersonas([
      persona(0, { userIntent: { name: "patients and healthcare professionals." } }),
    ]);
    expect(out[0].userIntent).toEqual({
      name: "patients and healthcare professionals.",
    });
  });

  it("drops non-persona keys inside userIntent", () => {
    const out = sanitizeICPPersonas([
      persona(0, { userIntent: { name: "kept", bogus: "dropped" } as any }),
    ]);
    expect(out[0].userIntent).toEqual({ name: "kept" });
  });

  it("omits userIntent entirely when absent", () => {
    const out = sanitizeICPPersonas([persona(0)]);
    expect(out[0].userIntent).toBeUndefined();
  });
});

// ───────────────────────── input validation ─────────────────────────

describe("regenerateSingleIcpForUser — invalid input writes nothing", () => {
  it("rejects a negative index without touching the DB", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    await expect(regenerateSingleIcpForUser("u1", -1)).rejects.toThrow(/index/i);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("rejects an index past the end of the set without touching the DB", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    await expect(regenerateSingleIcpForUser("u1", 5)).rejects.toThrow(/index/i);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it("rejects when the user has no ICPs to regenerate", async () => {
    userDb.getUserById.mockResolvedValue(seedUser({ icpResult: [] }));
    await expect(regenerateSingleIcpForUser("u1", 0)).rejects.toThrow();
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});

// ───────────────────────── the reported bug ─────────────────────────

describe("regenerateSingleIcpForUser — regenerates exactly one persona", () => {
  it("replaces the target and leaves the other four byte-identical", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    const llm = new FakeLlm({ icp: REGENERATED });

    await regenerateSingleIcpForUser("u1", 3, { llm });

    const written = lastWrittenIcps()!;
    expect(written).toHaveLength(5);
    expect(written[3].name).toBe(REGENERATED.name);
    for (const i of [0, 1, 2, 4]) {
      expect(written[i]).toEqual(FIVE[i]);
    }
  });

  it("preserves a hand-edited persona when a DIFFERENT card is regenerated", async () => {
    const edited = persona(2, {
      name: "ZZZ TEST 123",
      userIntent: { name: "ZZZ TEST 123" },
    });
    const icps = FIVE.map((p, i) => (i === 2 ? edited : { ...p }));
    userDb.getUserById.mockResolvedValue(seedUser({ icpResult: icps }));

    await regenerateSingleIcpForUser("u1", 4, { llm: new FakeLlm({ icp: REGENERATED }) });

    const written = lastWrittenIcps()!;
    expect(written[2].name).toBe("ZZZ TEST 123");
    expect(written[2].userIntent).toEqual({ name: "ZZZ TEST 123" });
  });

  it("re-reads the record before writing so a concurrent edit is not lost", async () => {
    const before = seedUser();
    const concurrentlyEdited = seedUser({
      icpResult: FIVE.map((p, i) =>
        i === 0 ? persona(0, { name: "EDITED MID-FLIGHT" }) : { ...p },
      ),
    });
    userDb.getUserById
      .mockResolvedValueOnce(before) // validation + brand context
      .mockResolvedValue(concurrentlyEdited); // read-modify-write before persisting

    await regenerateSingleIcpForUser("u1", 3, { llm: new FakeLlm({ icp: REGENERATED }) });

    const written = lastWrittenIcps()!;
    expect(written[0].name).toBe("EDITED MID-FLIGHT");
    expect(written[3].name).toBe(REGENERATED.name);
  });
});

// ───────────────────── eventual-consistency guard ─────────────────────
//
// Fangfang's trace: /icp/edit-one at 22:21:36, /icp/regenerate-one at
// 22:21:37. `getUserById` reads the eventually-consistent UserIdIndex GSI, so
// one second later it can still return the PRE-edit row — and the anchor we
// are supposed to honour would be invisible to the regeneration.

describe("regenerateSingleIcpForUser — reads the user strongly-consistently", () => {
  it("sees an anchor written one second earlier, even when the GSI is stale", async () => {
    const anchor = "patients and healthcare professionals.";
    const stale = seedUser(); // GSI row: no anchor yet
    const fresh = seedUser({
      icpResult: FIVE.map((p, i) =>
        i === 1 ? persona(1, { name: anchor, userIntent: { name: anchor } }) : { ...p },
      ),
    });
    userDb.getUserById.mockResolvedValue(stale);
    userDb.getUserByEmailConsistent.mockResolvedValue(fresh);

    const llm = new FakeLlm({ icp: REGENERATED });
    await regenerateSingleIcpForUser("u1", 1, { llm });

    expect(userDb.getUserByEmailConsistent).toHaveBeenCalledWith("founder@acme.com");
    expect(llm.lastUserPrompt).toContain(anchor);
    expect(lastWrittenIcps()![1].name).toBe(anchor);
  });

  it("falls back to the GSI read when no consistent read is available", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    userDb.getUserByEmailConsistent.mockResolvedValue(null);

    await regenerateSingleIcpForUser("u1", 3, { llm: new FakeLlm({ icp: REGENERATED }) });

    expect(lastWrittenIcps()![3].name).toBe(REGENERATED.name);
  });
});

// ───────────────────────── prompt construction ─────────────────────────

describe("regenerateSingleIcpForUser — what the model is sent", () => {
  it("names the other four personas so it does not duplicate them", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    const llm = new FakeLlm({ icp: REGENERATED });

    await regenerateSingleIcpForUser("u1", 1, { llm });

    expect(llm.lastSystemPrompt).toBe(ICP_SINGLE_REGEN_SYSTEM_PROMPT);
    for (const name of ["P0", "P2", "P3", "P4"]) {
      expect(llm.lastUserPrompt).toContain(name);
    }
  });

  it("passes the user's anchor text verbatim and omits the 'be distinct' instruction", async () => {
    const anchor = "patients and healthcare professionals.";
    const icps = FIVE.map((p, i) =>
      i === 1 ? persona(1, { name: anchor, userIntent: { name: anchor } }) : { ...p },
    );
    userDb.getUserById.mockResolvedValue(seedUser({ icpResult: icps }));
    const llm = new FakeLlm({ icp: REGENERATED });

    await regenerateSingleIcpForUser("u1", 1, { llm });

    expect(llm.lastUserPrompt).toContain(anchor);
    // The user is refining this persona, not rejecting it — telling the model
    // to produce something "different" would fight the edit.
    expect(llm.lastUserPrompt).not.toContain(ICP_REGEN_DISTINCT_INSTRUCTION);
  });

  it("refines an edited card: the model sees its current content, not just the anchor", async () => {
    // Without the persona's existing fields the model rebuilds an entirely new
    // ICP from one sentence, so editing `objection` silently replaced the
    // persona's identity. An edited card is one the user has invested in —
    // regenerate it as a refinement, not a replacement.
    const anchor = "We already have preferred panel vendors.";
    const icps = FIVE.map((p, i) =>
      i === 1
        ? persona(1, { objection: anchor, userIntent: { objection: anchor } })
        : { ...p },
    );
    userDb.getUserById.mockResolvedValue(seedUser({ icpResult: icps }));
    const llm = new FakeLlm({ icp: REGENERATED });

    await regenerateSingleIcpForUser("u1", 1, { llm });

    // The card's current content is context for the refinement.
    expect(llm.lastUserPrompt).toContain("pain1");
    expect(llm.lastUserPrompt).toContain("desire1");
    expect(llm.lastUserPrompt).toContain(anchor);
    expect(llm.lastUserPrompt).toContain(ICP_REGEN_REFINE_INSTRUCTION);
    expect(llm.lastUserPrompt).not.toContain(ICP_REGEN_DISTINCT_INSTRUCTION);
  });

  it("names which fields the user authored so the model keeps them fixed", async () => {
    const anchor = "We already have preferred panel vendors.";
    const icps = FIVE.map((p, i) =>
      i === 2
        ? persona(2, { objection: anchor, userIntent: { objection: anchor } })
        : { ...p },
    );
    userDb.getUserById.mockResolvedValue(seedUser({ icpResult: icps }));
    const llm = new FakeLlm({ icp: REGENERATED });

    await regenerateSingleIcpForUser("u1", 2, { llm });

    expect(llm.lastUserPrompt).toMatch(/user wrote[\s\S]*objection/i);
  });

  it("asks for a distinct persona when the card was never edited", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    const llm = new FakeLlm({ icp: REGENERATED });

    await regenerateSingleIcpForUser("u1", 1, { llm });

    expect(llm.lastUserPrompt).toContain(ICP_REGEN_DISTINCT_INSTRUCTION);
    expect(llm.lastUserPrompt).not.toContain(ICP_REGEN_REFINE_INSTRUCTION);
  });
});

// ───────────────────────── competitor coupling ─────────────────────────

describe("regenerateSingleIcpForUser — competitor entry follows the persona", () => {
  it("regenerates only per_icp[N] and leaves the rest untouched", async () => {
    const per_icp = FIVE.map((p) => ({
      icp_id: p.name,
      competitor_names: [`c-${p.name}`],
      offer_angles: [],
      meta_targeting_brief: p.meta_targeting_brief,
    }));
    userDb.getUserById.mockResolvedValue(
      seedUser({ competitorResult: { per_icp } }),
    );

    await regenerateSingleIcpForUser("u1", 2, { llm: new FakeLlm({ icp: REGENERATED }) });

    const calls = userDb.updateUser.mock.calls;
    const compWrite = calls.map((c: any[]) => c[1]).filter((p: any) => p?.competitorResult).pop();
    expect(compWrite).toBeDefined();
    expect(compWrite.competitorResult.per_icp[2].icp_id).toBe(REGENERATED.name);
    expect(compWrite.competitorResult.per_icp[0]).toEqual(per_icp[0]);
    expect(compWrite.competitorResult.per_icp[4]).toEqual(per_icp[4]);
  });
});

// ───────────────────────────── error paths ─────────────────────────────

describe("regenerateSingleIcpForUser — failures", () => {
  it("marks the run failed and rethrows when the LLM blows up", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    userDb.getUserByEmailConsistent.mockResolvedValue(seedUser());
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const llm = {
      generateJsonRobust: jest.fn().mockRejectedValue(new Error("bedrock down")),
    };

    await expect(regenerateSingleIcpForUser("u1", 2, { llm })).rejects.toThrow("bedrock down");

    const failed = userDb.updateUser.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.icpStatus === "failed");
    expect(failed).toBeDefined();
    expect(failed.icpError).toContain("bedrock down");
    spy.mockRestore();
  });

  it("keeps the regenerated persona when competitor refresh fails", async () => {
    const per_icp = FIVE.map((p) => ({
      icp_id: p.name,
      competitor_names: [],
      offer_angles: [],
      meta_targeting_brief: p.meta_targeting_brief,
    }));
    userDb.getUserById.mockResolvedValue(seedUser({ competitorResult: { per_icp } }));
    competitorService.generateCompetitorStrategyForUser.mockRejectedValue(
      new Error("competitor LLM down"),
    );
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    // Personas are already persisted — a competitor failure must not roll them
    // back, and must not surface as a failed ICP run.
    await expect(
      regenerateSingleIcpForUser("u1", 2, { llm: new FakeLlm({ icp: REGENERATED }) }),
    ).resolves.toBeUndefined();

    expect(competitorService.generateCompetitorStrategyForUser).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      "[onboardingIcpService] competitor entry refresh failed",
      expect.objectContaining({ err: "competitor LLM down" }),
    );
    expect(lastWrittenIcps()![2].name).toBe(REGENERATED.name);
    expect(
      userDb.updateUser.mock.calls.map((c: any[]) => c[1]).some((p: any) => p?.icpStatus === "failed"),
    ).toBe(false);
    spy.mockRestore();
  });

  it("falls back to the GSI row when the consistent read throws", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    userDb.getUserByEmailConsistent.mockRejectedValue(new Error("dynamo timeout"));

    await regenerateSingleIcpForUser("u1", 0, { llm: new FakeLlm({ icp: REGENERATED }) });

    expect(lastWrittenIcps()![0].name).toBe(REGENERATED.name);
  });
});

// ───────────────────────── full-set anti-clobber ─────────────────────────

describe("triggerIcpDiscoveryForUser — a full run never destroys human work", () => {
  it("preserves an anchored persona and regenerates only the untouched slots", async () => {
    const anchored = persona(1, {
      name: "ZZZ TEST 123",
      userIntent: { name: "ZZZ TEST 123" },
    });
    const icps = FIVE.map((p, i) => (i === 1 ? anchored : { ...p }));
    userDb.getUserById.mockResolvedValue(seedUser({ icpResult: icps }));

    const fresh = [0, 1, 2, 3, 4].map((n) => persona(n + 100));
    const llm = new FakeLlm({ icps: fresh });

    await triggerIcpDiscoveryForUser("u1", { llm, loadStrategicContext: async () => null });

    const written = lastWrittenIcps()!;
    expect(written[1].name).toBe("ZZZ TEST 123");
    expect(written[1].userIntent).toEqual({ name: "ZZZ TEST 123" });
    expect(written.filter((p: any) => p.name === "ZZZ TEST 123")).toHaveLength(1);
  });
});
