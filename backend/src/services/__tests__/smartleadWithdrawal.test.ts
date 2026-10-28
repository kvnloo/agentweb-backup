import { withdrawalSweep, WITHDRAWALS_PER_LIST, type WithdrawalDeps } from "../smartleadWithdrawal";
import { smartleadMarkerKey } from "../smartleadMarkers";
import { SmartleadApiError } from "../smartleadService";

const NOW = new Date("2026-10-28T12:00:00Z");
const marker = (state = "pushed", id: string | null = "9001") => ({ state, pushedAt: "x", runId: "r1", payloadHash: "h", ...(id ? { smartleadLeadId: id } : {}) });
const lead = (n: number, over: Record<string, any> = {}) => ({ leadId: `lead_${String(n).padStart(5, "0")}`, email: `p${n}@example.com`, system: { smartlead_77: marker("pushed", String(9000 + n)) }, ...over });
const optedOut = { contactStatus: "do-not-contact" };

interface Env { deps: WithdrawalDeps; leads: any[]; unsub: jest.Mock; find: jest.Mock; written: Array<{ leadId: string; marker: any }>; logs: string[]; runs: any[] }

function env(over: { leads?: any[]; runs?: any[]; key?: any; unsub?: (id: string) => any } = {}): Env {
  const leads = over.leads ?? [];
  const written: Env["written"] = [];
  const logs: string[] = [];
  const runs = over.runs ?? [{ runId: "run1", status: "completed", listId: "L", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "smartlead-owner", createdAt: "2026-10-27T00:00:00Z" }];
  const unsub = jest.fn(async (_k: string, id: string) => (over.unsub ? over.unsub(id) : "ok"));
  const find = jest.fn(async () => "7777" as string | null);
  const deps: WithdrawalDeps = {
    db: { listRunsSince: jest.fn(async (since: string) => runs.filter(r => r.createdAt >= since) as any), getRun: jest.fn(async (id: string) => runs.find(r => r.runId === id) ?? null) },
    resolveKey: jest.fn(async () => over.key ?? ({ ok: true, apiKey: "KEY", ownerUserId: "owner", accountId: "smartlead-owner", accountName: "x" })),
    reportFailure: jest.fn(async () => "key_rejected"),
    readLeads: async (_l, after, limit) => { const start = after ? leads.findIndex(x => x.leadId === after.leadId) + 1 : 0; return { items: leads.slice(start, start + limit), hasMore: start + limit < leads.length }; },
    writeMarker: async (_l, leadId, _k, m) => { written.push({ leadId, marker: m }); const l = leads.find(x => x.leadId === leadId); if (l) l.system = { ...l.system, [smartleadMarkerKey(77)]: m }; },
    smartlead: { unsubscribe: unsub, findLeadId: find },
    now: () => NOW,
    log: l => logs.push(l),
  };
  return { deps, leads, unsub, find, written, logs, runs };
}

describe("withdrawalSweep (ENG-673)", () => {
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

  it("leaves alone leads that are already withdrawn or released, and leads with no marker for the campaign", async () => {
    const e = env({ leads: [lead(1, { ...optedOut, system: { smartlead_77: marker("withdrawn") } }), lead(2, { ...optedOut, system: { smartlead_77: marker("released") } }), lead(3, { ...optedOut, system: {} }), lead(4, { ...optedOut, system: { smartlead_99: marker() } })] });
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

  it("treats a lead Smartlead no longer has (404) as withdrawn, so it stops being retried", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: () => "not_found" });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 1, failed: 0 });
    expect(e.written[0].marker.state).toBe("withdrawn");
  });

  it("leaves the marker 'pushed' and counts a failure when Smartlead changed nothing, so the next pass tries again", async () => {
    const e = env({ leads: [lead(1, optedOut)], unsub: () => "no_update" });
    expect(await withdrawalSweep(e.deps)).toMatchObject({ withdrawn: 0, failed: 1 });
    expect(e.written).toHaveLength(0);
  });

  it("leaves the marker 'pushed' after a rate limit or an outage, and stops the list after three failures in a row", async () => {
    const e = env({ leads: [1, 2, 3, 4, 5].map(n => lead(n, optedOut)), unsub: () => { throw new SmartleadApiError("slow", 429); } });
    const r = await withdrawalSweep(e.deps);
    expect(r.withdrawn).toBe(0);
    expect(r.failed).toBe(3); // not five: the list was left for the next pass
    expect(e.unsub).toHaveBeenCalledTimes(3);
    expect(e.written).toHaveLength(0);
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
    expect(e.logs.join("\n")).toMatch(/key unavailable/);
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
      { runId: "old", listId: "OLD", campaignId: 77, keyOwnerId: "owner", smartleadAccountId: "a", createdAt: "2026-06-01T00:00:00Z" },
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
});
