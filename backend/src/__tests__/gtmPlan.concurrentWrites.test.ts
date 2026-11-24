import request from "supertest";
import express from "express";

/**
 * ENG-2840 W2-4 (Opslane P1 on the PR): overlapping writes to one GTM plan.
 *
 * Every route that rewrites a plan reads the whole plan, changes one phase or item and writes the whole `phases` list back. Two such
 * writes that overlap used to overwrite each other: an item reported as added was missing from the plan, and a deleted phase came back
 * with its items. These tests make two requests READ the plan before either WRITES (a barrier on the fake database's reads, released only
 * when both have read) and then check that nothing was lost.
 *
 * The database is the in-memory DynamoDB fake. Its reads return the stored object itself, which would let two handlers share one object;
 * the wrapper below copies on read, as the real service does.
 */
const hooks: { afterGet?: (params: any) => Promise<void>; beforeUpdate?: (params: any) => Promise<void>; afterUpdate?: (params: any) => Promise<void> } = {};
(global as any).__gtmRaceHooks = hooks;

jest.mock("aws-sdk", () => {
  const { InMemoryDynamo } = jest.requireActual("./helpers/inMemoryDynamo");
  const fake = new InMemoryDynamo({ "AW-GTMPlan": { hash: "planId" } });
  (global as any).__gtmRaceFake = fake;
  const Inner = fake.documentClient;
  class RacingDocumentClient {
    private inner = new Inner();
    createSet(list: any[]) { return this.inner.createSet(list); }
    put(params: any) { return this.inner.put(params); }
    delete(params: any) { return this.inner.delete(params); }
    query(params: any) { return this.inner.query(params); }
    scan(params: any) { return { promise: async () => ({ Items: fake.items(params.TableName) }) }; }
    get(params: any) {
      return {
        promise: async () => {
          const read = await this.inner.get(params).promise();
          const copy = read.Item ? JSON.parse(JSON.stringify(read.Item)) : undefined;
          const gate = (global as any).__gtmRaceHooks.afterGet;
          if (gate) await gate(params);
          return { Item: copy };
        },
      };
    }
    update(params: any) {
      return {
        promise: async () => {
          const gate = (global as any).__gtmRaceHooks.beforeUpdate;
          if (gate) await gate(params);
          const applied = await this.inner.update(params).promise();
          const after = (global as any).__gtmRaceHooks.afterUpdate;
          if (after) await after(params);
          return applied;
        },
      };
    }
  }
  return {
    DynamoDB: { DocumentClient: RacingDocumentClient },
    S3: jest.fn(() => ({})),
    SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: "{}" }) }) })),
    config: { update: jest.fn() },
  };
});

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "user-123", email: "user@example.com", isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));
jest.mock("../services/settingsService", () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));
jest.mock("../services/gtmPlanNotificationService", () => ({
  sendGTMPlanUpdateNotifications: jest.fn(),
  sendPhaseStatusReport: jest.fn(),
  sendPlanStatusReport: jest.fn(),
}));

import gtmPlanRoutes from "../routes/gtmPlan";
import { sendGTMPlanUpdateNotifications } from "../services/gtmPlanNotificationService";

const fake: any = (global as any).__gtmRaceFake;
const app = express();
app.use(express.json());
app.use("/api/gtm-plan", gtmPlanRoutes);

const SEEDED_AT = "2026-10-01T09:00:00.000Z";
const seedPlan = (overrides: Record<string, any> = {}) =>
  fake.seed("AW-GTMPlan", {
    planId: "plan-1",
    userId: "user-123",
    title: "Plan",
    status: "in_progress",
    phases: [
      { id: "ph1", title: "Phase 1", description: null, dri: null, dueDate: null, status: "in_progress", workItems: [{ id: "it1", title: "Item 1", description: null, dri: null, status: "pending", notes: null, dueDate: null }] },
      { id: "ph2", title: "Phase 2", description: null, dri: null, dueDate: null, status: "in_progress", workItems: [] },
    ],
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    ...overrides,
  });
const stored = () => fake.items("AW-GTMPlan").find((p: any) => p.planId === "plan-1");
const phase = (id: string) => stored().phases.find((p: any) => p.id === id);
const titles = (id: string) => phase(id).workItems.map((i: any) => i.title).sort();

let updateAttempts: number;

/** Makes the first `n` reads of the plan wait until all `n` have been made: the n requests have all read before any of them writes. */
function overlapReads(n: number) {
  let arrived = 0;
  let release!: () => void;
  const everyoneRead = new Promise<void>((resolve) => { release = resolve; });
  hooks.afterGet = async () => {
    arrived += 1;
    if (arrived > n) return;
    if (arrived === n) release();
    await everyoneRead;
  };
}

beforeEach(() => {
  fake.tables.get("AW-GTMPlan")?.clear();
  hooks.afterGet = undefined;
  hooks.afterUpdate = undefined;
  updateAttempts = 0;
  hooks.beforeUpdate = async () => { updateAttempts += 1; };
  seedPlan();
});

const addItem = (title: string, phaseId = "ph1") => request(app).post(`/api/gtm-plan/plan-1/phases/${phaseId}/work-items`).send({ title });

describe("overlapping writes to one plan", () => {
  it("two items added at the same moment are both stored (one write used to overwrite the other)", async () => {
    overlapReads(2);
    const [a, b] = await Promise.all([addItem("A"), addItem("B")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(titles("ph1")).toEqual(["A", "B", "Item 1"]);
    expect(updateAttempts).toBe(3); // two first tries, one of which lost and ran again
  });

  it("four overlapping adds are all stored", async () => {
    overlapReads(4);
    const answers = await Promise.all(["A", "B", "C", "D"].map((t) => addItem(t)));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(titles("ph1")).toEqual(["A", "B", "C", "D", "Item 1"]);
  });

  it("an item added while its phase is deleted never brings the phase back", async () => {
    overlapReads(2);
    const [del, add] = await Promise.all([request(app).delete("/api/gtm-plan/plan-1/phases/ph1"), addItem("LATE")]);
    expect(del.status).toBe(200);
    expect([200, 404]).toContain(add.status); // the add either went first (then the phase was deleted) or found no phase
    expect(stored().phases.map((p: any) => p.id)).toEqual(["ph2"]);
  });

  it("an item deleted while another is added: the add stays, the delete holds", async () => {
    overlapReads(2);
    const [del, add] = await Promise.all([request(app).delete("/api/gtm-plan/plan-1/phases/ph1/work-items/it1"), addItem("NEW")]);
    expect([del.status, add.status]).toEqual([200, 200]);
    expect(titles("ph1")).toEqual(["NEW"]);
  });

  describe.each([
    ["a plan update", () => request(app).put("/api/gtm-plan/plan-1").send({ title: "Renamed plan" }), () => expect(stored().title).toBe("Renamed plan")],
    ["a phase added", () => request(app).post("/api/gtm-plan/plan-1/phases").send({ title: "Phase 3" }), () => expect(stored().phases.map((p: any) => p.title)).toContain("Phase 3")],
    ["a phase renamed", () => request(app).put("/api/gtm-plan/plan-1/phases/ph1").send({ title: "Discovery" }), () => expect(phase("ph1").title).toBe("Discovery")],
    ["a work item updated", () => request(app).put("/api/gtm-plan/plan-1/phases/ph1/work-items/it1").send({ notes: "five booked" }), () => expect(phase("ph1").workItems.find((i: any) => i.id === "it1").notes).toBe("five booked")],
    ["common items added to another phase", () => request(app).post("/api/gtm-plan/plan-1/add-common-items").send({ items: [{ title: "Blog" }], targetPhaseId: "ph2" }), () => expect(titles("ph2")).toEqual(["Blog"])],
    ["another phase deleted", () => request(app).delete("/api/gtm-plan/plan-1/phases/ph2"), () => expect(stored().phases.map((p: any) => p.id)).toEqual(["ph1"])],
    ["a work item deleted", () => request(app).delete("/api/gtm-plan/plan-1/phases/ph1/work-items/it1"), () => expect(titles("ph1")).not.toContain("Item 1")],
  ])("%s at the same moment as an item added to the first phase", (_name, other, expectEffect) => {
    // the request that reaches the database first wins; the other must notice, read again and run again. Both orders, so that each of the
    // routes is the one that loses at least once (and so its own conflict handling is the code under test).
    it.each([
      ["the other route first", false],
      ["the add first", true],
    ])("keeps both changes (%s)", async (_order, addFirst) => {
      overlapReads(2);
      const [one, two] = await Promise.all(addFirst ? [addItem("RACER"), other()] : [other(), addItem("RACER")]);
      const [first, second] = addFirst ? [two, one] : [one, two];
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expectEffect();
      expect(titles("ph1")).toContain("RACER");
      expect(updateAttempts).toBe(3); // two first tries and one run again by the loser, whichever route it was
    });
  });

  it("a plan that is changed again and again answers 409 after a bounded number of tries, and writes nothing of its own", async () => {
    // a competing write lands between every read and this write
    hooks.beforeUpdate = async (params: any) => {
      updateAttempts += 1;
      const row = fake.items("AW-GTMPlan")[0];
      row.updatedAt = `2026-10-02T09:00:0${updateAttempts % 10}.000Z`;
      fake.seed("AW-GTMPlan", row);
      void params;
    };
    const res = await addItem("NEVER");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "The plan is being changed by someone else right now. Nothing was lost; please try again." });
    expect(updateAttempts).toBe(8);
    expect(titles("ph1")).toEqual(["Item 1"]);
  });

  it("an error that is not a conflict is not retried", async () => {
    hooks.beforeUpdate = async () => {
      updateAttempts += 1;
      throw new Error("the table is down");
    };
    const res = await addItem("X");
    expect(res.status).toBe(500);
    expect(updateAttempts).toBe(1);
  });

  it("without contention each write is made once, conditional on the updatedAt it read", async () => {
    const seen: any[] = [];
    hooks.beforeUpdate = async (params: any) => {
      updateAttempts += 1;
      seen.push(params);
    };
    const res = await addItem("ALONE");
    expect(res.status).toBe(200);
    expect(updateAttempts).toBe(1);
    expect(seen[0].ConditionExpression).toBe("attribute_exists(planId) AND #readUpdatedAt = :readUpdatedAt");
    expect(seen[0].ExpressionAttributeValues[":readUpdatedAt"]).toBe(SEEDED_AT);
    expect(seen[0].ExpressionAttributeNames["#readUpdatedAt"]).toBe("updatedAt");
  });

  it("a plan stored without an updatedAt can still be written (conditioned on its absence), and then has one", async () => {
    fake.tables.get("AW-GTMPlan")?.clear();
    seedPlan({ updatedAt: undefined });
    const seen: any[] = [];
    hooks.beforeUpdate = async (params: any) => { seen.push(params); };
    const res = await addItem("LEGACY");
    expect(res.status).toBe(200);
    expect(seen[0].ConditionExpression).toBe("attribute_exists(planId) AND attribute_not_exists(#readUpdatedAt)");
    expect(stored().updatedAt).toEqual(expect.any(String));
  });

  it("deleting a phase or an item now sets updatedAt (it did not, so no other writer could tell it had happened)", async () => {
    expect((await request(app).delete("/api/gtm-plan/plan-1/phases/ph2")).status).toBe(200);
    const afterPhase = stored().updatedAt;
    expect(afterPhase).not.toBe(SEEDED_AT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await request(app).delete("/api/gtm-plan/plan-1/phases/ph1/work-items/it1")).status).toBe(200);
    expect(stored().updatedAt).not.toBe(afterPhase);
  });

  describe("an answer that never arrived", () => {
    // The SDK resends a request it got no answer to. When the first copy had been applied, the resend fails its own condition: that is not
    // someone else's write, and running the handler again would add the item twice or find the deleted phase gone.
    const lostAnswerOnce = () => {
      let dropped = false;
      hooks.afterUpdate = async () => {
        if (dropped) return;
        dropped = true;
        throw Object.assign(new Error("The conditional request failed"), { code: "ConditionalCheckFailedException" });
      };
    };

    it("an added item is stored once and the answer is a success", async () => {
      lostAnswerOnce();
      const res = await addItem("ONCE");
      expect(res.status).toBe(200);
      expect(titles("ph1")).toEqual(["Item 1", "ONCE"]);
      expect(updateAttempts).toBe(1);
    });

    it("an added phase is stored once", async () => {
      lostAnswerOnce();
      const res = await request(app).post("/api/gtm-plan/plan-1/phases").send({ title: "Phase 3" });
      expect(res.status).toBe(200);
      expect(stored().phases.filter((p: any) => p.title === "Phase 3")).toHaveLength(1);
    });

    it("common items are added once", async () => {
      lostAnswerOnce();
      const res = await request(app).post("/api/gtm-plan/plan-1/add-common-items").send({ items: [{ title: "Blog" }], targetPhaseId: "ph2" });
      expect(res.status).toBe(200);
      expect(titles("ph2")).toEqual(["Blog"]);
    });

    it("a deleted phase answers 200, not 404 (the phase is gone because this request deleted it)", async () => {
      lostAnswerOnce();
      const res = await request(app).delete("/api/gtm-plan/plan-1/phases/ph1");
      expect(res.status).toBe(200);
      expect(stored().phases.map((p: any) => p.id)).toEqual(["ph2"]);
    });

    it("a deleted item answers 200", async () => {
      lostAnswerOnce();
      const res = await request(app).delete("/api/gtm-plan/plan-1/phases/ph1/work-items/it1");
      expect(res.status).toBe(200);
      expect(titles("ph1")).toEqual([]);
    });

    it("the check that it was our own write reads consistently", async () => {
      lostAnswerOnce();
      const reads: any[] = [];
      hooks.afterGet = async (params: any) => { reads.push(params); };
      await addItem("ONCE");
      expect(reads).toHaveLength(2); // the handler's read, then the check
      expect(reads[1].ConsistentRead).toBe(true);
    });

    it("what a recovered write answers is the stored plan, like the write's own answer", async () => {
      lostAnswerOnce();
      const res = await addItem("ONCE");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(stored());
    });

    it("a work item update that lost its answer still notifies once, with the full plan", async () => {
      lostAnswerOnce();
      (sendGTMPlanUpdateNotifications as jest.Mock).mockClear();
      const res = await request(app)
        .put("/api/gtm-plan/plan-1/phases/ph1/work-items/it1")
        .send({ status: "completed", notifications: { notifyUser: true } });
      expect(res.status).toBe(200);
      expect(phase("ph1").workItems[0].status).toBe("completed");
      expect(sendGTMPlanUpdateNotifications).toHaveBeenCalledTimes(1);
      const [notifiedPlan] = (sendGTMPlanUpdateNotifications as jest.Mock).mock.calls[0];
      expect(notifiedPlan.planId).toBe("plan-1");
      expect(notifiedPlan.phases).toEqual(stored().phases);
      expect(res.body.data).toEqual(stored());
    });

    it("the stamp counts as much as the phases: a competitor that landed the same phases under its own stamp is not our write", async () => {
      let first = true;
      hooks.beforeUpdate = async () => {
        updateAttempts += 1;
        if (!first) return;
        first = false;
        // the portal sends whole lists: another writer lands the very same phases with another title and its own stamp
        const competitor = JSON.parse(JSON.stringify(fake.items("AW-GTMPlan")[0]));
        competitor.title = "COMPETITOR TITLE";
        competitor.updatedAt = "2099-01-01T00:00:00.000Z";
        fake.seed("AW-GTMPlan", competitor);
      };
      const sameList = JSON.parse(JSON.stringify(stored().phases));
      const res = await request(app).put("/api/gtm-plan/plan-1").send({ title: "OUR TITLE", phases: sameList });
      expect(res.status).toBe(200);
      expect(stored().title).toBe("OUR TITLE"); // our title was applied by the rerun, not dropped as if already stored
      expect(updateAttempts).toBe(2);
    });

    it("a failing check of our own write falls back to running the handler again", async () => {
      let reads = 0;
      hooks.afterGet = async () => {
        reads += 1;
        if (reads === 2) throw Object.assign(new Error("throttled"), { code: "ProvisionedThroughputExceededException" });
      };
      let first = true;
      hooks.beforeUpdate = async () => {
        updateAttempts += 1;
        if (!first) return;
        first = false;
        const competitor = JSON.parse(JSON.stringify(fake.items("AW-GTMPlan")[0]));
        competitor.updatedAt = "2099-01-01T00:00:00.000Z";
        fake.seed("AW-GTMPlan", competitor);
      };
      const res = await addItem("AFTER A THROTTLE");
      expect(res.status).toBe(200);
      expect(titles("ph1")).toEqual(["AFTER A THROTTLE", "Item 1"]);
      expect(updateAttempts).toBe(2);
    });

    it("a competitor that stamped the same updatedAt but wrote other phases is a conflict, not our write", async () => {
      let first = true;
      hooks.beforeUpdate = async (params: any) => {
        updateAttempts += 1;
        if (!first) return;
        first = false;
        // another writer got in: same stamp as the one we are about to write, different content
        const competitor = JSON.parse(JSON.stringify(fake.items("AW-GTMPlan")[0]));
        competitor.phases[0].workItems.push({ id: "c1", title: "COMPETITOR", status: "pending" });
        competitor.updatedAt = params.ExpressionAttributeValues[":updatedAt"];
        fake.seed("AW-GTMPlan", competitor);
      };
      const res = await addItem("OURS");
      expect(res.status).toBe(200);
      expect(titles("ph1")).toEqual(["COMPETITOR", "Item 1", "OURS"]);
      expect(updateAttempts).toBe(2);
    });
  });

  describe.each([
    ["with an updatedAt", false],
    ["without an updatedAt", true],
  ])("a plan deleted between the read and the write (%s)", (_name, legacy) => {
    it("answers 404 and does not bring back a row with no owner", async () => {
      if (legacy) {
        fake.tables.get("AW-GTMPlan")?.clear();
        seedPlan({ updatedAt: undefined });
      }
      let gone = false;
      hooks.afterGet = async () => {
        if (gone) return;
        gone = true;
        fake.tables.get("AW-GTMPlan")?.clear();
      };
      const res = await addItem("GHOST");
      expect(res.status).toBe(404);
      expect(fake.items("AW-GTMPlan")).toEqual([]);
    });
  });

  describe("the eight guarded routes read the plan consistently", () => {
    it.each([
      ["plan update", () => request(app).put("/api/gtm-plan/plan-1").send({ title: "T" })],
      ["work item update", () => request(app).put("/api/gtm-plan/plan-1/phases/ph1/work-items/it1").send({ notes: "n" })],
      ["add phase", () => request(app).post("/api/gtm-plan/plan-1/phases").send({ title: "Phase 3" })],
      ["update phase", () => request(app).put("/api/gtm-plan/plan-1/phases/ph1").send({ title: "Renamed" })],
      ["add work item", () => addItem("X")],
      ["delete phase", () => request(app).delete("/api/gtm-plan/plan-1/phases/ph2")],
      ["delete work item", () => request(app).delete("/api/gtm-plan/plan-1/phases/ph1/work-items/it1")],
      ["add common items", () => request(app).post("/api/gtm-plan/plan-1/add-common-items").send({ items: [{ title: "C" }], targetPhaseId: "ph2" })],
    ])("%s", async (_name, call) => {
      const reads: any[] = [];
      hooks.afterGet = async (params: any) => { reads.push(params); };
      const res = await call();
      expect(res.status).toBe(200);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((r) => r.ConsistentRead === true)).toBe(true);
    });
  });

  it("the delete answers carry the new updatedAt, not the one it read", async () => {
    const phase = await request(app).delete("/api/gtm-plan/plan-1/phases/ph2");
    expect(phase.body.data.updatedAt).toBe(stored().updatedAt);
    expect(phase.body.data.updatedAt).not.toBe(SEEDED_AT);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const item = await request(app).delete("/api/gtm-plan/plan-1/phases/ph1/work-items/it1");
    expect(item.body.data.updatedAt).toBe(stored().updatedAt);
  });

  it("a write that loses the race is not applied twice: the item is added once", async () => {
    overlapReads(2);
    await Promise.all([addItem("TWICE"), addItem("OTHER")]);
    expect(phase("ph1").workItems.filter((i: any) => i.title === "TWICE")).toHaveLength(1);
  });
});
