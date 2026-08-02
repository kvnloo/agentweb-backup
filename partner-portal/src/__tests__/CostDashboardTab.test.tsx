import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import CostDashboardTab from "../components/admin/CostDashboardTab";

jest.mock("axios");
jest.mock("../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
}));
jest.mock("../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "admin-token", user: { isAdmin: true } }),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const populatedPayload = {
  start: "2026-06-29",
  end: "2026-07-28",
  totals: {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1200,
    callCount: 3,
    costMicroUsd: 3750000,
    costUsd: 3.75,
  },
  byModel: [
    {
      model: "claude-opus-4-8",
      inputTokens: 800,
      outputTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 950,
      callCount: 2,
      costMicroUsd: 3000000,
      costUsd: 3,
    },
    {
      model: "gemini-3.1-flash-lite",
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 250,
      callCount: 1,
      costMicroUsd: 750000,
      costUsd: 0.75,
    },
  ],
  series: [
    {
      date: "2026-07-27",
      model: "claude-opus-4-8",
      costMicroUsd: 3000000,
      costUsd: 3,
      totalTokens: 950,
      callCount: 2,
    },
    {
      date: "2026-07-28",
      model: "gemini-3.1-flash-lite",
      costMicroUsd: 750000,
      costUsd: 0.75,
      totalTokens: 250,
      callCount: 1,
    },
  ],
  byFeature: [],
  topUsers: [
    {
      userId: "u-1",
      email: "spender@example.com",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1200,
      callCount: 3,
      costMicroUsd: 3750000,
      costUsd: 3.75,
      byModel: [],
    },
  ],
};

describe("CostDashboardTab", () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
  });

  const expectedWindow = (days: number) => {
    const now = new Date();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  };

  it("renders the stable dashboard heading before data arrives", () => {
    mockedAxios.get.mockReturnValue(new Promise(() => undefined));
    render(<CostDashboardTab />);
    expect(screen.getByRole("heading", { name: /llm cost dashboard/i })).toBeInTheDocument();
  });

  it("loads the default 30-day window and renders totals, models, series, and top users", async () => {
    mockedAxios.get.mockResolvedValue({ data: populatedPayload });
    render(<CostDashboardTab />);
    const range = expectedWindow(30);

    await waitFor(() =>
      expect(mockedAxios.get).toHaveBeenCalledWith(
        `https://api.test/api/admin/usage/cost-aggregation?start=${range.start}&end=${range.end}`,
        { headers: { Authorization: "Bearer admin-token" } }
      )
    );
    expect((await screen.findAllByText("$3.75")).length).toBeGreaterThan(0);
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
    expect(screen.getByLabelText("Spend over time")).toBeInTheDocument();
    expect(screen.getByText("spender@example.com")).toBeInTheDocument();
  });

  it("switches to a seven-day window without mixing records from the prior range", async () => {
    mockedAxios.get.mockResolvedValue({ data: populatedPayload });
    render(<CostDashboardTab />);
    await waitFor(() => expect(mockedAxios.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    const range = expectedWindow(7);

    await waitFor(() =>
      expect(mockedAxios.get).toHaveBeenLastCalledWith(
        `https://api.test/api/admin/usage/cost-aggregation?start=${range.start}&end=${range.end}`,
        { headers: { Authorization: "Bearer admin-token" } }
      )
    );
  });

  it("applies an explicit custom window to every dashboard widget through one request", async () => {
    mockedAxios.get.mockResolvedValue({ data: populatedPayload });
    render(<CostDashboardTab />);
    await waitFor(() => expect(mockedAxios.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-07-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(mockedAxios.get).toHaveBeenLastCalledWith(
        "https://api.test/api/admin/usage/cost-aggregation?start=2026-07-01&end=2026-07-15",
        { headers: { Authorization: "Bearer admin-token" } }
      )
    );
  });

  it("renders an explicit empty state instead of undefined or NaN values", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        ...populatedPayload,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          callCount: 0,
          costMicroUsd: 0,
          costUsd: 0,
        },
        byModel: [],
        series: [],
        topUsers: [],
      },
    });
    render(<CostDashboardTab />);

    expect(await screen.findByText(/no llm usage was recorded in this window/i)).toBeInTheDocument();
    expect(screen.queryByText(/NaN|undefined/)).not.toBeInTheDocument();
  });
});
