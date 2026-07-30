import React from "react";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { LocalizationProvider } from "@mui/x-date-pickers";
import { AdapterDateFns } from "@mui/x-date-pickers/AdapterDateFns";
import axios from "axios";

// The date pickers need the localization context the app provides at its root.
const render = (ui: React.ReactElement) =>
  rtlRender(<LocalizationProvider dateAdapter={AdapterDateFns}>{ui}</LocalizationProvider>);
import UsageCostByUserTab, {
  providerOfModel,
  providersInData,
  userRowForProvider,
  rankedUserRows,
  providerIsAllocatedEstimate,
  xAccountsFromFeatures,
  xAccountRows,
  xAccountLabel,
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
  byFeature: [
    { feature: "x-account:acc-1", costUsd: 0.3, callCount: 18, totalTokens: 0 },
    { feature: "agent-chat", costUsd: 0.94, callCount: 22, totalTokens: 1000 },
  ],
  byXAccount: [{ accountId: "acc-1", handle: "alice", costUsd: 0.3, callCount: 18 }],
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

const RECON = {
  cycle: { start: "2026-07-03", end: "2026-07-20" },
  measured: { projectId: "p1", projectCap: 2_000_000, projectUsage: 4141, capResetDay: 3 },
  allocated: { costUsd: 0.3, callCount: 18, postReadUnits: 5000 },
  reconciliation: {
    allocatedPostReadUnits: 5000,
    measuredPostReadUnits: 4141,
    dedupSavingsUnits: 859,
    capUsedPct: (4141 / 2_000_000) * 100,
    measuredDerivedCostUsd: 0.28,
  },
};

// Route axios by endpoint — the tab fetches cost-aggregation AND x-reconciliation.
function routeAxios(opts?: { reconError?: any }) {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes("/x-reconciliation")) {
      return opts?.reconError ? Promise.reject(opts.reconError) : Promise.resolve({ data: RECON });
    }
    return Promise.resolve({ data: AGG });
  });
}

describe("UsageCostByUserTab pure helpers", () => {
  it("classifies vendor-namespaced models by provider and plain ids as llm", () => {
    expect(providerOfModel("twitter:post")).toBe("twitter");
    expect(providerOfModel("v0:generate")).toBe("v0");
    expect(providerOfModel("claude-opus-4-8")).toBe("llm");
  });

  it("treats a Bedrock numeric version suffix as llm, not a vendor", () => {
    // Bedrock ids carry a ":0" version tag — must NOT become its own provider.
    expect(providerOfModel("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("llm");
    expect(providerOfModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe("llm");
    // A word suffix is still a real vendor operation.
    expect(providerOfModel("you.com:search")).toBe("you.com");
  });

  it("lists the providers present, 'all' first, and always offers twitter", () => {
    expect(providersInData(AGG)).toEqual(["all", "llm", "twitter"]);
    // twitter is always offered so the X filter is discoverable before any X usage.
    expect(providersInData(null)).toEqual(["all", "twitter"]);
    const noX = { ...AGG, topUsers: [{ ...AGG.topUsers[0], byModel: [{ model: "claude-opus-4-8", costUsd: 1, callCount: 1, totalTokens: 1 }] }] };
    expect(providersInData(noX)).toEqual(["all", "llm", "twitter"]);
  });

  it("recomputes a user's cost/calls under a provider filter", () => {
    const x = userRowForProvider(AGG.topUsers[0], "twitter");
    expect(x).not.toBeNull();
    expect(x!.costUsd).toBeCloseTo(0.1, 6);
    expect(x!.callCount).toBe(10);
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

  it("extracts per-X-account rollups from the feature dimension (handle null), skipping non-X features", () => {
    const accts = xAccountsFromFeatures(AGG.byFeature);
    expect(accts).toEqual([{ accountId: "acc-1", handle: null, costUsd: 0.3, callCount: 18 }]);
    expect(xAccountsFromFeatures(undefined)).toEqual([]);
  });

  it("prefers the server-enriched byXAccount cut (with @handle) over the feature fallback", () => {
    expect(xAccountRows(AGG)).toEqual([{ accountId: "acc-1", handle: "alice", costUsd: 0.3, callCount: 18 }]);
    // Falls back to feature derivation (handle null) when byXAccount is absent.
    const noEnrich = { ...AGG, byXAccount: undefined };
    expect(xAccountRows(noEnrich)[0]).toMatchObject({ accountId: "acc-1", handle: null });
    expect(xAccountRows(null)).toEqual([]);
  });

  it("labels an account by @handle when known, else the raw id", () => {
    expect(xAccountLabel({ accountId: "acc-1", handle: "alice", costUsd: 0, callCount: 0 })).toBe("@alice");
    expect(xAccountLabel({ accountId: "acc-1", handle: null, costUsd: 0, callCount: 0 })).toBe("acc-1");
  });
});

describe("UsageCostByUserTab rendering", () => {
  beforeEach(() => jest.resetAllMocks());

  it("renders per-user rows, the by-account table, and the reconciliation panel", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);

    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());
    expect(screen.getByText("(no email on file)")).toBeInTheDocument();
    // X-only tab: total is the twitter spend across users ($0.10 + $0.20), not the
    // all-providers sum — LLM spend is excluded by the fixed twitter filter.
    expect(screen.getByTestId("total-cost")).toHaveTextContent("$0.30");

    // by-account cut — shows the enriched @handle (with the raw id alongside)
    const acctTable = await screen.findByTestId("x-account-table");
    expect(acctTable).toHaveTextContent("@alice");
    expect(acctTable).toHaveTextContent("acc-1");

    // reconciliation panel (measured vs allocated)
    const panel = await screen.findByTestId("x-recon-panel");
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId("x-recon-cap")).toHaveTextContent("4,141");
    expect(screen.getByTestId("x-recon-dedup")).toHaveTextContent("859");
  });

  it("is X-only by default: allocated caveat shown, no provider selector", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    // Twitter is fixed (ENG-664, X-only for now) — total reflects X spend only and
    // the allocated caveat renders without any filtering.
    expect(screen.getByTestId("total-cost")).toHaveTextContent("$0.30");
    expect(screen.getAllByText(/allocated/i).length).toBeGreaterThan(0);
    // The provider selector is removed while the tab is X-only.
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
  });

  it("degrades gracefully when X reconciliation is unavailable (502)", async () => {
    routeAxios({ reconError: { response: { data: { message: "X app bearer token is not configured" } } } });
    render(<UsageCostByUserTab />);

    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());
    const err = await screen.findByTestId("x-recon-error");
    expect(err).toHaveTextContent(/bearer token/i);
    // The rest of the tab still renders.
    expect(screen.getByTestId("total-cost")).toBeInTheDocument();
  });

  it("a quick-range preset reloads the aggregation with a new range", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    const aggCalls = () =>
      mockedAxios.get.mock.calls.filter(([u]) => (u as string).includes("/cost-aggregation")).length;
    const before = aggCalls();

    await userEvent.click(screen.getByRole("button", { name: "30d" }));

    await waitFor(() => expect(aggCalls()).toBe(before + 1));
    const lastAgg = mockedAxios.get.mock.calls.filter(([u]) => (u as string).includes("/cost-aggregation")).pop();
    expect(lastAgg?.[0]).toMatch(/start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}/);
  });

  it("surfaces a load error for the main aggregation", async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes("/x-reconciliation")) return Promise.resolve({ data: RECON });
      return Promise.reject({ response: { data: { message: "nope" } } });
    });
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("nope")).toBeInTheDocument());
  });
});
