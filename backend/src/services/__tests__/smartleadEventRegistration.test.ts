import { EVENT_TYPES, EVENT_WEBHOOK_NAME, ensureEventWebhook, publicBaseUrl, removeEventWebhooks, webhookUrlFor, type WebhookApi } from "../smartleadEventRegistration";
import { verifyWebhookToken } from "../smartleadWebhookToken";
import type { SmartleadWebhook } from "../smartleadService";

const ACCOUNT = "smartlead-u1";
const SECRET = "reg-secret";
const BASE = "https://api.example.test";
const url = (campaign: number, base = BASE) => webhookUrlFor(base, SECRET, ACCOUNT, campaign);

function fake(initial: Record<string, any> = {}) {
  const store: Record<number, SmartleadWebhook[]> & Record<string, any> = JSON.parse(JSON.stringify(initial));
  let next = 1000;
  const calls: string[] = [];
  const api: WebhookApi = {
    list: async (_k, c) => { calls.push(`list ${c}`); if ((store as any)[`fail${c}`]) throw new Error("smartlead 500"); return (store[c] ?? []).map(w => ({ ...w })); },
    save: async (_k, c, input) => {
      calls.push(`save ${c}${input.id !== undefined ? ` id=${input.id}` : ""}`);
      const list = (store[c] ??= []);
      if (input.id !== undefined) { const w = list.find(x => x.id === input.id)!; w.name = input.name; w.url = input.url; w.eventTypes = input.eventTypes; return w.id; }
      list.push({ id: next++, name: input.name, url: input.url, eventTypes: input.eventTypes });
      return list[list.length - 1].id;
    },
    del: async (_k, c, id) => { calls.push(`del ${c} id=${id}`); store[c] = (store[c] ?? []).filter(w => w.id !== id); },
  };
  return { api, store, calls };
}
const ours = (campaign: number, id = 1, over: Partial<SmartleadWebhook> = {}): SmartleadWebhook => ({ id, name: EVENT_WEBHOOK_NAME, url: url(campaign), eventTypes: [...EVENT_TYPES], ...over });
const args = (campaignId: number, over: Record<string, unknown> = {}) => ({ apiKey: "k", accountId: ACCOUNT, campaignId, baseUrl: BASE as string | null, secret: SECRET, ...over });

describe("the customer-facing webhook name", () => {
  it("is plain product wording: no ticket, project or internal wording", () => {
    expect(EVENT_WEBHOOK_NAME).toBe("AgentWeb: replies, bounces and unsubscribes");
    expect(EVENT_WEBHOOK_NAME).not.toMatch(/ENG|Linear|ticket|slice|[0-9]/i);
  });
});

describe("the address Smartlead is given", () => {
  it("is this deployment's public address, the account, the campaign and a token the endpoint accepts", () => {
    const u = url(77);
    expect(u.startsWith(`${BASE}/api/webhooks/smartlead/${ACCOUNT}/77/`)).toBe(true);
    const token = u.split("/").pop()!;
    expect(verifyWebhookToken(SECRET, ACCOUNT, "77", token)).toBe(true);
    expect(verifyWebhookToken(SECRET, ACCOUNT, "78", token)).toBe(false);
  });

  it("needs a real public address: https in production, http only elsewhere, never localhost", () => {
    expect(publicBaseUrl({ BACKEND_URL: "https://api.agentweb.pro/", NODE_ENV: "production" })).toBe("https://api.agentweb.pro");
    expect(publicBaseUrl({ BACKEND_URL: "http://api.agentweb.pro", NODE_ENV: "production" })).toBeNull();
    expect(publicBaseUrl({ BACKEND_URL: "http://1.2.3.4:3001", NODE_ENV: "development" })).toBe("http://1.2.3.4:3001");
    for (const bad of [undefined, "", "   ", "not a url", "ftp://x.y", "http://localhost:3001", "https://127.0.0.1", "http://0.0.0.0"]) expect(publicBaseUrl({ BACKEND_URL: bad, NODE_ENV: "development" })).toBeNull();
  });
});

describe("making sure a campaign has our webhook (ENG-673)", () => {
  it("creates it when there is none, with the exact events", async () => {
    const f = fake();
    expect(await ensureEventWebhook(f.api, args(77))).toBe("created");
    expect(f.store[77]).toEqual([expect.objectContaining({ name: EVENT_WEBHOOK_NAME, url: url(77), eventTypes: EVENT_TYPES })]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const f = fake();
    await ensureEventWebhook(f.api, args(77));
    f.calls.length = 0;
    expect(await ensureEventWebhook(f.api, args(77))).toBe("present");
    expect(f.calls).toEqual(["list 77"]);
  });

  it("updates ours in place when its address or events are wrong (a changed secret), without creating a second", async () => {
    const f = fake({ 77: [ours(77, 5, { url: `${BASE}/api/webhooks/smartlead/smartlead-u1/77/oldtoken` })] });
    expect(await ensureEventWebhook(f.api, args(77))).toBe("updated");
    expect(f.store[77]).toHaveLength(1);
    expect(f.store[77][0]).toMatchObject({ id: 5, url: url(77) });
    const g = fake({ 77: [ours(77, 6, { eventTypes: ["EMAIL_REPLY"] })] });
    expect(await ensureEventWebhook(g.api, args(77))).toBe("updated");
    expect(g.store[77][0].eventTypes).toEqual(EVENT_TYPES);
  });

  it("removes duplicates of ours so one event is not delivered twice", async () => {
    const f = fake({ 77: [ours(77, 1), ours(77, 2), ours(77, 3)] });
    expect(await ensureEventWebhook(f.api, args(77))).toBe("present");
    expect(f.store[77].map(w => w.id)).toEqual([1]);
  });

  it("never touches a webhook that is not ours: another name, or ours-by-name pointing at another AgentWeb account", async () => {
    const mine = ours(77, 9, { url: url(77) });
    const customers = { id: 20, name: "Customer CRM sync", url: "https://crm.example.com/hook", eventTypes: ["EMAIL_REPLY"] };
    const lookalike = { id: 21, name: EVENT_WEBHOOK_NAME, url: "https://other-tool.example.com/hook", eventTypes: ["EMAIL_REPLY"] };
    const otherAccount = { id: 22, name: EVENT_WEBHOOK_NAME, url: webhookUrlFor(BASE, SECRET, "smartlead-someone-else", 77), eventTypes: [...EVENT_TYPES] };
    const f = fake({ 77: [customers, lookalike, otherAccount, mine] });
    expect(await ensureEventWebhook(f.api, args(77))).toBe("present");
    expect(f.store[77].map(w => w.id).sort((a, b) => a - b)).toEqual([9, 20, 21, 22]);
    // a webhook with a different NAME is never ours, even when its address is: it is not touched or deleted (at worst we add our own beside it)
    const renamed = { id: 23, name: "Renamed by the customer", url: url(77), eventTypes: ["EMAIL_REPLY"] };
    const h = fake({ 77: [renamed] });
    await ensureEventWebhook(h.api, args(77));
    expect(h.store[77].find(w => w.id === 23)).toEqual(renamed);
    const r = fake({ 1: [renamed] });
    await removeEventWebhooks(r.api, { apiKey: "k", accountId: ACCOUNT, baseUrl: BASE, campaignIds: [1] });
    expect(r.store[1]).toEqual([renamed]);
    const g = fake({ 77: [customers, lookalike, otherAccount] });
    expect(await ensureEventWebhook(g.api, args(77))).toBe("created");
    expect(g.store[77].filter(w => w.id < 1000).map(w => w.id)).toEqual([20, 21, 22]); // untouched (the new one is 1000)
  });

  it("never touches another deployment's webhook (same account, other host), and does not delete it on disconnect", async () => {
    const other = ours(77, 30, { url: url(77, "https://test-env.example.test") });
    const f = fake({ 77: [other] });
    expect(await ensureEventWebhook(f.api, args(77))).toBe("created");
    expect(f.store[77].find(w => w.id === 30)).toEqual(other); // not rewritten to our host
    const r = await removeEventWebhooks(f.api, { apiKey: "k", accountId: ACCOUNT, baseUrl: BASE, campaignIds: [77] });
    expect(r.removed).toBe(1);
    expect(f.store[77].map(w => w.id)).toEqual([30]); // only ours went
  });

  it("does nothing, and calls nothing, when there is no usable public address", async () => {
    const f = fake();
    expect(await ensureEventWebhook(f.api, args(77, { baseUrl: null }))).toBe("no_public_url");
    expect(f.calls).toEqual([]);
  });

  it("a Smartlead error is thrown to the caller (which logs it and carries on)", async () => {
    const f = fake({ fail77: [] as any });
    await expect(ensureEventWebhook(f.api, args(77))).rejects.toThrow("smartlead 500");
  });
});

describe("removing our webhook (ENG-673)", () => {
  it("removes only ours, for this account, from every campaign given", async () => {
    const customers = { id: 20, name: "Customer CRM sync", url: "https://crm.example.com/hook", eventTypes: ["EMAIL_REPLY"] };
    const otherAccount = { id: 22, name: EVENT_WEBHOOK_NAME, url: webhookUrlFor(BASE, SECRET, "smartlead-someone-else", 2), eventTypes: [...EVENT_TYPES] };
    const f = fake({ 1: [ours(1, 10), customers], 2: [otherAccount, ours(2, 11)], 3: [] });
    const out = await removeEventWebhooks(f.api, { apiKey: "k", accountId: ACCOUNT, baseUrl: BASE, campaignIds: [1, 2, 3] });
    expect(out).toEqual({ campaigns: 3, removed: 2, failed: 0 });
    expect(f.store[1].map(w => w.id)).toEqual([20]);
    expect(f.store[2].map(w => w.id)).toEqual([22]);
  });

  it("one campaign failing does not stop the others, and is reported", async () => {
    const f = fake({ 1: [ours(1, 10)], fail2: [] as any, 3: [ours(3, 12)] });
    const logs: string[] = [];
    const out = await removeEventWebhooks(f.api, { apiKey: "k", accountId: ACCOUNT, baseUrl: BASE, campaignIds: [1, 2, 3] }, l => logs.push(l));
    expect(out).toEqual({ campaigns: 3, removed: 2, failed: 1 });
    expect(logs.join("\n")).toContain("campaign 2");
  });
});
