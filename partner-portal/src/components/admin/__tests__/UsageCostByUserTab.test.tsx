import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import axios from "axios";
import UsageCostByUserTab, {
  providerOfModel,
  providersInData,
  userRowForProvider,
  rankedUserRows,
  providerIsAllocatedEstimate,
  CostAggregation,
} from "../UsageCostByUserTab";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "fake-token" }),
}));
jest.mock("../../../config", () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

const AGG: CostAggregation = {
  start: "2026-07-01",
  end: "2026-07-29",
  totals: { costUsd: 1.24, callCount: 40, totalTokens: 1000 },
  byModel: [],
  topUsers: [
    {
      userId: "user-a",
      email: "a@example.com",
      costUsd: 1.0,
      callCount: 30,
      totalTokens: 900,
      byModel: [
        { model: "claude-opus-4-8", costUsd: 0.9, callCount: 20, totalTokens: 900 },
        { model: "twitter:search_tweets", costUsd: 0.1, callCount: 10, totalTokens: 0 },
      ],
    },
    {
      userId: "user-b",
      email: null,
      costUsd: 0.24,
      callCount: 10,
      totalTokens: 100,
      byModel: [
        { model: "twitter:post", costUsd: 0.2, callCount: 8, totalTokens: 0 },
        { model: "gpt-5-chat-2", costUsd: 0.04, callCount: 2, totalTokens: 100 },
      ],
    },
  ],
};

describe("UsageCostByUserTab pure helpers", () => {
  it("classifies vendor-namespaced models by provider and plain ids as llm", () => {
    expect(providerOfModel("twitter:post")).toBe("twitter");
    expect(providerOfModel("v0:generate")).toBe("v0");
    expect(providerOfModel("claude-opus-4-8")).toBe("llm");
  });

  it("lists the providers present, 'all' first", () => {
    expect(providersInData(AGG)).toEqual(["all", "llm", "twitter"]);
    expect(providersInData(null)).toEqual(["all"]);
  });

  it("recomputes a user's cost/calls under a provider filter", () => {
    const x = userRowForProvider(AGG.topUsers[0], "twitter");
    expect(x).not.toBeNull();
    expect(x!.costUsd).toBeCloseTo(0.1, 6);
    expect(x!.callCount).toBe(10);
    // A user with no spend under a provider drops out.
    expect(userRowForProvider(AGG.topUsers[0], "v0")).toBeNull();
  });

  it("ranks users by filtered cost desc; twitter filter puts user-b first", () => {
    const rows = rankedUserRows(AGG, "twitter");
    expect(rows.map((r) => r.userId)).toEqual(["user-b", "user-a"]);
    expect(rows[0].costUsd).toBeCloseTo(0.2, 6);
  });

  it("flags only twitter as an allocated estimate", () => {
    expect(providerIsAllocatedEstimate("twitter")).toBe(true);
    expect(providerIsAllocatedEstimate("llm")).toBe(false);
  });
});

describe("UsageCostByUserTab rendering", () => {
  beforeEach(() => jest.resetAllMocks());

  it("renders per-user rows from the cost-aggregation endpoint", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: AGG });
    render(<UsageCostByUserTab />);

    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());
    expect(screen.getByText("(no email on file)")).toBeInTheDocument();
    // All-provider total is the sum of both users' full spend.
    expect(screen.getByTestId("total-cost")).toHaveTextContent("$1.24");
  });

  it("filtering to X recomputes totals and shows the allocated caveat", async () => {
    mockedAxios.get.mockResolvedValue({ data: AGG });
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Provider"));
    await userEvent.click(await screen.findByRole("option", { name: "X (Twitter)" }));

    // twitter-only total = 0.1 + 0.2 = 0.30
    await waitFor(() => expect(screen.getByTestId("total-cost")).toHaveTextContent("$0.30"));
    // The allocated caveat appears both as the info banner and per-row chips.
    expect(screen.getAllByText(/allocated/i).length).toBeGreaterThan(0);
  });

  it("surfaces a load error", async () => {
    mockedAxios.get.mockRejectedValueOnce({ response: { data: { message: "nope" } } });
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
  });
});
