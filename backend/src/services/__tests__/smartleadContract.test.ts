import axios from "axios";
import { __configureSmartleadClient, getCampaignEmailAccounts, listCampaigns, listEmailAccounts } from "../smartleadService";
import { realCampaignMailboxes, realCampaignsList, realEmailAccounts } from "./fixtures/smartleadRealReplies";

// Contract tests: the readers must cope with replies shaped like a LIVE Smartlead account's (fixtures recorded 2026-10-27),
// not only with what its docs say. If Smartlead changes a shape, re-record the fixtures and these show what broke.
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;
const KEY = "sk_live_supersecret123";

describe("Smartlead readers against live-shaped replies (ENG-673)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    __configureSmartleadClient({ options: { requestsPerMinute: 0 }, sleep: async () => {}, random: () => 0.5, now: () => 0 });
  });

  it("listEmailAccounts reads message_per_day, drops the SMTP and IMAP passwords, and does not need a second page", async () => {
    mockedAxios.request.mockResolvedValueOnce({ data: realEmailAccounts } as never).mockResolvedValueOnce({ data: [] } as never);
    const accounts = await listEmailAccounts(KEY);
    expect(accounts).toEqual([
      { id: 1001, email: "box1@example-outreach.test", dailyLimit: 15 },
      { id: 1002, email: "box2@example-outreach.test", dailyLimit: 30 },
    ]);
    expect(JSON.stringify(accounts)).not.toMatch(/REDACTED|password/i);
  });

  it("listCampaigns reads a bare array and keeps DRAFTED as DRAFTED", async () => {
    mockedAxios.request.mockResolvedValue({ data: realCampaignsList } as never);
    const campaigns = await listCampaigns(KEY);
    expect(campaigns.map(c => [c.id, c.status])).toEqual([[2001, "ACTIVE"], [2002, "DRAFTED"], [2003, "ARCHIVED"]]);
    expect(campaigns[0].maxLeadsPerDay).toBe(200);
  });

  it("getCampaignEmailAccounts reads a bare array that carries the per-day limit, and drops the password", async () => {
    mockedAxios.request.mockResolvedValue({ data: realCampaignMailboxes } as never);
    const mailboxes = await getCampaignEmailAccounts(KEY, 2001);
    expect(mailboxes).toEqual([{ id: 1001, email: "box1@example-outreach.test", dailyLimit: 15 }]);
    expect(JSON.stringify(mailboxes)).not.toMatch(/REDACTED|password/i);
  });
});
