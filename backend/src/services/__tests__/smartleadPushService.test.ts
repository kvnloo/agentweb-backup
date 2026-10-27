/**
 * ENG-673: the Smartlead push service (access, keys, approval, starting, control, the worker and the resumer), with in-memory CRM and
 * Smartlead fakes. It runs on an in-memory run store everywhere (so CI and the pre-push hook exercise it), and again on the REAL run store
 * when DYNAMODB_LOCAL_ENDPOINT points at a DynamoDB Local.
 */
jest.unmock("aws-sdk");

export {};

import AWS from "aws-sdk";
import { ulid } from "ulid";
import { SmartleadPushService, STALE_PAUSED_MS, type PushServiceDeps } from "../smartleadPushService";
import { LEASE_MS, SMARTLEAD_PUSH_RUNS_TABLE_SPEC, SmartleadPushRunDb, SmartleadPushRunStoreError } from "../smartleadPushRunDb";
import { isMarkedForCampaign } from "../smartleadMarkers";
import { SmartleadApiError } from "../smartleadService";
import { verifyPushToken } from "../smartleadPushToken";
import { CAMPAIGN, FakeSmartlead, SEQUENCE, mkLead } from "./fixtures/smartleadPushEngineFakes";
import { InMemoryPushRunDb } from "./fixtures/inMemoryPushRunDb";

const ENDPOINT = process.env.DYNAMODB_LOCAL_ENDPOINT;
const START = Date.parse("2026-10-28T10:00:00Z");
let clock = START;

interface Made { db: SmartleadPushRunDb; cleanup: () => Promise<void> }
const stores: Array<[string, () => Promise<Made>, boolean]> = [
  ["in-memory run store", async () => ({ db: new InMemoryPushRunDb(() => clock) as unknown as SmartleadPushRunDb, cleanup: async () => {} }), true],
  [
    "real run store on DynamoDB Local",
    async () => {
      // Each test gets its own table: a run left live by one test must never be claimed by another test's resumer.
      const config = { endpoint: ENDPOINT, region: "us-west-2", accessKeyId: "x", secretAccessKey: "x" };
      const raw = new AWS.DynamoDB(config);
      const table = `Test-AW-SmartleadPushRuns-${ulid()}`;
      await raw.createTable({ ...SMARTLEAD_PUSH_RUNS_TABLE_SPEC, TableName: table }).promise();
      return { db: new SmartleadPushRunDb(new AWS.DynamoDB.DocumentClient(config), table, () => clock, async () => {}), cleanup: async () => { await raw.deleteTable({ TableName: table }).promise().catch(() => {}); } };
    },
    !!ENDPOINT,
  ],
];

for (const [storeName, makeStore, enabled] of stores) (enabled ? describe : describe.skip)(`SmartleadPushService on the ${storeName} (ENG-673)`, () => {
  let db: SmartleadPushRunDb;
  let cleanup: () => Promise<void> = async () => {};
  beforeEach(async () => {
    clock = START;
    ({ db, cleanup } = await makeStore());
  });
  afterEach(async () => { await cleanup(); });

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
      const broken = new Proxy({}, { get: () => async () => { throw new SmartleadPushRunStoreError("table_missing", "no table"); } }) as unknown as SmartleadPushRunDb;
      const e = env({ shareDb: broken });
      const p = await approve(e);
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 503, code: "unavailable" });
      expect(e.sl.posts).toHaveLength(0);
    });
  });

  describe("review findings (PR-C2)", () => {
    it("lets an approval be used ONCE: a replay (a retry, a double click) never pushes another cohort", async () => {
      const e = env({ leads: Array.from({ length: 120 }, (_, i) => mkLead(i + 1)) });
      const p = await approve(e); // the first push defaults to a 50-lead test cohort
      expect(p.cohort.chosen).toBe(50);
      const first = (await e.svc.start("owner", go(p.token))) as any;
      await drain(e);
      expect(e.sl.emails.size).toBe(50);
      const replay = (await e.svc.start("owner", go(p.token))) as any;
      expect(replay).toMatchObject({ ok: true, started: false });
      expect(replay.run.runId).toBe(first.run.runId); // shown the run it started, not a new one
      await drain(e);
      expect(e.sl.emails.size).toBe(50);
      const widened = await approve(e); // pushing more takes a fresh, deliberate approval
      expect(widened.list.alreadyPushed).toBe(50);
      expect(widened.cohort.chosen).toBe(70);
    });

    it("lets only one of two simultaneous submits of the same approval start anything", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const p = await approve(e);
      const [a, b] = await Promise.all([e.svc.start("owner", go(p.token)), e.svc.start("owner", go(p.token))]);
      expect([a, b].filter(r => r.ok && (r as any).started)).toHaveLength(1);
      expect((await db.listRunsForList(e.listId))).toHaveLength(1);
    });

    it("gives an approval back when the start definitely did not happen (it lost the race for the lock)", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const one = await approve(e);
      const two = await approve(e);
      const results = (await Promise.all([e.svc.start("owner", go(one.token)), e.svc.start("owner", go(two.token))])) as any[];
      expect(results.filter(r => r.started)).toHaveLength(1);
      const loser = results.find(r => r.ok && !r.started) ? (results[0].started ? two : one) : null;
      expect(loser).not.toBeNull();
      const jti = verifyPushToken("svc-secret", loser!.token, clock)!.jti;
      expect(await db.claimToken(jti, 60)).toBe(true); // not spent by the attempt that started nothing
    });

    it("lets only the person whose Smartlead connection a run uses resume it; other editors can pause and cancel", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      e.editors.add("editor");
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      expect((await e.svc.pause("editor", r.run.runId)).ok).toBe(true);
      expect(await e.svc.resume("editor", r.run.runId)).toMatchObject({ ok: false, status: 403, code: "resume_requires_pusher" });
      expect(((await e.svc.status("owner", r.run.runId)) as any).run.status).toBe("paused");
      expect((await e.svc.resume("owner", r.run.runId)).ok).toBe(true);
      expect((await e.svc.cancel("editor", r.run.runId)).ok).toBe(true);
    });

    it("starts with the connection the preview used, whatever the start request names, and never picks between several of the user's connections", async () => {
      const e = env();
      const asked: Array<string | undefined> = [];
      const resolve = e.deps.resolveKey;
      e.deps.resolveKey = async (u, a) => { asked.push(a); return resolve(u, a); };
      const p = await approve(e);
      asked.length = 0;
      const maxConcurrent = await e.svc.start("owner", go(p.token, { accountId: "smartlead-someone-else" }));
      expect(maxConcurrent).toMatchObject({ ok: true, started: true });
      expect(asked[0]).toBe("smartlead-owner"); // the start's own lookup, before the worker's
      await drain(e);
      // Two connections of the user's own: a lookup without an account id is ambiguous, one with an id is not.
      e.deps.resolveKey = async (_u, a) => (a ? { ok: true, apiKey: "k", ownerUserId: "owner", accountId: a, accountName: "x" } : { ok: false, reason: "choose", message: "Several", candidates: [{ accountId: "a", ownerUserId: "owner" }, { accountId: "b", ownerUserId: "owner" }] });
      expect(await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 409, code: "choose_connection" });
      expect((await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN, accountId: "b" })).ok).toBe(true);
    });

    it("refuses a start when the connection is no longer the one that was previewed", async () => {
      const e = env();
      const p = await approve(e);
      e.deps.resolveKey = async () => ({ ok: true, apiKey: "k", ownerUserId: "owner", accountId: "smartlead-other", accountName: "x" });
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 409, code: "connection_changed" });
    });

    it("never cancels a run the operator's kill switch paused: a long outage must not wipe them out when the switch comes back", async () => {
      const e = env({ leads: Array.from({ length: 900 }, (_, i) => mkLead(i + 1)) });
      e.sl.onPost = () => { e.flags.enabled = false; };
      const r = (await e.svc.start("owner", go((await approve(e, "owner", { cohort: 900 })).token))) as any;
      await drain(e);
      expect(((await e.svc.status("owner", r.run.runId)) as any).run.pauseReason).toBe("disabled_by_operator");
      clock += 400 * 24 * 60 * 60 * 1000; // the switch stayed off for more than a year
      e.flags.enabled = true;
      await e.svc.resumerTick();
      expect(((await e.svc.status("owner", r.run.runId)) as any).run.status).toBe("paused");
      expect(await e.svc.cancel("owner", r.run.runId)).toMatchObject({ ok: true }); // its owner can always release it
      expect(await db.getLock(e.listId, CAMPAIGN)).toBeNull();
    });

    it("gives the approval back when the check for newer runs could not run, since nothing started", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const p = await approve(e);
      const list = db.listRunsForList.bind(db);
      let fail = true;
      (e.deps.db as any) = new Proxy(db, { get: (t, k) => (k === "listRunsForList" ? async (...a: any[]) => { if (fail) { fail = false; throw new SmartleadPushRunStoreError("unavailable", "index down"); } return (list as any)(...a); } : (t as any)[k]?.bind?.(t) ?? (t as any)[k]) });
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 503 });
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: true, started: true }); // not burned by the failed check
    });

    it("does not cancel a lockless run while its lease is still valid, even if a lagging index lists it (a start in progress)", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      await db.releaseLock(e.listId, CAMPAIGN, r.run.runId);
      const alive = env({ shareDb: db, listId: e.listId, leads: e.leads, sl: e.sl });
      const row = (await db.listRunsForList(e.listId))[0];
      (alive.deps.db as any) = new Proxy(db, { get: (t, k) => (k === "findExpiredLeases" ? async () => [row] : (t as any)[k]?.bind?.(t) ?? (t as any)[k]) });
      expect(await alive.svc.resumerTick()).toEqual({ claimed: 0, canceled: 0 });
      expect(((await alive.svc.status("owner", r.run.runId)) as any).run.status).toBe("running");
      clock += LEASE_MS + 31_000; // once the lease has lapsed it IS an orphan
      expect(await alive.svc.resumerTick()).toEqual({ claimed: 0, canceled: 1 });
    });

    it("does NOT hand the approval back when starting threw: a lost reply must not let it start a second run", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const p = await approve(e);
      const start = db.startRun.bind(db);
      let fail = true;
      (e.deps.db as any) = new Proxy(db, { get: (t, k) => (k === "startRun" ? async (...a: any[]) => { const r = await (start as any)(...a); if (fail) { fail = false; throw new SmartleadPushRunStoreError("unavailable", "reply lost"); } return r; } : (t as any)[k]?.bind?.(t) ?? (t as any)[k]) });
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 503 });
      // The write DID commit. The same approval must not start another run.
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: true, started: false }); // shown the run holding the lock
      expect(await db.listRunsForList(e.listId)).toHaveLength(1);
    });

    it("keeps cancelling a run whose start could not be settled until it is confirmed dead (even while switched off)", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const p = await approve(e);
      const start = db.startRun.bind(db);
      let cancelFails = 2;
      (e.deps.db as any) = new Proxy(db, {
        get: (t, k) => {
          if (k === "startRun") return async (...a: any[]) => { const r: any = await (start as any)(...a); throw new SmartleadPushRunStoreError("unavailable", "could not settle", r.run.runId); };
          if (k === "cancelRun") return async (id: string) => { if (cancelFails-- > 0) throw new SmartleadPushRunStoreError("unavailable", "down"); return (t as any).cancelRun(id); };
          return (t as any)[k]?.bind?.(t) ?? (t as any)[k];
        },
      });
      expect(await e.svc.start("owner", go(p.token))).toMatchObject({ ok: false, status: 503 });
      const live = (await db.listRunsForList(e.listId))[0];
      expect(live.status).toBe("running");
      e.flags.enabled = false;
      await e.svc.resumerTick(); // cancel fails
      await e.svc.resumerTick(); // fails again
      expect((await db.getRun(live.runId))!.status).toBe("running");
      await e.svc.resumerTick(); // confirmed
      expect((await db.getRun(live.runId))!.status).toBe("canceled");
      expect(await db.getLock(e.listId, CAMPAIGN)).toBeNull();
    });

    it("refuses an approval that went stale because another run started on the list and campaign since the preview", async () => {
      const e = env({ leads: Array.from({ length: 120 }, (_, i) => mkLead(i + 1)) });
      const first = await approve(e);
      const second = await approve(e); // taken while nothing had been pushed: both default to the 50-lead test cohort
      expect(await e.svc.start("owner", go(first.token))).toMatchObject({ ok: true, started: true });
      await drain(e);
      expect(await e.svc.start("owner", go(second.token))).toMatchObject({ ok: false, status: 409, code: "changed_since_preview" });
      expect(e.sl.emails.size).toBe(50);
      clock += 1000;
      expect((await e.svc.start("owner", go((await approve(e)).token))).ok).toBe(true); // a fresh preview sees what is pushed and may go on
    });

    it("cancels, and never works, a running run that has no lock (a crash between a start's two writes)", async () => {
      const e = env({ maxConcurrentWorkers: 0 });
      const r = (await e.svc.start("owner", go((await approve(e)).token))) as any;
      await db.releaseLock(e.listId, CAMPAIGN, r.run.runId);
      clock += LEASE_MS + 31_000;
      const alive = env({ shareDb: db, listId: e.listId, leads: e.leads, sl: e.sl });
      expect(await alive.svc.resumerTick()).toEqual({ claimed: 0, canceled: 1 });
      await drain(alive);
      expect(((await alive.svc.status("owner", r.run.runId)) as any).run.status).toBe("canceled");
      expect(e.sl.posts).toHaveLength(0);
    });

    it("binds the 'send even though my sequence could not be read' acknowledgement to the preview (it blocks an ACTIVE campaign)", async () => {
      const e = env();
      e.sl.sequences = [null];
      e.sl.status = "ACTIVE";
      const acknowledged = await approve(e, "owner", { acknowledgeUnreadable: true });
      const not = await approve(e);
      expect(not.canStart).toBe(false);
      expect(acknowledged.canStart).toBe(true);
      const confirm = { acknowledgements: { lawfulBasis: true, activeConfirmed: true } };
      expect(await e.svc.start("owner", go(not.token, { ...confirm, acknowledgeUnreadable: true }))).toMatchObject({ ok: false, status: 409, code: "blocked" }); // a body flag cannot add it
      expect(await e.svc.start("owner", go(acknowledged.token, confirm))).toMatchObject({ ok: true, started: true });
      await drain(e);
    });

    it("tells a rejected key from a refusal, a rate limit, a bad request and an outage, and sends nothing", async () => {
      const e = env();
      for (const [status, expectedStatus, code] of [[401, 422, "key_rejected"], [403, 422, "smartlead_forbidden"], [400, 422, "smartlead_rejected_request"], [429, 429, "smartlead_rate_limited"], [500, 502, "smartlead_unavailable"], [undefined, 502, "smartlead_unavailable"]] as const) {
        e.deps.smartlead.getCampaign = async () => { throw new SmartleadApiError("x", status); };
        const r = await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN });
        expect(r).toMatchObject({ ok: false, status: expectedStatus, code });
        expect((r as any).message).not.toMatch(/api_key|stack/i);
      }
      expect(e.sl.posts).toHaveLength(0);
    });

    it("does not hold a preview slot while it waits on Smartlead, only while it reads the list", async () => {
      const e = env();
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const original = e.deps.smartlead.getCampaign;
      let calls = 0;
      e.deps.smartlead.getCampaign = async (...a) => { if (calls++ < 3) await gate; return original(...a); };
      const slow = [1, 2, 3].map(() => e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN }));
      await new Promise(r => setTimeout(r, 20));
      expect((await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).ok).toBe(true); // not turned away as busy
      release();
      for (const r of await Promise.all(slow)) expect(r.ok).toBe(true);
    });

    it("refuses a fourth simultaneous preview instead of loading another whole list into memory", async () => {
      const e = env();
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const read = e.deps.crm.readLeads;
      e.deps.crm.readLeads = async (...a) => { await gate; return read(...a); };
      const running = [1, 2, 3].map(() => e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN }));
      await new Promise(r => setTimeout(r, 20));
      let campaignReads = 0;
      const original = e.deps.smartlead.getCampaign;
      e.deps.smartlead.getCampaign = async (...a) => { campaignReads++; return original(...a); };
      expect(await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).toMatchObject({ ok: false, status: 429, code: "busy" });
      expect(campaignReads).toBe(0); // turned away before it spent any of the customer's Smartlead quota
      release();
      for (const r of await Promise.all(running)) expect(r.ok).toBe(true);
      expect((await e.svc.preview("owner", { listId: e.listId, campaignId: CAMPAIGN })).ok).toBe(true);
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
