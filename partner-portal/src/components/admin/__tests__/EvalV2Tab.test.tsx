import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import axios from "axios";

import EvalV2Tab from "../EvalV2Tab";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

let mockToken: string | null = "fake-token";
jest.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: mockToken }),
}));
jest.mock("../../../config", () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

const metric = (graderId: string, passes: number, n: number, ci: { low: number; high: number } | null, mayGate = false) => ({
  graderId,
  versions: [1],
  n,
  passes,
  rate: n ? passes / n : null,
  ci,
  notApplicable: 0,
  mayGate,
});

const GRADERS = [
  { id: "agent-task-success", version: 1, measures: "task", mayGate: false },
  { id: "agent-tool-correctness", version: 1, measures: "tools", mayGate: false },
  { id: "agent-groundedness-offline", version: 1, measures: "claims", mayGate: false },
];

const snapshot = (date: string, sessions: number) => ({
  date,
  windowLabel: "7d",
  windowStartDate: "2026-09-18",
  windowEndDate: date,
  sessions,
  coverage: [{ date, frameSize: 56, sampleSize: 50, scored: 50 }],
  groups: [
    {
      surface: "all",
      taskType: "all",
      model: "all",
      sessions,
      metrics: [
        metric("agent-task-success", 2, 3, { low: 0.2077, high: 0.9385 }),
        metric("agent-tool-correctness", 41, 50, { low: 0.6921, high: 0.9024 }),
        metric("agent-groundedness-offline", 0, 0, null),
      ],
    },
    {
      surface: "agent/scheduled",
      taskType: "ads",
      model: "gemini-3.8-flash",
      sessions: 7,
      metrics: [
        metric("agent-task-success", 1, 1, { low: 0.2065, high: 1 }),
        metric("agent-tool-correctness", 6, 7, { low: 0.4869, high: 0.9743 }),
        metric("agent-groundedness-offline", 0, 0, null),
      ],
    },
  ],
});

const RESPONSE = {
  windowLabel: "7d",
  samplerEnabled: false,
  count: 2,
  hasData: true,
  graders: GRADERS,
  snapshots: [snapshot("2026-09-23", 47), snapshot("2026-09-24", 50)],
};

describe("EvalV2Tab (ENG-2144)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockToken = "fake-token";
  });

  it("fetches the trend with the useAuth token", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    await screen.findByTestId("eval-v2-row-0");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "http://localhost:3000/api/admin/loops/eval-v2-trend?days=30&window=7d",
      { headers: { Authorization: "Bearer fake-token" } },
    );
  });

  it("shows every rate with its 95% CI and n, per surface × task type × model", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);

    const cell = await screen.findByTestId("eval-v2-row-1");
    expect(within(cell).getByText("agent/scheduled")).toBeInTheDocument();
    expect(within(cell).getByText("ads")).toBeInTheDocument();
    expect(within(cell).getByText("gemini-3.8-flash")).toBeInTheDocument();
    expect(within(cell).getByText("86%")).toBeInTheDocument();
    expect(within(cell).getByText("[49%–97%] n=7")).toBeInTheDocument();
    // No labelled session: no rate, and n=0 said outright rather than a 0%.
    expect(within(cell).getByText("– (n=0)")).toBeInTheDocument();

    const all = screen.getByTestId("eval-v2-row-0");
    expect(within(all).getByText("67%")).toBeInTheDocument();
    expect(within(all).getByText("[21%–94%] n=3")).toBeInTheDocument();
  });

  it("labels every grader unvalidated when mayGate is false", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);

    expect(await screen.findByTestId("eval-v2-unvalidated-banner")).toHaveTextContent("All graders are unvalidated");
    for (const g of GRADERS) {
      expect(within(screen.getByTestId(`eval-v2-grader-${g.id}`)).getByText("unvalidated")).toBeInTheDocument();
    }
    // Legend (3) + one per grader column header (3).
    expect(screen.getAllByText("unvalidated")).toHaveLength(6);
    expect(screen.queryByText("validated")).not.toBeInTheDocument();
  });

  it("labels a validated grader as such and drops the all-unvalidated banner", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { ...RESPONSE, graders: GRADERS.map((g) => (g.id === "agent-tool-correctness" ? { ...g, mayGate: true } : g)) },
    });
    render(<EvalV2Tab />);
    expect(await screen.findByTestId("eval-v2-unvalidated-banner")).toHaveTextContent("2 graders are unvalidated");
    expect(within(screen.getByTestId("eval-v2-grader-agent-tool-correctness")).getByText("validated")).toBeInTheDocument();
  });

  it("shows the trend newest first, with n and CI on each day", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    const newest = await screen.findByTestId("eval-v2-trend-2026-09-24");
    expect(within(newest).getByText("50")).toBeInTheDocument();
    expect(within(newest).getByText("[69%–90%] n=50")).toBeInTheDocument();
    const rows = screen.getAllByTestId(/^eval-v2-trend-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["eval-v2-trend-2026-09-24", "eval-v2-trend-2026-09-23"]);
  });

  it("says when the sampler is off and when there is no data yet", async () => {
    mockedAxios.get.mockResolvedValue({ data: { ...RESPONSE, hasData: false, count: 0, snapshots: [] } });
    render(<EvalV2Tab />);
    expect(await screen.findByText("No eval-v2 snapshots yet.")).toBeInTheDocument();
    expect(screen.getByText(/The sampler is off/)).toBeInTheDocument();
  });

  it("switches to the 1-day window", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    await screen.findByTestId("eval-v2-row-0");
    await userEvent.click(screen.getByRole("button", { name: "1 day" }));
    await waitFor(() =>
      expect(mockedAxios.get).toHaveBeenLastCalledWith(
        "http://localhost:3000/api/admin/loops/eval-v2-trend?days=30&window=1d",
        expect.anything(),
      ),
    );
  });

  it("does not call the API without a token", async () => {
    mockToken = null;
    render(<EvalV2Tab />);
    expect(await screen.findByText("Admin authentication is required.")).toBeInTheDocument();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
