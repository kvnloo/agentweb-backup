import { SmartleadEventService, type EventDeps } from "../smartleadEventService";
import { parseSmartleadEvent, type SmartleadEvent } from "../smartleadEvents";

const ACCOUNT = "smartlead-u1";
const CAMPAIGN = 77;
const marker = (runId: string, state = "pushed") => ({ runId, state, email: "x", payloadHash: "h", pushedAt: "2026-10-29T10:00:00.000Z" });

interface World {
  leads: Record<string, any>[];
  runs: Record<string, { smartleadAccountId?: string; campaignId?: number; campaignName?: string }>;
  notified: any[];
  statusWrites: any[];
  appended: any[];
  raceOnce?: boolean;
  raceAlways?: boolean;
  notifyThrows?: boolean;
  /** When set, the run counter is wired and every call lands here (with how many status writes had been made at that moment). */
  counted?: Array<{ runId: string; kind: string; statusWritesSoFar: number }>;
  countThrows?: boolean;
  /** The counter never answers. */
  countHangs?: boolean;
  /** The first status write fails (a retry then finds the engagement already recorded). */
  statusFailsOnce?: boolean;
  /** The status write for this list always fails. */
  statusFailsFor?: string;
}
const lead = (listId: string, leadId: string, email: string, over: Record<string, any> = {}) => ({ listId, leadId, email, updatedAt: "2026-10-29T10:00:00.000Z", engagements: [], system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") }, ...over });

function make(w: World) {
  const deps: EventDeps = {
    findLeadsByEmail: async email => w.leads.filter(l => l.email === email),
    getRun: async id => w.runs[id] ?? null,
    getList: async listId => ({ listId, userId: "owner" }),
    readLeadConsistent: async (listId, leadId) => w.leads.find(l => l.listId === listId && l.leadId === leadId) ?? null,
    addEngagement: async (listId, leadId, engagement, opts) => {
      const l = w.leads.find(x => x.listId === listId && x.leadId === leadId)!;
      if (w.raceAlways || (w.raceOnce && !(w as any).raced)) {
        (w as any).raced = true;
        l.updatedAt = "2026-10-29T10:00:05.000Z"; // somebody else wrote
        throw Object.assign(new Error("race"), { preconditionFailed: true });
      }
      if (opts.expectedUpdatedAt !== undefined && opts.expectedUpdatedAt !== l.updatedAt) throw Object.assign(new Error("race"), { preconditionFailed: true });
      l.engagements = [...(l.engagements ?? []), engagement];
      l.updatedAt = new Date(Date.parse(l.updatedAt) + 1000).toISOString();
      w.appended.push({ listId, leadId, ...engagement });
    },
    setContactStatus: async (listId, leadId, fields) => {
      if (w.statusFailsFor === listId) throw new Error("db down for this list");
      if (w.statusFailsOnce && !(w as any).statusFailed) { (w as any).statusFailed = true; throw new Error("db blip"); }
      const l = w.leads.find(x => x.listId === listId && x.leadId === leadId)!;
      Object.assign(l, fields);
      w.statusWrites.push({ listId, leadId, ...fields });
    },
    notify: async (list, l, type, data, at) => {
      if (w.notifyThrows) throw new Error("mail down");
      w.notified.push({ list: list.listId, lead: l.leadId, type, data, at });
    },
    ...(w.counted ? {
      countContactEvent: async (runId: string, kind: string) => {
        if (w.countHangs) await new Promise(() => undefined);
        if (w.countThrows) throw new Error("run table down");
        w.counted!.push({ runId, kind, statusWritesSoFar: w.statusWrites.length });
      },
    } : {}),
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    log: () => undefined,
  };
  return new SmartleadEventService(deps as EventDeps);
}
const world = (over: Partial<World> = {}): World => ({
  leads: [lead("L1", "a", "ann@example.com")],
  runs: { "run-ok": { smartleadAccountId: ACCOUNT, campaignId: CAMPAIGN, campaignName: "Q4" } },
  notified: [], statusWrites: [], appended: [], ...over,
});
const ev = (body: Record<string, unknown>): SmartleadEvent => {
  const r = parseSmartleadEvent({ campaign_id: CAMPAIGN, ...body });
  if (!r.ok) throw new Error(r.reason);
  return r.event;
};
// the real shape: from_email is the sending mailbox, the contact is sl_lead_email / to_email
const reply = (extra: Record<string, unknown> = {}) => ev({ event_type: "EMAIL_REPLY", sl_lead_email: "ann@example.com", from_email: "us@ours.com", to_email: "ann@example.com", subject: "Re: Hi", time_replied: "2026-10-29T11:00:00Z", ...extra });
const unsub = () => ev({ event_type: "LEAD_UNSUBSCRIBED", lead_email: "ann@example.com" });
const bounce = (extra: Record<string, unknown> = {}) => ev({ event_type: "EMAIL_BOUNCE", lead_email: "ann@example.com", ...extra });
const ctx = { accountId: ACCOUNT, campaignId: CAMPAIGN };

describe("applying a Smartlead event to the CRM (ENG-673)", () => {
  it("a reply is recorded as the lead's email.received and alerts the list owner once", async () => {
    const w = world();
    const out = await make(w).handle(ctx, reply());
    expect(out).toEqual({ matched: 1, changed: 1, duplicates: 0 });
    expect(w.appended).toHaveLength(1);
    expect(w.appended[0]).toMatchObject({ listId: "L1", leadId: "a", eventType: "email.received", createdAt: "2026-10-29T11:00:00.000Z" });
    expect(w.appended[0].eventData).toMatchObject({ source: "smartlead", subject: "Re: Hi", from: "ann@example.com", campaign: "Q4", campaignId: CAMPAIGN });
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0]).toMatchObject({ list: "L1", type: "email.received" });
  });

  it("the same reply delivered again does nothing: no second engagement, no second alert", async () => {
    const w = world();
    const svc = make(w);
    await svc.handle(ctx, reply());
    const again = await svc.handle(ctx, reply());
    expect(again).toEqual({ matched: 1, changed: 0, duplicates: 1 });
    expect(w.appended).toHaveLength(1);
    expect(w.notified).toHaveLength(1);
    // a different reply (later) is a new event
    await svc.handle(ctx, reply({ time_replied: "2026-10-29T15:00:00Z" }));
    expect(w.appended).toHaveLength(2);
    expect(w.notified).toHaveLength(2);
  });

  it("a hard bounce blocks the contact for good and records it; a replay changes nothing", async () => {
    const w = world();
    const svc = make(w);
    const first = await svc.handle(ctx, bounce({ reason: "550 user unknown" }));
    expect(first.matched).toBe(1);
    expect(w.statusWrites).toHaveLength(1);
    expect(w.statusWrites[0]).toMatchObject({ contactStatus: "do-not-contact", contactStatusReason: "bounced", contactStatusUpdatedBy: "system", unsubscribedFromGroupEmail: true });
    expect(w.statusWrites[0].contactStatusNote).toContain("550 user unknown");
    expect(w.appended.map(a => a.eventType)).toEqual(["email.bounced"]);
    const again = await svc.handle(ctx, bounce({ reason: "550 user unknown" }));
    expect(again.changed).toBe(0);
    expect(w.statusWrites).toHaveLength(1);
  });

  it("keeps free text out of a bounce or unsubscribe engagement (the CRM reads words like 'received' in event data as engagement); the reason lives only in the status note", async () => {
    const w = world();
    await make(w).handle(ctx, bounce({ reason: "Message not received by the remote server" }));
    const data = w.appended[0].eventData;
    expect(Object.keys(data).sort()).toEqual(["campaignId", "smartleadEventKey", "source"]);
    expect(JSON.stringify(data)).not.toMatch(/received|replied|clicked/i);
    expect(w.statusWrites[0].contactStatusNote).toContain("not received");
    const w2 = world();
    await make(w2).handle(ctx, unsub());
    expect(JSON.stringify(w2.appended[0].eventData)).not.toMatch(/Q4/); // the campaign's name is not carried either
  });

  it("a bounce Smartlead says came from our own side is recorded but blocks nobody", async () => {
    const w = world();
    await make(w).handle(ctx, bounce({ is_sender_originated_bounce: true, reason: "Sender mailbox rejected" }));
    expect(w.statusWrites).toHaveLength(0);
    expect(w.appended[0].eventType).toBe("email.bounced");
    expect(w.leads[0].contactStatus).toBeUndefined();
  });

  it("a temporary bounce is recorded but does not block", async () => {
    const w = world();
    await make(w).handle(ctx, bounce({ reason: "Mailbox full, try again later" }));
    expect(w.statusWrites).toHaveLength(0);
    expect(w.appended[0]).toMatchObject({ eventType: "email.bounced" });
    expect(w.appended[0].eventData.soft).toBe(true);
  });

  it("an unsubscribe marks the contact unsubscribed (opted out); a replay changes nothing", async () => {
    const w = world();
    const svc = make(w);
    await svc.handle(ctx, unsub());
    expect(w.statusWrites).toEqual([expect.objectContaining({ contactStatus: "unsubscribed", contactStatusReason: "opted-out", contactStatusNote: "Unsubscribed in Smartlead" })]);
    await svc.handle(ctx, unsub());
    expect(w.statusWrites).toHaveLength(1);
  });

  it("the loop is harmless: a contact already blocked in AgentWeb (so our sweep unsubscribed them in Smartlead) is not changed by Smartlead reporting it back", async () => {
    const w = world({ leads: [lead("L1", "a", "ann@example.com", { contactStatus: "do-not-contact", contactStatusReason: "admin-flagged" })] });
    const out = await make(w).handle(ctx, unsub());
    expect(out.matched).toBe(1);
    expect(w.statusWrites).toHaveLength(0);
    expect(w.leads[0].contactStatusReason).toBe("admin-flagged"); // the admin's own reason is kept
  });

  it("acts only on a contact that proves it was pushed to THIS campaign through THIS account", async () => {
    const w = world({
      leads: [
        lead("L1", "no-marker", "ann@example.com", { system: {} }),
        lead("L2", "other-campaign", "ann@example.com", { system: { smartlead_99: marker("run-ok") } }),
        lead("L3", "other-account", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-foreign") } }),
        lead("L4", "run-missing", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-gone") } }),
        lead("L5", "no-run-id", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: { state: "pushed" } } }),
        lead("L6", "wrong-run-campaign", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-other-campaign") } }),
      ],
      runs: {
        "run-ok": { smartleadAccountId: ACCOUNT, campaignId: CAMPAIGN },
        "run-foreign": { smartleadAccountId: "smartlead-someone-else", campaignId: CAMPAIGN },
        "run-other-campaign": { smartleadAccountId: ACCOUNT, campaignId: 99 },
      },
    });
    const out = await make(w).handle(ctx, unsub());
    expect(out).toEqual({ matched: 0, changed: 0, duplicates: 0 });
    expect(w.statusWrites).toHaveLength(0);
    expect(w.appended).toHaveLength(0);
    expect(w.leads.every(l => l.contactStatus === undefined)).toBe(true);
  });

  it("a contact in several lists is handled in each list that was pushed here, and only those", async () => {
    const w = world({ leads: [lead("L1", "a", "ann@example.com"), lead("L2", "b", "ann@example.com"), lead("L3", "c", "ann@example.com", { system: {} })] });
    const out = await make(w).handle(ctx, unsub());
    expect(out.matched).toBe(2);
    expect(w.statusWrites.map(s => s.leadId).sort()).toEqual(["a", "b"]);
    expect(w.leads.find(l => l.leadId === "c")!.contactStatus).toBeUndefined();
  });

  it("a released or withdrawn contact is still handled (an opt-out must not be lost because AgentWeb let go of them)", async () => {
    for (const state of ["released", "withdrawn"]) {
      const w = world({ leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok", state) } })] });
      const out = await make(w).handle(ctx, unsub());
      expect(out.matched).toBe(1);
      expect(w.statusWrites).toHaveLength(1);
    }
  });

  it("tries the next candidate address only when the first matches nobody, and stops at the first that does", async () => {
    const w = world({ leads: [lead("L1", "a", "ann@example.com"), lead("L2", "b", "other@example.com")] });
    const e = ev({ event_type: "EMAIL_BOUNCE", to_email: "nobody@example.com", from_email: "ann@example.com" });
    expect(e.candidateEmails).toEqual(["nobody@example.com", "ann@example.com"]);
    const out = await make(w).handle(ctx, e);
    expect(out.matched).toBe(1);
    expect(w.statusWrites.map(s => s.leadId)).toEqual(["a"]);
    const both = ev({ event_type: "EMAIL_BOUNCE", to_email: "ann@example.com", from_email: "other@example.com" });
    const w2 = world({ leads: [lead("L1", "a", "ann@example.com"), lead("L2", "b", "other@example.com")] });
    await make(w2).handle(ctx, both);
    expect(w2.statusWrites.map(s => s.leadId)).toEqual(["a"]); // the first candidate won; the second contact is untouched
  });

  it("ignores an event whose body names a different campaign than the URL", async () => {
    const w = world();
    const e = { ...reply(), campaignId: 12345 };
    expect(await make(w).handle(ctx, e)).toEqual({ matched: 0, changed: 0, duplicates: 0 });
    expect(w.appended).toHaveLength(0);
  });

  it("two deliveries racing do not both append: the loser re-reads, sees the event, and stands down", async () => {
    const w = world({ raceOnce: true });
    // the other writer already recorded this very event
    const e = reply();
    w.leads[0].engagements = [];
    const svc = make(w);
    const original = w.leads[0].updatedAt;
    // simulate the winner: after the first (failed) attempt the lead already holds the event
    const deps = (svc as any).deps as EventDeps;
    const realRead = deps.readLeadConsistent;
    deps.readLeadConsistent = async (l, id) => {
      const cur = await realRead(l, id);
      if (cur && !cur.engagements.some((x: any) => x.eventData?.smartleadEventKey === e.eventKey)) cur.engagements = [{ eventType: "email.received", eventData: { smartleadEventKey: e.eventKey }, createdAt: "x" }];
      return cur;
    };
    const out = await svc.handle(ctx, e);
    expect(out).toEqual({ matched: 1, changed: 0, duplicates: 1 });
    expect(w.appended).toHaveLength(0);
    expect(w.notified).toHaveLength(0);
    expect(w.leads[0].updatedAt).not.toBe(original);
  });

  it("a lost race with nobody having recorded the event is retried once, then recorded", async () => {
    const w = world({ raceOnce: true });
    const out = await make(w).handle(ctx, reply());
    expect(out.changed).toBe(1);
    expect(w.appended).toHaveLength(1);
  });

  it("gives up with an error (so Smartlead retries) when the write keeps losing the race", async () => {
    const w = world({ raceAlways: true });
    await expect(make(w).handle(ctx, reply())).rejects.toThrow("concurrent write");
    expect(w.notified).toHaveLength(0);
  });

  it("a failing alert never fails the event: the reply is recorded and the failure is only logged", async () => {
    const w = world({ notifyThrows: true });
    const out = await make(w).handle(ctx, reply());
    expect(out.changed).toBe(1);
    expect(w.appended).toHaveLength(1);
  });

  it("an infrastructure error while looking up the contact is not swallowed (the route answers 5xx so it is retried)", async () => {
    const w = world();
    const svc = make(w);
    ((svc as any).deps as EventDeps).findLeadsByEmail = async () => { throw new Error("dynamo down"); };
    await expect(svc.handle(ctx, reply())).rejects.toThrow("dynamo down");
  });
});

describe("events found by the hourly poll (ENG-673)", () => {
  const polled = (kind: "reply" | "bounce" | "unsubscribe", over: Partial<SmartleadEvent> = {}): SmartleadEvent => ({
    kind, campaignId: CAMPAIGN, candidateEmails: ["ann@example.com"], soft: false, polled: true, eventKey: `poll:${kind}:${CAMPAIGN}:9`, ...over,
  });
  const ctx = { accountId: ACCOUNT, campaignId: CAMPAIGN };
  const pushed = () => world({ leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } })] });

  it("recovers a missed unsubscribe: the contact is blocked and one engagement is recorded", async () => {
    const w = pushed();
    const out = await make(w).handle(ctx, polled("unsubscribe"));
    expect(out.changed).toBeGreaterThan(0);
    expect(w.leads[0].contactStatus).toBe("unsubscribed");
    expect(w.appended.map(a => a.eventType)).toEqual(["email.unsubscribed"]);
  });

  it("recovers a missed bounce as do-not-contact", async () => {
    const w = pushed();
    await make(w).handle(ctx, polled("bounce"));
    expect(w.leads[0].contactStatus).toBe("do-not-contact");
  });

  it("changes nothing for a contact the webhook already blocked (no second engagement, whatever the key), and polling again is a no-op", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, ev({ event_type: "LEAD_UNSUBSCRIBED", sl_lead_email: "ann@example.com", event_id: "webhook-1" }));
    const before = w.appended.length;
    const out = await svc.handle(ctx, polled("unsubscribe"));
    expect(out.changed).toBe(0);
    expect(out.duplicates).toBe(1);
    expect(w.appended).toHaveLength(before);
  });

  it("does not record again when our own withdrawal blocked the contact and Smartlead now lists it as unsubscribed", async () => {
    const w = world({ leads: [lead("L1", "a", "ann@example.com", { contactStatus: "do-not-contact", system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } })] });
    const out = await make(w).handle(ctx, polled("unsubscribe"));
    expect(out.changed).toBe(0);
    expect(w.appended).toHaveLength(0);
    expect(w.notified).toHaveLength(0);
  });

  it("records a missed first reply and alerts once; a webhook-recorded reply is not recorded or alerted again", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, polled("reply"));
    expect(w.appended.map(a => a.eventType)).toEqual(["email.received"]);
    expect(w.notified).toHaveLength(1);
    await svc.handle(ctx, polled("reply", { eventKey: `poll:reply:${CAMPAIGN}:10` }));
    expect(w.appended).toHaveLength(1);
    expect(w.notified).toHaveLength(1);

    const x = pushed();
    const s2 = make(x);
    await s2.handle(ctx, ev({ event_type: "EMAIL_REPLY", sl_lead_email: "ann@example.com", event_id: "webhook-r1", subject: "Re: hi" }));
    await s2.handle(ctx, polled("reply"));
    expect(x.appended).toHaveLength(1);
    expect(x.notified).toHaveLength(1);
  });

  it("a CRM user's Resubscribe sticks: Smartlead keeps listing the contact as unsubscribed, but the poll never applies the event again", async () => {
    for (const how of ["webhook", "poll"] as const) {
      const w = pushed();
      const svc = make(w);
      await svc.handle(ctx, how === "webhook" ? ev({ event_type: "LEAD_UNSUBSCRIBED", sl_lead_email: "ann@example.com", event_id: "w1" }) : polled("unsubscribe"));
      expect(w.leads[0].contactStatus).toBe("unsubscribed");
      // the user resubscribes the contact in the portal
      Object.assign(w.leads[0], { contactStatus: "active", unsubscribedFromGroupEmail: false });
      const appended = w.appended.length;
      const out = await svc.handle(ctx, polled("unsubscribe"));
      expect(out.changed).toBe(0);
      expect(w.leads[0].contactStatus).toBe("active");
      expect(w.appended).toHaveLength(appended);
    }
    // the same for a bounce
    const b = pushed();
    const sb = make(b);
    await sb.handle(ctx, polled("bounce"));
    Object.assign(b.leads[0], { contactStatus: "active", unsubscribedFromGroupEmail: false });
    await sb.handle(ctx, polled("bounce", { eventKey: `poll:bounce:${CAMPAIGN}:10` }));
    expect(b.leads[0].contactStatus).toBe("active");
  });

  it("the poll does not read back our own withdrawal: a withdrawn marker, or a released one that was withdrawn first, is left alone", async () => {
    const withdrawnAt = "2026-10-29T11:00:00.000Z";
    for (const m of [{ ...marker("run-ok", "withdrawn"), withdrawnAt }, { ...marker("run-ok", "released"), withdrawnAt }]) {
      const w = world({ leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: m } })] });
      const out = await make(w).handle(ctx, polled("unsubscribe"));
      expect(out.matched).toBe(0);
      expect(w.leads[0].contactStatus).toBeUndefined();
      expect(w.appended).toHaveLength(0);
    }
    // while the webhook still acts on such a marker as before
    const w2 = world({ leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok", "withdrawn") } })] });
    expect((await make(w2).handle(ctx, unsub())).matched).toBe(1);
  });

  it("a withdrawal in one campaign is not read back as news in another campaign or list: the Smartlead lead is the same, and unsubscribed everywhere", async () => {
    const withdrawn = { ...marker("run-other", "withdrawn"), smartleadLeadId: "SL-1", withdrawnAt: "2026-10-29T11:00:00.000Z" };
    const pushedHere = { ...marker("run-ok"), smartleadLeadId: "SL-1" };
    // the same lead pushed to two campaigns, withdrawn from the first, resubscribed in the CRM
    const runs = { "run-ok": { smartleadAccountId: ACCOUNT, campaignId: CAMPAIGN, campaignName: "Q4" }, "run-other": { smartleadAccountId: ACCOUNT, campaignId: 55 } };
    const same = world({ runs, leads: [lead("L1", "a", "ann@example.com", { contactStatus: "active", system: { smartlead_55: withdrawn, [`smartlead_${CAMPAIGN}`]: pushedHere } })] });
    await make(same).handle(ctx, polled("unsubscribe"));
    expect(same.leads[0].contactStatus).toBe("active");
    expect(same.appended).toHaveLength(0);
    // another lead record of the same person, in another list, pushed to this campaign
    const other = world({ runs, leads: [
      lead("L1", "a", "ann@example.com", { system: { smartlead_55: withdrawn } }),
      lead("L2", "b", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: pushedHere } }),
    ] });
    await make(other).handle(ctx, polled("unsubscribe"));
    expect(other.leads[1].contactStatus).toBeUndefined();
    // a different Smartlead lead id is not affected
    const unrelated = world({ runs, leads: [lead("L1", "a", "ann@example.com", { system: { smartlead_55: withdrawn, [`smartlead_${CAMPAIGN}`]: { ...marker("run-ok"), smartleadLeadId: "SL-2" } } })] });
    await make(unrelated).handle(ctx, polled("unsubscribe"));
    expect(unrelated.leads[0].contactStatus).toBe("unsubscribed");
    // the webhook is never held back by this
    const hook = world({ runs, leads: [lead("L1", "a", "ann@example.com", { system: { smartlead_55: withdrawn, [`smartlead_${CAMPAIGN}`]: pushedHere } })] });
    await make(hook).handle(ctx, unsub());
    expect(hook.leads[0].contactStatus).toBe("unsubscribed");
  });

  it("another customer's withdrawn marker with the same Smartlead id text does not suppress ours: only a marker whose run is THIS account's counts", async () => {
    const theirs = { ...marker("run-theirs", "withdrawn"), smartleadLeadId: "SL-1", withdrawnAt: "2026-10-29T11:00:00.000Z" };
    const w = world({
      leads: [
        lead("L1", "a", "ann@example.com", { userId: "someone-else", system: { smartlead_55: theirs } }),
        lead("L2", "b", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: { ...marker("run-ok"), smartleadLeadId: "SL-1" } } }),
      ],
      runs: { "run-ok": { smartleadAccountId: ACCOUNT, campaignId: CAMPAIGN, campaignName: "Q4" }, "run-theirs": { smartleadAccountId: "smartlead-other-tenant", campaignId: 55 } },
    });
    await make(w).handle(ctx, polled("unsubscribe"));
    expect(w.leads[1].contactStatus).toBe("unsubscribed");
    // and ours, in the same account, still suppresses
    const mine = world({
      leads: [
        lead("L1", "a", "ann@example.com", { system: { smartlead_55: { ...marker("run-mine", "withdrawn"), smartleadLeadId: "SL-1", withdrawnAt: "2026-10-29T11:00:00.000Z" } } }),
        lead("L2", "b", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: { ...marker("run-ok"), smartleadLeadId: "SL-1" } } }),
      ],
      runs: { "run-ok": { smartleadAccountId: ACCOUNT, campaignId: CAMPAIGN }, "run-mine": { smartleadAccountId: ACCOUNT, campaignId: 55 } },
    });
    await make(mine).handle(ctx, polled("unsubscribe"));
    expect(mine.leads[1].contactStatus).toBeUndefined();
  });

  it("the poll still reads a contact released without a withdrawal (still live in Smartlead), and a reply from a withdrawn one", async () => {
    const released = world({ leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok", "released") } })] });
    await make(released).handle(ctx, polled("unsubscribe"));
    expect(released.leads[0].contactStatus).toBe("unsubscribed");
    const withdrawn = world({ leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: { ...marker("run-ok", "withdrawn"), withdrawnAt: "2026-10-29T11:00:00.000Z" } } })] });
    await make(withdrawn).handle(ctx, polled("reply"));
    expect(withdrawn.appended.map(a => a.eventType)).toEqual(["email.received"]);
  });

  it("a bounce on file, a Resubscribe and a corrected address do not hide a later opt-out from the poll; and the other way round", async () => {
    const hardBounce = { eventType: "email.bounced", createdAt: "2026-10-29T10:30:00.000Z", eventData: { source: "smartlead", campaignId: CAMPAIGN, smartleadEventKey: "b1" } };
    const w = world({ leads: [lead("L1", "a", "ann@example.com", { engagements: [hardBounce], contactStatus: "active", contactStatusUpdatedAt: "2026-10-29T11:00:00.000Z" })] });
    await make(w).handle(ctx, polled("unsubscribe"));
    expect(w.leads[0].contactStatus).toBe("unsubscribed");
    const unsubbed = { eventType: "email.unsubscribed", createdAt: "2026-10-29T10:30:00.000Z", eventData: { source: "smartlead", campaignId: CAMPAIGN, smartleadEventKey: "u1" } };
    const x = world({ leads: [lead("L1", "a", "ann@example.com", { engagements: [unsubbed], contactStatus: "active", contactStatusUpdatedAt: "2026-10-29T11:00:00.000Z" })] });
    await make(x).handle(ctx, polled("bounce"));
    expect(x.leads[0].contactStatus).toBe("do-not-contact");
  });

  it("an event time from Smartlead later than our own clock is recorded as now, so it cannot out-date a Resubscribe", async () => {
    const w = pushed();
    await make(w).handle(ctx, ev({ event_type: "LEAD_UNSUBSCRIBED", sl_lead_email: "ann@example.com", event_id: "future-1", event_timestamp: "2027-01-01T00:00:00.000Z" }));
    expect(w.appended[0].createdAt <= "2026-10-29T12:00:00.000Z").toBe(true);
  });

  it("a temporary bounce on file does not hide a later opt-out from the poll", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, bounce({ event_id: "soft-1", bounce_message: { text: "452 mailbox full, try again later" } }));
    expect(w.appended[0].eventData.soft).toBe(true);
    expect(w.leads[0].contactStatus).toBeUndefined();
    await svc.handle(ctx, polled("unsubscribe"));
    expect(w.leads[0].contactStatus).toBe("unsubscribed");
  });

  it("the poll does not turn a temporary bounce already on file into a block", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, bounce({ event_id: "soft-1", bounce_message: { text: "452 mailbox full, try again later" } }));
    const out = await svc.handle(ctx, polled("bounce"));
    expect(out.duplicates).toBe(1);
    expect(w.leads[0].contactStatus).toBeUndefined();
  });

  it("the poll finishes a half-applied block: the engagement is on file, the status write never landed; no second engagement", async () => {
    const onFile = { eventType: "email.unsubscribed", createdAt: "2026-10-29T11:00:00.000Z", eventData: { source: "smartlead", campaignId: CAMPAIGN, smartleadEventKey: "w1" } };
    const w = world({ leads: [lead("L1", "a", "ann@example.com", { engagements: [onFile] })] });
    const out = await make(w).handle(ctx, polled("unsubscribe"));
    expect(w.leads[0].contactStatus).toBe("unsubscribed");
    expect(out.changed).toBe(1);
    expect(w.appended).toHaveLength(0);
  });

  it("a status write that fails on the poll's own pass is finished on its next", async () => {
    const w = pushed();
    const deps = (make(w) as any).deps as EventDeps;
    const realSet = deps.setContactStatus;
    deps.setContactStatus = async () => { throw new Error("dynamo down"); };
    const svc = new SmartleadEventService(deps);
    await expect(svc.handle(ctx, polled("unsubscribe"))).rejects.toThrow("dynamo down");
    expect(w.leads[0].contactStatus).toBeUndefined();
    deps.setContactStatus = realSet;
    await svc.handle(ctx, polled("unsubscribe"));
    expect(w.leads[0].contactStatus).toBe("unsubscribed");
    expect(w.appended).toHaveLength(1);
  });

  it("decides a Resubscribe from a fresh read, not the possibly stale lookup row", async () => {
    const onFile = { eventType: "email.unsubscribed", createdAt: "2026-10-29T11:00:00.000Z", eventData: { source: "smartlead", campaignId: CAMPAIGN, smartleadEventKey: "w1" } };
    const w = world({ leads: [lead("L1", "a", "ann@example.com", { engagements: [onFile], contactStatus: "active", contactStatusUpdatedAt: "2026-10-29T11:30:00.000Z" })] });
    const deps = (make(w) as any).deps as EventDeps;
    deps.findLeadsByEmail = async () => [{ ...w.leads[0], contactStatusUpdatedAt: undefined }]; // the index has not caught up
    await new SmartleadEventService(deps).handle(ctx, polled("unsubscribe"));
    expect(w.leads[0].contactStatus).toBe("active");
  });

  it("still only acts on a contact that proves it was pushed to this campaign through this account", async () => {
    const w = world({ leads: [lead("L1", "a", "ann@example.com", { system: {} })] }); // no marker
    const out = await make(w).handle(ctx, polled("unsubscribe"));
    expect(out.matched).toBe(0);
    expect(w.leads[0].contactStatus).toBeUndefined();
    const other = pushed();
    const o2 = await make(other).handle({ accountId: "smartlead-someone-else", campaignId: CAMPAIGN }, polled("unsubscribe"));
    expect(o2.matched).toBe(0);
  });
});

describe("the reply text goes to the owner's alert and nowhere else (ENG-673)", () => {
  it("is passed to the alert but never stored on the contact", async () => {
    const w = world();
    await make(w).handle(ctx, { ...reply(), replyText: "Yes, interested. Call me." });
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0].data.replyText).toBe("Yes, interested. Call me.");
    expect(JSON.stringify(w.appended)).not.toContain("interested");
    expect(w.appended[0].eventData).not.toHaveProperty("replyText");
  });

  it("an event without it alerts exactly as before", async () => {
    const w = world();
    await make(w).handle(ctx, reply());
    expect(w.notified[0].data).not.toHaveProperty("replyText");
  });
});

describe("counting a run's replied, bounced and unsubscribed contacts for the run view (ENG-673)", () => {
  const pushed = (over: Partial<World> = {}) => world({ counted: [], leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } })], ...over });
  const polled = (kind: "reply" | "bounce" | "unsubscribe", over: Partial<SmartleadEvent> = {}): SmartleadEvent => ({
    kind, campaignId: CAMPAIGN, candidateEmails: ["ann@example.com"], soft: false, polled: true, eventKey: `poll:${kind}:${CAMPAIGN}:9`, ...over,
  });
  const kinds = (w: World) => w.counted!.map(c => `${c.runId}:${c.kind}`);

  it("counts a contact's reply once, and a second reply from the same contact does not count again", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, reply());
    await svc.handle(ctx, reply({ time_replied: "2026-10-29T11:30:00Z", subject: "Re: Hi again" }));
    expect(w.appended.filter(a => a.eventType === "email.received")).toHaveLength(2); // both replies are on the contact
    expect(kinds(w)).toEqual(["run-ok:replied"]); // the run counts contacts, not messages
  });

  it("a replayed delivery counts nothing the second time", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, unsub());
    await svc.handle(ctx, unsub());
    expect(kinds(w)).toEqual(["run-ok:unsubscribed"]);
  });

  it("counts a hard bounce but not a temporary one; a hard bounce after a temporary one still counts", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, bounce({ bounce_type: "soft", sl_email_lead_id: 1, time: "2026-10-29T10:30:00.000Z" } as any));
    expect(w.counted).toHaveLength(0);
    await svc.handle(ctx, bounce({ time: "2026-10-29T11:00:00.000Z" }));
    expect(kinds(w)).toEqual(["run-ok:bounced"]);
  });

  it("a failing counter never changes what happens to the contact: the opt-out is still saved and the event still succeeds", async () => {
    const w = pushed({ countThrows: true });
    const out = await make(w).handle(ctx, unsub());
    expect(out.changed).toBeGreaterThan(0);
    expect(w.leads[0].contactStatus).toBe("unsubscribed");
    expect(w.appended.map(a => a.eventType)).toEqual(["email.unsubscribed"]);
    const r = pushed({ countThrows: true });
    await expect(make(r).handle(ctx, reply())).resolves.toMatchObject({ changed: 1 });
    expect(r.notified).toHaveLength(1); // and the reply alert still went out
  });

  it("the counter comes after the block is written, never before it", async () => {
    const w = pushed();
    await make(w).handle(ctx, unsub());
    expect(w.statusWrites).toHaveLength(1);
    expect(w.counted![0].statusWritesSoFar).toBe(1);
  });

  it("does not count an opt-out for a contact that was already blocked: our own withdrawal echoed back by Smartlead is not a contact's act", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, bounce({ time: "2026-10-29T11:00:00.000Z" })); // hard bounce: counted, blocked
    await svc.handle(ctx, unsub()); // the sweep unsubscribes the blocked contact in Smartlead, which reports it back
    expect(kinds(w)).toEqual(["run-ok:bounced"]);
    const admin = pushed({ leads: [lead("L1", "a", "ann@example.com", { contactStatus: "do-not-contact", system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } })] });
    await make(admin).handle(ctx, unsub());
    expect(admin.statusWrites).toHaveLength(0);
    expect(admin.counted).toHaveLength(0);
  });

  it("a retry after a failed block write still counts, once", async () => {
    const w = pushed({ statusFailsOnce: true });
    const svc = make(w);
    await expect(svc.handle(ctx, unsub())).rejects.toThrow("db blip"); // Smartlead would retry
    expect(w.counted).toHaveLength(0);
    await svc.handle(ctx, unsub());
    expect(w.leads[0].contactStatus).toBe("unsubscribed");
    expect(kinds(w)).toEqual(["run-ok:unsubscribed"]);
    await svc.handle(ctx, unsub()); // and a further replay does not count again
    expect(kinds(w)).toEqual(["run-ok:unsubscribed"]);
  });

  it("a contact in two lists is blocked in both before any counter is written, so a counter can never hold up the second block", async () => {
    const w = pushed({ leads: [
      lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } }),
      lead("L2", "b", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } }),
    ] });
    await make(w).handle(ctx, unsub());
    expect(w.statusWrites).toHaveLength(2);
    expect(w.counted!.map(c => c.statusWritesSoFar)).toEqual([2, 2]);
  });

  it("when a later list's block fails (Smartlead will retry), the first list's block is still counted", async () => {
    const w = pushed({ statusFailsFor: "L2", leads: [
      lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } }),
      lead("L2", "b", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } }),
    ] });
    await expect(make(w).handle(ctx, unsub())).rejects.toThrow("db down");
    expect(w.leads[0].contactStatus).toBe("unsubscribed"); // the first block was written...
    expect(kinds(w)).toEqual(["run-ok:unsubscribed"]); // ...so it is counted, once
  });

  it("a broken logger and a failing counter cannot replace the error of a failed block (Smartlead must still see the original failure and retry)", async () => {
    const w = pushed({ countThrows: true, statusFailsFor: "L2", leads: [
      lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } }),
      lead("L2", "b", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } }),
    ] });
    const svc = new SmartleadEventService({ ...(make(w) as any).deps, log: () => { throw new Error("logger broken"); } } as EventDeps);
    await expect(svc.handle(ctx, unsub())).rejects.toThrow("db down for this list");
  });

  it("a counter that never answers does not hold up the response for more than a couple of seconds", async () => {
    jest.useFakeTimers();
    try {
      const w = pushed({ countHangs: true });
      const p = make(w).handle(ctx, unsub());
      await jest.advanceTimersByTimeAsync(2100);
      await expect(p).resolves.toMatchObject({ matched: 1 });
      expect(w.leads[0].contactStatus).toBe("unsubscribed");
    } finally {
      jest.useRealTimers();
    }
  });

  it("the poll finding what the webhook already delivered counts nothing", async () => {
    const w = pushed();
    const svc = make(w);
    await svc.handle(ctx, unsub());
    await svc.handle(ctx, polled("unsubscribe"));
    expect(kinds(w)).toEqual(["run-ok:unsubscribed"]);
    const r = pushed();
    await make(r).handle(ctx, polled("unsubscribe")); // a missed one the poll recovers is new
    expect(kinds(r)).toEqual(["run-ok:unsubscribed"]);
  });

  it("works with no run store wired (nothing is counted, nothing breaks)", async () => {
    const w = world({ leads: [lead("L1", "a", "ann@example.com", { system: { [`smartlead_${CAMPAIGN}`]: marker("run-ok") } })] });
    await expect(make(w).handle(ctx, unsub())).resolves.toMatchObject({ matched: 1 });
  });
});
