import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";

import CostDashboardTab from "../CostDashboardTab";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "fake-token" }),
}));
jest.mock("../../../config", () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

/**
 * A Counters block from a dollar figure.
 *
 * `costMicroUsd` is derived rather than passed, so a fixture cannot express the
 * one state the real ledger never produces — the two cost fields disagreeing —
 * and a test can therefore never pass against an impossible row.
 */
const counters = (costUsd: number, calls = 1, tokens = 100) => ({
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: tokens,
  callCount: calls,
  costMicroUsd: Math.round(costUsd * 1e6),
  costUsd,
});

const AGG = {
  start: "2026-08-11",
  end: "2026-09-10",
  totals: counters(4.5, 30, 3000),
  byModel: [
    { model: "anthropic.claude-opus-5", ...counters(3, 10, 1000) },
    { model: "gemini-3.5-flash", ...counters(1.5, 20, 2000) },
  ],
  byProvider: [
    { provider: "bedrock", ...counters(3, 10, 1000) },
    { provider: "gemini", ...counters(1.5, 20, 2000) },
  ],
  series: [],
  topUsers: [],
};

describe("CostDashboardTab — spend by provider (ENG-1859)", () => {
  beforeEach(() => jest.resetAllMocks());

  it("groups spend by the upstream that served it, with each share of the total", async () => {
    mockedAxios.get.mockResolvedValue({ data: AGG });
    render(<CostDashboardTab />);

    const bedrock = await screen.findByTestId("provider-row-bedrock");
    expect(within(bedrock).getByText("bedrock")).toBeInTheDocument();
    expect(within(bedrock).getByText("$3.00")).toBeInTheDocument();
    // 3 of 4.5 — the share is against the headline total, not a sum of rows.
    expect(within(bedrock).getByText("66.7%")).toBeInTheDocument();

    const gemini = screen.getByTestId("provider-row-gemini");
    expect(within(gemini).getByText("33.3%")).toBeInTheDocument();
  });

  it("separates the same model served through two different providers", async () => {
    // The reason this cut cannot be derived from by-model: one model, two
    // upstreams, two different costs to us.
    mockedAxios.get.mockResolvedValue({
      data: {
        ...AGG,
        totals: counters(2.7, 2, 200),
        byModel: [{ model: "anthropic.claude-sonnet-4-6", ...counters(2.7, 2, 200) }],
        byProvider: [
          { provider: "bedrock", ...counters(2, 1, 100) },
          { provider: "openrouter", ...counters(0.7, 1, 100) },
        ],
      },
    });
    render(<CostDashboardTab />);

    expect(await screen.findByTestId("provider-row-bedrock")).toBeInTheDocument();
    expect(screen.getByTestId("provider-row-openrouter")).toBeInTheDocument();
    // One model row, two provider rows — the point of the cut.
    expect(screen.getAllByText("anthropic.claude-sonnet-4-6")).toHaveLength(1);
  });

  it("caveats pre-provider-tracking spend instead of naming it as an upstream", async () => {
    const UNRECORDED = "(recorded before provider tracking)";
    mockedAxios.get.mockResolvedValue({
      data: {
        ...AGG,
        totals: counters(4, 2, 200),
        byProvider: [
          { provider: "bedrock", ...counters(3, 1, 100) },
          { provider: UNRECORDED, ...counters(1, 1, 100) },
        ],
      },
    });
    render(<CostDashboardTab />);

    const row = await screen.findByTestId(`provider-row-${UNRECORDED}`);
    expect(within(row).getByText("Not recorded")).toBeInTheDocument();
    expect(row).toHaveTextContent("before the ledger tracked a provider");
    // The raw bucket key is never presented as though it were an upstream name.
    expect(within(row).queryByText(UNRECORDED)).not.toBeInTheDocument();
    // It is still real spend and still counted.
    expect(within(row).getByText("$1.00")).toBeInTheDocument();
  });

  it("renders nothing for the section against a backend that does not send the cut", async () => {
    // The two projects deploy separately; an older backend omits byProvider and
    // the section must be absent rather than rendering an empty table.
    const { byProvider, ...withoutCut } = AGG;
    void byProvider;
    mockedAxios.get.mockResolvedValue({ data: withoutCut });
    render(<CostDashboardTab />);

    await waitFor(() => expect(screen.getByText("Spend by model")).toBeInTheDocument());
    expect(screen.queryByText("Spend by provider")).not.toBeInTheDocument();
  });

  it("leaves the by-model cut untouched", async () => {
    mockedAxios.get.mockResolvedValue({ data: AGG });
    render(<CostDashboardTab />);

    await waitFor(() => expect(screen.getByText("Spend by model")).toBeInTheDocument());
    expect(screen.getByText("anthropic.claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText("gemini-3.5-flash")).toBeInTheDocument();
  });
});
