import axios from "axios";
import {
  __configureSmartleadClient,
  getSmartLeadMetrics,
  listEmailAccounts,
  scrubSmartleadSecrets,
  SmartleadApiError,
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

    it("returns an empty list for a real empty array", async () => {
      mockedAxios.request.mockResolvedValue({ data: [] } as never);
      await expect(listEmailAccounts(KEY)).resolves.toEqual([]);
    });

    it("rejects a response that is not a list, so a key is never called valid on a guess", async () => {
      mockedAxios.request.mockResolvedValue({ data: { message: "Plan expired!" } } as never);
      await expect(listEmailAccounts(KEY)).rejects.toBeInstanceOf(SmartleadApiError);
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
