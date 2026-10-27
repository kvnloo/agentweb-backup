/**
 * ENG-673: the push engine driven through the REAL run store (SmartleadPushRunDb) on DynamoDB Local: the fence, the lease and the
 * resume are the store's own conditions, not fakes. Opt-in like smartleadPushRunDb.dynamodbLocal.test.ts (DYNAMODB_LOCAL_ENDPOINT).
 * Smartlead and the lead list are the in-memory fakes from fixtures/smartleadPushEngineFakes.ts.
 */
jest.unmock("aws-sdk");

export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

import AWS from "aws-sdk";
import { ulid } from "ulid";
import { executeRun } from "../smartleadPushEngine";
import { isMarkedForCampaign } from "../smartleadMarkers";
import { LEASE_MS, SMARTLEAD_PUSH_RUNS_TABLE_SPEC, SmartleadPushRunDb, type NewPushRun } from "../smartleadPushRunDb";
import { CAMPAIGN, FakeSmartlead, HASH, makeDeps, mkLead } from "./fixtures/smartleadPushEngineFakes";

suite("executeRun on the real run store (ENG-673)", () => {
  const table = `Test-AW-SmartleadPushRuns-${ulid()}`;
  const config = { endpoint: ENDPOINT, region: "us-west-2", accessKeyId: "x", secretAccessKey: "x" };
  const raw = new AWS.DynamoDB(config);
  const doc = new AWS.DynamoDB.DocumentClient(config);
  let clock = Date.parse("2026-10-27T10:00:00Z");
  const db = new SmartleadPushRunDb(doc, table, () => clock, async () => {});

  const input = (count: number): NewPushRun => ({
    ownerId: "u1", pushedBy: "u1", keyOwnerId: "u1", smartleadAccountId: "smartlead-u1", channel: "ui", listId: `list_${ulid()}`, campaignId: CAMPAIGN, campaignName: "Q4",
    campaignSource: "selected", options: { includeUnverified: false, mapping: {}, startStatus: "DRAFTED" }, sequenceHash: HASH, previewEligible: count,
  });

  beforeAll(async () => { await raw.createTable({ ...SMARTLEAD_PUSH_RUNS_TABLE_SPEC, TableName: table }).promise(); });
  afterAll(async () => { await raw.deleteTable({ TableName: table }).promise().catch(() => {}); });

  it("runs a list to completion: state, cursor, counts and lock all end where they should", async () => {
    const leads: any[] = Array.from({ length: 900 }, (_, i) => mkLead(i + 1));
    const sl = new FakeSmartlead();
    const started = await db.startRun(input(900), "worker-A");
    if (!started.started) throw new Error("expected start");
    await db.confirmStart(started.run.runId);
    await expect(executeRun(started.run, makeDeps(leads, sl, db))).resolves.toEqual({ outcome: "completed" });
    const run = (await db.getRun(started.run.runId))!;
    expect(run).toMatchObject({ status: "completed", listExhausted: true, cursor: { leadId: "lead_00900" } });
    expect(run.counts).toMatchObject({ examined: 900, added: 900 });
    expect(await db.getLock(run.listId, run.campaignId)).toBeNull();
    expect(leads.every(l => isMarkedForCampaign(l, CAMPAIGN))).toBe(true);
  });

  it("survives a crash: a second worker claims the lapsed lease and finishes, and no lead is sent twice", async () => {
    const leads: any[] = Array.from({ length: 900 }, (_, i) => mkLead(i + 1));
    const sl = new FakeSmartlead();
    const started = await db.startRun(input(900), "worker-A");
    if (!started.started) throw new Error("expected start");
    await db.confirmStart(started.run.runId);
    // worker A "dies" right after the first batch is recorded: its next heartbeat throws
    const deps = makeDeps(leads, sl, db);
    let advances = 0;
    const advance = db.advance.bind(db);
    const crashing = Object.create(db) as SmartleadPushRunDb;
    crashing.advance = async (...a) => { const ok = await advance(...a); if (++advances === 1) throw new Error("process died"); return ok; };
    await expect(executeRun(started.run, { ...deps, store: crashing })).rejects.toThrow("process died");
    expect(sl.posts).toHaveLength(1);
    expect((await db.getRun(started.run.runId))!.counts.added).toBe(400);

    clock += LEASE_MS + 31_000; // the lease lapses
    const claimed = await db.claimLease(started.run.runId, "worker-B", 1);
    expect(claimed).toMatchObject({ leaseEpoch: 2 });
    await expect(executeRun(claimed!, makeDeps(leads, sl, db))).resolves.toEqual({ outcome: "completed" });
    expect(sl.posts.map(p => p.length)).toEqual([400, 400, 100]);
    expect(new Set(sl.posts.flat()).size).toBe(900);
    expect((await db.getRun(started.run.runId))!.counts.added).toBe(900);
  });

  it("a worker that lost its lease cannot move the run, even though it kept going", async () => {
    const leads: any[] = Array.from({ length: 900 }, (_, i) => mkLead(i + 1));
    const sl = new FakeSmartlead();
    const started = await db.startRun(input(900), "worker-A");
    if (!started.started) throw new Error("expected start");
    await db.confirmStart(started.run.runId);
    sl.onPost = async () => { clock += LEASE_MS + 31_000; await db.claimLease(started.run.runId, "worker-B", 1); }; // taken over during the first POST
    await new Promise<void>(resolve => { void executeRun(started.run, makeDeps(leads, sl, db)).then(o => { expect(o.outcome).toBe("lost"); resolve(); }); });
    expect(sl.posts.length).toBe(1);
    expect((await db.getRun(started.run.runId))!.counts.added).toBe(0); // the cursor write was fenced
    expect(leads.filter(l => isMarkedForCampaign(l, CAMPAIGN))).toHaveLength(400); // but what Smartlead accepted IS marked
  });

  it("stops at the next batch when the user pauses, and a resume carries on without re-sending", async () => {
    const leads: any[] = Array.from({ length: 900 }, (_, i) => mkLead(i + 1));
    const sl = new FakeSmartlead();
    const started = await db.startRun(input(900), "worker-A");
    if (!started.started) throw new Error("expected start");
    await db.confirmStart(started.run.runId);
    sl.onPost = async () => { if (sl.posts.length === 0) await db.pauseRun(started.run.runId, "user"); };
    const out = await executeRun(started.run, makeDeps(leads, sl, db));
    expect(out.outcome).toBe("lost");
    expect(sl.posts).toHaveLength(1);
    const paused = (await db.getRun(started.run.runId))!;
    expect(paused.status).toBe("paused");
    const resumed = await db.resumeRun(paused.runId, "worker-A", paused.leaseEpoch);
    expect(resumed).toMatchObject({ status: "running", leaseEpoch: 2 });
    sl.onPost = undefined;
    await expect(executeRun(resumed!, makeDeps(leads, sl, db))).resolves.toEqual({ outcome: "completed" });
    expect(new Set(sl.posts.flat()).size).toBe(900);
    expect(sl.posts.flat()).toHaveLength(900); // 900 sends in all: the first batch was not repeated
  });
});
