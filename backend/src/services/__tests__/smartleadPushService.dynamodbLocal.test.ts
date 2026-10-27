/**
 * ENG-673: the Smartlead push service (access, keys, approval, starting, control, the worker and the resumer) on the REAL run store,
 * with in-memory CRM and Smartlead fakes. Opt-in like the other DynamoDB Local suites (DYNAMODB_LOCAL_ENDPOINT).
 */
jest.unmock("aws-sdk");

export {};

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

import AWS from "aws-sdk";
import { ulid } from "ulid";
import { SmartleadPushService, STALE_PAUSED_MS, type PushServiceDeps } from "../smartleadPushService";
import { LEASE_MS, SMARTLEAD_PUSH_RUNS_TABLE_SPEC, SmartleadPushRunDb } from "../smartleadPushRunDb";
import { isMarkedForCampaign } from "../smartleadMarkers";
import { SmartleadApiError } from "../smartleadService";
import { CAMPAIGN, FakeSmartlead, SEQUENCE, mkLead } from "./fixtures/smartleadPushEngineFakes";

suite("SmartleadPushService on the real run store (ENG-673)", () => {
  // Each test gets its own table: a run left live by one test must never be claimed by another test's resumer.
  let table = "";
  const config = { endpoint: ENDPOINT, region: "us-west-2", accessKeyId: "x", secretAccessKey: "x" };
  const raw = new AWS.DynamoDB(config);
  const doc = new AWS.DynamoDB.DocumentClient(config);
  let clock = Date.parse("2026-10-28T10:00:00Z");
  let db: SmartleadPushRunDb;
  beforeEach(async () => {
    table = `Test-AW-SmartleadPushRuns-${ulid()}`;
    db = new SmartleadPushRunDb(doc, table, () => clock, async () => {});
    await raw.createTable({ ...SMARTLEAD_PUSH_RUNS_TABLE_SPEC, TableName: table }).promise();
  });
  afterEach(async () => { await raw.deleteTable({ TableName: table }).promise().catch(() => {}); });

  interface Env { svc: SmartleadPushService; deps: PushServiceDeps; sl: FakeSmartlead; leads: any[]; jobs: Promise<unknown>[]; logs: string[]; listId: string; flags: { enabled: boolean }; editors: Set<string> }

  function env(opts: { leads?: any[]; maxConcurrentWorkers?: number; shareDb?: SmartleadPushRunDb; listId?: string; sl?: FakeSmartlead; leadsShared?: any[] } = {}): Env {
    const leads: any[] = opts.leads ?? Array.from({ length: 5 }, (_, i) => mkLead(i + 1));
    const sl = opts.sl ?? new FakeSmartlead();
    const listId = opts.listId ?? `list_${ulid()}`;
    const jobs: Promise<unknown>[] = [];
    const logs: string[] = [];
    const flags = { enabled: true };
    const editors = new Set<string>();
    const key = (userId: string) => ({ ok: true as const, apiKey: `key-of-${userId}`, ownerUserId: userId, accountId: `smartlead-${userId}`, accountName: "SL" });
    const deps: PushServiceDeps = {
      db: opts.shareDb ?? db,
      getList: async id => (id === listId ? { listId, userId: "owner" } : null),
      canEdit: async (userId, list) => userId === list.userId || editors.has(userId),
      resolveKey: async userId => (userId === "nokey" ? { ok: false, reason: "not_connected", message: "No Smartlead account is connected." } : key(userId)),
      reportFailure: async () => "not_an_auth_error",
      crm: {
        readLeads: async (_l, after, limit) => { const start = after ? leads.findIndex(l => l.leadId === after.leadId) + 1 : 0; return { items: leads.slice(start, start + limit), hasMore: start + limit < leads.length }; },
        readLeadConsistent: async (_l, id) => leads.find(l => l.leadId === id) ?? null,
        writeMarker: async (_l, id, k, m) => { const l = leads.find(x => x.leadId === id)!; l.system = { ...(l.system ?? {}), [k]: m }; },
      },
      smartlead: {
        listCampaigns: async () => [
          { id: 1, name: "Draft", status: "DRAFTED" }, { id: 2, name: "Live", status: "ACTIVE" }, { id: 3, name: "Old", status: "ARCHIVED" }, { id: 4, name: "Paused", status: "PAUSED" },
        ] as any,
        getCampaign: async () => (sl.campaignMissing ? null : ({ id: CAMPAIGN, name: "Q4", status: sl.status, maxLeadsPerDay: 100, addUnsubscribeTag: true } as any)),
        getSequences: async () => { if (!sl.sequences) throw new SmartleadApiError("boom", 500); return sl.sequences; },
        getMailboxes: async () => [{ id: 1, email: "a@x.com", dailyLimit: 30 }],
        addLeads: (_k, _c, x) => sl.addLeads(x),
      },
      secret: "svc-secret",
      enabled: () => flags.enabled,
      now: () => new Date(clock),
      sleep: async () => {},
      track: (_n, job) => { jobs.push(job); return job; },
      log: line => { logs.push(line); },
      maxConcurrentWorkers: opts.maxConcurrentWorkers,
    };
    return { svc: new SmartleadPushService(deps), deps, sl, leads, jobs, logs, listId, flags, editors };
  }
  const drain = async (e: Env) => { await Promise.all(e.jobs.splice(0)); };

  async function approve(e: Env, user = "owner", over: Record<string, any> = {}) {
    const p = await e.svc.preview(user, { listId: e.listId, campaignId: CAMPAIGN, ...over });
    if (!p.ok) throw new Error(`preview failed: ${p.code}`);
    return p.preview;
  }
  const go = (token: string, over: Record<string, any> = {}) => ({ token, acknowledgements: { lawfulBasis: true }, ...over });

  describe("preview", () => {
    it("works for the owner and returns a token", async () => {
      const e = env();
      const p = await approve(e);
      expect(p.list.eligible).toBe(5);
      expect(p.canStart).toBe(true);
      expect(p.token).toBeTruthy();
    });

    it("refuses without edit access, for a missing list, with no connection, with a teammate-only key, and while switched off", async () => {
      const e = env();
      expect(await e.svc.preview("stranger", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 403, code: "forbidden" });
      expect(await e.svc.preview("owner", { listId: "nope", campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 404 });
      e.editors.add("nokey");
      expect(await e.svc.preview("nokey", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 409, code: "not_connected" });
      e.deps.resolveKey = async () => ({ ok: true, apiKey: "k", ownerUserId: "teammate", accountId: "smartlead-teammate", accountName: "x" });
      expect(await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 403, code: "shared_key_not_supported" });
      e.flags.enabled = false;
      expect(await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 503, code: "disabled" });
    });

    it("lets a list editor who is not the owner preview, using their OWN key", async () => {
      const e = env();
      e.editors.add("editor");
      const seen: string[] = [];
      const resolve = e.deps.resolveKey;
      e.deps.resolveKey = async (u, a) => { seen.push(u); return resolve(u, a); };
      expect((await e.svc.preview("editor", { listId: e.listId, campaignId: CAMPAIGN })).ok).toBe(true);
      expect(seen).toEqual(["editor"]);
    });

    it("maps an archived or missing campaign to a clear error", async () => {
      const e = env();
      e.sl.status = "ARCHIVED";
      expect(await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 409, code: "campaign_not_pushable" });
      e.sl.status = "DRAFTED"; e.sl.campaignMissing = true;
      expect(await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 404, code: "campaign_not_found" });
    });
  });

  describe("campaigns", () => {
    it("lists the user's own campaigns, marking which can be pushed to and which need a second confirmation", async () => {
      const e = env();
      const r = (await e.svc.campaigns("owner")) as any;
      expect(r.campaigns).toEqual([
        { id: 1, name: "Draft", status: "DRAFTED", pushable: true, needsConfirmation: false },
        { id: 2, name: "Live", status: "ACTIVE", pushable: true, needsConfirmation: true },
        { id: 3, name: "Old", status: "ARCHIVED", pushable: false, needsConfirmation: false },
        { id: 4, name: "Paused", status: "PAUSED", pushable: true, needsConfirmation: false },
      ]);
      expect(await e.svc.campaigns("nokey")).toMatchObject({ ok: false, status: 409, code: "not_connected" });
      e.flags.enabled = false;
      expect(await e.svc.campaigns("owner")).toMatchObject({ ok: false, status: 503 });
    });
  });

  describe("start", () => {
    it("starts a run, works it in the background to the end, marks the leads, and releases the lock", async () => {
      const e = env();
      const p = await approve(e);
      const r = await e.svc.start("owner", go(p.token));
      expect(r).toMatchObject({ ok: true, started: true, run: { status: "running", approved: 5 } });
      await drain(e);
      const run = (await e.svc.status("owner", (r as any).run.runId)) as any;
      expect(run.run.status).toBe("completed");
      expect(run.run.counts.added).toBe(5);
      expect(e.leads.every(l => isMarkedForCampaign(l, CAMPAIGN))).toBe(true);
      expect(await db.getLock(e.listId, CAMPAIGN)).toBeNull();
      expect(e.logs.join("\n")).toMatch(/started run=.* approved=5/);
    });

    it("records who pushed, with which key, what they approved and acknowledged", async () => {
      const e = env();
      e.editors.add("editor");
      const p = await approve(e, "editor");
      const r = (await e.svc.start("editor", go(p.token))) as any;
      const run = (await db.getRun(r.run.runId))!;
      expect(run).toMatchObject({ ownerId: "owner", pushedBy: "editor", keyOwnerId: "editor", channel: "ui", campaignSource: "selected", previewEligible: 5 });
      expect(run.options).toMatchObject({ includeUnverified: false, startStatus: "DRAFTED", acknowledgements: { lawfulBasis: true } });
      await drain(e);
    });

    it("rejects a forged, expired or someone else's token, and a start without the lawful-basis acknowledgement", async () => {
      const e = env();
      const p = await approve(e);
      expect(await e.svc.start("owner", go(p.token + "x"))).toMatchObject({ ok: false, status: 400, code: "invalid_token" });
      expect(await e.svc.start("owner", go("garbage"))).toMatchObject({ ok: false, code: "invalid_token" });
      e.editors.add("editor");
      expect(await e.svc.start("editor", go(p.token))).toMatchObject({ ok: false, code: "invalid_token" });
      expect(await e.svc.start("owner", { token: p.token, acknowledgements: {} })).toMatchObject({ ok: false, status: 400, code: "acknowledgement_required" });
      clock += 31 * 60 * 1000;
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, code: "invalid_token" });
    });

    it("refuses when the world changed after the preview: the sequence, or the campaign was started", async () => {
      const e = env();
      const p = await approve(e);
      e.sl.sequences = [{ ...SEQUENCE[0], email_body: "<p>different</p>" }];
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 409, code: "sequence_changed" });
      e.sl.sequences = SEQUENCE;
      e.sl.status = "ACTIVE";
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 409, code: "campaign_started_since_preview" });
      e.sl.status = "ARCHIVED";
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 409, code: "campaign_not_pushable" });
    });

    it("needs the second confirmation for an ACTIVE campaign", async () => {
      const e = env();
      e.sl.status = "ACTIVE";
      const p = await approve(e);
      expect(p.requiresActiveConfirmation).toBe(true);
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 400, code: "active_confirmation_required" });
      expect(await e.svc.start("owner", go(p.token, { acknowledgements: { lawfulBasis: true, activeConfirmed: true } }))).toMatchObject({ ok: true, started: true });
      await drain(e);
    });

    it("lets exactly one of two simultaneous starts win; the other is told which run is live", async () => {
      const e = env({ maxConcurrentWorkers: 0 }); // no worker, so the run stays live
      const p = await approve(e);
      const [a, b] = await Promise.all([e.svc.start("owner", go(p.token)), e.svc.start("owner", go(p.token))]);
      const started = [a, b].filter(r => r.ok && (r as any).started);
      expect(started).toHaveLength(1);
      const other = [a, b].find(r => r !== started[0]) as any;
      expect(other).toMatchObject({ ok: true, started: false });
      expect(other.run.runId).toBe((started[0] as any).run.runId);
    });

    it("does nothing while switched off, and sends nothing", async () => {
      const e = env();
      const p = await approve(e);
      e.flags.enabled = false;
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 503, code: "disabled" });
      expect(e.sl.posts).toHaveLength(0);
    });

    it("fails closed with a 503 and sends nothing when the run table is unavailable", async () => {
      const e = env({ shareDb: new SmartleadPushRunDb(doc, `Test-missing-${ulid()}`, () => clock, async () => {}) });
      const p = await approve(e);
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 503, code: "unavailable" });
      expect(e.sl.posts).toHaveLength(0);
    });
  });

  describe("control", () => {
    it("shows a run only to its owner or a list editor, and to nobody else (a stranger is told it does not exist)", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      expect((await e.svc.status("owner", r.run.runId)).ok).toBe(true);
      e.editors.add("editor");
      expect((await e.svc.status("editor", r.run.runId)).ok).toBe(true);
      expect(await e.svc.status("stranger", r.run.runId)).toMatchObject({ ok: false, status: 404 });
      expect(await e.svc.status("owner", "no-such-run")).toMatchObject({ ok: false, status: 404 });
      expect(await e.svc.history("stranger", e.listId)).toMatchObject({ ok: false, status: 403 });
      expect((await e.svc.history("owner", e.listId)) as any).toMatchObject({ ok: true, runs: [{ runId: r.run.runId }] });
    });

    it("pauses, resumes (the worker picks it up and finishes), and cancels", async () => {
      const e = env({ leads: Array.from({ length: 900 }, (_, i) => mkLead(i + 1)) });
      e.sl.onPost = async () => { if (e.sl.posts.length === 0) await e.svc.pause("owner", (await db.listRunsForList(e.listId))[0].runId); };
      const r = (await e.svc.start("owner", go((await approve(e, "owner", { cohort: 900 })).token))) as any;
      await drain(e);
      expect(((await e.svc.status("owner", r.run.runId)) as any).run.status).toBe("paused");
      expect(await e.svc.pause("owner", r.run.runId)).toMatchObject({ ok: false, status: 409, code: "not_running" });
      e.sl.onPost = undefined;
      expect(await e.svc.resume("owner", r.run.runId)).toMatchObject({ ok: true, run: { status: "running" } });
      await drain(e);
      expect(((await e.svc.status("owner", r.run.runId)) as any).run.status).toBe("completed");
      expect(e.sl.emails.size).toBe(900);
      expect(await e.svc.cancel("owner", r.run.runId)).toMatchObject({ ok: false, status: 409, code: "already_finished" });
      expect(await e.svc.resume("owner", r.run.runId)).toMatchObject({ ok: false, status: 409, code: "not_paused" });
    });

    it("cancels a paused run and frees the lock for a new one", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      await e.svc.pause("owner", r.run.runId);
      expect(await e.svc.cancel("owner", r.run.runId)).toMatchObject({ ok: true, run: { status: "canceled" } });
      expect(await db.getLock(e.listId, CAMPAIGN)).toBeNull();
    });

    it("keeps pause and cancel working while switched off, but not resume", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      e.flags.enabled = false;
      expect((await e.svc.pause("owner", r.run.runId)).ok).toBe(true);
      expect(await e.svc.resume("owner", r.run.runId)).toMatchObject({ ok: false, code: "disabled" });
      expect((await e.svc.cancel("owner", r.run.runId)).ok).toBe(true);
    });
  });

  describe("the worker", () => {
    it("the kill switch pauses a running run at its next batch", async () => {
      const e = env({ leads: Array.from({ length: 900 }, (_, i) => mkLead(i + 1)) });
      e.sl.onPost = () => { e.flags.enabled = false; };
      const r = (await e.svc.start("owner", go((await approve(e, "owner", { cohort: 900 })).token))) as any;
      await drain(e);
      expect(((await e.svc.status("owner", r.run.runId)) as any).run).toMatchObject({ status: "paused", pauseReason: "disabled_by_operator" });
    });

    it("pauses (not fails) a run whose Smartlead key is no longer available", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      const run = (await db.getRun(r.run.runId))!;
      e.deps.resolveKey = async () => ({ ok: false, reason: "key_rejected", message: "rejected" });
      await e.svc.work(run);
      expect(((await e.svc.status("owner", r.run.runId)) as any).run).toMatchObject({ status: "paused", pauseReason: "key_rejected" });
    });

    it("never throws out of the worker, and scrubs a key from its log line", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      const run = (await db.getRun(r.run.runId))!;
      e.deps.resolveKey = async () => { throw new Error("boom api_key=SECRETKEY123"); };
      await expect(e.svc.work(run)).resolves.toBeUndefined();
      expect(e.logs.join("\n")).not.toContain("SECRETKEY123");
    });
  });

  describe("the resumer", () => {
    it("claims a run whose worker died, and finishes it without sending anything twice", async () => {
      const leads: any[] = Array.from({ length: 900 }, (_, i) => mkLead(i + 1));
      const sl = new FakeSmartlead();
      const dead = env({ leads, sl, maxConcurrentWorkers: 0 }); // starts the run but never works it: the process "died"
      const r = (await dead.svc.start("owner", go((await approve(dead, "owner", { cohort: 900 })).token))) as any;
      const alive = env({ leads, sl, shareDb: db, listId: dead.listId });
      expect(await alive.svc.resumerTick()).toEqual({ claimed: 0, canceled: 0 }); // the lease is still valid
      clock += LEASE_MS + 31_000;
      expect(await alive.svc.resumerTick()).toMatchObject({ claimed: 1 });
      await drain(alive);
      expect(((await alive.svc.status("owner", r.run.runId)) as any).run.status).toBe("completed");
      expect(new Set(sl.posts.flat()).size).toBe(900);
      expect(sl.posts.flat()).toHaveLength(900);
    });

    it("cancels a paused run nobody resumed for a week, and frees its lock", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      await e.svc.pause("owner", r.run.runId);
      clock += STALE_PAUSED_MS - 10 * 60_000; // counted from the run's last lease, a minute or two after the pause
      expect((await e.svc.resumerTick()).canceled).toBe(0);
      clock += 20 * 60_000;
      expect((await e.svc.resumerTick()).canceled).toBeGreaterThanOrEqual(1);
      expect(((await e.svc.status("owner", r.run.runId)) as any).run.status).toBe("canceled");
      expect(await db.getLock(e.listId, CAMPAIGN)).toBeNull();
    });

    it("does nothing while switched off, and does not start more workers than its capacity", async () => {
      const dead = env({ maxConcurrentWorkers: 0 });
      await dead.svc.start("owner", go((await approve(dead)).token));
      clock += LEASE_MS + 31_000;
      const off = env({ shareDb: db, listId: dead.listId, leads: dead.leads, sl: dead.sl });
      off.flags.enabled = false;
      expect(await off.svc.resumerTick()).toEqual({ claimed: 0, canceled: 0 });
      const full = env({ shareDb: db, listId: dead.listId, leads: dead.leads, sl: dead.sl, maxConcurrentWorkers: 0 });
      expect(await full.svc.resumerTick()).toEqual({ claimed: 0, canceled: 0 });
    });
  });
});
