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
      const l = w.leads.find(x => x.listId === listId && x.leadId === leadId)!;
      Object.assign(l, fields);
      w.statusWrites.push({ listId, leadId, ...fields });
    },
    notify: async (list, l, type, data, at) => {
      if (w.notifyThrows) throw new Error("mail down");
      w.notified.push({ list: list.listId, lead: l.leadId, type, data, at });
    },
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    log: () => undefined,
  };
  return new SmartleadEventService(deps);
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
const reply = (extra: Record<string, unknown> = {}) => ev({ event_type: "EMAIL_REPLY", from_email: "ann@example.com", to_email: "us@ours.com", subject: "Re: Hi", time_replied: "2026-10-29T11:00:00Z", ...extra });
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
