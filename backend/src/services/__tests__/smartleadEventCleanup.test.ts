import { prepareSmartleadEventCleanup, type CleanupDeps } from "../smartleadEventCleanup";
import { EVENT_TYPES, EVENT_WEBHOOK_NAME, webhookUrlFor } from "../smartleadEventRegistration";

const ACCOUNT = "smartlead-u1";
const BASE = "https://api.example.test";
const mine = (c: number, id: number) => ({ id, name: EVENT_WEBHOOK_NAME, url: webhookUrlFor(BASE, "s", ACCOUNT, c), eventTypes: [...EVENT_TYPES] });

function deps(over: Partial<CleanupDeps> = {}) {
  const deleted: Array<[number, number]> = [];
  const logs: string[] = [];
  const d: CleanupDeps = {
    resolveKey: async () => ({ ok: true, apiKey: "k" }),
    listCampaignIds: async () => [1, 2],
    api: { list: async (_k, c) => (c === 1 ? [mine(1, 10)] : []), save: async () => 0, del: async (_k, c, id) => { deleted.push([c, id]); } },
    baseUrl: () => BASE,
    reconnected: async () => false,
    log: l => logs.push(l),
    ...over,
  };
  return { d, deleted, logs };
}

describe("taking our webhook off when a Smartlead connection is removed (ENG-673)", () => {
  it("finds the key first and returns the background job; the job removes ours from the account's campaigns", async () => {
    const x = deps();
    const job = (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run();
    expect(await job).toEqual({ campaigns: 2, removed: 1, failed: 0 });
    expect(x.deleted).toEqual([[1, 10]]);
    expect(x.logs.join("\n")).toContain("removed 1 webhook");
  });

  it("the caller only waits for the key lookup: it gets control back while the Smartlead work is still blocked", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const x = deps({ listCampaignIds: async () => { await gate; return [1]; } });
    const job = (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run(); // returns although the job cannot finish yet
    expect(x.deleted).toEqual([]);
    release();
    expect(await job).toEqual({ campaigns: 1, removed: 1, failed: 0 });
    expect(x.deleted).toEqual([[1, 10]]);
  });

  it("does nothing when the key cannot be used (already revoked, or not theirs)", async () => {
    const x = deps({ resolveKey: async () => ({ ok: false }) });
    expect(await (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run()).toBeNull();
    expect(x.deleted).toEqual([]);
  });

  it("never throws or rejects, whatever goes wrong: the connection is removed regardless", async () => {
    const x = deps({ listCampaignIds: async () => { throw new Error("smartlead down"); } });
    expect(await (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run()).toBeNull();
    expect(x.logs.join("\n")).toContain("smartlead down");
    const y = deps({ resolveKey: async () => { throw new Error("db down"); } });
    expect(await (await prepareSmartleadEventCleanup("u1", ACCOUNT, y.d)).run()).toBeNull();
    expect(y.logs.join("\n")).toContain("db down");
  });

  it("looks at no more than 300 campaigns", async () => {
    const seen: number[] = [];
    const x = deps({ listCampaignIds: async () => Array.from({ length: 500 }, (_, i) => i + 1), api: { list: async (_k, c) => { seen.push(c); return []; }, save: async () => 0, del: async () => undefined } });
    const out = await (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run();
    expect(out!.campaigns).toBe(300);
    expect(seen).toHaveLength(300);
  });

  it("does nothing without a public address (nothing can be recognised as ours)", async () => {
    const x = deps({ baseUrl: () => null });
    expect(await (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run()).toBeNull();
    expect(x.deleted).toEqual([]);
  });

  it("stops when the connection was added again, so the new connection's webhook is kept", async () => {
    let back = false;
    const x = deps({ listCampaignIds: async () => [1, 2, 3], reconnected: async () => back, api: { list: async (_k, c) => { if (c === 1) back = true; return [mine(c, 10 + c)]; }, save: async () => 0, del: async (_k, c, id) => { x.deleted.push([c, id]); } } });
    const out = await (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run();
    expect(out!.campaigns).toBe(1); // campaign 1 was handled before the check saw it back; 2 and 3 were not touched
    expect(x.deleted.map(d => d[0])).toEqual([1]);
    expect(x.logs.join("\n")).toContain("added again");
  });

  it("does nothing to Smartlead until it is run, so the caller can delete the connection first", async () => {
    const calls: string[] = [];
    const x = deps({ listCampaignIds: async () => { calls.push("list"); return []; } });
    const prepared = await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d);
    expect(calls).toEqual([]);
    await prepared.run();
    expect(calls).toEqual(["list"]);
  });

  it("not knowing whether the connection came back means stop: a failed read removes nothing", async () => {
    const x = deps({ reconnected: async () => { throw new Error("dynamo down"); } });
    expect(await (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run()).toBeNull();
    expect(x.deleted).toEqual([]);
    expect(x.logs.join("\n")).toContain("dynamo down");
  });

  it("stops between campaigns when its time budget is spent, and says so", async () => {
    const seen: number[] = [];
    const x = deps({ budgetMs: 30, listCampaignIds: async () => Array.from({ length: 50 }, (_, i) => i + 1), api: { list: async (_k, c) => { seen.push(c); await new Promise(r => setTimeout(r, 20)); return []; }, save: async () => 0, del: async () => undefined } });
    const out = await (await prepareSmartleadEventCleanup("u1", ACCOUNT, x.d)).run();
    expect(out!.campaigns).toBeGreaterThan(0);
    expect(out!.campaigns).toBeLessThan(50);
    expect(x.logs.join("\n")).toContain("stopped at its time budget");
  });
});
