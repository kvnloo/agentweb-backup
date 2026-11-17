import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import ZomaScoreboardTab from "../ZomaScoreboardTab";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "fake-token" }),
}));

jest.mock("../../../config", () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

const board = {
  generatedAt: "2026-11-12T12:00:00.000Z",
  activeWindowDays: 7,
  definitions: { active: "active def", firstSuccessfulAd: "first ad def", excluded: "excluded def" },
  summary: { zomaUsers: 2, activeUsers7d: 1, firstAdUsers: 1, excludedAccounts: 2, palUsers: 1 },
  rows: [
    {
      userId: "u1", email: "ann@acme.co", zomaStage: "ad_live", active7d: true,
      writes7d: { create: 2, edit: 1, pause: 0, approve: 1, total: 4 },
      lastSuccessfulWriteAt: "2026-11-11T10:00:00.000Z",
      firstAdLive: { at: "2026-11-11T12:00:00.000Z", approvedAt: "2026-11-11T10:00:00.000Z", campaignId: "120250", platform: "meta", effectiveStatus: "ACTIVE", impressions: 42 },
      goLiveApprovalsAwaitingProof: 0,
    },
    {
      userId: "u2", email: "bo@acme.co", zomaStage: "first_write", active7d: false,
      writes7d: { create: 0, edit: 0, pause: 0, approve: 0, total: 0 }, goLiveApprovalsAwaitingProof: 1,
    },
    {
      userId: "t1", email: "harsha@agentweb.pro", excluded: "internal", active7d: false,
      writes7d: { create: 5, edit: 0, pause: 0, approve: 0, total: 5 }, goLiveApprovalsAwaitingProof: 0,
    },
    {
      userId: "p1", email: "pal@gmail.com", excluded: "pal", active7d: false,
      writes7d: { create: 0, edit: 0, pause: 0, approve: 0, total: 0 }, goLiveApprovalsAwaitingProof: 0,
    },
  ],
};

describe("ZomaScoreboardTab", () => {
  beforeEach(() => jest.resetAllMocks());

  it("renders the summary counts and per-user rows with the team account flagged", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: board });
    render(<ZomaScoreboardTab />);
    expect(await screen.findByText("ann@acme.co")).toBeInTheDocument();
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "http://localhost:3000/api/admin/zoma/scoreboard",
      { headers: { Authorization: "Bearer fake-token" } },
    );
    expect(screen.getByText("Zoma users").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("Active (7d)", { selector: "p" }).nextSibling).toHaveTextContent("1");
    expect(screen.getByText("campaign 120250 · 42 impressions")).toBeInTheDocument();
    expect(screen.getByText("1 approval(s) awaiting proof")).toBeInTheDocument();
    expect(screen.getByText("team")).toBeInTheDocument();
    // ENG-3134: a "just a friend" user is labelled pal, not test, and not counted.
    expect(screen.getByText("pal")).toBeInTheDocument();
    expect(screen.getByText("2 team/test/pal excluded (1 pal)")).toBeInTheDocument();
  });

  it("runs the provider first-ad check and reloads", async () => {
    mockedAxios.get.mockResolvedValue({ data: board });
    mockedAxios.post.mockResolvedValueOnce({ data: { results: [{ userId: "u2", outcome: "no_impressions" }] } });
    render(<ZomaScoreboardTab />);
    await screen.findByText("ann@acme.co");
    fireEvent.click(screen.getByText("Check first ads"));
    expect(await screen.findByText("no_impressions: 1")).toBeInTheDocument();
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "http://localhost:3000/api/admin/zoma/scoreboard/verify-first-ads", {},
      { headers: { Authorization: "Bearer fake-token" } },
    );
    await waitFor(() => expect(mockedAxios.get).toHaveBeenCalledTimes(2));
  });

  it("shows the server error", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { data: { message: "Scoreboard unavailable" } } });
    render(<ZomaScoreboardTab />);
    expect(await screen.findByText("Scoreboard unavailable")).toBeInTheDocument();
  });
});
