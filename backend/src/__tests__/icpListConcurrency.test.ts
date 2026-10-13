/**
 * Concurrent /icp/edit-one, /icp/delete-one and /icp/regenerate-one must not lose
 * each other's change.
 *
 * Both routes read the persona list, changed it in memory and wrote the WHOLE list
 * back, so two writers that read the same list each stored a list lacking the
 * other's change: two deletes in flight left one card behind, two edits to
 * different fields of one card kept only the last, and a regeneration that
 * finished after the user's edit replaced their words with the model's.
 *
 * These run the real routes, the real service and the real `userDb.updateUser`
 * against an in-memory DynamoDB that evaluates the actual Update/Condition
 * expressions (helpers/fakeDocClient.ts), and force the interleaving with a
 * barrier so both writers have read the same list before either writes.
 */

jest.mock("aws-sdk", () => {
  const { createFakeDocClient } = require("./helpers/fakeDocClient");
  const table = { row: {}, updates: [] as any[] };
  (global as any).__icpListTable = table;
  const client = createFakeDocClient(table);
  const inert = () => new Proxy({}, { get: () => jest.fn(() => ({ promise: async () => ({}) })) });
  const sdk: any = new Proxy(
    { DynamoDB: { DocumentClient: jest.fn(() => client) }, config: { update: jest.fn() } },
    { get: (target: any, key) => (key in target ? target[key] : jest.fn(inert)) },
  );
  sdk.default = sdk;
  return sdk;
});
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "u1", email: "founder@acme.com", isAdmin: false };
    next();
  },
}));
jest.mock("../services/brandGuidelinesPopulation", () => ({
  populateEmptyBrandGuidelines: jest.fn().mockResolvedValue(undefined),
}));

import express from "express";
import request from "supertest";
import onboardingStepsRoutes from "../routes/onboardingSteps";
import { casUpdateIcpList, casUpdateIcpListUnqueued, regenerateSingleIcpForUser } from "../services/onboardingIcpService";
import type { FakeTable } from "./helpers/fakeDocClient";

const app = express();
app.use(express.json());
app.use("/api/onboarding", onboardingStepsRoutes);

const table = (): FakeTable => (global as any).__icpListTable;

const persona = (i: number) => ({
  id: `icp_${i}`,
  name: `Original ${i}`,
  pain: `pain ${i}`,
  desire: `desire ${i}`,
  objection: `objection ${i}`,
  meta_targeting_brief: `brief ${i}`,
});

function seed(overrides: Record<string, unknown> = {}) {
  const t = table();
  t.updates = [];
  t.beforeUpdate = undefined;
  t.indexRow = null;
  t.row = {
    userId: "u1",
    email: "founder@acme.com",
    companyName: "Acme",
    productDomain: "https://acme.com",
    icpStatus: "ready",
    icpStartedAt: "2026-10-09T10:00:00.000Z",
    icpResult: [0, 1, 2, 3, 4].map(persona),
    ...overrides,
  };
}

/** Holds the first `n` writes to the persona list until all `n` have arrived, so each was computed from the same read. */
function holdUntilBothRead(n = 2) {
  let arrived = 0;
  let all!: () => void;
  const everyoneArrived = new Promise<void>((r) => (all = r));
  table().beforeUpdate = async (params) => {
    if (!Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) return;
    if (++arrived === n) all();
    if (arrived <= n) await Promise.race([everyoneArrived, new Promise((r) => setTimeout(r, 300))]);
  };
}

const ids = () => (table().row.icpResult as any[]).map((p) => p.id);
const post = (path: string, body: unknown) => request(app).post(`/api/onboarding/icp/${path}`).send(body as object);

beforeEach(() => {
  seed();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("concurrent delete-one", () => {
  it("removes BOTH cards when two deletes read the same list", async () => {
    holdUntilBothRead();
    const [a, b] = await Promise.all([post("delete-one", { icpId: "icp_1" }), post("delete-one", { icpId: "icp_3" })]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(ids()).toEqual(["icp_0", "icp_2", "icp_4"]);
  });

  it("answers 404 for a card a concurrent delete already removed, and leaves the list alone", async () => {
    const first = await post("delete-one", { icpId: "icp_2" });
    const again = await post("delete-one", { icpId: "icp_2" });

    expect(first.status).toBe(200);
    expect(again.status).toBe(404);
    expect(ids()).toEqual(["icp_0", "icp_1", "icp_3", "icp_4"]);
  });
});

describe("concurrent edit-one", () => {
  it("applies edits to two different cards", async () => {
    holdUntilBothRead();
    const [a, b] = await Promise.all([
      post("edit-one", { icpId: "icp_2", patch: { name: "EDIT A" } }),
      post("edit-one", { icpId: "icp_3", patch: { name: "EDIT B" } }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const list = table().row.icpResult;
    expect(list[2].name).toBe("EDIT A");
    expect(list[3].name).toBe("EDIT B");
  });

  it("applies edits to two different fields of the SAME card and anchors both", async () => {
    holdUntilBothRead();
    await Promise.all([
      post("edit-one", { icpId: "icp_4", patch: { name: "NAME X" } }),
      post("edit-one", { icpId: "icp_4", patch: { pain: "PAIN Y" } }),
    ]);

    const card = table().row.icpResult[4];
    expect(card.name).toBe("NAME X");
    expect(card.pain).toBe("PAIN Y");
    expect(card.userIntent).toEqual({ name: "NAME X", pain: "PAIN Y" });
  });

  it("keeps an edit and a delete of different cards together", async () => {
    holdUntilBothRead();
    await Promise.all([post("edit-one", { icpId: "icp_0", patch: { name: "KEPT EDIT" } }), post("delete-one", { icpId: "icp_3" })]);

    expect(ids()).toEqual(["icp_0", "icp_1", "icp_2", "icp_4"]);
    expect(table().row.icpResult[0].name).toBe("KEPT EDIT");
  });

  it("serves the edit from a fresh read when the UserIdIndex still shows the list from before the last write", async () => {
    const before = JSON.parse(JSON.stringify(table().row));
    await post("delete-one", { icpId: "icp_1" });
    table().indexRow = before; // the index has not caught up with the delete
    const res = await post("edit-one", { icpId: "icp_2", patch: { name: "AFTER DELETE" } });

    expect(res.status).toBe(200);
    expect(ids()).toEqual(["icp_0", "icp_2", "icp_3", "icp_4"]);
    expect(table().row.icpResult[1].name).toBe("AFTER DELETE");
  });
});

describe("many writers at once on one instance", () => {
  it("applies all 20 simultaneous edits (5 cards x 4 fields) without lost updates or the unconditional fallback", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    // A real write takes milliseconds; without that every writer wins its turn.
    let inFlight = 0;
    let maxInFlight = 0;
    table().beforeUpdate = async (params) => {
      if (!Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) return;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 8));
      inFlight -= 1;
    };
    const fields = ["name", "pain", "desire", "objection"] as const;
    const jobs = [0, 1, 2, 3, 4].flatMap((i) => fields.map((f) => ({ id: `icp_${i}`, f, v: `${f}-${i}-new` })));
    const results = await Promise.all(jobs.map((j) => post("edit-one", { icpId: j.id, patch: { [j.f]: j.v } })));

    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const j of jobs) {
      const card = table().row.icpResult.find((p: any) => p.id === j.id);
      expect(card[j.f]).toBe(j.v);
    }
    expect(warn.mock.calls.some((c) => String(c[0]).includes("without the compare-and-swap"))).toBe(false);
    // They were queued, not raced: never more than one list write in flight.
    expect(maxInFlight).toBe(1);
  });

  it("removes exactly the cards asked for when four deletes arrive together", async () => {
    const results = await Promise.all([0, 1, 2, 3].map((i) => post("delete-one", { icpId: `icp_${i}` })));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(ids()).toEqual(["icp_4"]);
  });

  it("does not let a failed write wedge the writes queued behind it", async () => {
    let fail = true;
    table().beforeUpdate = async (params) => {
      if (fail && Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) {
        fail = false;
        // Slow enough that the second request is already queued behind this one.
        await new Promise((r) => setTimeout(r, 60));
        throw Object.assign(new Error("dynamo unavailable"), { code: "InternalServerError" });
      }
    };
    const [first, second] = await Promise.all([
      post("delete-one", { icpId: "icp_0" }),
      post("delete-one", { icpId: "icp_1" }),
    ]);

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(ids()).toEqual(["icp_0", "icp_2", "icp_3", "icp_4"]);
  });
});

describe("two instances (compare-and-swap, no shared queue)", () => {
  it("both land when two deletes read the same list", async () => {
    holdUntilBothRead();
    const del = (id: string) => casUpdateIcpListUnqueued("u1", (list) => ({ next: list.filter((p) => p.id !== id), result: null }));
    await Promise.all([del("icp_1"), del("icp_3")]);

    expect(ids()).toEqual(["icp_0", "icp_2", "icp_4"]);
    // The loser really lost the condition once and recomputed.
    expect(table().updates.length).toBeGreaterThan(2);
  });

  it("an edit and a delete of different cards both land", async () => {
    holdUntilBothRead();
    await Promise.all([
      casUpdateIcpListUnqueued("u1", (list) => ({ next: list.map((p) => (p.id === "icp_0" ? { ...p, name: "KEPT" } : p)), result: null })),
      casUpdateIcpListUnqueued("u1", (list) => ({ next: list.filter((p) => p.id !== "icp_3"), result: null })),
    ]);

    expect(ids()).toEqual(["icp_0", "icp_1", "icp_2", "icp_4"]);
    expect(table().row.icpResult[0].name).toBe("KEPT");
  });
});

describe("casUpdateIcpList", () => {
  it("still applies the change, from the freshest read, when the compare-and-swap never wins", async () => {
    // Every conditional write loses: the list changes between each read and write
    // (equivalently, the stored list never reads back equal to what was compared).
    let churn = 0;
    table().beforeUpdate = async (params, t) => {
      if (!Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) return;
      if (!params.ConditionExpression) return; // the final, unconditional write
      churn += 1;
      const list = t.row.icpResult.map((p: any, i: number) => (i === 4 ? { ...p, pain: `churn ${churn}` } : p));
      t.row = { ...t.row, icpResult: list };
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post("delete-one", { icpId: "icp_0" });

    // The user's delete is not lost to a 409 they cannot act on...
    expect(res.status).toBe(200);
    expect(ids()).toEqual(["icp_1", "icp_2", "icp_3", "icp_4"]);
    // ...it was computed from the latest list, so the concurrent change survives too...
    expect(table().row.icpResult[3].pain).toBe(`churn ${churn}`);
    // ...and the fallback is visible in the logs.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("without the compare-and-swap"))).toBe(true);
  });

  it("applies an edit the same way", async () => {
    table().beforeUpdate = async (params, t) => {
      if (!params.ConditionExpression) return;
      t.row = { ...t.row, icpResult: t.row.icpResult.map((p: any, i: number) => (i === 4 ? { ...p, pain: `churn ${Math.random()}` } : p)) };
    };
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post("edit-one", { icpId: "icp_2", patch: { name: "STILL APPLIED" } });

    expect(res.status).toBe(200);
    expect(table().row.icpResult[2].name).toBe("STILL APPLIED");
    expect(table().row.icpResult[2].userIntent).toEqual({ name: "STILL APPLIED" });
  });

  it("does not take the unconditional path when the first attempt wins", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await casUpdateIcpList("u1", (list) => ({ next: list.slice(1), result: null }));

    expect(warn.mock.calls.some((c) => String(c[0]).includes("without the compare-and-swap"))).toBe(false);
    expect(table().updates.every((u: any) => Boolean(u.ConditionExpression))).toBe(true);
  });
});

describe("edit made while the card is being regenerated", () => {
  const regenDeps = (llm: unknown) => ({
    llm: llm as any,
    loadStrategicContext: async () => null,
    competitor: {
      generateCompetitorStrategyForUser: async (_b: unknown, personas: any[]) => ({
        per_icp: [{ icp_id: personas[0].name, competitor_names: ["c"], offer_angles: [], meta_targeting_brief: "" }],
      }),
    },
  });
  const modelOutput = {
    name: "MODEL NAME",
    pain: "MODEL PAIN",
    desire: "MODEL DESIRE",
    objection: "MODEL OBJECTION",
    meta_targeting_brief: "MODEL BRIEF",
  };

  it("keeps the user's words and still regenerates the fields they did not touch", async () => {
    // The user edits the card while the model is still thinking.
    const llm = {
      generateJsonRobust: async () => {
        const edited = await post("edit-one", { icpId: "icp_0", patch: { name: "MY OWN NAME" } });
        expect(edited.status).toBe(200);
        return { icp: modelOutput };
      },
    };
    await regenerateSingleIcpForUser("u1", 0, regenDeps(llm));

    const card = table().row.icpResult[0];
    expect(card.name).toBe("MY OWN NAME");
    expect(card.pain).toBe("MODEL PAIN");
    expect(card.userIntent).toEqual({ name: "MY OWN NAME" });
    expect(card.id).toBe("icp_0");
  });

  it("re-anchors and retries when the edit lands between the card read and the card write", async () => {
    // The race the whole-card condition exists for: the model has returned and the
    // write is about to go out when the user's edit is stored. An id-only slot
    // check lets the model's text overwrite it; the whole-card check fails the
    // write and the retry re-anchors from the edited card.
    let injected = false;
    table().beforeUpdate = async (params, t) => {
      const touchesCard = Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult") && /icpCardNow/.test(params.ConditionExpression ?? "");
      if (!touchesCard || injected) return;
      injected = true;
      t.row = {
        ...t.row,
        icpResult: t.row.icpResult.map((p: any, i: number) =>
          i === 0 ? { ...p, name: "LATE USER EDIT", userIntent: { name: "LATE USER EDIT" } } : p,
        ),
      };
    };
    const llm = { generateJsonRobust: async () => ({ icp: modelOutput }) };
    await regenerateSingleIcpForUser("u1", 0, regenDeps(llm));

    expect(injected).toBe(true);
    const card = table().row.icpResult[0];
    expect(card.name).toBe("LATE USER EDIT");
    expect(card.pain).toBe("MODEL PAIN");
    expect(card.userIntent).toEqual({ name: "LATE USER EDIT" });
  });
});
