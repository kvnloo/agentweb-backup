import { executeRun, readPushOptions } from "../smartleadPushEngine";
import { isMarkedForCampaign, smartleadMarkerKey } from "../smartleadMarkers";
import type { AdvanceStep, PushRun } from "../smartleadPushRunDb";
import { SmartleadApiError } from "../smartleadService";
import { CAMPAIGN, FakeSmartlead, HASH, SEQUENCE, makeDeps, mkLead } from "./fixtures/smartleadPushEngineFakes";

/** A run store with the real store's fencing rules, held in memory. */
class FakeStore {
  run: PushRun;
  heartbeats = 0;
  constructor(run: PushRun) { this.run = run; }
  private fenced(epoch: number) { return this.run.leaseEpoch === epoch && this.run.status === "running"; }
  async getRun() { return { ...this.run }; }
  async heartbeat(_id: string, epoch: number) { this.heartbeats++; return this.fenced(epoch); }
  async advance(_id: string, epoch: number, step: AdvanceStep) {
    if (!this.fenced(epoch)) return false;
    if (!step.cursor && !step.listExhausted) throw new Error("advance needs a cursor");
    if (step.cursor) this.run.cursor = step.cursor;
    for (const [k, v] of Object.entries(step.counts)) (this.run.counts as any)[k] += v ?? 0;
    for (const [r, n] of Object.entries(step.skipped ?? {})) if (n) this.run.counts.skippedByReason[r] = (this.run.counts.skippedByReason[r] ?? 0) + n;
    if (step.listExhausted) this.run.listExhausted = true;
    this.run.batchAttempts = 0;
    return true;
  }
  async recordBatchFailure(_id: string, epoch: number) {
    if (!this.fenced(epoch)) return null;
    this.run.batchAttempts++;
    if (this.run.batchAttempts >= 3) { this.run.status = "partial"; return { attempts: this.run.batchAttempts, partial: true }; }
    return { attempts: this.run.batchAttempts, partial: false };
  }
  async pauseRun(_id: string, reason: string, epoch?: number) {
    if (this.run.status !== "running" || (epoch !== undefined && epoch !== this.run.leaseEpoch)) return false;
    this.run.status = "paused"; this.run.pauseReason = reason; return true;
  }
  async finishRun(_id: string, epoch: number, status: "completed" | "failed") {
    if (!this.fenced(epoch)) return false;
    if (status === "completed" && !this.run.listExhausted) return false;
    this.run.status = status; return true;
  }
}

function setup(leadCount: number, opts: { leads?: any[]; run?: Partial<PushRun> } = {}) {
  const leads: any[] = opts.leads ?? Array.from({ length: leadCount }, (_, i) => mkLead(i + 1));
  const run: PushRun = {
    runId: "run1", schemaVersion: 1, status: "running", ownerId: "u", pushedBy: "u", keyOwnerId: "u", smartleadAccountId: "a", channel: "ui", listId: "L", campaignId: CAMPAIGN,
    campaignName: "Q4", campaignSource: "selected", options: { includeUnverified: false, mapping: {}, startStatus: "DRAFTED" }, sequenceHash: HASH, previewEligible: leadCount,
    counts: { examined: 0, added: 0, alreadyInCampaign: 0, unconfirmed: 0, withdrawn: 0, skippedByReason: {} }, cursor: null, listExhausted: false, batchAttempts: 0, leaseOwner: "w",
    leaseEpoch: 1, leaseUntil: 0, createdAt: "2026-10-27T00:00:00.000Z", startedAt: "2026-10-27T00:00:00.000Z", ...opts.run,
  };
  const store = new FakeStore(run);
  const sl = new FakeSmartlead();
  const sleeps: number[] = [];
  const errors: unknown[] = [];
  const deps = makeDeps(leads, sl, store, { sleeps, errors });
  const marked = () => leads.filter(l => isMarkedForCampaign(l, CAMPAIGN)).length;
  return { leads, run, store, sl, deps, sleeps, errors, marked };
}

describe("executeRun (ENG-673)", () => {
  it("pushes a small list, marks every lead, and completes", async () => {
    const t = setup(10);
    await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
    expect(t.sl.posts).toHaveLength(1);
    expect(t.marked()).toBe(10);
    expect(t.run).toMatchObject({ status: "completed", listExhausted: true, cursor: { listId: "L", leadId: "lead_00010" } });
    expect(t.run.counts).toMatchObject({ examined: 10, added: 10, alreadyInCampaign: 0 });
    expect(t.leads[0].system[smartleadMarkerKey(CAMPAIGN)]).toMatchObject({ state: "pushed", runId: "run1", smartleadLeadId: "9000", email: "p1@example.com" }); // the address that was pushed: the sweep trusts the id only while it matches
  });

  it("sends at most 400 a request and moves the cursor exactly to the last lead examined", async () => {
    const t = setup(900);
    const cursors: Array<string | undefined> = [];
    const advance = t.store.advance.bind(t.store);
    t.store.advance = async (id, epoch, step) => { cursors.push(step.cursor?.leadId); return advance(id, epoch, step); };
    await executeRun(t.run, t.deps);
    expect(cursors).toEqual(["lead_00400", "lead_00800", "lead_00900"]);
    expect(t.sl.posts.map(p => p.length)).toEqual([400, 400, 100]);
    expect(t.marked()).toBe(900);
    expect(t.run.counts.added).toBe(900);
    expect(new Set(t.sl.posts.flat()).size).toBe(900);
  });

  it("counts every skip reason, and never sends a skipped lead", async () => {
    const leads = [mkLead(1), mkLead(2, { email: "" }), mkLead(3, { contactStatus: "do-not-contact" }), mkLead(4, { customFields: { email_validation: { status: "risky" } } }), mkLead(5, { firstName: "" }), mkLead(6)];
    const t = setup(2, { leads });
    await executeRun(t.run, t.deps);
    expect(t.sl.posts.flat()).toEqual(["p1@example.com", "p6@example.com"]);
    expect(t.run.counts.skippedByReason).toMatchObject({ no_email: 1, do_not_contact: 1, unverified: 1, missing_tag: 1 });
    expect(t.run.counts.examined).toBe(6);
  });

  it("stops at the approved count even when more eligible leads follow (the ceiling)", async () => {
    const t = setup(120, { run: { previewEligible: 50 } });
    await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
    expect(t.sl.posts.flat()).toHaveLength(50);
    expect(t.marked()).toBe(50);
    expect(t.run.counts.added).toBe(50);
  });

  it("honours an opt-out recorded after the page was read (the consistent re-check before the POST)", async () => {
    const t = setup(5);
    t.deps.readLeadConsistent = async (_l, id) => ({ ...t.leads.find(l => l.leadId === id)!, ...(id === "lead_00003" ? { contactStatus: "unsubscribed" } : {}) });
    await executeRun(t.run, t.deps);
    expect(t.sl.posts.flat()).not.toContain("p3@example.com");
    expect(t.sl.posts.flat()).toHaveLength(4);
    expect(t.run.counts.skippedByReason.do_not_contact).toBe(1);
  });

  it("drops a lead another run marked in the meantime, and one that was deleted", async () => {
    const t = setup(4);
    t.deps.readLeadConsistent = async (_l, id) => {
      if (id === "lead_00002") return { ...t.leads[1], system: { [smartleadMarkerKey(CAMPAIGN)]: { state: "pushed" } } };
      if (id === "lead_00003") return null;
      return t.leads.find(l => l.leadId === id) ?? null;
    };
    await executeRun(t.run, t.deps);
    expect(t.sl.posts.flat().sort()).toEqual(["p1@example.com", "p4@example.com"]);
    expect(t.run.counts.skippedByReason).toMatchObject({ already_pushed: 1, lead_missing: 1 });
  });

  describe("crash and retry", () => {
    it("rebuilds and resends a batch whose markers could not be written, and Smartlead's answer converges it (no lead added twice)", async () => {
      const t = setup(10);
      let failing = true;
      const write = t.deps.writeMarker;
      t.deps.writeMarker = async (...a) => { if (failing) throw new Error("ddb down"); return write(...a); };
      // the first POST succeeds, marking fails 3 times per lead; then the store recovers
      const originalPost = t.sl.addLeads.bind(t.sl);
      let posts = 0;
      t.sl.addLeads = async l => { const r = await originalPost(l); if (++posts === 2) failing = false; return r; };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(t.sl.emails.size).toBe(10); // Smartlead holds each lead once
      expect(t.marked()).toBe(10);
      expect(t.run.counts.added + t.run.counts.alreadyInCampaign).toBe(10);
      expect(t.run.counts.alreadyInCampaign).toBe(10); // the resend was answered "already in the campaign"
    });

    it("does not lose a failed batch's leads as 'duplicates' when it is rebuilt", async () => {
      const t = setup(6);
      t.sl.failNext = [new SmartleadApiError("timeout", undefined, true)];
      await executeRun(t.run, t.deps);
      expect(t.sl.posts).toHaveLength(1);
      expect(t.sl.posts[0]).toHaveLength(6);
      expect(t.run.counts.skippedByReason.duplicate_in_run).toBeUndefined();
      expect(t.sleeps).toEqual([1000]);
    });

    it("stops as partial after three failed batches and keeps what it has", async () => {
      const t = setup(6);
      t.sl.failNext = [new SmartleadApiError("a", 500, true), new SmartleadApiError("b", 500, true), new SmartleadApiError("c", 500, true)];
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "partial" });
      expect(t.run.status).toBe("partial");
      expect(t.marked()).toBe(0);
      expect(t.sleeps).toEqual([1000, 5000]);
    });

    it("continues a resumed run after its cursor, and skips leads already marked", async () => {
      const t = setup(10);
      for (let i = 0; i < 4; i++) t.leads[i].system = { [smartleadMarkerKey(CAMPAIGN)]: { state: "pushed", pushedAt: "x", runId: "old", payloadHash: "h" } };
      t.run.cursor = { listId: "L", leadId: "lead_00004" };
      t.run.counts.added = 4;
      await executeRun(t.run, t.deps);
      expect(t.sl.posts.flat()).toHaveLength(6);
      expect(t.sl.posts.flat()).not.toContain("p1@example.com");
      expect(t.run.status).toBe("completed");
    });
  });

  describe("the fence", () => {
    it("stops without sending more when the run is paused mid-way", async () => {
      const t = setup(900);
      t.sl.onPost = () => { t.run.status = "paused"; };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "lost" });
      expect(t.sl.posts).toHaveLength(1); // at most the batch in flight
      expect(t.run.counts.added).toBe(0); // and the fenced cursor write did not happen
    });

    it("still marks every lead Smartlead accepted when the run is paused during the POST (an unmarked lead would be invisible to the opt-out safeguards)", async () => {
      const t = setup(5);
      t.sl.onPost = () => { t.run.status = "paused"; };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "lost" });
      expect(t.marked()).toBe(5);
      expect(t.run.counts.added).toBe(0); // the cursor write is the fenced one
      expect(t.run.cursor).toBeNull();
    });

    it("sends nothing when the run was canceled before the POST (the strong read)", async () => {
      const t = setup(5);
      const getRun = t.store.getRun.bind(t.store);
      t.store.getRun = async () => ({ ...(await getRun()), status: "canceled" as const });
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "lost" });
      expect(t.sl.posts).toHaveLength(0);
    });

    it("loses the run to a newer lease epoch", async () => {
      const t = setup(5);
      t.run.leaseEpoch = 2;
      await expect(executeRun({ ...t.run, leaseEpoch: 1 }, t.deps)).resolves.toEqual({ outcome: "lost" });
      expect(t.sl.posts).toHaveLength(0);
    });

    it("lets a store error through (fail closed) and sends nothing after it", async () => {
      const t = setup(5);
      t.store.heartbeat = async () => { throw new Error("table missing"); };
      await expect(executeRun(t.run, t.deps)).rejects.toThrow("table missing");
      expect(t.sl.posts).toHaveLength(0);
    });
  });

  describe("pauses for a human", () => {
    it.each([
      ["the campaign no longer exists", (t: any) => { t.sl.campaignMissing = true; }, "campaign_missing"],
      ["the campaign was archived", (t: any) => { t.sl.status = "ARCHIVED"; }, "campaign_not_pushable"],
      ["the campaign was started under a DRAFTED approval", (t: any) => { t.sl.status = "ACTIVE"; }, "campaign_started"],
      ["the sequence was edited", (t: any) => { t.sl.sequences = [{ ...SEQUENCE[0], email_body: "<p>changed</p>" }]; }, "sequence_changed"],
      ["the sequence can no longer be read", (t: any) => { t.sl.sequences = [null]; }, "sequence_unreadable"],
    ])("when %s", async (_name, mutate, reason) => {
      const t = setup(5);
      mutate(t);
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason });
      expect(t.run).toMatchObject({ status: "paused", pauseReason: reason });
      expect(t.sl.posts).toHaveLength(0);
    });

    it("does not pause an ACTIVE-approved run for staying ACTIVE", async () => {
      const t = setup(5, { run: { options: { includeUnverified: false, mapping: {}, startStatus: "ACTIVE" } } });
      t.sl.status = "ACTIVE";
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
    });

    it("when Smartlead rejects the key, and reports it to the caller", async () => {
      const t = setup(5);
      const e = new SmartleadApiError("nope", 401);
      t.sl.failNext = [e];
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "key_rejected" });
      expect(t.errors).toEqual([e]);
    });

    it("when a campaign read is rejected too", async () => {
      const t = setup(5);
      t.deps.smartlead.getCampaign = async () => { throw new SmartleadApiError("nope", 403); };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "key_rejected" });
    });

    it("when Smartlead returns no per-lead map: nothing is marked, because an unmarked lead would be pushed again", async () => {
      const t = setup(5);
      t.sl.omitMap = true;
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "no_lead_map" });
      expect(t.marked()).toBe(0);
      expect(t.run.counts.added).toBe(0);
    });

    it("after marking, when Smartlead's account lead limit is used up, WITHOUT moving the cursor; a resume then finishes without re-sending", async () => {
      const t = setup(900);
      t.sl.limitExhausted = true;
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "smartlead_lead_limit" });
      expect(t.marked()).toBe(400);
      expect(t.run.counts.added).toBe(0);
      expect(t.run.cursor).toBeNull();
      t.sl.limitExhausted = false;
      t.run.status = "running"; t.run.leaseEpoch = 2;
      await expect(executeRun({ ...t.run }, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(t.sl.emails.size).toBe(900);
      expect(t.marked()).toBe(900);
      expect(t.run.counts.added + t.run.counts.alreadyInCampaign).toBe(900);
    });

    it("pauses (not completes) when the lead limit is hit on the LAST batch", async () => {
      const t = setup(5);
      t.sl.limitExhausted = true;
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "smartlead_lead_limit" });
      expect(t.run.status).toBe("paused");
    });
  });

  describe("what Smartlead does not accept", () => {
    it("does NOT move on past a lead Smartlead did not name when its tallies do not explain it (it may be in the campaign unmarked): retries, then stops as partial", async () => {
      const t = setup(5);
      t.sl.dropFromMap = new Set(["p2@example.com"]);
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "partial" });
      expect(t.run.cursor).toBeNull();
      expect(t.marked()).toBe(4); // the named ones are marked
      expect(t.sl.posts).toHaveLength(3); // each retry resent only what was not yet marked
      expect(t.sl.posts[1]).toEqual(["p2@example.com"]);
    });

    it("accepts a lead Smartlead did not name when its own tallies explain it (block list), counted and unmarked", async () => {
      const t = setup(5);
      t.sl.silentSkip = new Set(["p2@example.com"]); // a block-listed lead: not added, not named, only counted
      t.sl.tallies = { blockList: 1 };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(t.run.counts.skippedByReason.smartlead_skipped).toBe(1);
      expect(t.marked()).toBe(4);
    });

    it("does not mark a lead Smartlead lists under 'existing in other campaigns' but did not add (it would look pushed when it is not)", async () => {
      const t = setup(3);
      t.sl.skipButListOther = new Set(["p2@example.com"]);
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "other_campaign_leads" }); // unknowable, so a human decides
      expect(t.marked()).toBe(2);
      expect(isMarkedForCampaign(t.leads[1], CAMPAIGN)).toBe(false);
    });

    it("counts an address Smartlead called invalid, and does not mark it", async () => {
      const t = setup(5);
      t.sl.invalid = new Set(["p3@example.com"]);
      await executeRun(t.run, t.deps);
      expect(t.run.counts.skippedByReason.smartlead_invalid).toBe(1);
      expect(t.marked()).toBe(4);
    });
  });

  describe("review findings", () => {
    it("counts a lead its own run marked between the page read and the fresh re-read toward the ceiling", async () => {
      const t = setup(10, { run: { previewEligible: 5 } });
      t.deps.readLeadConsistent = async (_l, id) => {
        const l = t.leads.find(x => x.leadId === id)!;
        if (id === "lead_00001" || id === "lead_00002") {
          t.sl.emails.set(l.email, `own${id}`); // already in Smartlead, pushed by an older worker of this same run
          return { ...l, system: { [smartleadMarkerKey(CAMPAIGN)]: { state: "pushed", pushedAt: "x", runId: "run1", payloadHash: "h" } } };
        }
        return l;
      };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(t.sl.emails.size).toBe(5);
      expect(t.run.counts.alreadyInCampaign).toBe(2);
      expect(t.run.counts.skippedByReason.already_pushed).toBeUndefined();
    });

    it("reports a resumed run's own earlier markers as already in the campaign, not as skips", async () => {
      const t = setup(6);
      for (let i = 0; i < 3; i++) { t.leads[i].system = { [smartleadMarkerKey(CAMPAIGN)]: { state: "pushed", pushedAt: "x", runId: "run1", payloadHash: "h" } }; t.sl.emails.set(t.leads[i].email, `x${i}`); }
      await executeRun(t.run, t.deps);
      expect(t.run.counts.alreadyInCampaign).toBe(3);
      expect(t.run.counts.added).toBe(3);
      expect(t.run.counts.skippedByReason.already_pushed).toBeUndefined();
    });

    it("pauses for a human, never completes, when a lead listed only under 'other campaigns' may have been added without a marker", async () => {
      const t = setup(1);
      t.sl.extraOther = { "p1@example.com": "77" }; // Smartlead added it (the fake does) but names it only in the other-campaigns map
      t.sl.dropFromMap = new Set(["p1@example.com"]); // ...and not in the newly-added map
      t.sl.tallies = { inOtherCampaign: 1 };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "other_campaign_leads" });
      expect(t.sl.emails.size).toBe(1); // it IS in Smartlead, unmarked: exactly why a human must look
      expect(t.run.cursor).toBeNull();
      expect(t.run.status).toBe("paused");
    });

    it("a lead already in ANOTHER campaign is skipped and reported, not marked and not a pause (the live shape, 2026-10-28)", async () => {
      const t = setup(3);
      t.sl.skipButListOther = new Set(["p2@example.com"]); // Smartlead skips it and lists it under "other campaigns" with its existing id
      t.sl.tallies = { inOtherCampaign: 1 };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(isMarkedForCampaign(t.leads[1], CAMPAIGN)).toBe(false);
      expect(isMarkedForCampaign(t.leads[0], CAMPAIGN)).toBe(true);
      expect(isMarkedForCampaign(t.leads[2], CAMPAIGN)).toBe(true);
      expect(t.run.counts.skippedByReason).toMatchObject({ smartlead_in_other_campaign: 1 });
    });

    it("pauses when Smartlead names more 'other campaign' leads than it counts as skipped for that", async () => {
      const t = setup(3);
      t.sl.skipButListOther = new Set(["p2@example.com", "p3@example.com"]);
      t.sl.tallies = { inOtherCampaign: 1 };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "other_campaign_leads" });
    });

    it("a lead Smartlead ADDED but did not name is never explained away by a tally (other-campaign or block list): the batch is retried", async () => {
      for (const tallies of [{ inOtherCampaign: 1 }, { blockList: 1 }]) {
        const t = setup(3);
        t.sl.dropFromMap = new Set(["p2@example.com"]); // added, but missing from the map
        t.sl.tallies = tallies;
        const outcome = await executeRun(t.run, t.deps);
        expect(outcome.outcome).not.toBe("completed");
        expect(t.run.counts.skippedByReason.smartlead_skipped ?? 0).toBe(0);
      }
    });

    it("a lead counted as ALREADY in the campaign but not named is never accepted either", async () => {
      const first = setup(3);
      await expect(executeRun(first.run, first.deps)).resolves.toEqual({ outcome: "completed" }); // Smartlead now holds all three
      // A second run of the same three leads WITHOUT markers (e.g. they were lost), against the same Smartlead account.
      const second = setup(3);
      const deps = makeDeps(second.leads, first.sl, second.store);
      first.sl.dropFromMap = new Set(["p2@example.com"]); // counted as already in the campaign, but not named
      first.sl.tallies = { blockList: 1 }; // a tally that could "explain" one unnamed lead: it must not excuse a lead counted as in the campaign
      const outcome = await executeRun(second.run, deps);
      expect(outcome).toEqual({ outcome: "partial" }); // retried, never accepted
      expect(isMarkedForCampaign(second.leads[1], CAMPAIGN)).toBe(false);
      expect(second.run.counts.skippedByReason.smartlead_skipped ?? 0).toBe(0);
    });

    it("the other-campaign tally is matched to the leads it names: what is left can explain only that many unnamed skips", async () => {
      const t = setup(3);
      t.sl.skipButListOther = new Set(["p1@example.com"]); // named, counted
      t.sl.silentSkip = new Set(["p2@example.com"]);       // not named; the other-campaign tally of 1 is used up by p1
      t.sl.tallies = { inOtherCampaign: 1 };
      const outcome = await executeRun(t.run, t.deps);
      expect(outcome.outcome).not.toBe("completed"); // p2 is unexplained: retried, never accepted
      expect(isMarkedForCampaign(t.leads[1], CAMPAIGN)).toBe(false);
    });

    it("a lead named in THIS campaign and also listed under other campaigns is marked (it is in this campaign)", async () => {
      const t = setup(2);
      t.sl.extraOther = { "p1@example.com": "77" }; // named under other campaigns AND newly added here
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(isMarkedForCampaign(t.leads[0], CAMPAIGN)).toBe(true);
      expect(t.run.counts.skippedByReason.smartlead_in_other_campaign ?? 0).toBe(0);
    });

    it("trusts nothing in the 'other campaigns' map while Smartlead also reports leads skipped for being in other campaigns", async () => {
      const t = setup(3);
      t.sl.dropFromMap = new Set(["p2@example.com"]); // added by Smartlead but not named, which leaves room under the size bound
      t.sl.skipButListOther = new Set(["p3@example.com"]); // skipped, yet listed under "other campaigns"
      t.sl.tallies = { inOtherCampaign: 1, blockList: 1 };
      await executeRun(t.run, t.deps);
      expect(isMarkedForCampaign(t.leads[2], CAMPAIGN)).toBe(false);
    });

    it("never exceeds the approved count after a rebuilt batch: leads this run marked but never recorded count toward the ceiling", async () => {
      const t = setup(1000, { run: { previewEligible: 400 } });
      const write = t.deps.writeMarker;
      t.deps.writeMarker = async (l, id, k, m) => { if (id === "lead_00300" && t.sl.posts.length === 1) throw new Error("ddb down"); return write(l, id, k, m); };
      await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(t.sl.emails.size).toBe(400);
      expect(t.marked()).toBe(400);
      expect(t.run.counts.added + t.run.counts.alreadyInCampaign).toBe(400);
    });

    it("counts leads left marked by a paused-mid-POST run toward the ceiling on resume", async () => {
      const t = setup(1000, { run: { previewEligible: 400 } });
      t.sl.onPost = () => { t.run.status = "paused"; };
      await executeRun(t.run, t.deps);
      t.sl.onPost = undefined;
      t.run.status = "running"; t.run.leaseEpoch = 2;
      await expect(executeRun({ ...t.run }, t.deps)).resolves.toEqual({ outcome: "completed" });
      expect(t.sl.emails.size).toBe(400);
    });

    it("does not email an address that is opted out on ANOTHER record, wherever that record sits in the list (the pre-scan)", async () => {
      const leads: any[] = Array.from({ length: 900 }, (_, i) => mkLead(i + 1));
      leads[0] = mkLead(1, { email: "shared@example.com" });
      leads[700] = mkLead(701, { email: "shared@example.com", contactStatus: "do-not-contact" });
      const t = setup(899, { leads });
      await executeRun(t.run, t.deps);
      expect(t.sl.posts.flat()).not.toContain("shared@example.com");
    });

    it("keeps that suppression across a restart (a resume whose cursor is already past the opted-out record)", async () => {
      const leads: any[] = Array.from({ length: 10 }, (_, i) => mkLead(i + 1));
      leads[1] = mkLead(2, { email: "shared@example.com", contactStatus: "unsubscribed" });
      leads[6] = mkLead(7, { email: "shared@example.com" });
      const t = setup(9, { leads, run: { cursor: { listId: "L", leadId: "lead_00003" } } });
      await executeRun(t.run, t.deps);
      expect(t.sl.posts.flat()).not.toContain("shared@example.com");
    });

    it("re-runs the whole eligibility check on the fresh record: a bounce or an edited address after the page read is not sent", async () => {
      const t = setup(4);
      t.deps.readLeadConsistent = async (_l, id) => {
        const l = t.leads.find(x => x.leadId === id)!;
        if (id === "lead_00002") return { ...l, customFields: { email_validation: { status: "undeliverable" } } };
        if (id === "lead_00003") return { ...l, email: "bad address" };
        return l;
      };
      await executeRun(t.run, t.deps);
      expect(t.sl.posts.flat().sort()).toEqual(["p1@example.com", "p4@example.com"]);
    });

    it("marks every accepted lead even when renewing the lease throws a store error after the POST", async () => {
      const t = setup(5);
      let calls = 0;
      const hb = t.store.heartbeat.bind(t.store);
      t.store.heartbeat = async (id: string, e: number) => { if (t.sl.posts.length === 1 && ++calls > 0) throw new Error("ddb blip"); return hb(id, e); };
      await executeRun(t.run, t.deps).catch(() => undefined); // a later renewal may fail the run closed; what matters is the marking
      expect(t.marked()).toBe(5);
    });
  });

  it("pauses at the next batch when the operator's kill switch is on, and a resume carries on", async () => {
    const t = setup(900);
    let off = false;
    t.deps.isDisabled = () => off;
    t.sl.onPost = () => { off = true; };
    await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "disabled_by_operator" });
    expect(t.sl.posts).toHaveLength(1);
    expect(t.marked()).toBe(400); // the batch in flight was recorded first
    off = false; t.sl.onPost = undefined; t.run.status = "running"; t.run.leaseEpoch = 2;
    await expect(executeRun({ ...t.run }, t.deps)).resolves.toEqual({ outcome: "completed" });
    expect(t.sl.emails.size).toBe(900);
  });

  it("pauses at the next batch with the reason the permission check gives (a shared connection un-shared mid-run), keeping what was already added", async () => {
    const t = setup(900);
    let verdict: string | null = null;
    const asked: number[] = [];
    t.deps.stillPermitted = async () => { asked.push(t.sl.posts.length); return verdict; };
    t.sl.onPost = () => { verdict = "connection_unshared"; };
    await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "paused", reason: "connection_unshared" });
    expect(t.sl.posts).toHaveLength(1);
    expect(t.marked()).toBe(400); // the batch in flight was recorded first
    expect(asked).toEqual([0, 1]); // asked before every batch
  });

  it("a permission check that always passes changes nothing", async () => {
    const t = setup(900);
    t.deps.stillPermitted = async () => null;
    await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
    expect(t.sl.emails.size).toBe(900);
  });

  it("completes an empty list without calling Smartlead's add", async () => {
    const t = setup(0, { leads: [] });
    await expect(executeRun(t.run, t.deps)).resolves.toEqual({ outcome: "completed" });
    expect(t.sl.posts).toHaveLength(0);
  });

  it("renews its lease between phases of a big batch", async () => {
    const t = setup(400);
    await executeRun(t.run, t.deps);
    expect(t.store.heartbeats).toBeGreaterThanOrEqual(8);
  });

  it("pins the cohort to the PREVIEW time: a lead created after the user previewed (but before the run started) is not pushed", async () => {
    const leads = [mkLead(1, { createdAt: "2026-10-27T00:30:00.000Z" }), mkLead(2, { createdAt: "2026-10-27T00:10:00.000Z" }), mkLead(3, { createdAt: "2026-10-26T12:00:00.000Z" })];
    const t = setup(2, { leads, run: { startedAt: "2026-10-27T00:40:00.000Z", options: { includeUnverified: false, mapping: {}, startStatus: "DRAFTED", approvedAt: "2026-10-27T00:20:00.000Z" } } });
    await executeRun(t.run, t.deps);
    expect(t.sl.posts.flat().sort()).toEqual(["p2@example.com", "p3@example.com"]); // lead 1 appeared after the preview
    expect(t.run.counts.skippedByReason.created_after_start).toBe(1);
  });

  it("falls back to the run start when no preview time was recorded", async () => {
    const t = setup(1, { leads: [mkLead(1, { createdAt: "2026-10-27T00:30:00.000Z" })], run: { startedAt: "2026-10-27T00:40:00.000Z" } });
    await executeRun(t.run, t.deps);
    expect(t.sl.posts.flat()).toEqual(["p1@example.com"]);
  });

  it("reads the approved options defensively", () => {
    expect(readPushOptions({ includeUnverified: "yes", mapping: { industry: "customFields.industry", bad: 5 }, startStatus: "drafted" })).toEqual({ includeUnverified: false, mapping: { industry: "customFields.industry" }, startStatus: "DRAFTED" });
    expect(readPushOptions(undefined)).toEqual({ includeUnverified: false, mapping: {}, startStatus: "" });
    expect(readPushOptions({ approvedAt: "2026-10-27T00:20:00.000Z" }).approvedAt).toBe("2026-10-27T00:20:00.000Z");
    expect(readPushOptions({ approvedAt: "not a date" }).approvedAt).toBeUndefined();
    expect(readPushOptions({ approvedAt: 5 }).approvedAt).toBeUndefined();
  });
});
