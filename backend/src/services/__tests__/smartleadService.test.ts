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
  getCampaign,
  getCampaignEmailAccounts,
  getCampaignSequences,
  listCampaigns,
  getSmartLeadMetrics,
  listEmailAccounts,
  scrubSmartleadSecrets,
  SmartleadApiError,
  SmartleadUnexpectedResponseError,
  smartleadRequest,
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

  describe("getCampaign and getCampaignSequences (live shapes, 2026-10-28)", () => {
    it("reads one campaign's status, name, limit and unsubscribe setting", async () => {
      mockedAxios.request.mockResolvedValueOnce({ data: { id: 9, name: "Q4", status: "drafted", max_leads_per_day: 100, add_unsubscribe_tag: true } } as never);
      await expect(getCampaign(KEY, 9)).resolves.toEqual({ id: 9, name: "Q4", status: "DRAFTED", maxLeadsPerDay: 100, addUnsubscribeTag: true });
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
        ignore_duplicate_leads_in_other_campaign: false,
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
