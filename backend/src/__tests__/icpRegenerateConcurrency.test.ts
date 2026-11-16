/**
 * ENG-2308: concurrent /icp/regenerate-one calls must not lose each other's card.
 *
 * Found live in production: regenerating two cards at the same moment sometimes
 * left one of them unchanged. Each regeneration re-read the user, then wrote the
 * WHOLE `icpResult` list back; two finishing together each wrote a list lacking
 * the other's card, and the last write won. The competitor entry and the
 * marketStrategy mirror had the same shape.
 *
 * These tests run the real service and the real `userDb.updateUser` against an
 * in-memory DynamoDB that evaluates the actual UpdateExpression and
 * ConditionExpression strings (see helpers/fakeDocClient.ts). Asserting the
 * arguments handed to a mocked `updateUser` could not have seen this defect: it
 * lives in what DynamoDB does with them.
 */

jest.mock("aws-sdk", () => {
  const { createFakeDocClient } = require("./helpers/fakeDocClient");
  const table = { row: {}, updates: [] as any[] };
  (global as any).__icpTable = table;
  const client = createFakeDocClient(table);
  // Only DynamoDB is faked; any other service (SecretsManager, S3, ...) is an
  // inert stub so modules that construct clients at import time still load.
  const inert = () => new Proxy({}, { get: () => jest.fn(() => ({ promise: async () => ({}) })) });
  const sdk: any = new Proxy(
    { DynamoDB: { DocumentClient: jest.fn(() => client) }, config: { update: jest.fn() } },
    { get: (target: any, key) => (key in target ? target[key] : jest.fn(inert)) },
  );
  sdk.default = sdk;
  return sdk;
});
jest.mock("../services/brandGuidelinesPopulation", () => ({
  populateEmptyBrandGuidelines: jest.fn().mockResolvedValue(undefined),
}));

import { regenerateSingleIcpForUser } from "../services/onboardingIcpService";
import type { FakeTable } from "./helpers/fakeDocClient";

const table = (): FakeTable => (global as any).__icpTable;

const persona = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `icp_${i}`,
  name: `Original ${i}`,
  pain: `pain ${i}`,
  desire: `desire ${i}`,
  objection: `objection ${i}`,
  meta_targeting_brief: `brief ${i}`,
  ...extra,
});
const fresh = (label: string) => ({
  name: `Regenerated ${label}`,
  pain: `new pain ${label}`,
  desire: `new desire ${label}`,
  objection: `new objection ${label}`,
  meta_targeting_brief: `new brief ${label}`,
});

function seed(overrides: Record<string, unknown> = {}) {
  const t = table();
  t.updates = [];
  t.beforeUpdate = undefined;
  t.row = {
    userId: "u1",
    email: "founder@acme.com",
    companyName: "Acme",
    productDomain: "https://acme.com",
    icpStatus: "running",
    icpStartedAt: "2026-10-09T10:00:00.000Z",
    icpResult: [0, 1, 2, 3, 4].map((i) => persona(i)),
    competitorResult: {
      per_icp: [0, 1, 2, 3, 4].map((i) => ({
        icp_id: `Original ${i}`,
        competitor_names: [`orig-comp-${i}`],
        offer_angles: [],
        meta_targeting_brief: "",
      })),
    },
    ...overrides,
  };
}

/** Resolves every pending LLM call together, so all regenerations proceed to their writes at once. */
function gatedLlm(byLabel: Record<string, ReturnType<typeof fresh>>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const llmFor = (label: string) => ({
    generateJsonRobust: async () => {
      await gate;
      return { icp: byLabel[label] };
    },
  });
  return { release, llmFor };
}

const deps = (llm: unknown) => ({
  llm: llm as any,
  loadStrategicContext: async () => null,
  competitor: {
    generateCompetitorStrategyForUser: async (_b: unknown, personas: any[]) => ({
      per_icp: [
        { icp_id: personas[0].name, competitor_names: [`new-comp-${personas[0].name}`], offer_angles: [], meta_targeting_brief: "" },
      ],
    }),
  },
});

const names = () => table().row.icpResult.map((p: any) => p.name);

/** True for any write to the persona list, whether it replaces the list or one slot of it. */
const writesIcpList = (params: any) => Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult");

describe("concurrent regenerate-one", () => {
  beforeEach(() => seed());

  it("keeps BOTH cards when two different cards finish at the same moment", async () => {
    // Worst case: both regenerations have read the list before either has written.
    let arrivals = 0;
    let both!: () => void;
    const bothArrived = new Promise<void>((r) => (both = r));
    table().beforeUpdate = async (params) => {
      if (!writesIcpList(params)) return;
      if (++arrivals === 2) both();
      if (arrivals <= 2) await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 250))]);
    };
    const { release, llmFor } = gatedLlm({ a: fresh("A"), b: fresh("B") });

    const runs = Promise.all([
      regenerateSingleIcpForUser("u1", 1, deps(llmFor("a"))),
      regenerateSingleIcpForUser("u1", 3, deps(llmFor("b"))),
    ]);
    setTimeout(release, 20);
    await runs;

    expect(names()).toEqual(["Original 0", "Regenerated A", "Original 2", "Regenerated B", "Original 4"]);
    expect(table().row.icpStatus).toBe("ready");
  });

  it("keeps both competitor entries and mirrors the final list to marketStrategy", async () => {
    const { release, llmFor } = gatedLlm({ a: fresh("A"), b: fresh("B") });
    const runs = Promise.all([
      regenerateSingleIcpForUser("u1", 0, deps(llmFor("a"))),
      regenerateSingleIcpForUser("u1", 4, deps(llmFor("b"))),
    ]);
    setTimeout(release, 20);
    await runs;

    const per = table().row.competitorResult.per_icp;
    expect(per.map((e: any) => e.icp_id)).toEqual([
      "Regenerated A",
      "Original 1",
      "Original 2",
      "Original 3",
      "Regenerated B",
    ]);
    expect(table().row.marketStrategy.icp.map((i: any) => i.title)).toEqual(
      table().row.icpResult.map((p: any) => p.name),
    );
  });

  it("lands the card in the right slot when a concurrent delete shifted the list mid-flight", async () => {
    // Between this regeneration's read and its write, another request deletes card 0.
    let deleted = false;
    table().beforeUpdate = (params, t) => {
      if (!deleted && writesIcpList(params)) {
        deleted = true;
        t.row = { ...t.row, icpResult: t.row.icpResult.filter((p: any) => p.id !== "icp_0") };
      }
    };
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 3, deps(llmFor("a")));
    setTimeout(release, 5);
    await run;

    // The slot index it first computed (3) now holds old card 4; the id condition
    // must refuse that write, and the retry must find the card at index 2.
    expect(names()).toEqual(["Original 1", "Original 2", "Regenerated A", "Original 4"]);
  });

  it("never appends when the slot it read is gone from the end of the list", async () => {
    // DynamoDB appends on SET list[n] with n past the end; the condition must stop that.
    table().beforeUpdate = (params, t) => {
      if (writesIcpList(params) && t.row.icpResult.length === 5) {
        t.row = { ...t.row, icpResult: t.row.icpResult.slice(0, 4) };
      }
    };
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 4, deps(llmFor("a")));
    setTimeout(release, 5);
    await run;

    // Card 4 was removed: nothing is appended and the status still leaves `running`.
    expect(table().row.icpResult).toHaveLength(4);
    expect(names().every((n: string) => n.startsWith("Original"))).toBe(true);
    expect(table().row.icpStatus).toBe("ready");
  });

  it("saves a persona that predates stable ids (existence-only slot check)", async () => {
    seed({ icpResult: [0, 1, 2].map((i) => ({ ...persona(i), id: undefined })) });
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 1, deps(llmFor("a")));
    setTimeout(release, 5);
    await run;
    expect(names()).toEqual(["Original 0", "Regenerated A", "Original 2"]);
  });
});

describe("competitor entry follows the latest persona of its card", () => {
  beforeEach(() => seed());

  it("a card regenerated twice ends with the entry for its second persona", async () => {
    for (const label of ["first", "second"]) {
      const { release, llmFor } = gatedLlm({ a: fresh(label) });
      const run = regenerateSingleIcpForUser("u1", 2, deps(llmFor("a")));
      setTimeout(release, 5);
      await run;
    }
    expect(names()[2]).toBe("Regenerated second");
    expect(table().row.competitorResult.per_icp[2].icp_id).toBe("Regenerated second");
  });

  it("drops a refresh whose card was regenerated again in the meantime, leaving the entry untouched", async () => {
    // While the first regeneration's competitor entry is being written, the card
    // is regenerated again: its persona name no longer matches what the entry
    // was generated for.
    table().beforeUpdate = (params, t) => {
      if (Object.values(params.ExpressionAttributeNames ?? {}).includes("competitorResult")) {
        const list = [...t.row.icpResult];
        list[2] = { ...list[2], name: "Regenerated again" };
        t.row = { ...t.row, icpResult: list };
        t.beforeUpdate = undefined;
      }
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { release, llmFor } = gatedLlm({ a: fresh("first") });
    const run = regenerateSingleIcpForUser("u1", 2, deps(llmFor("a")));
    setTimeout(release, 5);
    await run;
    warn.mockRestore();

    expect(table().row.competitorResult.per_icp[2].icp_id).toBe("Original 2");
  });
});

describe("regenerate-one edge cases found in review", () => {
  beforeEach(() => seed());

  it("a failing mirror re-check does not turn a saved card into a failed run", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    let reads = 0;
    // Fail every read made AFTER the slot write has landed.
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const svc = require("../services/onboardingIcpService");
    const db = require("../services/db").userDb;
    const realById = db.getUserById.bind(db);
    const realConsistent = db.getUserByEmailConsistent?.bind(db);
    let slotWritten = false;
    table().beforeUpdate = (params) => {
      if (writesIcpList(params)) slotWritten = true;
    };
    db.getUserById = async (id: string) => {
      if (slotWritten && ++reads > 1) throw new Error("throttled");
      return realById(id);
    };
    if (realConsistent) {
      db.getUserByEmailConsistent = async (e: string) => {
        if (slotWritten) throw new Error("throttled");
        return realConsistent(e);
      };
    }
    try {
      const run = svc.regenerateSingleIcpForUser("u1", 1, deps(llmFor("a")));
      setTimeout(release, 5);
      await expect(run).resolves.toBeUndefined();
    } finally {
      db.getUserById = realById;
      if (realConsistent) db.getUserByEmailConsistent = realConsistent;
      err.mockRestore();
    }
    expect(names()[1]).toBe("Regenerated A");
    expect(table().row.icpStatus).toBe("ready");
  });

  it("a card deleted mid-flight leaves the list untouched and only settles the status", async () => {
    table().beforeUpdate = (params, t) => {
      // First write attempt: the card is deleted just before it lands.
      if (writesIcpList(params) && t.row.icpResult.some((p: any) => p.id === "icp_2")) {
        t.row = { ...t.row, icpResult: t.row.icpResult.filter((p: any) => p.id !== "icp_2") };
      }
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 2, deps(llmFor("a")));
    setTimeout(release, 5);
    await run;
    warn.mockRestore();
    expect(names()).toEqual(["Original 0", "Original 1", "Original 3", "Original 4"]);
    expect(table().row.icpStatus).toBe("ready");
  });

  it("a card deleted while joined to a full run leaves the status to that run", async () => {
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 2, { ...deps(llmFor("a")), statusOwnedElsewhere: true });
    // Deleted while the LLM call is in flight, i.e. before the regeneration re-reads.
    setTimeout(() => {
      table().row = { ...table().row, icpResult: table().row.icpResult.filter((p: any) => p.id !== "icp_2") };
      release();
    }, 5);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await run;
    warn.mockRestore();
    expect(names()).toEqual(["Original 0", "Original 1", "Original 3", "Original 4"]);
    expect(table().row.icpStatus).toBe("running");
    expect(table().row.icpStartedAt).toBe("2026-10-09T10:00:00.000Z");
  });
});

describe("a regeneration that joined another card's claim", () => {
  beforeEach(() => seed());

  // Review finding: card B's click lands ~50ms after card A's, so B joins A's
  // claim and leaves the status to it. When B's write lands FIRST, B used to
  // return early and never refresh its competitor entry (A's cascade does not
  // cover B), leaving per_icp[B] describing B's previous persona.
  it("still refreshes its competitor entry and the mirror when its card lands before the claim owner finishes", async () => {
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    const llmA = { generateJsonRobust: async () => { await gateB; await new Promise((r) => setTimeout(r, 80)); return { icp: fresh("A") }; } };
    const llmB = { generateJsonRobust: async () => { await gateB; return { icp: fresh("B") }; } };

    const a = regenerateSingleIcpForUser("u1", 0, deps(llmA));
    const b = regenerateSingleIcpForUser("u1", 2, { ...deps(llmB), statusOwnedElsewhere: true });
    setTimeout(releaseB, 5);
    await Promise.all([a, b]);

    expect(names()).toEqual(["Regenerated A", "Original 1", "Regenerated B", "Original 3", "Original 4"]);
    expect(table().row.competitorResult.per_icp.map((e: any) => e.icp_id)).toEqual([
      "Regenerated A", "Original 1", "Regenerated B", "Original 3", "Original 4",
    ]);
    expect(table().row.marketStrategy.icp.map((i: any) => i.title)).toEqual(names());
    expect(table().row.icpStatus).toBe("ready");
  });
});

describe("regenerate-one that joined a full /icp/start run", () => {
  it("saves only its card and leaves the status to the full run", async () => {
    seed();
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 2, { ...deps(llmFor("a")), statusOwnedElsewhere: true });
    setTimeout(release, 5);
    await run;

    expect(names()[2]).toBe("Regenerated A");
    expect(table().row.icpStatus).toBe("running");
    expect(table().row.icpStartedAt).toBe("2026-10-09T10:00:00.000Z");
  });

  it("leaves a full run's set intact when that run landed first and replaced the cards", async () => {
    seed();
    // A full run mints new ids for the cards it generates.
    const landed = [0, 1, 2, 3, 4].map((i) => persona(i, { id: `full_${i}`, name: `Full run ${i}` }));
    table().beforeUpdate = (_p, t) => {
      t.row = { ...t.row, icpStatus: "ready", icpResult: landed };
      t.beforeUpdate = undefined;
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 2, { ...deps(llmFor("a")), statusOwnedElsewhere: true });
    setTimeout(release, 5);
    await run;
    warn.mockRestore();

    expect(names()).toEqual(landed.map((p) => p.name));
  });

  // Found by driving the real UI: the second click lands ~50ms after the first,
  // so the second request sees the first's fresh claim, mistakes it for a full
  // run and defers. The "run" then finishes first -- but it was another card's
  // regeneration, so this card must still be saved.
  it("still saves its card when the claim it joined was another card's regeneration that finished first", async () => {
    seed();
    table().beforeUpdate = (_p, t) => {
      // Card 0's regeneration completes between this one's read and its write.
      const list = [...t.row.icpResult];
      list[0] = { ...list[0], name: "Regenerated card 0" };
      t.row = { ...t.row, icpStatus: "ready", icpResult: list };
      t.beforeUpdate = undefined;
    };
    const { release, llmFor } = gatedLlm({ a: fresh("A") });
    const run = regenerateSingleIcpForUser("u1", 2, { ...deps(llmFor("a")), statusOwnedElsewhere: true });
    setTimeout(release, 5);
    await run;

    expect(names()).toEqual(["Regenerated card 0", "Original 1", "Regenerated A", "Original 3", "Original 4"]);
    expect(table().row.icpStatus).toBe("ready");
  });
});
