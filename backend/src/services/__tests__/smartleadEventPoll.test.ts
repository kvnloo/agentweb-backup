import { eventPoll, __pendingBounceCount, __resetEventPoll, type PollDeps } from "../smartleadEventPoll";
import type { SmartleadEvent } from "../smartleadEvents";
import { SmartleadApiError } from "../smartleadService";

const T0 = Date.parse("2026-10-30T12:00:00.000Z");
let clock = T0;
const run = (runId: string, campaignId: number, over: Record<string, unknown> = {}) => ({ runId, campaignId, listId: "L1", status: "completed", ...over });

interface World {
  runs: any[];
  campaigns: Record<number, { status: string } | null>;
  /** status -> campaign -> rows */
  leads: Record<string, Record<number, Array<{ leadId: string; email: string; unsubscribed: boolean }>>>;
  handled: Array<{ ctx: any; event: SmartleadEvent }>;
  logs: string[];
  keyOk: boolean;
  listFails?: number;
  failStatus?: number;
  campaignSize?: number;
  /** Smartlead statuses whose read fails (a rate limit, a timeout). */
  failOn?: string[];
  calls: string[];
}
const world = (over: Partial<World> = {}): World => ({ runs: [run("r1", 77)], campaigns: { 77: { status: "ACTIVE" } }, leads: {}, handled: [], logs: [], keyOk: true, calls: [], ...over });

function deps(w: World, extra: Partial<PollDeps> = {}): PollDeps {
  return {
    db: {
      listRunsSince: async () => w.runs,
      getRun: async id => ({ runId: id, keyOwnerId: "u1", smartleadAccountId: "smartlead-u1" } as any),
    },
    resolveKey: async () => (w.keyOk ? ({ ok: true, apiKey: "KEY" } as any) : ({ ok: false, reason: "not_connected", message: "" } as any)),
    reportFailure: async () => undefined,
    smartlead: {
      campaignStatus: async (_k, c) => w.campaigns[c]?.status ?? null,
      listLeads: async (_k, c, status, offset, limit) => {
        w.calls.push(`${c}:${status}:${offset}`);
        if (w.failOn?.includes(String(status))) throw new SmartleadApiError("smartlead 429 api_key=SECRETKEY", 429);
        if (w.listFails && limit !== 1) { w.listFails--; throw new SmartleadApiError("smartlead 500 api_key=SECRETKEY", w.failStatus ?? 500); }
        // The campaign's own size (the plain listing) is bigger than any filtered answer unless a test says otherwise.
        if (status === null && !w.leads["null"]?.[c]) return { total: w.campaignSize ?? 1000, rows: [] };
        const all = w.leads[String(status)]?.[c] ?? [];
        return { total: all.length, rows: all.slice(offset, offset + limit) };
      },
    },
    events: { handle: async (ctx, event) => { w.handled.push({ ctx, event }); return { matched: 1, changed: 1, duplicates: 0 }; } },
    now: () => new Date(clock),
    log: l => w.logs.push(l),
    bounceConfirmAfterMs: 0, // most tests are not about the wait for a second sighting; the tests of it switch it back on
    ...extra,
  };
}
const rows = (n: number, prefix = "p", unsubscribed = false) => Array.from({ length: n }, (_, i) => ({ leadId: `${prefix}${i}`, email: `${prefix}${i}@example.com`, unsubscribed }));

beforeEach(() => { __resetEventPoll(); clock = T0; });

describe("the hourly event poll (ENG-673)", () => {
  it("feeds every contact Smartlead lists as unsubscribed, bounced or replied through the same handler, marked as polled", async () => {
    const w = world({ leads: { is_unsubscribed: { 77: rows(1, "u", true) }, is_bounced: { 77: rows(2, "b") }, is_replied: { 77: rows(1, "r") } } });
    const out = await eventPoll(deps(w));
    expect(out).toMatchObject({ campaigns: 1, checked: 4, changed: 4, errors: 0 });
    expect(w.handled.map(h => h.event.kind)).toEqual(["unsubscribe", "bounce", "bounce", "reply"]);
    expect(w.handled.every(h => h.event.polled === true && h.event.soft === false && h.ctx.accountId === "smartlead-u1" && h.ctx.campaignId === 77)).toBe(true);
    expect(w.handled[0].event).toMatchObject({ candidateEmails: ["u0@example.com"], eventKey: "poll:unsubscribe:77:u0" });
  });

  it("reads replies and bounces with a status filter, and opt-outs both filtered and from the plain listing", async () => {
    const w = world();
    await eventPoll(deps(w));
    expect(w.calls.map(c => c.split(":")[1]).sort()).toEqual(["is_bounced", "is_replied", "is_unsubscribed", "null", "null"]); // the second null is the campaign's size; the sender-side list is read only when something bounced
  });

  it("recovers an opt-out Smartlead's own filter does not list: a plain-listing row flagged unsubscribed (live finding), and skips unflagged rows", async () => {
    const w = world({ leads: { null: { 77: [...rows(2, "ok"), ...rows(1, "gone", true)] } } });
    const out = await eventPoll(deps(w));
    expect(out.checked).toBe(1);
    expect(w.handled).toHaveLength(1);
    expect(w.handled[0].event).toMatchObject({ kind: "unsubscribe", candidateEmails: ["gone0@example.com"], eventKey: "poll:unsubscribe:77:gone0", polled: true });
  });

  it("a contact listed by both opt-out reads is handled once", async () => {
    const w = world({ leads: { is_unsubscribed: { 77: rows(1, "x", true) }, null: { 77: rows(1, "x", true) } } });
    await eventPoll(deps(w));
    expect(w.handled).toHaveLength(1);
  });

  it("does not look at the same contact again within six hours, and does again after", async () => {
    const w = world({ leads: { is_bounced: { 77: rows(2) } } });
    await eventPoll(deps(w));
    await eventPoll(deps(w));
    expect(w.handled).toHaveLength(2);
    clock += 7 * 60 * 60 * 1000;
    await eventPoll(deps(w));
    expect(w.handled).toHaveLength(4);
  });

  it("polls a campaign once however many runs went into it, and each campaign with its own key lookup", async () => {
    const w = world({ runs: [run("r3", 77), run("r2", 88), run("r1", 77)], campaigns: { 77: { status: "ACTIVE" }, 88: { status: "COMPLETED" } } });
    const out = await eventPoll(deps(w));
    expect(out.campaigns).toBe(2);
    expect(new Set(w.calls.map(c => c.split(":")[0]))).toEqual(new Set(["77", "88"]));
  });

  it("skips only a campaign that is gone; a drafted, archived or stopped one is still read (an opt-out recorded in Smartlead must reach the CRM whatever its status)", async () => {
    const w = world({ runs: [run("a", 1), run("b", 2), run("c", 3), run("d", 4)], campaigns: { 1: null, 2: { status: "DRAFTED" }, 3: { status: "ARCHIVED" }, 4: { status: "STOPPED" } } });
    await eventPoll(deps(w));
    expect(new Set(w.calls.map(c => c.split(":")[0]))).toEqual(new Set(["2", "3", "4"]));
  });

  it("leaves a campaign alone when no key of theirs can be used (the withdrawal sweep already says why)", async () => {
    const w = world({ keyOk: false });
    const out = await eventPoll(deps(w));
    expect(out).toMatchObject({ campaigns: 0, keyUnavailable: 1, errors: 0 });
    expect(w.calls).toEqual([]);
  });

  it("pages through a long answer", async () => {
    const w = world({ leads: { is_replied: { 77: rows(250) } } });
    await eventPoll(deps(w));
    expect(w.handled.filter(h => h.event.kind === "reply")).toHaveLength(250);
    expect(w.calls.filter(c => c.includes("is_replied"))).toEqual(["77:is_replied:0", "77:is_replied:100", "77:is_replied:200"]);
  });

  it("stops at the page limit and says so, once a day", async () => {
    const w = world({ leads: { is_replied: { 77: rows(450) } } });
    await eventPoll(deps(w, { maxPages: 2 }));
    expect(w.handled.filter(h => h.event.kind === "reply")).toHaveLength(200);
    expect(w.logs.filter(l => l.includes("the rest are not polled"))).toHaveLength(1);
    await eventPoll(deps(w, { maxPages: 2 }));
    expect(w.logs.filter(l => l.includes("the rest are not polled"))).toHaveLength(1);
  });

  it("only looks at the newest campaigns when there are too many, and says so", async () => {
    const w = world({ runs: [run("a", 1), run("b", 2), run("c", 3)], campaigns: { 1: { status: "ACTIVE" }, 2: { status: "ACTIVE" }, 3: { status: "ACTIVE" } } });
    const out = await eventPoll(deps(w, { maxCampaigns: 2 }));
    expect(out.campaigns).toBe(2);
    expect(w.logs.join("\n")).toContain("only the 2 waiting longest are polled");
  });

  it("one failing campaign does not stop the others, and the error is logged without the key", async () => {
    const w = world({ runs: [run("a", 1), run("b", 2)], campaigns: { 1: { status: "ACTIVE" }, 2: { status: "ACTIVE" } }, leads: { is_unsubscribed: { 2: rows(1, "u", true) } }, listFails: 1 });
    const out = await eventPoll(deps(w));
    expect(out.errors).toBe(1);
    expect(w.handled).toHaveLength(1);
    expect(w.logs.join("\n")).toContain("campaign=1");
    expect(w.logs.join("\n")).not.toContain("SECRETKEY");
  });

  it("one contact that cannot be handled does not stop the rest of its campaign, is counted, and the log never carries the key", async () => {
    const w = world({ leads: { is_bounced: { 77: rows(3) }, is_replied: { 77: rows(1, "r") } } });
    let n = 0;
    const out = await eventPoll(deps(w, { events: { handle: async (ctx, event) => { n++; if (event.eventKey.endsWith(":p1")) throw new Error("db down api_key=SECRETKEY"); w.handled.push({ ctx, event }); return { matched: 1, changed: 1, duplicates: 0 }; } } }));
    expect(out.errors).toBe(1);
    expect(n).toBe(4); // every contact was tried, including the ones after the failing one and the next status
    expect(w.handled).toHaveLength(3);
    expect(w.logs.join("\n")).toContain("one contact could not be handled");
    expect(w.logs.join("\n")).not.toContain("SECRETKEY");
  });

  it("when there are more campaigns than a pass covers, the ones waiting longest go first, so none starve", async () => {
    const campaigns = { 1: { status: "ACTIVE" }, 2: { status: "ACTIVE" }, 3: { status: "ACTIVE" } };
    const w = world({ runs: [run("a", 1), run("b", 2), run("c", 3)], campaigns });
    await eventPoll(deps(w, { maxCampaigns: 2 }));
    expect(new Set(w.calls.map(c => c.split(":")[0]))).toEqual(new Set(["1", "2"]));
    w.calls.length = 0;
    clock += 60 * 60 * 1000;
    await eventPoll(deps(w, { maxCampaigns: 2 }));
    expect(w.calls.some(c => c.startsWith("3:"))).toBe(true); // campaign 3 is reached on the next pass
    expect(w.calls.some(c => c.startsWith("2:"))).toBe(false);
  });

  it("a refused key is reported to the connection (so it gets flagged) and stops that campaign; the pass goes on", async () => {
    const reported: unknown[] = [];
    const w = world({ runs: [run("a", 1), run("b", 2)], campaigns: { 1: { status: "ACTIVE" }, 2: { status: "ACTIVE" } }, listFails: 1, failStatus: 401 });
    const out = await eventPoll(deps(w, { reportFailure: async (_r, e) => { reported.push(e); } }));
    expect(out.errors).toBe(1);
    expect(reported).toHaveLength(1);
    expect(w.calls.filter(c => c.startsWith("1:"))).toHaveLength(2); // the size read, then the refused one; nothing more was asked with that key
    expect(w.calls.filter(c => c.startsWith("2:"))).toHaveLength(5);
  });

  it("one failed read costs only that read: the other kinds of event are still asked for", async () => {
    const w = world({ leads: { is_bounced: { 77: rows(1, "b") }, is_replied: { 77: rows(1, "r") } }, listFails: 1 });
    const out = await eventPoll(deps(w));
    expect(out.errors).toBe(1);
    expect(w.handled.map(h => h.event.kind)).toEqual(["bounce", "reply"]);
    expect(w.logs.join("\n")).toContain("could not read");
    expect(w.logs.join("\n")).not.toContain("SECRETKEY");
  });

  it("campaigns with no usable key do not stay at the front of the queue and starve the others", async () => {
    const w = world({ runs: [run("bad1", 1), run("bad2", 2), run("good", 3)], campaigns: { 1: { status: "ACTIVE" }, 2: { status: "ACTIVE" }, 3: { status: "ACTIVE" } } });
    const d = deps(w, {
      maxCampaigns: 2,
      db: { listRunsSince: async () => w.runs, getRun: async id => ({ runId: id, keyOwnerId: id, smartleadAccountId: "smartlead-u1" } as any) },
      resolveKey: async owner => (owner === "good" ? ({ ok: true, apiKey: "KEY" } as any) : ({ ok: false, reason: "not_connected", message: "" } as any)),
    });
    await eventPoll(d);
    expect(w.calls).toEqual([]);
    clock += 60 * 60 * 1000;
    await eventPoll(d);
    expect(w.calls.some(c => c.startsWith("3:"))).toBe(true);
  });

  it("says so, once a day, when the key cannot see a campaign", async () => {
    const w = world({ campaigns: { 77: null } });
    await eventPoll(deps(w));
    await eventPoll(deps(w));
    expect(w.logs.filter(l => l.includes("cannot see this campaign"))).toHaveLength(1);
  });

  it("a contact whose handling failed is tried again on the next pass, not after six hours", async () => {
    const w = world({ leads: { is_unsubscribed: { 77: rows(1, "u", true) } } });
    let fail = true;
    const d = deps(w, { events: { handle: async (ctx, event) => { if (fail) throw new Error("dynamo down"); w.handled.push({ ctx, event }); return { matched: 1, changed: 1, duplicates: 0 }; } } });
    expect((await eventPoll(d)).errors).toBe(1);
    fail = false;
    clock += 60 * 60 * 1000; // the next hourly pass
    const out = await eventPoll(d);
    expect(out.changed).toBe(1);
    expect(w.handled).toHaveLength(1);
  });

  it("a contact that matched nobody in the CRM is looked at again after two hours (not every hourly pass), one that matched after six hours", async () => {
    const w = world({ leads: { is_bounced: { 77: rows(1, "b") }, is_replied: { 77: rows(1, "r") } } });
    const d = deps(w, { events: { handle: async (ctx, event) => { w.handled.push({ ctx, event }); return { matched: event.kind === "bounce" ? 1 : 0, changed: 0, duplicates: 0 }; } } });
    await eventPoll(d);
    expect(w.handled).toHaveLength(2);
    clock += 61 * 60 * 1000; // the next hourly pass: nothing is repeated
    await eventPoll(d);
    expect(w.handled).toHaveLength(2);
    clock += 61 * 60 * 1000; // two hours on: only the unmatched one again
    await eventPoll(d);
    expect(w.handled.map(h => h.event.kind)).toEqual(["bounce", "reply", "reply"]);
    clock += 6 * 60 * 60 * 1000;
    await eventPoll(d);
    expect(w.handled).toHaveLength(5);
  });

  it("refuses a filtered answer that lists the whole campaign (a status filter Smartlead ignored), and acts on nobody from it", async () => {
    const w = world({ campaignSize: 40, leads: { is_bounced: { 77: rows(40, "b") }, is_replied: { 77: rows(2, "r") } } });
    const out = await eventPoll(deps(w));
    expect(w.handled.map(h => h.event.kind)).toEqual(["reply", "reply"]); // no bounce was acted on; the believable reply answer (2 of 40) is still used
    expect(out.errors).toBe(1);
    expect(w.logs.join("\n")).toContain("treated as an ignored filter");
  });

  it("a bounce from OUR sending side is not the contact's: only contacts in the bounced list and NOT in the sender-side list are acted on", async () => {
    const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(6, "b") }, is_sender_bounced: { 77: rows(4, "b") } } });
    await eventPoll(deps(w));
    expect(w.handled.filter(h => h.event.kind === "bounce").map(h => h.event.eventKey)).toEqual(["poll:bounce:77:b4", "poll:bounce:77:b5"]);
  });

  it("when every bounced contact is sender-side, nothing is blocked (the real shape: 41 of 57 on one campaign)", async () => {
    const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(41, "b") }, is_sender_bounced: { 77: rows(41, "b") } } });
    await eventPoll(deps(w));
    expect(w.handled.filter(h => h.event.kind === "bounce")).toHaveLength(0);
  });

  it("if the sender-side list cannot be read, NO bounce is acted on that pass (opt-outs and replies still are), and it is said once", async () => {
    const w = world({ campaignSize: 1000, failOn: ["is_sender_bounced"], leads: { is_bounced: { 77: rows(3, "b") }, is_replied: { 77: rows(1, "r") }, is_unsubscribed: { 77: rows(1, "u", true) } } });
    const out = await eventPoll(deps(w));
    await eventPoll(deps(w));
    expect(w.handled.map(h => h.event.kind)).toEqual(["unsubscribe", "reply"]); // once each: the second pass repeats nothing
    expect(out.errors).toBeGreaterThan(0);
    expect(w.logs.filter(l => l.includes("sender-side bounces are not known"))).toHaveLength(1);
    expect(w.logs.join("\n")).not.toContain("SECRETKEY");
  });

  it("if there are more sender-side bounces than are read, the exclusion cannot be proven, so no bounce is acted on", async () => {
    // the sender-side list (150) is longer than the one page read; the first page of bounces (b0-b99) overlaps only part of what WAS read (b50-b149)
    const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(200, "b") }, is_sender_bounced: { 77: rows(200, "b").slice(50) } } });
    await eventPoll(deps(w, { maxPages: 1 }));
    expect(w.handled.filter(h => h.event.kind === "bounce")).toHaveLength(0);
  });

  describe("a genuine-looking bounce is acted on only when it looks so on two passes", () => {
    const hour = 60 * 60 * 1000;
    const on = { bounceConfirmAfterMs: undefined as unknown as number }; // the default wait

    it("first sighting: nothing; the next hourly pass: acted on once; a later pass repeats nothing", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(2, "b") } } });
      const d = deps(w, on);
      await eventPoll(d);
      expect(w.handled).toHaveLength(0);
      clock += hour;
      await eventPoll(d);
      expect(w.handled.map(h => h.event.eventKey)).toEqual(["poll:bounce:77:b0", "poll:bounce:77:b1"]);
      clock += hour;
      await eventPoll(d);
      expect(w.handled).toHaveLength(2);
    });

    it("if the contact turns up as sender-side in between (the flag arrived later), it is never acted on", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(2, "b") } } });
      const d = deps(w, on);
      await eventPoll(d);
      w.leads.is_sender_bounced = { 77: rows(1, "b") }; // b0 is now flagged sender-side
      clock += hour;
      await eventPoll(d);
      expect(w.handled.map(h => h.event.eventKey)).toEqual(["poll:bounce:77:b1"]);
      w.leads.is_sender_bounced = { 77: [] }; // even if the flag later disappears, b0 starts its wait again
      clock += hour;
      await eventPoll(d);
      expect(w.handled.map(h => h.event.eventKey)).toEqual(["poll:bounce:77:b1"]);
    });

    it("two passes closer together than the wait do not act", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      const d = deps(w, on);
      await eventPoll(d);
      clock += 10 * 60 * 1000;
      await eventPoll(d);
      expect(w.handled).toHaveLength(0);
    });

    it("a contact that left the bounced list and came back much later starts its wait again: an old first sighting is not the second one", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      const d = deps(w, on);
      await eventPoll(d); // first sighting
      w.leads.is_bounced = { 77: [] }; // it drops out of the list...
      clock += 2 * hour; await eventPoll(d);
      w.leads.is_bounced = { 77: rows(1, "b") }; // ...and is back 13 hours after it was last seen
      clock += 13 * hour; await eventPoll(d);
      expect(w.handled).toHaveLength(0); // a new first sighting, not an acted-on second
      clock += hour; await eventPoll(d);
      expect(w.handled.map(h => h.event.eventKey)).toEqual(["poll:bounce:77:b0"]); // the real second sighting
    });

    it("a contact seen every hour while its handling keeps failing is not made to start over: the 'last seen' time keeps moving", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      let fail = true;
      let attempts = 0;
      const d = deps(w, { ...on, events: { handle: async (ctx, event) => { attempts++; if (fail) throw new Error("db down"); w.handled.push({ ctx, event }); return { matched: 1, changed: 1, duplicates: 0 }; } } });
      await eventPoll(d); // first sighting
      for (let i = 0; i < 13; i++) { clock += hour; await eventPoll(d); } // 13 hours of failures, seen every hour
      expect(attempts).toBe(13); // tried on every one of those passes: the wait was never restarted as stale (it restarts silently, with no attempt, if 'last seen' does not move)
      fail = false;
      clock += hour; await eventPoll(d);
      expect(w.handled).toHaveLength(1);
    });

    it("records of contacts not seen for a day are dropped (the map cannot fill with contacts that left the list); a recent one is kept", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      const d = deps(w, on);
      await eventPoll(d);
      expect(__pendingBounceCount()).toBe(1);
      w.leads.is_bounced = { 77: [] };
      clock += 13 * hour; await eventPoll(d);
      expect(__pendingBounceCount()).toBe(1); // 13 h unseen: stale for the wait, but not yet dropped
      clock += 12 * hour; await eventPoll(d);
      expect(__pendingBounceCount()).toBe(0); // 25 h unseen: gone
    });

    it("the sweep goes by when a contact was last SEEN, not first: one bounced and failing for 30 hours keeps its record", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      let attempts = 0;
      const d = deps(w, { ...on, events: { handle: async () => { attempts++; throw new Error("db down"); } } });
      await eventPoll(d);
      for (let i = 0; i < 30; i++) { clock += hour; await eventPoll(d); }
      expect(__pendingBounceCount()).toBe(1);
      expect(attempts).toBe(30); // tried on every pass after the first: a sweep by first-seen would have deleted the record at 25 h and restarted the wait (one pass without an attempt)
    });

    it("a campaign polled only every few passes still completes its wait (the wait is not restarted by a 3 h gap)", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      const d = deps(w, on);
      await eventPoll(d);
      clock += 3 * hour; await eventPoll(d);
      expect(w.handled).toHaveLength(1);
    });

    it("a contact whose handling failed keeps its wait, so the next pass retries at once", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      let fail = true;
      const d = deps(w, { ...on, events: { handle: async (ctx, event) => { if (fail) throw new Error("db down"); w.handled.push({ ctx, event }); return { matched: 1, changed: 1, duplicates: 0 }; } } });
      await eventPoll(d);
      clock += hour; expect((await eventPoll(d)).errors).toBe(1);
      fail = false;
      clock += 5 * 60 * 1000; await eventPoll(d); // five minutes later, not another hour
      expect(w.handled).toHaveLength(1);
    });

    it("a sender-side list that cannot be read leaves the waits alone and acts on nothing", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      const d = deps(w, on);
      await eventPoll(d); // first sighting recorded
      w.failOn = ["is_sender_bounced"];
      clock += hour; const out = await eventPoll(d);
      expect(w.handled).toHaveLength(0);
      expect(out.errors).toBeGreaterThan(0);
      w.failOn = [];
      clock += 5 * 60 * 1000; await eventPoll(d); // the wait was not lost
      expect(w.handled).toHaveLength(1);
    });

    it("a restart (nothing remembered) starts the wait again", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(1, "b") } } });
      const d = deps(w, on);
      await eventPoll(d);
      __resetEventPoll();
      clock += hour;
      await eventPoll(d);
      expect(w.handled).toHaveLength(0);
    });

    it("opt-outs and replies are not made to wait", async () => {
      const w = world({ campaignSize: 1000, leads: { is_unsubscribed: { 77: rows(1, "u", true) }, is_replied: { 77: rows(1, "r") } } });
      await eventPoll(deps(w, on));
      expect(w.handled.map(h => h.event.kind)).toEqual(["unsubscribe", "reply"]);
    });
  });

  describe("reading Smartlead's sender-side list", () => {
    it("is skipped when nothing bounced: no extra read, and a failing read costs nothing", async () => {
      const w = world({ campaignSize: 1000, failOn: ["is_sender_bounced"], leads: { is_replied: { 77: rows(1, "r") } } });
      const out = await eventPoll(deps(w));
      expect(w.calls.some(c => c.includes("is_sender_bounced"))).toBe(false);
      expect(out.errors).toBe(0);
    });

    it("is read across pages: sender-side contacts on the second page are excluded too", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(150, "b").slice(0, 100) }, is_sender_bounced: { 77: rows(150, "b") } } });
      await eventPoll(deps(w));
      expect(w.handled.filter(h => h.event.kind === "bounce")).toHaveLength(0); // all 100 listed bounces are among the 150 sender-side ones
      expect(w.calls.filter(c => c.includes("is_sender_bounced"))).toEqual(["77:is_sender_bounced:0", "77:is_sender_bounced:100"]);
    });

    it("exactly the pages it may read is complete; one more contact than that is not", async () => {
      const exact = world({ campaignSize: 5000, leads: { is_bounced: { 77: rows(150, "b") }, is_sender_bounced: { 77: rows(200, "s") } } });
      await eventPoll(deps(exact, { maxPages: 2 }));
      expect(exact.handled.filter(h => h.event.kind === "bounce").length).toBeGreaterThan(0); // 200 sender-side rows = 2 pages: complete, so bounces go ahead
      const over = world({ campaignSize: 5000, leads: { is_bounced: { 77: rows(150, "b") }, is_sender_bounced: { 77: rows(201, "s") } } });
      await eventPoll(deps(over, { maxPages: 2 }));
      expect(over.handled.filter(h => h.event.kind === "bounce")).toHaveLength(0); // 201 > 2 pages: cannot be proven, nothing acted on
    });

    it("an empty page before the end of the sender-side list means it is incomplete: no bounce is acted on", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(2, "b") }, is_sender_bounced: { 77: rows(250, "s") } } });
      const d = deps(w);
      const real = d.smartlead.listLeads;
      d.smartlead.listLeads = async (k, c, status, offset, limit) => { const r = await real(k, c, status, offset, limit); return status === "is_sender_bounced" && offset >= 100 ? { total: r.total, rows: [] } : r; };
      await eventPoll(d);
      expect(w.handled.filter(h => h.event.kind === "bounce")).toHaveLength(0);
    });

    it("a sender-side list that is null stops only the bounce kind: it is read once, not once per page, and replies still come through", async () => {
      const w = world({ campaignSize: 1000, failOn: ["is_sender_bounced"], leads: { is_bounced: { 77: rows(250, "b") }, is_replied: { 77: rows(1, "r") } } });
      await eventPoll(deps(w));
      expect(w.calls.filter(c => c.includes("is_sender_bounced"))).toHaveLength(1);
      expect(w.calls.filter(c => c.includes("is_bounced"))).toHaveLength(1);
      expect(w.handled.map(h => h.event.kind)).toEqual(["reply"]);
    });

    it("a sender-side contact that is not in the bounced list changes nothing", async () => {
      const w = world({ campaignSize: 1000, leads: { is_bounced: { 77: rows(2, "b") }, is_sender_bounced: { 77: rows(1, "x") } } });
      await eventPoll(deps(w));
      expect(w.handled.filter(h => h.event.kind === "bounce")).toHaveLength(2);
    });
  });

  it("a small pilot campaign is protected too: a bounce filter that listed all 6 of 6 contacts is refused", async () => {
    const w = world({ campaignSize: 6, leads: { is_bounced: { 77: rows(6, "b") } } });
    const out = await eventPoll(deps(w));
    expect(w.handled).toHaveLength(0);
    expect(out.errors).toBe(1);
    expect(w.logs.join("\n")).toContain("treated as an ignored filter");
  });

  it("the guard's minimum is exactly 5: all 4 of 4 are acted on, all 5 of 5 are refused", async () => {
    const four = world({ campaignSize: 4, leads: { is_bounced: { 77: rows(4, "b") } } });
    await eventPoll(deps(four));
    expect(four.handled.filter(h => h.event.kind === "bounce")).toHaveLength(4);
    const five = world({ campaignSize: 5, leads: { is_bounced: { 77: rows(5, "b") } } });
    await eventPoll(deps(five));
    expect(five.handled).toHaveLength(0);
  });

  it("without the campaign's size, bounces and replies are NOT polled (nothing guards a filter that was ignored), opt-outs still are, and it is said once a day", async () => {
    const w = world({ leads: { is_bounced: { 77: rows(1, "b") }, is_replied: { 77: rows(1, "r") }, is_unsubscribed: { 77: rows(1, "u", true) } } });
    const real = w.campaignSize;
    const d = deps(w);
    const failing = { ...d, smartlead: { ...d.smartlead, listLeads: async (k: string, c: number, status: any, o: number, l: number) => { if (status === null && l === 1) throw new SmartleadApiError("smartlead 500 api_key=SECRETKEY", 500); return d.smartlead.listLeads(k, c, status, o, l); } } };
    await eventPoll(failing); await eventPoll(failing);
    expect(real).toBeUndefined();
    expect(w.handled.map(h => h.event.kind)).toEqual(["unsubscribe"]);
    expect(w.logs.filter(l => l.includes("could not read the campaign's size"))).toHaveLength(1);
    expect(w.logs.join("\n")).not.toContain("SECRETKEY");
  });

  it("says once a day when contacts come back from the unsubscribed filter without the flag (so a flag that link-unsubscribes do not set would show)", async () => {
    const w = world({ leads: { is_unsubscribed: { 77: rows(3, "u", false) } } });
    await eventPoll(deps(w));
    await eventPoll(deps(w));
    expect(w.logs.filter(l => l.includes("without the unsubscribed flag set"))).toHaveLength(1);
    expect(w.handled).toHaveLength(0);
  });

  it("an opt-out is believed only when the contact's own flag is set, whichever read found it", async () => {
    const w = world({ leads: { is_unsubscribed: { 77: rows(2, "u", false) } } });
    await eventPoll(deps(w));
    expect(w.handled).toHaveLength(0);
  });

  it("does nothing without runs", async () => {
    const w = world({ runs: [] });
    expect(await eventPoll(deps(w))).toMatchObject({ campaigns: 0, checked: 0 });
  });
});
