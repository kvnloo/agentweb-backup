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

let lastSeed: any;
function seedUser(overrides: Record<string, unknown> = {}) {
  lastSeed = {
    userId: "u1",
    email: "founder@acme.com",
    companyName: "Acme",
    productDomain: "https://acme.com",
    icpStatus: "running",
    icpStartedAt: new Date().toISOString(),
    icpResult: FIVE.map((p) => ({ ...p })),
    ...overrides,
  };
  return lastSeed;
}

/**
 * The persona list after every write, in order. A card is saved by replacing
 * ONE slot (`elementSets`), not by sending the whole list, so the result is the
 * last record the code read with those slots applied. (The concurrency suite
 * below uses a stateful fake that also enforces the slot conditions.)
 */
function lastWrittenIcps(): any[] | undefined {
  let list: any[] | undefined = lastSeed?.icpResult ? lastSeed.icpResult.map((p: any) => ({ ...p })) : undefined;
  let wrote = false;
  for (const call of userDb.updateUser.mock.calls) {
    const patch = call[1] ?? {};
    if (patch.icpResult) {
      list = patch.icpResult;
      wrote = true;
    }
    for (const el of call[2]?.elementSets ?? []) {
      if (el.path.length === 1 && el.path[0] === "icpResult" && list) {
        list = [...list];
        list[el.index] = el.value;
        wrote = true;
      }
    }
  }
  return wrote ? list : undefined;
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

// ──────────────── the list moving under a 20s LLM call ────────────────

describe("regenerateSingleIcpForUser — the persona list can move mid-flight", () => {
  const identified = () => FIVE.map((p, i) => persona(i, { id: `icp_stable_${i}` }));

  it("splices by persona id, not index, when a concurrent delete shifted the list", async () => {
    const before = seedUser({ icpResult: identified() });
    // While the LLM ran, /icp/delete-one removed icp_stable_0. The target the
    // user clicked (icp_stable_3) now sits at index 2. Splicing by the ORIGINAL
    // index 3 would overwrite icp_stable_4 — a different persona.
    const afterDelete = seedUser({
      icpResult: identified().filter((p: any) => p.id !== "icp_stable_0"),
    });
    userDb.getUserById.mockResolvedValueOnce(before).mockResolvedValue(afterDelete);

    await regenerateSingleIcpForUser("u1", 3, { llm: new FakeLlm({ icp: REGENERATED }) });

    const written = lastWrittenIcps()!;
    const target = written.find((p: any) => p.id === "icp_stable_3");
    expect(target.name).toBe(REGENERATED.name);
    // The neighbour it would have clobbered is untouched.
    expect(written.find((p: any) => p.id === "icp_stable_4").name).toBe("P4");
  });

  it("drops the result when the target persona was deleted mid-flight", async () => {
    const before = seedUser({ icpResult: identified() });
    const afterDelete = seedUser({
      icpResult: identified().filter((p: any) => p.id !== "icp_stable_3"),
    });
    userDb.getUserById.mockResolvedValueOnce(before).mockResolvedValue(afterDelete);
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await regenerateSingleIcpForUser("u1", 3, { llm: new FakeLlm({ icp: REGENERATED }) });

    // Nothing is written to the list: a whole-list write here could erase a
    // concurrent regeneration's slot, and there is no card left to save.
    expect(lastWrittenIcps()).toBeUndefined();
    expect(
      userDb.updateUser.mock.calls.some((c: any[]) => JSON.stringify(c).includes(REGENERATED.name)),
    ).toBe(false);
    // Status must still leave `running`, or the FE spins until it times out.
    const statuses = userDb.updateUser.mock.calls.map((c: any[]) => c[1]?.icpStatus);
    expect(statuses).toContain("ready");
    spy.mockRestore();
  });

  it("still persists the regenerated persona when a newer run already flipped the status", async () => {
    const before = seedUser({ icpResult: identified() });
    // A second regenerate-one finished first and set the record to `ready`, so
    // icpReadyPatch returns null. Dropping our result here loses the card the
    // user asked for and leaves its spinner stuck.
    const finished = seedUser({ icpResult: identified(), icpStatus: "ready" });
    userDb.getUserById.mockResolvedValueOnce(before).mockResolvedValue(finished);

    await regenerateSingleIcpForUser("u1", 1, { llm: new FakeLlm({ icp: REGENERATED }) });

    const written = lastWrittenIcps()!;
    expect(written.find((p: any) => p.id === "icp_stable_1").name).toBe(REGENERATED.name);
  });
});

// ─────────────── model omits a required field (ENG-2308 live finding) ───────────────
//
// Reproduced against the real model at ~1 in 3: it returns a persona without
// `meta_targeting_brief`, which the sanitiser rejects, failing the user's click.

describe("generateSingleIcpForUser — model drops a required field", () => {
  const { generateSingleIcpForUser } = require("../services/onboardingIcpService");
  const { name, pain, desire, objection } = REGENERATED as any;
  const missingBrief = { icp: { name, pain, desire, objection } };

  class SeqLlm {
    public calls = 0;
    constructor(private readonly seq: unknown[]) {}
    async generateJsonRobust<T = unknown>(): Promise<T> {
      return this.seq[Math.min(this.calls++, this.seq.length - 1)] as T;
    }
  }

  it("retries once and returns the complete persona", async () => {
    const llm = new SeqLlm([missingBrief, { icp: REGENERATED }]);
    const got = await generateSingleIcpForUser({}, FIVE[1], [FIVE[0]], { llm });
    expect(got.name).toBe(REGENERATED.name);
    expect(llm.calls).toBe(2);
  });

  it("still fails (after exactly one retry) when the model keeps omitting it", async () => {
    const llm = new SeqLlm([missingBrief, missingBrief, { icp: REGENERATED }]);
    await expect(generateSingleIcpForUser({}, FIVE[1], [FIVE[0]], { llm })).rejects.toThrow(
      "LLM returned no icp",
    );
    expect(llm.calls).toBe(2);
  });

  it("does not retry when the first answer is complete", async () => {
    const llm = new SeqLlm([{ icp: REGENERATED }]);
    await generateSingleIcpForUser({}, FIVE[1], [FIVE[0]], { llm });
    expect(llm.calls).toBe(1);
  });

  it("tells the model all five fields are required, including meta_targeting_brief", () => {
    expect(ICP_SINGLE_REGEN_SYSTEM_PROMPT).toMatch(/ALL FIVE fields are required/);
    expect(ICP_SINGLE_REGEN_SYSTEM_PROMPT).toMatch(/Never omit meta_targeting_brief/);
  });
});

// ─────────────── joined a full /icp/start run (ENG-2308 live finding) ───────────────
//
// The UI stops polling at the first terminal status. A regenerate that flipped
// the record to `ready` while the full run was still going hid that run's
// result until a reload.

describe("regenerateSingleIcpForUser — joined a full run (statusOwnedElsewhere)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("saves the card but writes no status while the full run is still running", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    userDb.updateUser.mockResolvedValue({});
    await regenerateSingleIcpForUser("u1", 1, { llm: new FakeLlm({ icp: REGENERATED }), statusOwnedElsewhere: true });

    // No call changes the status (the claim's owner settles it); the card is
    // saved by its slot, and the follow-up mirror/competitor writes still run.
    expect(userDb.updateUser.mock.calls.some((c: any[]) => c[1]?.icpStatus !== undefined)).toBe(false);
    const [, patch, opts] = userDb.updateUser.mock.calls[0];
    // No status, no whole list: just the one slot.
    expect(patch).toEqual({});
    expect(opts.elementSets).toHaveLength(1);
    expect(opts.elementSets[0]).toMatchObject({ path: ["icpResult"], index: 1 });
    expect(opts.elementSets[0].value.name).toBe(REGENERATED.name);
  });

  it("conditions the card save on the joined run still being in flight", async () => {
    const startedAt = "2026-04-24T11:59:00.000Z";
    userDb.getUserById.mockResolvedValue(
      seedUser({ icpStartedAt: startedAt, icpResult: FIVE.map((p, i) => ({ ...p, id: `icp_x_${i}` })) }),
    );
    userDb.updateUser.mockResolvedValue({});
    await regenerateSingleIcpForUser("u1", 1, { llm: new FakeLlm({ icp: REGENERATED }), statusOwnedElsewhere: true });
    const opts = userDb.updateUser.mock.calls[0][2];
    expect(opts.condition.expression).toBe(
      "#icpStatus = :icpDeferRunning AND #icpStartedAt = :icpDeferStartedAt AND #icpResult[1] = :icpCardNow",
    );
    expect(opts.condition.values).toEqual({
      ":icpCardNow": expect.objectContaining({ id: "icp_x_1" }),
      ":icpDeferRunning": "running",
      ":icpDeferStartedAt": startedAt,
    });
  });

  it("re-reads and retries (rather than dropping the card) when the joined claim ended before the write", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    userDb.updateUser
      .mockRejectedValueOnce(Object.assign(new Error("cond"), { code: "ConditionalCheckFailedException" }))
      .mockResolvedValue({});
    await expect(
      regenerateSingleIcpForUser("u1", 1, { llm: new FakeLlm({ icp: REGENERATED }), statusOwnedElsewhere: true }),
    ).resolves.toBeUndefined();
    const withCard = userDb.updateUser.mock.calls.filter((c: any[]) => c[2]?.elementSets?.length);
    expect(withCard).toHaveLength(2);
    expect(withCard[1][2].elementSets[0].value.name).toBe(REGENERATED.name);
  });

  it("does not mark the axis failed on an LLM miss while the full run is still running", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    userDb.updateUser.mockResolvedValue({});
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      regenerateSingleIcpForUser("u1", 1, { llm: new FakeLlm({ icp: { name: "x" } }), statusOwnedElsewhere: true }),
    ).rejects.toThrow("LLM returned no icp");
    expect(userDb.updateUser).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("behaves normally (flips to ready) when the full run has already finished", async () => {
    userDb.getUserById.mockResolvedValue(seedUser({ icpStatus: "ready" }));
    userDb.updateUser.mockResolvedValue({});
    await regenerateSingleIcpForUser("u1", 1, { llm: new FakeLlm({ icp: REGENERATED }), statusOwnedElsewhere: true });
    // Status already left `running`: the card is still saved, in its own slot.
    expect(userDb.updateUser.mock.calls[0][2].elementSets[0].value.name).toBe(REGENERATED.name);
    expect(lastWrittenIcps()![1].name).toBe(REGENERATED.name);
  });

  it("without the flag it still flips running -> ready as before", async () => {
    userDb.getUserById.mockResolvedValue(seedUser());
    userDb.updateUser.mockResolvedValue({});
    await regenerateSingleIcpForUser("u1", 1, { llm: new FakeLlm({ icp: REGENERATED }) });
    expect(userDb.updateUser.mock.calls.some((c: any[]) => c[1]?.icpStatus === "ready")).toBe(true);
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

    const compCall = userDb.updateUser.mock.calls.find((c: any[]) =>
      c[2]?.elementSets?.some((e: any) => e.path[0] === "competitorResult"),
    );
    expect(compCall).toBeDefined();
    const [, patch, opts] = compCall;
    // Only this persona's slot is written, so the other four entries cannot be
    // clobbered by (or clobber) a concurrent regeneration.
    expect(patch).toEqual({});
    expect(opts.elementSets).toHaveLength(1);
    expect(opts.elementSets[0]).toMatchObject({ path: ["competitorResult", "per_icp"], index: 2 });
    expect(opts.elementSets[0].value.icp_id).toBe(REGENERATED.name);
    // ...and only while the card in that slot is still the persona it was
    // generated for (keyed on the persona, not on the entry being replaced).
    expect(opts.condition.expression).toBe(
      "attribute_exists(#competitorResult.#perIcp[2]) AND #icpResult[2].#personaName = :personaName",
    );
    expect(opts.condition.values).toEqual({ ":personaName": REGENERATED.name });
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
