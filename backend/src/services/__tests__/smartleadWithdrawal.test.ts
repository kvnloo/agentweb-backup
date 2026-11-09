import { __resetWithdrawalAttempts, withdrawalSweep, WITHDRAWALS_PER_LIST, type WithdrawalDeps } from "../smartleadWithdrawal";
import { smartleadMarkerKey } from "../smartleadMarkers";
import { SmartleadApiError } from "../smartleadService";

const NOW = new Date("2026-10-28T12:00:00Z");
const marker = (state = "pushed", id: string | null = "9001") => ({ state, pushedAt: "x", runId: "r1", payloadHash: "h", ...(id ? { smartleadLeadId: id } : {}) });
const lead = (n: number, over: Record<string, any> = {}) => ({ leadId: `lead_${String(n).padStart(5, "0")}`, email: `p${n}@example.com`, system: { smartlead_77: marker("pushed", String(9000 + n)) }, ...over });
const optedOut = { contactStatus: "do-not-contact" };

interface Env { deps: WithdrawalDeps; leads: any[]; unsub: jest.Mock; find: jest.Mock; upd: jest.Mock; written: Array<{ leadId: string; marker: any }>; logs: string[]; runs: any[] }

function env(over: { update?: (id: string, email: string) => any; visible?: boolean; leads?: any[]; runs?: any[]; key?: any; unsub?: (id: string) => any; keyFor?: (owner: string) => any; consistent?: (leadId: string) => any; cap?: number } = {}): Env {
  const leads = over.leads ?? [];
  const written: Env["written"] = [];
  const logs: string[] = [];
  const runs = over.runs ?? [{ runId: "run1", status: "completed", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "smartlead-owner", createdAt: "2026-10-27T00:00:00Z" }];
  const unsub = jest.fn(async (_k: string, id: string) => (over.unsub ? over.unsub(id) : "ok"));
  const find = jest.fn(async () => "7777" as string | null);
  const upd = jest.fn(async (_k: string, _c: number, id: string, email: string) => (over.update ? over.update(id, email) : "ok"));
  const deps: WithdrawalDeps = {
    db: { listRunsSince: jest.fn(async (since: string) => runs.filter(r => r.createdAt >= since) as any), getRun: jest.fn(async (id: string) => runs.find(r => r.runId === id) ?? null) },
    resolveKey: jest.fn(async (owner: string) => over.keyFor?.(owner) ?? over.key ?? ({ ok: true, apiKey: "KEY", ownerUserId: owner, accountId: "smartlead-owner", accountName: "x" })),
    reportFailure: jest.fn(async () => "key_rejected"),
    readLeads: async (_l, after, limit) => { const start = after ? leads.findIndex(x => x.leadId === after.leadId) + 1 : 0; return { items: leads.slice(start, start + limit), hasMore: start + limit < leads.length }; },
    readLeadConsistent: async (_l, id) => (over.consistent ? over.consistent(id) : leads.find(x => x.leadId === id) ?? null),
    maxPerList: over.cap,
    writeMarker: async (_l, leadId, _k, m) => { written.push({ leadId, marker: m }); const l = leads.find(x => x.leadId === leadId); if (l) l.system = { ...l.system, [smartleadMarkerKey(77)]: m }; },
    smartlead: { campaignVisible: jest.fn(async () => over.visible !== false), unsubscribe: unsub, findLeadId: find, updateLeadEmail: upd },
    now: () => NOW,
    log: l => logs.push(l),
  };
  return { deps, leads, unsub, find, upd, written, logs, runs };
}

describe("withdrawalSweep (ENG-673)", () => {
  beforeEach(() => __resetWithdrawalAttempts());

  it("unsubscribes a pushed lead that opted out here, account-wide, and marks it withdrawn", async () => {
    const e = env({ leads: [lead(1, optedOut), lead(2), lead(3, { contactStatus: "unsubscribed" })] });
    const r = await withdrawalSweep(e.deps);
    expect(r).toMatchObject({ targets: 1, withdrawn: 2, failed: 0 });
    expect(e.unsub.mock.calls.map(c => c[1]).sort()).toEqual(["9001", "9003"]);
    expect(e.unsub.mock.calls[0][0]).toBe("KEY");
    expect(e.written.map(w => w.leadId).sort()).toEqual(["lead_00001", "lead_00003"]);
    expect(e.written[0].marker).toMatchObject({ state: "withdrawn", withdrawnAt: NOW.toISOString(), runId: "r1", smartleadLeadId: expect.any(String) });
    expect(e.leads[1].system.smartlead_77.state).toBe("pushed"); // lead 2 did not opt out
  });

  it("leaves alone leads that are already withdrawn, and leads with no marker for the campaign", async () => {
    const e = env({ leads: [lead(1, { ...optedOut, system: { smartlead_77: marker("withdrawn") } }), lead(3, { ...optedOut, system: {} }), lead(4, { ...optedOut, system: { smartlead_99: marker() } })] });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 0 });
    expect(e.unsub).not.toHaveBeenCalled();
  });

  it("is idempotent: a second pass finds nothing left to do", async () => {
    const e = env({ leads: [lead(1, optedOut)] });
    await withdrawalSweep(e.deps);
    e.unsub.mockClear();
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0 });
    expect(e.unsub).not.toHaveBeenCalled();
  });

  it("treats a lead Smartlead no longer has (404, and not found by address either) as withdrawn, so it stops being retried", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: () => "not_found" });
    e.find.mockResolvedValueOnce(null);
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, failed: 0 });
    expect(e.written[0].marker.state).toBe("withdrawn");
  });

  it("leaves the marker 'pushed' and counts a failure when Smartlead changed nothing, so the next pass tries again", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: () => "no_update" });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
    expect(e.leads[0].system.smartlead_77.state).toBe("pushed");
    expect(e.written.filter(w => w.leadId === "lead_00001")).toHaveLength(0); // a failure writes NOTHING to the lead (it could undo a release made meanwhile) // still pushed; the attempt is noted
  });

  it("stops a list at the first rate limit (nothing is marked), and after ten failures in a row in an outage", async () => {
    const limited = env({ leads: [1, 2, 3].map(n => lead(n, optedOut)), unsub: () => { throw new SmartleadApiError("slow", 429); } });
    expect(await withdrawalSweep(limited.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
    expect(limited.unsub).toHaveBeenCalledTimes(1);
    const outage = env({ leads: Array.from({ length: 15 }, (_, i) => lead(i + 1, optedOut)), unsub: () => { throw new SmartleadApiError("down", 503); } });
    const r = await withdrawalSweep(outage.deps);
    expect(r.failed).toBe(10);
    expect(outage.unsub).toHaveBeenCalledTimes(10);
  });

  it("a lead that keeps failing does not block the ones behind it: it is tried last next time, and the others go out the same pass", async () => {
    const e = env({ leads: [lead(1, optedOut), lead(2, optedOut), lead(3, optedOut), lead(4, optedOut)], unsub: id => { if (["9001", "9002", "9003"].includes(id)) throw new SmartleadApiError("boom", 500); return "ok"; } });
    const r = await withdrawalSweep(e.deps);
    expect(r).toMatchObject({ withdrawn: 1, failed: 3 }); // the good lead behind three failures still went out
    expect(e.leads[3].system.smartlead_77.state).toBe("withdrawn");
    expect(e.leads[0].system.smartlead_77.state).toBe("pushed");
    expect(e.written.filter(w => w.leadId === "lead_00001")).toHaveLength(0); // a failure writes NOTHING to the lead (it could undo a release made meanwhile)
  });

  it("rotates: with a small cap, leads that failed before go to the back, so a good lead is reached on the next pass", async () => {
    const e = env({ cap: 2, leads: [lead(1, optedOut), lead(2, optedOut), lead(3, optedOut), lead(4, optedOut)], unsub: id => { if (["9001", "9002", "9003"].includes(id)) throw new SmartleadApiError("boom", 500); return "ok"; } });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 2 }); // tried leads 1 and 2
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, failed: 1 }); // leads 3 and 4 first (never tried): 4 goes out
    expect(e.leads[3].system.smartlead_77.state).toBe("withdrawn");
  });

  it("keeps going after one failure that is followed by a success", async () => {
    let n = 0;
    const e = env({ leads: [1, 2, 3].map(x => lead(x, optedOut)), unsub: () => { if (n++ === 0) throw new SmartleadApiError("blip", 500); return "ok"; } });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 2, failed: 1 });
  });

  it("reports a rejected key and leaves the list for the next pass without trying every lead", async () => {
    const e = env({ leads: [1, 2, 3].map(x => lead(x, optedOut)), unsub: () => { throw new SmartleadApiError("nope", 401); } });
    await withdrawalSweep(e.deps);
    expect(e.unsub).toHaveBeenCalledTimes(1);
    expect(e.deps.reportFailure).toHaveBeenCalledTimes(1);
    expect(e.written).toHaveLength(0);
  });

  it("looks a lead up by email when its marker has no Smartlead id, and treats 'not in Smartlead' as withdrawn without a call", async () => {
    const e = env({ leads: [lead(1, { ...optedOut, system: { smartlead_77: marker("pushed", null) } }), lead(2, { ...optedOut, system: { smartlead_77: marker("pushed", null) } })] });
    e.find.mockResolvedValueOnce("7777").mockResolvedValueOnce(null);
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 2 });
    expect(e.unsub).toHaveBeenCalledTimes(1);
    expect(e.unsub.mock.calls[0][1]).toBe("7777");
  });

  it("skips a list whose pusher's key can not be used, and says so", async () => {
    const e = env({ leads: [lead(1, optedOut)], key: { ok: false, reason: "key_rejected", message: "no" } });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ targets: 1, keyUnavailable: 1, withdrawn: 0 });
    expect(e.unsub).not.toHaveBeenCalled();
    expect(e.logs.join("\n")).toMatch(/NO usable Smartlead key/);
  });

  it("limits each list per pass; the rest wait for the next one", async () => {
    const e = env({ leads: Array.from({ length: WITHDRAWALS_PER_LIST + 50 }, (_, i) => lead(i + 1, optedOut)) });
    expect((await withdrawalSweep(e.deps)).withdrawn).toBe(WITHDRAWALS_PER_LIST);
    expect((await withdrawalSweep(e.deps)).withdrawn).toBe(50);
  });

  it("covers lists across pages, one target per list and campaign, and only runs inside the window", async () => {
    const runs = [
      { runId: "new", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-27T00:00:00Z" },
      { runId: "dup", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-20T00:00:00Z" },
      { runId: "old", listId: "OLD", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2025-01-01T00:00:00Z" },
    ];
    const e = env({ runs, leads: Array.from({ length: 450 }, (_, i) => lead(i + 1, i % 3 === 0 ? optedOut : {})) });
    const r = await withdrawalSweep(e.deps);
    expect(r.targets).toBe(1);
    expect(r.withdrawn).toBe(150);
  });

  it("resolves each pusher's key once however many lists they have", async () => {
    const runs = [
      { runId: "a", listId: "L1", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-27T00:00:00Z" },
      { runId: "b", listId: "L2", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-26T00:00:00Z" },
    ];
    const e = env({ runs, leads: [] });
    await withdrawalSweep(e.deps);
    expect(e.deps.resolveKey).toHaveBeenCalledTimes(1);
  });

  it("an opted-out lead whose marker write fails after a successful unsubscribe is simply retried (the call is idempotent)", async () => {
    const e = env({ leads: [lead(1, optedOut)] });
    let fail = true;
    const write = e.deps.writeMarker;
    e.deps.writeMarker = async (...a) => { if (fail) { fail = false; throw new Error("ddb"); } return write(...a); };
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, failed: 0 });
    expect(e.unsub).toHaveBeenCalledTimes(2);
  });
  it("also stops a RELEASED lead that is do-not-contact (releasing changes nothing in Smartlead), and leaves a released lead that is fine", async () => {
    const e = env({ leads: [lead(1, { ...optedOut, system: { smartlead_77: marker("released") } }), lead(2, { system: { smartlead_77: marker("released") } })] });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1 });
    expect(e.leads[0].system.smartlead_77.state).toBe("withdrawn");
    expect(e.leads[1].system.smartlead_77.state).toBe("released");
  });

  it("one list that throws does not stop the others, and is counted and logged", async () => {
    const runs = [
      { runId: "a", listId: "BAD", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-27T00:00:00Z" },
      { runId: "b", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-26T00:00:00Z" },
    ];
    const e = env({ runs, leads: [lead(1, optedOut)] });
    const read = e.deps.readLeads;
    e.deps.readLeads = async (l, a, n) => { if (l === "BAD") throw new Error("throttled"); return read(l, a, n); };
    expect(await withdrawalSweep(e.deps)).toMatchObject({ targets: 2, targetErrors: 1, withdrawn: 1 });
    expect(e.logs.join("\n")).toMatch(/list=BAD/);
  });

  it("falls back to an OLDER run's key when the newest run's key is gone", async () => {
    const runs = [
      { runId: "new", listId: "L", campaignId: 77, keyOwnerId: "gone", smartleadAccountId: "a", createdAt: "2026-10-27T00:00:00Z" },
      { runId: "old", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-20T00:00:00Z" },
    ];
    const e = env({ runs, leads: [lead(1, optedOut)], keyFor: o => (o === "gone" ? { ok: false, reason: "not_connected", message: "x" } : undefined) });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, keyUnavailable: 0 });
  });

  it("says loudly that opt-outs are not being sent when no run's key works", async () => {
    const e = env({ leads: [lead(1, optedOut)], key: { ok: false, reason: "key_rejected", message: "no" } });
    await withdrawalSweep(e.deps);
    expect(e.logs.join("\n")).toMatch(/NOT being sent/);
  });

  it("a 404 on the stored id looks the address up first: a lead the customer re-imported has a NEW id and is still emailed", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: id => (id === "9001" ? "not_found" : "ok") });
    e.find.mockResolvedValueOnce("5555");
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1 });
    expect(e.unsub.mock.calls.map(c => c[1])).toEqual(["9001", "5555"]);
  });

  it("a 404 whose address is not in Smartlead either means the lead is gone: withdrawn", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: () => "not_found" });
    e.find.mockResolvedValueOnce(null);
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1 });
    expect(e.unsub).toHaveBeenCalledTimes(1);
  });

  it("decides on a CONSISTENT re-read: a lead re-subscribed (or already withdrawn) since the page read is left alone", async () => {
    const e = env({ leads: [lead(1, optedOut), lead(2, optedOut), lead(3, optedOut)], consistent: id => {
      if (id === "lead_00001") return { ...lead(1), contactStatus: "active" }; // re-subscribed since the page read
      if (id === "lead_00002") return { ...lead(2, optedOut), system: { smartlead_77: marker("withdrawn") } }; // another pass got there first
      return null; // deleted
    } });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 0 });
    expect(e.unsub).not.toHaveBeenCalled();
  });

  it("trusts the stored id for a marker that records no address (older markers) and for an unchanged address", async () => {
    const e = env({ leads: [lead(1, { ...optedOut, system: { smartlead_77: { ...marker("pushed", "9001"), email: "p1@example.com" } } }), lead(2, optedOut)] });
    await withdrawalSweep(e.deps);
    expect(e.find).not.toHaveBeenCalled();
    expect(e.unsub.mock.calls.map(c => c[1]).sort()).toEqual(["9001", "9002"]);
  });
  it("a 404 followed by a lookup that finds the SAME id is a failure, not 'gone'", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: () => "not_found" });
    e.find.mockResolvedValueOnce("9001");
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
    expect(e.leads[0].system.smartlead_77.state).toBe("pushed");
  });

  it("a lead whose consistent re-read throws is a failure for THAT lead only: the ones behind it still go out, and it is tried last next time", async () => {
    let throwFirst = true;
    const e = env({ leads: [lead(1, optedOut), lead(2, optedOut)] });
    e.deps.readLeadConsistent = async (_l, id) => { if (id === "lead_00001" && throwFirst) throw new Error("throttled"); return e.leads.find(x => x.leadId === id) ?? null; };
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, failed: 1, targetErrors: 0 });
    throwFirst = false;
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, failed: 0 });
  });

  it("a rejected key on one lead is reported and counted against that lead, and stops the list", async () => {
    const e = env({ leads: [1, 2].map(n => lead(n, optedOut)), unsub: () => { throw new SmartleadApiError("forbidden", 403); } });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ failed: 1, withdrawn: 0 });
    expect(e.deps.reportFailure).toHaveBeenCalledTimes(1);
    expect(e.unsub).toHaveBeenCalledTimes(1);
  });

  it("still sweeps a list whose last run is 100 days old (a long-running campaign), but not one older than the retention window", async () => {
    const day = 24 * 60 * 60 * 1000;
    const at = (days: number) => new Date(NOW.getTime() - days * day).toISOString();
    const runs = [
      { runId: "mid", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: at(100) },
      { runId: "ancient", listId: "OLD", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: at(500) },
    ];
    const e = env({ runs, leads: [lead(1, optedOut)] });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ targets: 1, withdrawn: 1 });
  });
  it("a 404 on an id the lookup JUST returned is Smartlead disagreeing with itself: a failure, not 'gone'", async () => {
    const e = env({ leads: [lead(1, { ...optedOut, system: { smartlead_77: marker("pushed", null) } })], unsub: () => "not_found" });
    e.find.mockResolvedValueOnce("5555");
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
    expect(e.leads[0].system.smartlead_77.state).toBe("pushed");
  });

  it("a 404 on the stored id, then a lookup that finds another id that also 404s, is a failure", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: () => "not_found" });
    e.find.mockResolvedValueOnce("5555");
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
  });

  it("a lead that failed goes to the back of the queue for a few hours, and then back to its normal place", async () => {
    let nowMs = NOW.getTime();
    const failFirst = new Set(["9001"]);
    const e = env({ cap: 1, leads: [lead(1, optedOut), lead(2, optedOut)], unsub: id => (failFirst.has(id) ? (() => { throw new SmartleadApiError("boom", 500); })() : "ok") });
    e.deps.now = () => new Date(nowMs);
    await withdrawalSweep(e.deps); // lead 1 is tried first and fails
    failFirst.clear();
    nowMs += 60 * 60 * 1000; // an hour later: lead 2 (never failed) goes first
    await withdrawalSweep(e.deps);
    expect(e.leads[1].system.smartlead_77.state).toBe("withdrawn");
    expect(e.leads[0].system.smartlead_77.state).toBe("pushed");

    // the same two leads again, but the retry comes after the failure has decayed: lead 1 is back in its normal place (first)
    __resetWithdrawalAttempts();
    const f = env({ cap: 1, leads: [lead(1, optedOut), lead(2, optedOut)], unsub: id => (id === "9001" && failFirst.size ? (() => { throw new SmartleadApiError("boom", 500); })() : "ok") });
    failFirst.add("9001");
    f.deps.now = () => new Date(nowMs);
    await withdrawalSweep(f.deps); // lead 1 fails again
    failFirst.clear();
    nowMs += 7 * 60 * 60 * 1000;
    await withdrawalSweep(f.deps);
    expect(f.leads[0].system.smartlead_77.state).toBe("withdrawn"); // not starved behind lead 2
    expect(f.leads[1].system.smartlead_77.state).toBe("pushed");
  });

  it("warns loudly when the run limit truncates the sweep", async () => {
    const e = env({ leads: [] });
    e.deps.db.listRunsSince = jest.fn(async () => Array.from({ length: 1000 }, (_, i) => ({ runId: `r${i}`, listId: `L${i}`, campaignId: 1, createdAt: "2026-10-27T00:00:00Z" }) as any));
    e.deps.db.getRun = jest.fn(async () => null);
    await withdrawalSweep(e.deps);
    expect(e.logs.join("\n")).toMatch(/WARNING: 1000 runs/);
  });
  it("does not sweep with a key that cannot SEE the campaign (another Smartlead account answers 404 to everything): nothing is closed as withdrawn, and it says so", async () => {
    const e = env({ leads: [lead(1, optedOut), lead(2, optedOut)], visible: false, unsub: () => "not_found" });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, keyUnavailable: 1, failed: 0 });
    expect(e.unsub).not.toHaveBeenCalled();
    expect(e.leads[0].system.smartlead_77.state).toBe("pushed");
    expect(e.logs.join("\n")).toMatch(/cannot see this campaign/);
  });

  it("logs a list that has no usable key, one that throws, and the run limit ONCE a day, not every pass", async () => {
    const a = env({ leads: [lead(1, optedOut)], key: { ok: false, reason: "not_connected", message: "x" } });
    for (let i = 0; i < 5; i++) await withdrawalSweep(a.deps);
    expect(a.logs.filter(l => /NO usable Smartlead key/.test(l))).toHaveLength(1);
    const b = env({ leads: [lead(1, optedOut)], visible: false });
    for (let i = 0; i < 5; i++) await withdrawalSweep(b.deps);
    expect(b.logs.filter(l => /cannot see this campaign/.test(l))).toHaveLength(1);
    const c = env({ leads: [lead(1, optedOut)] });
    c.deps.readLeads = async () => { throw new Error("throttled"); };
    for (let i = 0; i < 5; i++) await withdrawalSweep(c.deps);
    expect(c.logs.filter(l => /list=L campaign=77: throttled/.test(l))).toHaveLength(1);
    const d = env({ leads: [] });
    d.deps.db.listRunsSince = jest.fn(async () => Array.from({ length: 1000 }, (_, i) => ({ runId: `r${i}`, listId: `L${i}`, campaignId: 1, createdAt: "2026-10-27T00:00:00Z" }) as any));
    d.deps.db.getRun = jest.fn(async () => null);
    for (let i = 0; i < 5; i++) await withdrawalSweep(d.deps);
    expect(d.logs.filter(l => /WARNING: 1000 runs/.test(l))).toHaveLength(1);
  });
  it("makes no Smartlead call at all on a quiet pass (nobody opted out): the visibility check only runs when there is something to withdraw", async () => {
    const e = env({ leads: [lead(1), lead(2)] });
    await withdrawalSweep(e.deps);
    expect(e.deps.smartlead.campaignVisible).not.toHaveBeenCalled();
    expect(e.unsub).not.toHaveBeenCalled();
  });

  it("reports a key that was rejected during the visibility check (so the connection is flagged and the customer told), and the other lists still run", async () => {
    const runs = [
      { runId: "a", listId: "BAD", campaignId: 88, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-27T00:00:00Z" },
      { runId: "b", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-10-26T00:00:00Z" },
    ];
    const e = env({ runs, leads: [lead(1, optedOut)] });
    const read = e.deps.readLeads;
    e.deps.readLeads = async (l, a, n) => (l === "BAD" ? { items: [{ leadId: "x", email: "x@example.com", contactStatus: "do-not-contact", system: { smartlead_88: marker("pushed", "1") } }], hasMore: false } : read(l, a, n));
    (e.deps.smartlead.campaignVisible as jest.Mock).mockImplementation(async (_k: string, campaignId: number) => { if (campaignId === 88) throw new SmartleadApiError("nope", 401); return true; });
    const r = await withdrawalSweep(e.deps);
    expect(e.deps.reportFailure).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ targetErrors: 1, withdrawn: 1 });
  });

  it("does not let the once-a-day log hide a DIFFERENT problem on the same list (a 429 today, a rejected key tomorrow)", async () => {
    const e = env({ leads: [lead(1, optedOut)] });
    let status = 429;
    (e.deps.smartlead.campaignVisible as jest.Mock).mockImplementation(async () => { throw new SmartleadApiError(`status ${status}`, status); });
    await withdrawalSweep(e.deps);
    status = 401;
    await withdrawalSweep(e.deps);
    expect(e.logs.filter(l => /list=L campaign=77: /.test(l) && /status 429/.test(l))).toHaveLength(1);
    expect(e.logs.filter(l => /list=L campaign=77: /.test(l) && /status 401/.test(l))).toHaveLength(1);
    const k = env({ leads: [lead(1, optedOut)], key: { ok: false, reason: "not_connected", message: "x" } });
    await withdrawalSweep(k.deps);
    k.deps.resolveKey = jest.fn(async () => ({ ok: false, reason: "key_rejected", message: "x" }) as any);
    await withdrawalSweep(k.deps);
    expect(k.logs.filter(l => /NO usable Smartlead key/.test(l))).toHaveLength(2);
  });

  it("logs a pass summary that only repeats the same problems once a day, but every pass that withdrew something", async () => {
    const same = env({ leads: [lead(1, optedOut)], visible: false });
    for (let i = 0; i < 4; i++) await withdrawalSweep(same.deps);
    expect(same.logs.filter(l => /\] pass:/.test(l))).toHaveLength(1);
    const busy = env({ leads: [1, 2, 3].map(n => lead(n, optedOut)) });
    await withdrawalSweep(busy.deps);
    expect(busy.logs.filter(l => /\] pass:/.test(l))).toHaveLength(1);
  });
  describe("pushing an edited address to Smartlead (Update Lead)", () => {
    const pushedAs = (email: string, id = "9001", state = "pushed") => ({ smartlead_77: { ...marker(state, id), email } });
    const edited = (n: number, newEmail: string, over: Record<string, any> = {}) => lead(n, { email: newEmail, system: pushedAs(`p${n}@example.com`, String(9000 + n)), ...over });

    it("replaces the pushed address in Smartlead (same lead id), records the new address on the marker, and unsubscribes nobody", async () => {
      const e = env({ leads: [edited(1, "fixed@example.com")] });
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 1, failed: 0, withdrawn: 0 });
      expect(e.upd).toHaveBeenCalledWith("KEY", 77, "9001", "fixed@example.com");
      expect(e.leads[0].system.smartlead_77).toMatchObject({ state: "pushed", email: "fixed@example.com", smartleadLeadId: "9001" });
      expect(e.unsub).not.toHaveBeenCalled();
      expect(e.find).not.toHaveBeenCalled();
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0 }); // idempotent: the marker now matches
    });

    it("also syncs a RELEASED lead, and leaves alone a withdrawn lead, a marker without an address or an id, an unchanged address and an invalid new address", async () => {
      const e = env({ leads: [
        edited(1, "a@example.com", { system: pushedAs("p1@example.com", "9001", "released") }),
        edited(2, "b@example.com", { system: pushedAs("p2@example.com", "9002", "withdrawn") }),
        lead(3, { email: "c@example.com" }), // older marker: no address recorded
        edited(4, "d@example.com", { system: { smartlead_77: { ...marker("pushed", null), email: "p4@example.com" } } }), // no id
        lead(5, { system: pushedAs("p5@example.com", "9005") }), // unchanged
        edited(6, "not an address"),
        edited(7, "e@example.com", { email: "E@Example.COM", system: pushedAs("e@example.com", "9007") }), // same address, other case
      ] });
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 1 });
      expect(e.upd.mock.calls.map(c => c[2])).toEqual(["9001"]);
    });

    it("makes no Smartlead call for a list with nothing edited and nobody opted out", async () => {
      const e = env({ leads: [lead(1), lead(2)] });
      await withdrawalSweep(e.deps);
      expect(e.upd).not.toHaveBeenCalled();
      expect(e.deps.smartlead.campaignVisible).not.toHaveBeenCalled();
    });

    it("an opted-out lead is STOPPED by its stored id and never moved to the new address first", async () => {
      const e = env({ leads: [edited(1, "fixed@example.com", optedOut)] });
      e.find.mockResolvedValue(null);
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0, withdrawn: 1, failed: 0 });
      expect(e.upd).not.toHaveBeenCalled();
      expect(e.unsub.mock.calls.map(c => c[1])).toEqual(["9001"]);
    });

    it("when the stop fails for an edited, opted-out lead the pushed address is NOT moved to the new one", async () => {
      const e = env({ leads: [edited(1, "fixed@example.com", optedOut)] });
      e.unsub.mockResolvedValue("no_update");
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0, withdrawn: 0, failed: 1 });
      expect(e.upd).not.toHaveBeenCalled();
    });

    it("stops the pushed address AND the lead that has the new address when Smartlead refuses the change (the new address is already another lead)", async () => {
      const e = env({ leads: [edited(1, "taken@example.com", optedOut)], update: () => "rejected" });
      e.find.mockImplementation(async (_k: string, address: string) => (address === "taken@example.com" ? "5555" : null));
      expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, synced: 0 });
      expect(e.unsub.mock.calls.map(c => c[1])).toEqual(["9001", "5555"]);
    });

    it("an opted-out, edited lead that the customer RE-IMPORTED in Smartlead (new id, pushed address still live) is stopped there too, not closed", async () => {
      const e = env({ leads: [edited(1, "fixed@example.com", optedOut)] });
      e.unsub.mockImplementation(async (_k: string, id: string) => (id === "9001" ? "not_found" : "ok") as any);
      e.find.mockImplementation(async (_k: string, address: string) => (address === "p1@example.com" ? "8123" : null));
      expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, failed: 0 });
      expect(e.unsub.mock.calls.map(c => c[1])).toEqual(["9001", "8123"]);
    });

    it("a stored id that is gone with nothing live at the pushed or the new address closes the lead; a looked-up id that 404s keeps it open", async () => {
      const gone = env({ leads: [edited(1, "fixed@example.com", optedOut)] });
      gone.unsub.mockResolvedValue("not_found");
      gone.find.mockResolvedValue(null);
      expect(await withdrawalSweep(gone.deps)).toMatchObject({ withdrawn: 1, failed: 0 });
      const odd = env({ leads: [edited(1, "fixed@example.com", optedOut)] });
      odd.unsub.mockResolvedValue("not_found");
      odd.find.mockImplementation(async (_k: string, address: string) => (address === "p1@example.com" ? "8123" : null));
      expect(await withdrawalSweep(odd.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
    });

    it("stops the stored lead when an opted-out lead's address was cleared (nothing to sync, nothing to look up)", async () => {
      const e = env({ leads: [edited(1, "", optedOut)] });
      expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1 });
      expect(e.upd).not.toHaveBeenCalled();
      expect(e.find.mock.calls.map(c => c[1])).toEqual(["p1@example.com"]); // only the pushed address is looked up: there is no new one
      expect(e.unsub.mock.calls.map(c => c[1])).toEqual(["9001", "7777"]);
    });

    it("a refused change on a lead that did NOT opt out is a failure that is logged once a day and leaves the marker alone", async () => {
      const e = env({ leads: [edited(1, "taken@example.com")], update: () => "rejected" });
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0, failed: 1 });
      await withdrawalSweep(e.deps);
      expect(e.leads[0].system.smartlead_77.email).toBe("p1@example.com");
      expect(e.logs.filter(l => /Smartlead refused the new one/.test(l))).toHaveLength(1);
      const later = NOW.getTime() + 25 * 60 * 60 * 1000;
      e.deps.now = () => new Date(later);
      await withdrawalSweep(e.deps);
      expect(e.logs.filter(l => /Smartlead refused the new one/.test(l))).toHaveLength(2);
    });

    it("ten refused address changes in a row end the edits for this pass (a refusal and an outage both answer 500), after the opt-outs have run", async () => {
      const drifted = Array.from({ length: 15 }, (_, i) => edited(i + 1, `taken${i}@example.com`));
      const e = env({ leads: [...drifted, lead(100, optedOut)], update: () => "rejected" });
      const r = await withdrawalSweep(e.deps);
      expect(r).toMatchObject({ failed: 10, withdrawn: 1 });
      expect(e.upd).toHaveBeenCalledTimes(10);
    });

    it("a 404 on the stored id with the pushed address NOT in Smartlead: nothing live to correct, the marker takes the new address, no failure", async () => {
      const e = env({ leads: [edited(1, "new@example.com")], update: () => "not_found" });
      e.find.mockResolvedValue(null);
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0, failed: 0 });
      expect(e.find).toHaveBeenCalledWith("KEY", "p1@example.com");
      expect(e.leads[0].system.smartlead_77.email).toBe("new@example.com");
      await withdrawalSweep(e.deps);
      expect(e.upd).toHaveBeenCalledTimes(1);
    });

    it("a 404 because the customer re-imported the lead (new id, pushed address still live): the NEW id gets the edited address and the marker follows it", async () => {
      const e = env({ leads: [edited(1, "new@example.com")], update: id => (id === "9001" ? "not_found" : "ok") });
      e.find.mockResolvedValue("8123");
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 1, failed: 0 });
      expect(e.upd.mock.calls.map(c => c[2])).toEqual(["9001", "8123"]);
      expect(e.leads[0].system.smartlead_77).toMatchObject({ email: "new@example.com", smartleadLeadId: "8123" });
    });

    it("a re-imported lead whose edited address cannot be applied stays OPEN (the pushed address is still live), marker untouched", async () => {
      const e = env({ leads: [edited(1, "new@example.com")], update: id => (id === "9001" ? "not_found" : "rejected") });
      e.find.mockResolvedValue("8123");
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0, failed: 1 });
      expect(e.leads[0].system.smartlead_77).toMatchObject({ email: "p1@example.com", smartleadLeadId: "9001" });
    });

    it("'Smartlead changed nothing' on an address change is a failure", async () => {
      const e = env({ leads: [edited(1, "x@example.com")], update: () => "no_update" });
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0, failed: 1 });
    });

    it("opt-outs are handled BEFORE address edits, so a rate limit during the edits never leaves somebody who said stop emailed", async () => {
      const e = env({ leads: [edited(1, "x@example.com"), lead(2, optedOut), lead(3, optedOut)] });
      e.upd.mockRejectedValue(new SmartleadApiError("slow", 429));
      expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 2, synced: 0, failed: 1 });
      expect(e.unsub).toHaveBeenCalledTimes(2);
      expect(e.upd).toHaveBeenCalledTimes(1);
    });

    it("a rate limit while stopping leads leaves the address edits for the next pass", async () => {
      const e = env({ leads: [lead(1, optedOut), edited(2, "x@example.com")] });
      e.unsub.mockRejectedValue(new SmartleadApiError("slow", 429));
      expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, synced: 0 });
      expect(e.upd).not.toHaveBeenCalled();
    });

    it("does not sync with a key that cannot see the campaign", async () => {
      const e = env({ leads: [edited(1, "x@example.com")], visible: false });
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0, keyUnavailable: 1 });
      expect(e.upd).not.toHaveBeenCalled();
    });

    it("decides on a consistent re-read: an address changed back (or a lead deleted) since the page read is not synced", async () => {
      const e = env({ leads: [edited(1, "x@example.com"), edited(2, "y@example.com")], consistent: id => (id === "lead_00001" ? { ...lead(1), system: pushedAs("p1@example.com", "9001") } : null) });
      expect(await withdrawalSweep(e.deps)).toMatchObject({ synced: 0 });
      expect(e.upd).not.toHaveBeenCalled();
    });
  });
});
