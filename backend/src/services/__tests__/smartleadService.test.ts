import axios from "axios";
import {
  realAddLeadsExistingInOtherCampaign,
  realAddLeadsFirstImport,
  realAddLeadsNoMap,
  realAddLeadsResend,
  realCampaignMailboxes,
  realCampaignsList,
  realEmailAccounts,
  realSequencesWithVariants,
} from "./fixtures/smartleadRealReplies";
import {
  __configureSmartleadClient,
  addLeadsToCampaign,
  findLeadIdByEmail,
  getCampaign,
  getCampaignAnalytics,
  getCampaignEmailAccounts,
  getCampaignSequences,
  listCampaigns,
  getSmartLeadMetrics,
  listCampaignLeadsByEmailStatus,
  listEmailAccounts,
  scrubSmartleadSecrets,
  SmartleadApiError,
  SmartleadUnexpectedResponseError,
  smartleadRequest,
  unsubscribeLeadGlobally,
  updateLeadEmail,
} from "../smartleadService";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const KEY = "sk_live_supersecret123";

function err429(retryAfter?: string) {
  return Object.assign(new Error("Request failed with status code 429"), {
    response: { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} },
  });
}

describe("smartleadService client hardening (ENG-2658)", () => {
  let sleeps: number[];
  let clock: number;

  beforeEach(() => {
    jest.resetAllMocks();
    sleeps = [];
    clock = 0;
    __configureSmartleadClient({
      options: { requestsPerMinute: 0 },
      sleep: async ms => { sleeps.push(ms); clock += ms; },
      random: () => 0.5,
      now: () => clock,
    });
  });

  it("retries 429 with exponential backoff + jitter, then succeeds", async () => {
    mockedAxios.request
      .mockRejectedValueOnce(err429())
      .mockRejectedValueOnce(err429())
      .mockResolvedValueOnce({ data: [{ id: 1 }] } as never);
    const data = await smartleadRequest<unknown[]>(KEY, "GET", "/campaigns");
    expect(data).toEqual([{ id: 1 }]);
    expect(mockedAxios.request).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]); // 0.5 * 1000*2^0, 0.5 * 1000*2^1
  });

  it("honours Retry-After seconds", async () => {
    mockedAxios.request.mockRejectedValueOnce(err429("3")).mockResolvedValueOnce({ data: [] } as never);
    await smartleadRequest(KEY, "GET", "/campaigns");
    expect(sleeps).toEqual([3000]);
  });

  it("gives up after maxRetries and throws a scrubbed error", async () => {
    mockedAxios.request.mockRejectedValue(err429());
    await expect(smartleadRequest(KEY, "GET", "/campaigns")).rejects.toMatchObject({ status: 429 });
    expect(mockedAxios.request).toHaveBeenCalledTimes(5);
  });

  it("does not retry non-429 errors", async () => {
    mockedAxios.request.mockRejectedValue(
      Object.assign(new Error("boom"), { response: { status: 500, headers: {} } }),
    );
    await expect(smartleadRequest(KEY, "GET", "/x")).rejects.toThrow(/500/);
    expect(mockedAxios.request).toHaveBeenCalledTimes(1);
  });

  it("never leaks the api key in thrown errors", async () => {
    mockedAxios.request.mockRejectedValue(
      new Error(`connect ECONNREFUSED https://server.smartlead.ai/api/v1/campaigns?api_key=${KEY}`),
    );
    const e = (await smartleadRequest(KEY, "GET", "/campaigns").catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain(KEY);
    expect(e.message).toContain("api_key=[REDACTED]");
  });

  it("never logs the api key from getSmartLeadMetrics", async () => {
    process.env.SMARTLEAD_API_KEY = KEY;
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockedAxios.request.mockRejectedValue(new Error(`bad url ?api_key=${KEY}&x=1 ${KEY}`));
    const m = await getSmartLeadMetrics();
    expect(m.status).toBe("error");
    expect(m.error).not.toContain(KEY);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    spy.mockRestore();
    delete process.env.SMARTLEAD_API_KEY;
  });

  it("self-throttles to requestsPerMinute", async () => {
    __configureSmartleadClient({
      options: { requestsPerMinute: 60 },
      sleep: async ms => { sleeps.push(ms); clock += ms; },
      now: () => clock,
    });
    mockedAxios.request.mockResolvedValue({ data: [] } as never);
    await smartleadRequest(KEY, "GET", "/a");
    await smartleadRequest(KEY, "GET", "/b");
    await smartleadRequest(KEY, "GET", "/c");
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("scrubSmartleadSecrets redacts query param and raw key", () => {
    expect(scrubSmartleadSecrets(`u?api_key=abc&y=2 and abc`, "abc")).toBe(
      "u?api_key=[REDACTED]&y=2 and [REDACTED]",
    );
  });

  it("leaves the metrics email-account count as before: a non-list reply counts 0 rather than failing", async () => {
    process.env.SMARTLEAD_API_KEY = KEY;
    mockedAxios.request.mockImplementation((async (cfg: { url: string }) =>
      ({ data: cfg.url.endsWith("/email-accounts") ? { message: "x" } : [] })) as never);
    const m = await getSmartLeadMetrics();
    expect(m.status).toBe("ok");
    expect(m.emailAccountsCount).toBe(0);
    delete process.env.SMARTLEAD_API_KEY;
  });

  describe("listEmailAccounts (ENG-673)", () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: from + i, from_email: `box${from + i}@mindd-outreach.com` }));

    it("returns the mailboxes of the key, with no paging parameters on the first request", async () => {
      mockedAxios.request
        .mockResolvedValueOnce({ data: page(1, 3) } as never)
        .mockResolvedValueOnce({ data: [] } as never);
      const accounts = await listEmailAccounts(KEY);
      expect(accounts).toEqual([
        { id: 1, email: "box1@mindd-outreach.com" },
        { id: 2, email: "box2@mindd-outreach.com" },
        { id: 3, email: "box3@mindd-outreach.com" },
      ]);
      expect(mockedAxios.request.mock.calls[0][0].params).toEqual({ api_key: KEY });
    });

    it("keeps paging by offset until a page is empty", async () => {
      mockedAxios.request
        .mockResolvedValueOnce({ data: page(1, 100) } as never)
        .mockResolvedValueOnce({ data: page(101, 20) } as never)
        .mockResolvedValueOnce({ data: [] } as never);
      const accounts = await listEmailAccounts(KEY);
      expect(accounts).toHaveLength(120);
      expect(mockedAxios.request.mock.calls[1][0].params).toMatchObject({ offset: 100 });
      expect(mockedAxios.request.mock.calls[2][0].params).toMatchObject({ offset: 120 });
    });

    it("stops if a page adds nothing new (API ignoring offset)", async () => {
      mockedAxios.request.mockResolvedValue({ data: page(1, 100) } as never);
      const accounts = await listEmailAccounts(KEY);
      expect(accounts).toHaveLength(100);
      expect(mockedAxios.request).toHaveBeenCalledTimes(2);
    });

    it("accepts string ids", async () => {
      mockedAxios.request
        .mockResolvedValueOnce({ data: [{ id: "7", from_email: "a@x.com" }] } as never)
        .mockResolvedValueOnce({ data: [] } as never);
      await expect(listEmailAccounts(KEY)).resolves.toEqual([{ id: 7, email: "a@x.com" }]);
    });

    it("keeps rows whose id it cannot read, so a valid key never looks empty", async () => {
      mockedAxios.request
        .mockResolvedValueOnce({ data: [{ mailbox_id: 1, from_email: "a@x.com" }, { mailbox_id: 2, from_email: "b@x.com" }] } as never)
        .mockResolvedValueOnce({ data: [] } as never);
      await expect(listEmailAccounts(KEY)).resolves.toHaveLength(2);
    });

    it("reads one page when maxPages is 1", async () => {
      mockedAxios.request.mockResolvedValue({ data: page(1, 100) } as never);
      await expect(listEmailAccounts(KEY, { maxPages: 1 })).resolves.toHaveLength(100);
      expect(mockedAxios.request).toHaveBeenCalledTimes(1);
    });

    it("returns an empty list for a real empty array", async () => {
      mockedAxios.request.mockResolvedValue({ data: [] } as never);
      await expect(listEmailAccounts(KEY)).resolves.toEqual([]);
    });

    it("rejects a response that is not a list, so a key is never called valid on a guess", async () => {
      mockedAxios.request.mockResolvedValue({ data: { message: "Plan expired!" } } as never);
      await expect(listEmailAccounts(KEY)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("surfaces a rejected key as a SmartleadApiError with the status and without the key", async () => {
      mockedAxios.request.mockRejectedValue(
        Object.assign(new Error(`Request failed with status code 401 ?api_key=${KEY}`), {
          response: { status: 401, headers: {} },
        }),
      );
      const e = (await listEmailAccounts(KEY).catch((x: unknown) => x)) as { status?: number; message: string };
      expect(e.status).toBe(401);
      expect(e.message).not.toContain(KEY);
    });

    it("honours a lower retry budget on 429", async () => {
      mockedAxios.request.mockRejectedValue(err429());
      await expect(listEmailAccounts(KEY, { maxRetries: 1 })).rejects.toMatchObject({ status: 429 });
      expect(mockedAxios.request).toHaveBeenCalledTimes(2);
    });
  });
});

describe("smartleadService slice 2 client (ENG-673)", () => {
  let sleeps: number[];
  let clock: number;

  beforeEach(() => {
    jest.resetAllMocks();
    sleeps = [];
    clock = 0;
    __configureSmartleadClient({
      options: { requestsPerMinute: 60 },
      sleep: async ms => { sleeps.push(ms); clock += ms; },
      random: () => 0.5,
      now: () => clock,
    });
  });

  it("throttles per key: another key does not wait behind this one", async () => {
    mockedAxios.request.mockResolvedValue({ data: [] } as never);
    await smartleadRequest("key-aaa", "GET", "/campaigns/");
    await smartleadRequest("key-bbb", "GET", "/campaigns/");
    await smartleadRequest("key-ccc", "GET", "/campaigns/");
    expect(sleeps).toEqual([]);
    await smartleadRequest("key-aaa", "GET", "/campaigns/");
    expect(sleeps).toEqual([1000]);
  });

  describe("listEmailAccounts mailbox limits", () => {
    it("reads the daily limit from either documented field name and never keeps credentials", async () => {
      mockedAxios.request
        .mockResolvedValueOnce({
          data: [
            { id: 1, from_email: "a@x.com", message_per_day: 50, password: "smtp-secret", imap_password: "imap-secret" },
            { id: 2, from_email: "b@x.com", max_email_per_day: "30" },
            { id: 3, from_email: "c@x.com" },
          ],
        } as never)
        .mockResolvedValueOnce({ data: [] } as never);
      const accounts = await listEmailAccounts(KEY);
      expect(accounts).toEqual([
        { id: 1, email: "a@x.com", dailyLimit: 50 },
        { id: 2, email: "b@x.com", dailyLimit: 30 },
        { id: 3, email: "c@x.com", dailyLimit: undefined },
      ]);
      expect(JSON.stringify(accounts)).not.toMatch(/secret/);
    });
  });

  describe("listCampaigns", () => {
    it("accepts a bare array and a wrapped `campaigns` array, upper-cases the status and drops rows without an id", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: [{ id: 5, name: "Q4", status: "drafted", max_leads_per_day: 100 }, { name: "no id" }] } as never);
      await expect(listCampaigns(KEY)).resolves.toEqual([{ id: 5, name: "Q4", status: "DRAFTED", maxLeadsPerDay: 100 }]);
      mockedAxios.request.mockResolvedValueOnce({ data: { success: true, campaigns: [{ id: "6", name: "B", status: "ACTIVE" }] } } as never);
      await expect(listCampaigns(KEY)).resolves.toEqual([{ id: 6, name: "B", status: "ACTIVE", maxLeadsPerDay: undefined }]);
    });

    it("drops a campaign whose id is null, empty or zero rather than offering campaign 0", async () => {
      mockedAxios.request.mockResolvedValue({ data: [{ id: null, name: "a" }, { id: "", name: "b" }, { id: 0, name: "c" }, { id: 8, name: "ok" }] } as never);
      await expect(listCampaigns(KEY)).resolves.toEqual([{ id: 8, name: "ok", status: "", maxLeadsPerDay: undefined }]);
    });

    it("rejects a reply that is not a list rather than showing no campaigns", async () => {
      mockedAxios.request.mockResolvedValue({ data: { message: "Plan expired!" } } as never);
      await expect(listCampaigns(KEY)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });
  });

  describe("getCampaignAnalytics (live shape, 2026-11-04)", () => {
    // The shape was read from real campaigns in AgentWeb's own Smartlead account (every counter is a STRING); some values here are changed.
    const live = {
      id: 3083885, name: "ICP2-Final", status: "COMPLETED", sent_count: "38", open_count: "26", click_count: "0", reply_count: "2", unique_sent_count: "13",
      bounce_count: "1", unsubscribed_count: "3", campaign_lead_stats: { total: 15, completed: 12 }, client_email: "someone@example.com",
    };

    it("reads the counters, turning Smartlead's strings into numbers and leaving opens and clicks out", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: live } as never);
      await expect(getCampaignAnalytics(KEY, 3083885)).resolves.toEqual({
        campaignId: 3083885, name: "ICP2-Final", status: "COMPLETED", leadsInCampaign: 15, contactsEmailed: 13, emailsSent: 38, replies: 2, bounces: 1, unsubscribes: 3,
      });
      expect(mockedAxios.request.mock.calls[0][0].url).toMatch(/\/campaigns\/3083885\/analytics$/);
      expect(mockedAxios.request.mock.calls[0][0].method).toBe("GET");
    });

    it("omits the lead total when Smartlead does not say, and reports a real zero as zero", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { ...live, campaign_lead_stats: undefined, sent_count: "0", unique_sent_count: "0", reply_count: 0, bounce_count: "0", unsubscribed_count: "0" } } as never);
      const r = await getCampaignAnalytics(KEY, 3083885);
      expect(r).toMatchObject({ contactsEmailed: 0, emailsSent: 0, replies: 0 });
      expect(r).not.toHaveProperty("leadsInCampaign");
    });

    it("gives null for the empty reply of a missing campaign (live: HTTP 200 with {}), and errors for anything that is not that campaign", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: "" } as never);
      await expect(getCampaignAnalytics(KEY, 9)).resolves.toBeNull();
      mockedAxios.request.mockResolvedValueOnce({ data: {} } as never);
      await expect(getCampaignAnalytics(KEY, 9)).resolves.toBeNull();
      mockedAxios.request.mockResolvedValueOnce({ data: { message: "Plan expired" } } as never);
      await expect(getCampaignAnalytics(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      mockedAxios.request.mockResolvedValueOnce({ data: [live] } as never);
      await expect(getCampaignAnalytics(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      mockedAxios.request.mockResolvedValueOnce({ data: live } as never);
      await expect(getCampaignAnalytics(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("never reports a missing or garbled counter as zero, for each of the five counters", async () => {
      for (const key of ["unique_sent_count", "sent_count", "reply_count", "bounce_count", "unsubscribed_count"]) {
        for (const bad of [undefined, null, "", "lots", "-4", "3.9", "0x10", "1e3", "99999999999999999999", 2.5, -1, NaN]) {
          mockedAxios.request.mockResolvedValueOnce({ data: { ...live, [key]: bad } } as never);
          await expect(getCampaignAnalytics(KEY, 3083885)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
        }
      }
    });

    it("accepts plain digit strings and whole numbers, with spaces trimmed", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { ...live, sent_count: " 7 ", reply_count: 3, bounce_count: "0" } } as never);
      await expect(getCampaignAnalytics(KEY, 3083885)).resolves.toMatchObject({ emailsSent: 7, replies: 3, bounces: 0 });
    });

    it("refuses a campaign id that is not a positive whole number without calling Smartlead", async () => {
      await expect(getCampaignAnalytics(KEY, 0)).rejects.toBeInstanceOf(SmartleadApiError);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("getCampaign and getCampaignSequences (live shapes, 2026-10-28)", () => {
    it("reads one campaign's status, name, limit and unsubscribe setting", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { id: 9, name: "Q4", status: "drafted", max_leads_per_day: 100, add_unsubscribe_tag: true } } as never);
      await expect(getCampaign(KEY, 9)).resolves.toEqual({ id: 9, name: "Q4", status: "DRAFTED", maxLeadsPerDay: 100, addUnsubscribeTag: true });
      // the footer text (live shape: null when empty), which decides whether Smartlead adds the link at all
      mockedAxios.request.mockResolvedValueOnce({ data: { id: 9, name: "Q4", status: "drafted", add_unsubscribe_tag: true, unsubscribe_text: null } } as never);
      await expect(getCampaign(KEY, 9)).resolves.toMatchObject({ addUnsubscribeTag: true, unsubscribeText: null });
      mockedAxios.request.mockResolvedValueOnce({ data: { id: 9, name: "Q4", status: "drafted", add_unsubscribe_tag: true, unsubscribe_text: "Unsubscribe here" } } as never);
      await expect(getCampaign(KEY, 9)).resolves.toMatchObject({ unsubscribeText: "Unsubscribe here" });
      expect(mockedAxios.request.mock.calls[0][0].url).toMatch(/\/campaigns\/9$/);
    });

    it("treats the EMPTY 200 a missing campaign returns as no campaign, and any other non-campaign reply as an error", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: "" } as never);
      await expect(getCampaign(KEY, 9)).resolves.toBeNull();
      mockedAxios.request.mockResolvedValueOnce({ data: { error: "nope" } } as never);
      await expect(getCampaign(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      mockedAxios.request.mockResolvedValueOnce({ data: [{ id: 9 }] } as never);
      await expect(getCampaign(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("refuses a reply for a different campaign than asked for", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { id: 10, status: "ACTIVE" } } as never);
      await expect(getCampaign(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("returns the steps, an empty array for a campaign with none, and never reads a not-found object as an empty sequence", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: realSequencesWithVariants } as never);
      await expect(getCampaignSequences(KEY, 9)).resolves.toEqual(realSequencesWithVariants);
      mockedAxios.request.mockResolvedValueOnce({ data: [] } as never);
      await expect(getCampaignSequences(KEY, 9)).resolves.toEqual([]);
      mockedAxios.request.mockResolvedValueOnce({ data: { error: "Campaign not found - Invalid campaign_id." } } as never);
      await expect(getCampaignSequences(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("refuses a bad campaign id before any request", async () => {
      await expect(getCampaign(KEY, 0)).rejects.toBeInstanceOf(SmartleadApiError);
      await expect(getCampaignSequences(KEY, 1.5)).rejects.toBeInstanceOf(SmartleadApiError);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("listCampaignLeadsByEmailStatus (live shape, 2026-10-30)", () => {
    // the real reply: total_leads is a STRING, each row has the Smartlead lead inside `lead`
    const realReply = { total_leads: "11", offset: 0, limit: 2, data: [
      { campaign_lead_map_id: "2833805595", status: "COMPLETED", lead_category_id: null, lead: { id: 3475601405, email: "Ivan@Daytona.io", is_unsubscribed: false } },
      { campaign_lead_map_id: "2833805617", status: "COMPLETED", lead_category_id: null, lead: { id: "3475601377", email: "annika@relay.app" } },
    ] };

    it("sends the status filter and paging, and reads total and rows (addresses lower-cased)", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: realReply } as never);
      const out = await listCampaignLeadsByEmailStatus(KEY, 9, "is_replied", { offset: 100, limit: 500 });
      expect(out).toEqual({ total: 11, rows: [{ leadId: "3475601405", email: "ivan@daytona.io", unsubscribed: false }, { leadId: "3475601377", email: "annika@relay.app", unsubscribed: false }] });
      const call = mockedAxios.request.mock.calls[0][0];
      expect(call.url).toMatch(/\/campaigns\/9\/leads$/);
      expect(call.params).toMatchObject({ emailStatus: "is_replied", offset: 100, limit: 100 }); // the page size is capped at 100
    });

    it("with no filter it sends none, and reads the lead's own unsubscribed flag (true only when exactly true)", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { total_leads: "3", data: [
        { status: "BLOCKED", lead: { id: 1, email: "a@b.co", is_unsubscribed: true } },
        { status: "STARTED", lead: { id: 2, email: "c@d.co", is_unsubscribed: false } },
        { status: "STARTED", lead: { id: 3, email: "e@f.co", is_unsubscribed: "true" } },
      ] } } as never);
      const out = await listCampaignLeadsByEmailStatus(KEY, 9, null);
      expect(out.rows.map(r => r.unsubscribed)).toEqual([true, false, false]);
      expect(mockedAxios.request.mock.calls[0][0].params).not.toHaveProperty("emailStatus");
    });

    it("drops rows without a usable id or address, and reads an empty answer as nobody", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { total_leads: "2", data: [{ lead: { id: 1 } }, { lead: { email: "a@b.co" } }, null, {}] } } as never);
      await expect(listCampaignLeadsByEmailStatus(KEY, 9, "is_bounced")).resolves.toEqual({ total: 2, rows: [] });
      mockedAxios.request.mockResolvedValueOnce({ data: { total_leads: "0", data: [] } } as never);
      await expect(listCampaignLeadsByEmailStatus(KEY, 9, "is_unsubscribed")).resolves.toEqual({ total: 0, rows: [] });
    });

    it("never reads an error object, a bare array or a reply without a total as nobody", async () => {
      for (const data of [{ error: "nope" }, [], "", { data: [] }, { total_leads: "x", data: [] }]) {
        mockedAxios.request.mockResolvedValueOnce({ data } as never);
        await expect(listCampaignLeadsByEmailStatus(KEY, 9, "is_replied")).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      }
    });

    it("refuses a bad campaign id before any request", async () => {
      await expect(listCampaignLeadsByEmailStatus(KEY, 0, "is_replied")).rejects.toBeInstanceOf(SmartleadApiError);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribeLeadGlobally and findLeadIdByEmail (live shapes, 2026-10-28)", () => {
    it("unsubscribes through the account-wide path and reads ok / no-update", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { ok: true } } as never);
      await expect(unsubscribeLeadGlobally(KEY, "4834410135")).resolves.toBe("ok");
      expect(mockedAxios.request.mock.calls[0][0]).toMatchObject({ method: "POST" });
      expect(mockedAxios.request.mock.calls[0][0].url).toMatch(/\/leads\/4834410135\/unsubscribe$/);
      expect(mockedAxios.request.mock.calls[0][0].url).not.toMatch(/campaigns/);
      mockedAxios.request.mockResolvedValueOnce({ data: { ok: false } } as never);
      await expect(unsubscribeLeadGlobally(KEY, 7)).resolves.toBe("no_update");
    });

    it("reads a 404 as a lead that is gone, and refuses any other shape or error", async () => {
      mockedAxios.request.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 404"), { response: { status: 404, headers: {} } }));
      await expect(unsubscribeLeadGlobally(KEY, 7)).resolves.toBe("not_found");
      mockedAxios.request.mockResolvedValueOnce({ data: { fine: 1 } } as never);
      await expect(unsubscribeLeadGlobally(KEY, 7)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      mockedAxios.request.mockResolvedValueOnce({ data: "" } as never);
      await expect(unsubscribeLeadGlobally(KEY, 7)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      mockedAxios.request.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 401"), { response: { status: 401, headers: {} } }));
      await expect(unsubscribeLeadGlobally(KEY, 7)).rejects.toMatchObject({ status: 401 });
    });

    it("refuses a bad lead id before any request", async () => {
      for (const bad of ["abc", "0", "-3", "1.5", "", "../campaigns/1", "99999999999999999"]) await expect(unsubscribeLeadGlobally(KEY, bad)).rejects.toBeInstanceOf(SmartleadApiError);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("finds a lead's id by email; an empty object is 'not found'; a different lead or no id is an error", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { id: 4834487988, email: "A@Example.com" } } as never);
      await expect(findLeadIdByEmail(KEY, " a@example.com ")).resolves.toBe("4834487988");
      expect(mockedAxios.request.mock.calls[0][0].params).toMatchObject({ email: "a@example.com" });
      mockedAxios.request.mockResolvedValueOnce({ data: {} } as never);
      await expect(findLeadIdByEmail(KEY, "none@example.com")).resolves.toBeNull();
      mockedAxios.request.mockResolvedValueOnce({ data: { id: 5, email: "other@example.com" } } as never);
      await expect(findLeadIdByEmail(KEY, "a@example.com")).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      mockedAxios.request.mockResolvedValueOnce({ data: { email: "a@example.com" } } as never);
      await expect(findLeadIdByEmail(KEY, "a@example.com")).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
      await expect(findLeadIdByEmail(KEY, "")).rejects.toBeInstanceOf(SmartleadApiError);
    });
  });

  describe("updateLeadEmail (live shapes, 2026-10-28)", () => {
    it("changes a lead's address in place with ONLY the email in the body (the other fields stay)", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { ok: true } } as never);
      await expect(updateLeadEmail(KEY, 77, "4835397655", " New@Example.COM ")).resolves.toBe("ok");
      const call = mockedAxios.request.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toMatch(/\/campaigns\/77\/leads\/4835397655\/$/);
      expect(call.data).toEqual({ email: "new@example.com" });
    });

    it("reads a refusal (HTTP 500, as for an address that already belongs to another lead), a missing lead and a no-op", async () => {
      mockedAxios.request.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 500"), { response: { status: 500, headers: {} } }));
      await expect(updateLeadEmail(KEY, 77, "1", "a@b.com", { maxRetries: 0 })).resolves.toBe("rejected");
      mockedAxios.request.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 404"), { response: { status: 404, headers: {} } }));
      await expect(updateLeadEmail(KEY, 77, "1", "a@b.com")).resolves.toBe("not_found");
      mockedAxios.request.mockResolvedValueOnce({ data: { ok: false } } as never);
      await expect(updateLeadEmail(KEY, 77, "1", "a@b.com")).resolves.toBe("no_update");
    });

    it("lets an auth failure, a rate limit and an odd reply through as errors, never as success", async () => {
      mockedAxios.request.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 401"), { response: { status: 401, headers: {} } }));
      await expect(updateLeadEmail(KEY, 77, "1", "a@b.com")).rejects.toMatchObject({ status: 401 });
      mockedAxios.request.mockResolvedValueOnce({ data: "" } as never);
      await expect(updateLeadEmail(KEY, 77, "1", "a@b.com")).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("refuses bad input before any request", async () => {
      await expect(updateLeadEmail(KEY, 0, "1", "a@b.com")).rejects.toBeInstanceOf(SmartleadApiError);
      await expect(updateLeadEmail(KEY, 77, "abc", "a@b.com")).rejects.toBeInstanceOf(SmartleadApiError);
      await expect(updateLeadEmail(KEY, 77, "1", "  ")).rejects.toBeInstanceOf(SmartleadApiError);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("getCampaignEmailAccounts", () => {
    it("reads the documented {ok, data} wrapper and a bare array", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { ok: true, data: [{ id: 2001, from_email: "s@x.com", type: "SMTP" }] } } as never);
      await expect(getCampaignEmailAccounts(KEY, 9)).resolves.toEqual([{ id: 2001, email: "s@x.com", dailyLimit: undefined }]);
      expect(mockedAxios.request.mock.calls[0][0].url).toMatch(/\/campaigns\/9\/email-accounts$/);
      mockedAxios.request.mockResolvedValueOnce({ data: [{ id: 2002, from_email: "t@x.com", message_per_day: 40 }] } as never);
      await expect(getCampaignEmailAccounts(KEY, 9)).resolves.toEqual([{ id: 2002, email: "t@x.com", dailyLimit: 40 }]);
    });

    it("rejects a non-list reply", async () => {
      mockedAxios.request.mockResolvedValue({ data: { error: "Resource not found" } } as never);
      await expect(getCampaignEmailAccounts(KEY, 9)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });
  });

  describe("addLeadsToCampaign", () => {
    const leads = [{ email: "a@example.com", first_name: "A", custom_fields: { agentweb_subject: "Hi" } }, { email: "b@example.com" }, { email: "bad-email" }];

    it("posts the leads with every block-list override off and return_lead_ids on", async () => {
      mockedAxios.request.mockResolvedValue({ data: realAddLeadsFirstImport } as never);
      await addLeadsToCampaign(KEY, 77, leads);
      const call = mockedAxios.request.mock.calls[0][0] as { method: string; url: string; data: { lead_list: unknown; settings: unknown } };
      expect(call.method).toBe("POST");
      expect(call.url).toMatch(/\/campaigns\/77\/leads$/);
      expect(call.data.lead_list).toEqual(leads);
      expect(call.data.settings).toEqual({
        ignore_global_block_list: false,
        ignore_unsubscribe_list: false,
        ignore_duplicate_leads_in_other_campaign: true, // TRUE skips a lead already in another campaign (verified live 2026-10-28)
        ignore_community_bounce_list: false,
        return_lead_ids: true,
      });
    });

    it("reads the real first-import reply: added is total_leads, NOT upload_count (which counts the invalid row too)", async () => {
      mockedAxios.request.mockResolvedValue({ data: realAddLeadsFirstImport } as never);
      const r = await addLeadsToCampaign(KEY, 77, leads);
      expect(r).toMatchObject({ submitted: 3, added: 2, skipped: 1, alreadyInCampaign: 0, invalidEmails: ["bad-email"] });
      expect(r.skippedBy.invalidEmail).toBe(1);
      expect(r.leads).toEqual({
        newlyAdded: { "a@example.com": "9001", "b@example.com": "9002" },
        existingInCampaign: {},
        existingInOtherCampaigns: {},
      });
    });

    it("reads a resend: nothing added, the leads are reported as already in this campaign, with their Smartlead ids", async () => {
      mockedAxios.request.mockResolvedValue({ data: realAddLeadsResend } as never);
      const r = await addLeadsToCampaign(KEY, 77, leads);
      expect(r).toMatchObject({ submitted: 3, added: 0, skipped: 3, alreadyInCampaign: 2 });
      expect(r.leads?.existingInCampaign).toEqual({ "a@example.com": "9001", "b@example.com": "9002" });
    });

    it("lists leads that already existed in another campaign separately (they were still added here)", async () => {
      mockedAxios.request.mockResolvedValue({ data: realAddLeadsExistingInOtherCampaign } as never);
      const r = await addLeadsToCampaign(KEY, 77, leads.slice(0, 2));
      expect(r.added).toBe(2);
      expect(r.leads?.existingInOtherCampaigns).toEqual({ "a@example.com": "9001", "b@example.com": "9002" });
      expect(r.leads?.newlyAdded).toEqual({});
    });

    it("has no per-lead map when Smartlead sends none", async () => {
      mockedAxios.request.mockResolvedValue({ data: realAddLeadsNoMap } as never);
      const r = await addLeadsToCampaign(KEY, 77, [leads[0]]);
      expect(r.added).toBe(1);
      expect(r.leads).toBeUndefined();
    });

    it("lower-cases the emails in the map", async () => {
      mockedAxios.request.mockResolvedValue({ data: { ...realAddLeadsNoMap, emailToLeadIdMap: { newlyAddedLeads: { "Mixed@Example.com": 5 }, existingLeads: {}, existingLeadsInOtherCampaigns: {} } } } as never);
      const r = await addLeadsToCampaign(KEY, 77, [leads[0]]);
      expect(r.leads?.newlyAdded).toEqual({ "mixed@example.com": "5" });
    });

    it("still accepts the reference's documented count (added_count) when total_leads is absent", async () => {
      mockedAxios.request.mockResolvedValue({ data: { success: true, added_count: 2, skipped_count: 1 } } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).resolves.toMatchObject({ added: 2, submitted: 3, skipped: 1 });
    });

    it("treats a reply with no count we recognise as an error, never as success or zero added", async () => {
      mockedAxios.request.mockResolvedValue({ data: { message: "ok" } } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("does not turn null or empty counts into a real zero", async () => {
      mockedAxios.request.mockResolvedValue({ data: { total_leads: null, added_count: "" } } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("reports when Smartlead stopped importing because the account's lead limit is used up", async () => {
      mockedAxios.request.mockResolvedValue({ data: { ...realAddLeadsNoMap, total_leads: 0, is_lead_limit_exhausted: true, lead_import_stopped_count: 1 } } as never);
      const r = await addLeadsToCampaign(KEY, 77, [leads[0]]);
      expect(r).toMatchObject({ added: 0, limitExhausted: true });
      expect(r.skippedBy.importStopped).toBe(1);
    });

    it.each([0, -3, 1.5, NaN])("refuses campaign id %p before any request", async (id) => {
      await expect(addLeadsToCampaign(KEY, id, leads)).rejects.toThrow(/campaign id/);
      await expect(getCampaignEmailAccounts(KEY, id)).rejects.toThrow(/campaign id/);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("marks a write whose outcome is unknown (timeout, 5xx, unreadable 2xx) but not a rate limit or a read", async () => {
      mockedAxios.request.mockRejectedValueOnce(new Error("timeout of 15000ms exceeded"));
      await expect(addLeadsToCampaign(KEY, 77, leads)).rejects.toMatchObject({ outcomeUnknown: true });
      mockedAxios.request.mockRejectedValueOnce(Object.assign(new Error("boom"), { response: { status: 502, headers: {} } }));
      await expect(addLeadsToCampaign(KEY, 77, leads)).rejects.toMatchObject({ outcomeUnknown: true, status: 502 });
      mockedAxios.request.mockResolvedValueOnce({ data: { message: "ok" } } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).rejects.toMatchObject({ outcomeUnknown: true });
      mockedAxios.request.mockRejectedValue(err429());
      await expect(addLeadsToCampaign(KEY, 77, leads, { maxRetries: 0 })).rejects.toMatchObject({ outcomeUnknown: false, status: 429 });
      mockedAxios.request.mockReset();
      mockedAxios.request.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 500, headers: {} } }));
      await expect(listCampaigns(KEY)).rejects.toMatchObject({ outcomeUnknown: false, status: 500 });
    });

    it("refuses more than 400 leads before any request", async () => {
      const many = Array.from({ length: 401 }, (_, i) => ({ email: `l${i}@x.com` }));
      await expect(addLeadsToCampaign(KEY, 77, many)).rejects.toThrow(/at most 400/);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("sends nothing for an empty batch", async () => {
      const r = await addLeadsToCampaign(KEY, 77, []);
      expect(r).toMatchObject({ submitted: 0, added: 0, skipped: 0 });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("retries a rate-limited request, which added nothing", async () => {
      mockedAxios.request
        .mockRejectedValueOnce(err429())
        .mockResolvedValueOnce({ data: realAddLeadsNoMap } as never);
      await expect(addLeadsToCampaign(KEY, 77, [leads[0]])).resolves.toMatchObject({ added: 1 });
      expect(mockedAxios.request).toHaveBeenCalledTimes(2);
    });
  });
});
