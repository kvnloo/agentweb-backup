import axios from "axios";
import {
  __configureSmartleadClient,
  addLeadsToCampaign,
  getCampaignEmailAccounts,
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

    it("rejects a reply that is not a list rather than showing no campaigns", async () => {
      mockedAxios.request.mockResolvedValue({ data: { message: "Plan expired!" } } as never);
      await expect(listCampaigns(KEY)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
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
    const leads = [{ email: "a@x.com", first_name: "A", custom_fields: { agentweb_subject: "Hi" } }, { email: "b@x.com" }];

    it("posts the leads with every block-list override off", async () => {
      mockedAxios.request.mockResolvedValue({ data: { success: true, added_count: 2, skipped_count: 0 } } as never);
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
      });
    });

    it("reads the reference reply (added_count / skipped_count / skipped_leads)", async () => {
      mockedAxios.request.mockResolvedValue({
        data: { added_count: 1, skipped_count: 1, skipped_leads: [{ email: "b@x.com", reason: "On global block list" }] },
      } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).resolves.toEqual({
        added: 1,
        skipped: 1,
        skippedLeads: [{ email: "b@x.com", reason: "On global block list" }],
      });
    });

    it("reads the older reply (upload_count plus duplicate / invalid / unsubscribed tallies)", async () => {
      mockedAxios.request.mockResolvedValue({
        data: { ok: true, upload_count: 5, duplicate_count: 2, invalid_email_count: 1, unsubscribed_leads: ["u@x.com"], block_count: 0 },
      } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).resolves.toMatchObject({ added: 5, skipped: 4 });
    });

    it("treats a reply with no count we recognise as an error, never as success or zero added", async () => {
      mockedAxios.request.mockResolvedValue({ data: { message: "ok" } } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).rejects.toBeInstanceOf(SmartleadUnexpectedResponseError);
    });

    it("refuses more than 400 leads before any request", async () => {
      const many = Array.from({ length: 401 }, (_, i) => ({ email: `l${i}@x.com` }));
      await expect(addLeadsToCampaign(KEY, 77, many)).rejects.toThrow(/at most 400/);
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("sends nothing for an empty batch", async () => {
      await expect(addLeadsToCampaign(KEY, 77, [])).resolves.toEqual({ added: 0, skipped: 0, skippedLeads: [] });
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it("retries a rate-limited request, which added nothing, and keeps the key out of errors", async () => {
      mockedAxios.request
        .mockRejectedValueOnce(err429())
        .mockResolvedValueOnce({ data: { added_count: 2, skipped_count: 0 } } as never);
      await expect(addLeadsToCampaign(KEY, 77, leads)).resolves.toMatchObject({ added: 2 });
      expect(mockedAxios.request).toHaveBeenCalledTimes(2);
    });
  });
});
