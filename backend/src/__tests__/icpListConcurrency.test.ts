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
import { regenerateSingleIcpForUser } from "../services/onboardingIcpService";
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

const listWrites = () =>
  table().updates.filter((u: any) => Object.values(u.ExpressionAttributeNames ?? {}).includes("icpResult"));

describe("per-card writes", () => {
  it("applies all 20 simultaneous edits (5 cards x 4 fields) with no lost update, no 409 and no retry exhaustion", async () => {
    // A real write takes milliseconds; without that every writer wins its turn.
    table().beforeUpdate = async (params) => {
      if (Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) await new Promise((r) => setTimeout(r, 8));
    };
    const fields = ["name", "pain", "desire", "objection"] as const;
    const jobs = [0, 1, 2, 3, 4].flatMap((i) => fields.map((f) => ({ id: `icp_${i}`, f, v: `${f}-${i}-new` })));
    const results = await Promise.all(jobs.map((j) => post("edit-one", { icpId: j.id, patch: { [j.f]: j.v } })));

    expect(results.map((r) => r.status)).toEqual(jobs.map(() => 200));
    for (const j of jobs) {
      const card = table().row.icpResult.find((p: any) => p.id === j.id);
      expect(card[j.f]).toBe(j.v);
      expect(card.userIntent[j.f]).toBe(j.v);
    }
  });

  it("never rewrites the whole list: every write is a path update on one card", async () => {
    await Promise.all([
      post("edit-one", { icpId: "icp_1", patch: { name: "A" } }),
      post("edit-one", { icpId: "icp_2", patch: { pain: "B" } }),
      post("delete-one", { icpId: "icp_4" }),
    ]);

    expect(listWrites().length).toBeGreaterThan(0);
    for (const u of listWrites()) {
      // Every assignment and removal must target INSIDE the list (`#x[2]...`), never the bare list attribute.
      const setPart = String(u.UpdateExpression).replace(/^SET\s+/, "").split(/\s+REMOVE\s+/)[0];
      const removePart = String(u.UpdateExpression).includes(" REMOVE ") ? String(u.UpdateExpression).split(/\s+REMOVE\s+/)[1] : "";
      const targets = [...setPart.split(","), ...removePart.split(",")]
        .map((x) => x.trim().split("=")[0].trim())
        .filter(Boolean);
      for (const t of targets) {
        const bare = !t.includes("[") && !t.includes(".");
        expect(bare && u.ExpressionAttributeNames[t] === "icpResult").toBe(false);
      }
    }
  });

  it("removes exactly the cards asked for when four deletes arrive together", async () => {
    table().beforeUpdate = async (params) => {
      if (Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) await new Promise((r) => setTimeout(r, 8));
    };
    const results = await Promise.all([0, 1, 2, 3].map((i) => post("delete-one", { icpId: `icp_${i}` })));

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(ids()).toEqual(["icp_4"]);
  });

  it("a delete that shifts the list makes a concurrent write on a later card recompute its position", async () => {
    holdUntilBothRead();
    const [del, edit] = await Promise.all([
      post("delete-one", { icpId: "icp_0" }),
      post("edit-one", { icpId: "icp_3", patch: { name: "STILL THE RIGHT CARD" } }),
    ]);

    expect([del.status, edit.status]).toEqual([200, 200]);
    expect(ids()).toEqual(["icp_1", "icp_2", "icp_3", "icp_4"]);
    expect(table().row.icpResult.find((p: any) => p.id === "icp_3").name).toBe("STILL THE RIGHT CARD");
    // Nothing else was touched.
    expect(table().row.icpResult.find((p: any) => p.id === "icp_4").name).toBe("Original 4");
  });

  it("returns the updated list in the response", async () => {
    const res = await post("edit-one", { icpId: "icp_2", patch: { name: "FROM RESPONSE" } });
    expect(res.body.icpResult.map((p: any) => p.id)).toEqual(["icp_0", "icp_1", "icp_2", "icp_3", "icp_4"]);
    expect(res.body.icpResult[2].name).toBe("FROM RESPONSE");
    const del = await post("delete-one", { icpId: "icp_0" });
    expect(del.body.icpResult.map((p: any) => p.id)).toEqual(["icp_1", "icp_2", "icp_3", "icp_4"]);
  });

  it("answers 409, and changes nothing, when the list keeps shifting under the write", async () => {
    // Every attempt: another writer rotates the list just before this write lands.
    table().beforeUpdate = async (params, t) => {
      if (!Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) return;
      const [first, ...rest] = t.row.icpResult;
      t.row = { ...t.row, icpResult: [...rest, first] };
    };
    const res = await post("delete-one", { icpId: "icp_2" });

    expect(res.status).toBe(409);
    expect([...ids()].sort()).toEqual(["icp_0", "icp_1", "icp_2", "icp_3", "icp_4"]);
  });

  it("does not wedge other users' writes, or later ones, after a write fails", async () => {
    let fail = true;
    table().beforeUpdate = async (params) => {
      if (fail && Object.values(params.ExpressionAttributeNames ?? {}).includes("icpResult")) {
        fail = false;
        throw Object.assign(new Error("dynamo unavailable"), { code: "InternalServerError" });
      }
    };
    const first = await post("delete-one", { icpId: "icp_0" });
    const second = await post("delete-one", { icpId: "icp_1" });

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(ids()).toEqual(["icp_0", "icp_2", "icp_3", "icp_4"]);
  });
});

describe("persona data that a whole-list comparison would trip over", () => {
  const legacy = (i: number) => ({ name: `Legacy ${i}`, pain: `p${i}`, desire: `d${i}`, objection: `o${i}`, meta_targeting_brief: `b${i}` });
  const odd = {
    ...persona(1),
    emptyString: "",
    float: 0.1 + 0.2,
    big: 12345678901234567890,
    nested: { a: [1, "two", { three: 3 }], z: null },
    unicode: "caf\u00e9 \ud83d\ude80",
    extraField: "kept",
  };

  // A positional ref (`icp-2`) names whatever is at position 2 NOW. A retry after a
  // concurrent delete must still act on the card the user clicked, not on whichever
  // card has slid into that position.
  it.each([
    ["the shifting delete lands first", ["icp-0", "icp-2"]],
    ["the shifting delete lands second", ["icp-2", "icp-0"]],
  ])("a retried positional delete still removes the card that was clicked (%s)", async (_label, order) => {
    seed({ icpResult: [legacy(0), legacy(1), legacy(2), legacy(3), legacy(4)] });
    holdUntilBothRead();
    const results = await Promise.all(order.map((icpId) => post("delete-one", { icpId })));

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    // Legacy 0 and Legacy 2 were clicked; 1, 3 and 4 survive whatever the order.
    expect(table().row.icpResult.map((p: any) => p.name)).toEqual(["Legacy 1", "Legacy 3", "Legacy 4"]);
  });

  it("a retried positional edit still lands on the card that was clicked", async () => {
    seed({ icpResult: [legacy(0), legacy(1), legacy(2), legacy(3)] });
    holdUntilBothRead();
    const [del, edit] = await Promise.all([
      post("delete-one", { icpId: "icp-0" }),
      post("edit-one", { icpId: "icp-2", patch: { pain: "EDITED L2" } }),
    ]);

    expect([del.status, edit.status]).toEqual([200, 200]);
    const byName = Object.fromEntries(table().row.icpResult.map((p: any) => [p.name, p]));
    expect(byName["Legacy 2"].pain).toBe("EDITED L2");
    expect(byName["Legacy 3"].pain).toBe("p3");
  });

  it("answers 404, and changes nothing, when a clicked card with an id was removed before the retry", async () => {
    seed({ icpResult: [persona(0), persona(1), persona(2)] });
    holdUntilBothRead();
    const results = await Promise.all([post("delete-one", { icpId: "icp_1" }), post("delete-one", { icpId: "icp_1" })]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(table().row.icpResult.map((p: any) => p.id)).toEqual(["icp_0", "icp_2"]);
  });

  it("answers 404 (refresh, no retry that could hit another card) when a clicked id-less card is already gone", async () => {
    seed({ icpResult: [legacy(0), legacy(1), legacy(2)] });
    holdUntilBothRead();
    const results = await Promise.all([post("delete-one", { icpId: "icp-1" }), post("delete-one", { icpId: "icp-1" })]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(table().row.icpResult.map((p: any) => p.name)).toEqual(["Legacy 0", "Legacy 2"]);
  });

  it("lands both edits when a concurrent edit renames the id-less card the other was matched on", async () => {
    seed({ icpResult: [legacy(0), legacy(1)] });
    holdUntilBothRead();
    const results = await Promise.all([
      post("edit-one", { icpId: "icp-0", patch: { name: "Renamed" } }),
      post("edit-one", { icpId: "icp-0", patch: { pain: "NEW PAIN" } }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(table().row.icpResult[0]).toMatchObject({ name: "Renamed", pain: "NEW PAIN" });
    expect(table().row.icpResult[1].name).toBe("Legacy 1");
  });

  it("lands both edits to different fields of one id-less card", async () => {
    seed({ icpResult: [legacy(0), legacy(1)] });
    holdUntilBothRead();
    const results = await Promise.all([
      post("edit-one", { icpId: "icp-0", patch: { pain: "P-NEW" } }),
      post("edit-one", { icpId: "icp-0", patch: { desire: "D-NEW" } }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(table().row.icpResult[0]).toMatchObject({ pain: "P-NEW", desire: "D-NEW" });
    expect(table().row.icpResult[0].userIntent).toEqual({ pain: "P-NEW", desire: "D-NEW" });
  });

  it("edits an id-less card whose fields hold lists or maps", async () => {
    seed({ icpResult: [{ ...legacy(0), desire: ["a", "b"], objection: { k: "v" } }, legacy(1)] });
    holdUntilBothRead();
    const results = await Promise.all([
      post("edit-one", { icpId: "icp-0", patch: { name: "N1" } }),
      post("edit-one", { icpId: "icp-0", patch: { pain: "P1" } }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(table().row.icpResult[0]).toMatchObject({ name: "N1", pain: "P1", desire: ["a", "b"] });
  });

  it.each([
    ["the shifting delete lands first", ["icp-0", "icp-1"]],
    ["the shifting delete lands second", ["icp-1", "icp-0"]],
  ])("never deletes the other card that shares the clicked id-less card's name (%s)", async (_label, order) => {
    seed({ icpResult: [legacy(0), { ...legacy(1), name: "Same name" }, { ...legacy(2), name: "Same name" }, legacy(3)] });
    holdUntilBothRead();
    const results = await Promise.all(order.map((icpId) => post("delete-one", { icpId })));

    for (const r of results) expect([200, 409]).toContain(r.status);
    const left = table().row.icpResult.map((p: any) => `${p.name}:${p.pain}`);
    // icp-1 is the FIRST "Same name" (p1); the second one (p2) is never the one removed.
    expect(left).toContain("Same name:p2");
    expect(left).toContain("Legacy 3:p3");
  });

  it.each([
    ["the rename lands first", ["edit", "delete"]],
    ["the delete lands first", ["delete", "edit"]],
  ])("never removes the wrong one of two identical id-less cards when the other is renamed (%s)", async (_label, order) => {
    const twin = { name: "Twin", pain: "same", desire: "same", objection: "same" };
    seed({ icpResult: [{ ...twin }, { ...twin }, legacy(2)] });
    holdUntilBothRead();
    const jobs: Record<string, () => Promise<any>> = {
      edit: () => post("edit-one", { icpId: "icp-1", patch: { name: "Renamed" } }),
      delete: () => post("delete-one", { icpId: "icp-1" }),
    };
    const results = await Promise.all(order.map((k) => jobs[k]()));

    for (const r of results) expect([200, 409]).toContain(r.status);
    const names = table().row.icpResult.map((p: any) => p.name);
    // Wrong card: the untouched twin deleted while the renamed one stays.
    expect(names).not.toEqual(["Renamed", "Legacy 2"]);
    expect(names).toContain("Legacy 2");
  });

  it("does not report success for a delete of a nameless, id-less card whose position the list has shrunk past", async () => {
    seed({ icpResult: [legacy(0), { pain: "no name", desire: "d", objection: "o" }] });
    holdUntilBothRead();
    const results = await Promise.all([post("delete-one", { icpId: "icp-1" }), post("delete-one", { icpId: "icp-1" })]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(table().row.icpResult.map((p: any) => p.name)).toEqual(["Legacy 0"]);
  });

  it.each([
    ["userIntent: null", { userIntent: null }],
    ["userIntent as a list", { userIntent: ["not", "a", "map"] }],
    ["userIntent as a string", { userIntent: "text" }],
    ["userIntent as an empty map", { userIntent: {} }],
  ])("edits a card whose stored %s", async (_label, extra) => {
    seed({ icpResult: [persona(0), { ...persona(1), ...extra }, persona(2)] });

    const res = await post("edit-one", { icpId: "icp_1", patch: { pain: "NEW" } });

    expect(res.status).toBe(200);
    const card = table().row.icpResult[1];
    expect(card.pain).toBe("NEW");
    expect(card.userIntent).toEqual({ pain: "NEW" });
  });

  it("merges into an anchor that is a real map and keeps what it already holds", async () => {
    seed({ icpResult: [persona(0), { ...persona(1), userIntent: { name: "kept" } }, persona(2)] });

    expect((await post("edit-one", { icpId: "icp_1", patch: { pain: "NEW" } })).status).toBe(200);

    expect(table().row.icpResult[1].userIntent).toEqual({ name: "kept", pain: "NEW" });
  });

  it("edits and deletes cards with an id that is not a string, or a null name", async () => {
    seed({ icpResult: [{ ...persona(0), id: 7 }, { ...legacy(1), name: null }, persona(2)] });

    expect((await post("edit-one", { icpId: "icp-0", patch: { pain: "NEW0" } })).status).toBe(200);
    expect((await post("edit-one", { icpId: "icp-1", patch: { pain: "NEW1" } })).status).toBe(200);
    expect(table().row.icpResult[0].pain).toBe("NEW0");
    expect(table().row.icpResult[1].pain).toBe("NEW1");
    expect((await post("delete-one", { icpId: "icp-1" })).status).toBe(200);
    expect(table().row.icpResult).toHaveLength(2);
  });

  it("edits and deletes cards that have no stable id (stored before ids existed)", async () => {
    seed({ icpResult: [legacy(0), legacy(1), legacy(2)] });

    const edit = await post("edit-one", { icpId: "icp-1", patch: { pain: "NEW PAIN" } });
    expect(edit.status).toBe(200);
    expect(table().row.icpResult[1].pain).toBe("NEW PAIN");
    expect(table().row.icpResult[0].pain).toBe("p0");

    const del = await post("delete-one", { icpId: "icp-0" });
    expect(del.status).toBe(200);
    expect(table().row.icpResult.map((p: any) => p.name)).toEqual(["Legacy 1", "Legacy 2"]);
  });

  it("leaves odd values on untouched cards and fields exactly as stored", async () => {
    seed({ icpResult: [persona(0), odd, persona(2)] });
    const before = JSON.parse(JSON.stringify(table().row.icpResult[1]));

    expect((await post("edit-one", { icpId: "icp_0", patch: { name: "EDITED" } })).status).toBe(200);
    expect((await post("delete-one", { icpId: "icp_2" })).status).toBe(200);

    expect(table().row.icpResult[1]).toEqual(before);
  });

  it("edits a card that has odd values, keeping every other field", async () => {
    seed({ icpResult: [persona(0), odd, persona(2)] });

    const res = await post("edit-one", { icpId: "icp_1", patch: { desire: "EDITED" } });

    expect(res.status).toBe(200);
    const card = table().row.icpResult[1];
    expect(card.desire).toBe("EDITED");
    expect(card.emptyString).toBe("");
    expect(card.float).toBe(odd.float);
    expect(card.nested).toEqual(odd.nested);
    expect(card.extraField).toBe("kept");
  });

  it("edit and delete still work when the stored list differs in any way from what the index shows", async () => {
    table().indexRow = { ...table().row, icpResult: [{ id: "icp_0", name: "totally different" }] };

    expect((await post("edit-one", { icpId: "icp_3", patch: { name: "EDITED" } })).status).toBe(200);
    expect((await post("delete-one", { icpId: "icp_1" })).status).toBe(200);
    expect(table().row.icpResult.find((p: any) => p.id === "icp_3").name).toBe("EDITED");
    expect(ids()).toEqual(["icp_0", "icp_2", "icp_3", "icp_4"]);
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
