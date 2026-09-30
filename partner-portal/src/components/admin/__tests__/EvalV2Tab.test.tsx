import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import axios from "axios";

import EvalV2Tab from "../EvalV2Tab";
import { hasMoreToScrollRight } from "../evalV2ScrollUtils";

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

const efficiency = (over: Record<string, number | null> = {}) => ({
  graded: 3,
  successes: 2,
  withSpend: 3,
  successesWithSpend: 2,
  spendNone: 0,
  spendUnknown: 0,
  costPerSuccessUsd: 1.234,
  medianSuccessCostUsd: 1,
  successesWithLatency: 2,
  latencyPerSuccessP50Ms: 45_000,
  latencyPerSuccessP95Ms: 150_000,
  ...over,
});

const rateWithCI = (passes: number, n: number, ci: { low: number; high: number } | null) => ({ n, passes, rate: n ? passes / n : null, ci });

const CREATIVE = {
  date: "2026-09-24",
  windowStartDate: "2026-09-18",
  windowEndDate: "2026-09-24",
  status: "ok",
  creatives: 4,
  gates: { ...rateWithCI(2, 4, { low: 0.15, high: 0.85 }), versions: ["2026-09-25.1"], failedChecks: { aspect_ratio: 2 }, mayGate: false },
  rubric: {
    versions: ["2026-09-25.1"],
    judged: 2,
    errors: 1,
    skipped: 0,
    passedCountDistribution: [0, 0, 0, 0, 0, 1, 0, 1],
    floorMet: rateWithCI(1, 2, { low: 0.09, high: 0.91 }),
    mayGate: false,
  },
};

const ACCOUNT_HEALTH = {
  date: "2026-09-24",
  windowStartDate: "2026-09-18",
  windowEndDate: "2026-09-24",
  status: "ok",
  accounts: 4,
  byState: { activation_incomplete: 1, at_risk: 1, healthy: 2, insufficient_evidence: 0, other: 0 },
  flips: rateWithCI(1, 4, { low: 0.05, high: 0.7 }),
  mayGate: false,
};

const REGISTRY = [
  { id: "session-judge-general", surface: "agent", graderType: "llm_judge", measures: "satisfaction", version: "prompt-sha256:4507a38770f1", modelFamily: "gemini", mayGate: false },
  { id: "creative-deterministic-gates", surface: "creative", graderType: "code", measures: "gates", version: "2026-09-25.1", modelFamily: "none", mayGate: false },
];

const SURFACES_RESPONSE = {
  ...RESPONSE,
  snapshots: RESPONSE.snapshots.map((snap) => ({
    ...snap,
    spendAttribution: { sessions: snap.sessions, attributed: 40, none: 8, truncated: 1, notRead: 1 },
    groups: snap.groups.map((g, i) => ({ ...g, efficiency: i === 0 ? efficiency() : efficiency({ costPerSuccessUsd: null, successesWithSpend: 0 }) })),
  })),
  creative: [CREATIVE],
  accountHealth: [ACCOUNT_HEALTH],
  registry: REGISTRY,
};

describe("EvalV2Tab — efficiency, creative, account health and registry (ENG-2196)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockToken = "fake-token";
  });

  it("shows cost and run time per success per row, and how much spend was tied to a session", async () => {
    mockedAxios.get.mockResolvedValue({ data: SURFACES_RESPONSE });
    render(<EvalV2Tab />);
    const all = await screen.findByTestId("eval-v2-row-0");
    expect(within(all).getByText("$1.23")).toBeInTheDocument();
    expect(within(all).getByText("n=2 of 2")).toBeInTheDocument();
    expect(within(all).getByText("45.0 s")).toBeInTheDocument();
    expect(within(all).getByText("p95 2.5 min n=2")).toBeInTheDocument();
    // No success with spend: no cost, said outright rather than $0.
    expect(within(screen.getByTestId("eval-v2-row-1")).getByText("– (no spend)")).toBeInTheDocument();
    expect(screen.getByTestId("eval-v2-spend-attribution")).toHaveTextContent("Spend tied to the session for 40 of 50 sampled sessions (8 with no spend row carrying their id, 2 not read)");
  });

  it("shows the creative gate pass rate with CI, failing checks and the rubric distribution", async () => {
    mockedAxios.get.mockResolvedValue({ data: SURFACES_RESPONSE });
    render(<EvalV2Tab />);
    const gates = await screen.findByTestId("eval-v2-creative-gates");
    expect(within(gates).getByText("50%")).toBeInTheDocument();
    expect(within(gates).getByText("[15%–85%] n=4")).toBeInTheDocument();
    expect(within(gates).getByText("failing: aspect_ratio 2")).toBeInTheDocument();
    const rubric = screen.getByTestId("eval-v2-creative-rubric");
    expect(within(rubric).getByText("0:0 1:0 2:0 3:0 4:0 5:1 6:0 7:1")).toBeInTheDocument();
    expect(rubric).toHaveTextContent("1 errors, 0 skipped");
  });

  it("shows the account-health state distribution and flip rate", async () => {
    mockedAxios.get.mockResolvedValue({ data: SURFACES_RESPONSE });
    render(<EvalV2Tab />);
    const section = await screen.findByTestId("eval-v2-account-health");
    expect(section).toHaveTextContent("4 classified accounts");
    expect(section).toHaveTextContent("activation_incomplete 1, at_risk 1, healthy 2");
    expect(within(section).getByText("25%")).toBeInTheDocument();
  });

  it("shows no numbers for a surface whose read was truncated", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { ...SURFACES_RESPONSE, creative: [{ ...CREATIVE, status: "truncated", statusReason: "too many items", creatives: 0 }] },
    });
    render(<EvalV2Tab />);
    const section = await screen.findByTestId("eval-v2-creative");
    expect(section).toHaveTextContent("Read stopped at its bound; no numbers are shown: too many items");
    expect(screen.queryByTestId("eval-v2-creative-gates")).not.toBeInTheDocument();
  });

  it("lists every registry grader with its version and validation state", async () => {
    mockedAxios.get.mockResolvedValue({ data: SURFACES_RESPONSE });
    render(<EvalV2Tab />);
    const row = await screen.findByTestId("eval-v2-registry-session-judge-general");
    expect(within(row).getByText("prompt-sha256:4507a38770f1")).toBeInTheDocument();
    expect(within(row).getByText("no")).toBeInTheDocument();
    expect(within(screen.getByTestId("eval-v2-registry-creative-deterministic-gates")).getByText("2026-09-25.1")).toBeInTheDocument();
  });

  it("says the legacy satisfaction score is unvalidated", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    expect(await screen.findByTestId("eval-v2-satisfaction-note")).toHaveTextContent("Satisfaction score is an unvalidated LLM-judge score");
  });

  it("still renders against a backend without the ENG-2196 fields", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    expect(await screen.findByText("No creative snapshots yet.")).toBeInTheDocument();
    expect(screen.getByText("No account-health snapshots yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("eval-v2-registry")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("eval-v2-row-0")).getByText("– (no spend)")).toBeInTheDocument();
  });
});

describe("EvalV2Tab — dashboard UX (ENG-2221)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockToken = "fake-token";
  });

  it("badges a rate below the low-n threshold, without dimming its text", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    const all = await screen.findByTestId("eval-v2-row-0");

    // agent-task-success: n=3, below the threshold.
    const lowNRate = within(all).getByText("67%");
    expect(within(lowNRate.closest("td") as HTMLElement).getByText("low n")).toBeInTheDocument();
    // Full-contrast text: the rate itself carries no secondary/muted color class.
    expect(lowNRate).not.toHaveClass("MuiTypography-colorTextSecondary");

    // agent-tool-correctness: n=50, at/above the threshold.
    const highNRate = within(all).getByText("82%");
    expect(within(highNRate.closest("td") as HTMLElement).queryByText("low n")).not.toBeInTheDocument();
  });

  it("shows the low-n badge on both sides of the threshold correctly (n=9 vs n=10)", async () => {
    const boundaryGroup = {
      surface: "boundary",
      taskType: "test",
      model: "test-model",
      sessions: 20,
      metrics: [
        metric("agent-task-success", 9, 9, { low: 0.7, high: 1 }),
        metric("agent-tool-correctness", 10, 10, { low: 0.75, high: 1 }),
      ],
    };
    mockedAxios.get.mockResolvedValue({
      data: {
        ...RESPONSE,
        graders: GRADERS.slice(0, 2),
        snapshots: [{ ...RESPONSE.snapshots[1], groups: [boundaryGroup] }],
      },
    });
    render(<EvalV2Tab />);
    const row = await screen.findByTestId("eval-v2-row-0");

    const rates = within(row).getAllByText("100%");
    expect(rates).toHaveLength(2);

    // n=9 (below LOW_SAMPLE_THRESHOLD=10): badge present.
    const belowThresholdCell = rates[0].closest("td") as HTMLElement;
    expect(within(belowThresholdCell).getByText("low n")).toBeInTheDocument();

    // n=10 (at LOW_SAMPLE_THRESHOLD=10, not below it): no badge.
    const atThresholdCell = rates[1].closest("td") as HTMLElement;
    expect(within(atThresholdCell).queryByText("low n")).not.toBeInTheDocument();
  });

  it("renders a sticky in-page nav with a jump link to every section", async () => {
    mockedAxios.get.mockResolvedValue({ data: SURFACES_RESPONSE });
    render(<EvalV2Tab />);
    const nav = await screen.findByTestId("eval-v2-section-nav");
    const labels = ["Main table", "Trend", "Creative", "Account health", "Grader registry"];
    for (const label of labels) {
      const link = within(nav).getByText(label);
      expect(link.closest("a")).toHaveAttribute(
        "href",
        `#eval-v2-section-${label === "Grader registry" ? "registry" : label.toLowerCase().replace(/ /g, "-")}`,
      );
    }
  });

  it("makes the first (surface) column of the breakdown table sticky", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    const row = await screen.findByTestId("eval-v2-row-0");
    const firstCell = row.querySelector("td") as HTMLElement;
    expect(firstCell).toHaveStyle({ position: "sticky", left: "0px" });
  });

  it("hasMoreToScrollRight: true only while there is unscrolled content past the right edge", () => {
    // Table wider than its viewport, scrolled to the start: more to scroll.
    expect(hasMoreToScrollRight({ scrollWidth: 1919, clientWidth: 1071, scrollLeft: 0 })).toBe(true);
    // Scrolled all the way to the end: nothing left to reveal.
    expect(hasMoreToScrollRight({ scrollWidth: 1919, clientWidth: 1071, scrollLeft: 848 })).toBe(false);
    // Table fits its viewport: never show a shadow, regardless of scrollLeft.
    expect(hasMoreToScrollRight({ scrollWidth: 1071, clientWidth: 1071, scrollLeft: 0 })).toBe(false);
    // Sub-pixel rounding at the end (epsilon) should not register as "more to scroll".
    expect(hasMoreToScrollRight({ scrollWidth: 1919.4, clientWidth: 1071, scrollLeft: 848 })).toBe(false);
  });

  it("shows the scroll-shadow only when the breakdown table actually overflows", async () => {
    mockedAxios.get.mockResolvedValue({ data: RESPONSE });
    render(<EvalV2Tab />);
    const container = await screen.findByTestId("eval-v2-breakdown-table");

    // jsdom reports 0/0 for scroll geometry by default: the table "fits", so no shadow.
    expect(screen.queryByTestId("eval-v2-breakdown-table-shadow")).not.toBeInTheDocument();

    // Simulate the confirmed overflow (scrollWidth 1919 vs clientWidth 1071) at the start of the scroll range.
    Object.defineProperty(container, "scrollWidth", { value: 1919, configurable: true });
    Object.defineProperty(container, "clientWidth", { value: 1071, configurable: true });
    Object.defineProperty(container, "scrollLeft", { value: 0, configurable: true });
    fireEvent.scroll(container);
    expect(screen.getByTestId("eval-v2-breakdown-table-shadow")).toBeInTheDocument();

    // Scroll all the way to the end: the shadow should disappear.
    Object.defineProperty(container, "scrollLeft", { value: 848, configurable: true });
    fireEvent.scroll(container);
    expect(screen.queryByTestId("eval-v2-breakdown-table-shadow")).not.toBeInTheDocument();
  });
});
