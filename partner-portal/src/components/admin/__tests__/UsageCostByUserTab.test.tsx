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
  providerHasDedupCaveat,
  providerTotalIsUndercount,
  providerLabel,
  breakdownColumnLabel,
  unattributedUserLabel,
  DEFAULT_PROVIDER,
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
  // What the server sends (ENG-1837): scopes first, then vendors alphabetically.
  // Includes v0 with no rows in this window — a metered vendor stays selectable
  // before it has any spend.
  availableProviders: ["all", "llm", "apollo", "twitter", "v0"],
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

// What the server returns for provider=twitter: already X-scoped, so totals
// reflect ONLY X spend across ALL users ($0.10 + $0.20), and userCount is the
// true distinct-user count (not the capped topUsers slice).
const AGG_XSCOPED: CostAggregation = {
  ...AGG,
  totals: { costUsd: 0.3, callCount: 18, totalTokens: 0 },
  userCount: 2,
  // topUsers must be X-only too. Spreading AGG's mixed byModel here made the
  // fixture unfaithful: the server filters BEFORE aggregating, so a scoped
  // response cannot contain another provider's rows. It also silently defeated
  // the picker-collapse regression test, which needs a payload that genuinely
  // lacks the LLM rows to notice they were dropped from the options.
  topUsers: AGG.topUsers.map((u) => ({
    ...u,
    byModel: u.byModel.filter((m) => m.model.startsWith("twitter:")),
  })),
};

/**
 * Route axios by endpoint AND by the requested provider, because the server
 * scopes every cut before aggregating (ENG-1837). Returning one fixture for
 * every provider would let a test pass while the tab sent the wrong scope.
 */
function routeAxios(opts?: {
  reconError?: any;
  agg?: CostAggregation;
  xAgg?: CostAggregation;
  recon?: any;
}) {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes("/x-reconciliation")) {
      return opts?.reconError
        ? Promise.reject(opts.reconError)
        : Promise.resolve({ data: opts?.recon ?? RECON });
    }
    if (url.includes("provider=twitter")) {
      return Promise.resolve({ data: opts?.xAgg ?? AGG_XSCOPED });
    }
    return Promise.resolve({ data: opts?.agg ?? AGG });
  });
}

/** Open the MUI provider select and pick an option by its visible label. */
async function selectProvider(label: string) {
  await userEvent.click(screen.getByLabelText("Provider"));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

const aggUrls = () =>
  mockedAxios.get.mock.calls
    .map(([u]) => u as string)
    .filter((u) => u.includes("/cost-aggregation"));

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

  it("prefers the server's availableProviders, which is not limited to what the rows show", () => {
    // "v0" has no row in AGG. It must still be offered, because the server
    // computed the list over the UNFILTERED window (ENG-1837 AC2/AC3).
    expect(providersInData(AGG)).toEqual(["all", "llm", "apollo", "twitter", "v0"]);
  });

  it("falls back to deriving options from the rows when the server omits the list", () => {
    // Keeps an old backend working during the deploy window: the two projects
    // ship separately, so the portal must not require the new field.
    const legacy = { ...AGG, availableProviders: undefined };
    expect(providersInData(legacy)).toEqual(["all", "llm", "twitter"]);
    // "all" and "llm" are scopes, not vendors — always offered, even with no data.
    expect(providersInData(null)).toEqual(["all", "llm", "twitter"]);
    const noX = {
      ...legacy,
      topUsers: [{ ...AGG.topUsers[0], byModel: [{ model: "claude-opus-4-8", costUsd: 1, callCount: 1, totalTokens: 1 }] }],
    };
    expect(providersInData(noX)).toEqual(["all", "llm", "twitter"]);
  });

  it("does not lose known options when a scoped response only contains one vendor", () => {
    // CodeRabbit, PR #2841. Against an OLD backend (no availableProviders), the
    // response for provider=apollo contains only apollo rows. Deriving from that
    // alone deletes every other option, so the picker offers a way in and no way
    // back. The options accumulate instead.
    const scoped: CostAggregation = {
      ...AGG,
      availableProviders: undefined,
      topUsers: [
        { ...AGG.topUsers[0], byModel: [{ model: "apollo:email_reveal", costUsd: 1, callCount: 1, totalTokens: 0 }] },
      ],
    };
    const known = providersInData({ ...AGG, availableProviders: undefined });
    expect(known).toEqual(["all", "llm", "twitter"]);
    expect(providersInData(scoped, known)).toEqual(["all", "llm", "apollo", "twitter"]);
  });

  it("lets an authoritative server list replace the accumulated one, rather than merging", () => {
    // A stale vendor must be able to LEAVE the list once the server is the
    // source of truth — a union would make every option permanent.
    expect(providersInData(AGG, ["all", "llm", "goneaway"])).toEqual(
      ["all", "llm", "apollo", "twitter", "v0"]
    );
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

  it("carries the same-resource dedup caveat for X only (ENG-1837 AC5)", () => {
    // X dedups a repeat read within a UTC day; no other metered vendor does, so
    // attaching this qualifier elsewhere would state something untrue of it.
    expect(providerHasDedupCaveat("twitter")).toBe(true);
    expect(providerHasDedupCaveat("all")).toBe(true); // X rows are in scope
    expect(providerHasDedupCaveat("v0")).toBe(false);
    expect(providerHasDedupCaveat("llm")).toBe(false);
  });

  it("marks only the all-vendor total as an undercount while ENG-698 is open", () => {
    expect(providerTotalIsUndercount("all")).toBe(true);
    expect(providerTotalIsUndercount("twitter")).toBe(false);
  });

  it("labels every metered vendor, and passes an unknown key through unchanged", () => {
    expect(providerLabel("all")).toBe("All providers");
    expect(providerLabel("llm")).toBe("LLM (tokens)");
    expect(providerLabel("twitter")).toBe("X (Twitter)");
    expect(providerLabel("v0")).toBe("v0 (Vercel)");
    expect(providerLabel("you.com")).toBe("You.com search");
    expect(providerLabel("google_cse")).toBe("Google Custom Search");
    expect(providerLabel("apollo")).toBe("Apollo");
    expect(providerLabel("enrich.so")).toBe("enrich.so");
    expect(providerLabel("remotion")).toBe("Remotion Lambda");
    // A vendor whose adapter shipped before anyone added a label is still listed.
    expect(providerLabel("brandnew")).toBe("brandnew");
  });

  it("names the drill-down column for what the rows actually are", () => {
    // A twitter:* row is a TOOL. Calling it a Model is the mis-read ENG-1519 fixed.
    expect(breakdownColumnLabel("llm")).toBe("Model");
    expect(breakdownColumnLabel("twitter")).toBe("Tool");
    expect(breakdownColumnLabel("all")).toBe("Tool / model");
  });

  it("names what an unattributed row actually is, rather than reporting a missing email", () => {
    // One blank-looking string covered four different situations in production
    // and hid the one that matters — `system` was the largest call count on the
    // page (ENG-1858) and read like a data-quality nit.
    expect(unattributedUserLabel("system")).toBe("System (unattributed)");
    expect(unattributedUserLabel("anon_618cab1a-7923-4e58-b0a7-8f557a651d2a")).toBe("Anonymous session");
    // Real production ids that are neither: a feature name and a test harness.
    expect(unattributedUserLabel("workplans")).toBe("Unknown or unresolved user");
    expect(unattributedUserLabel("eng1223-live-readonly-check")).toBe("Unknown or unresolved user");
    // Never asserts a cause it has not established — "deleted" is a guess.
    expect(unattributedUserLabel("7173e485-e9fd-4e06-bb57-955648309a72")).not.toMatch(/deleted/i);
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

  it("renders per-user rows, and under X the by-account table and reconciliation panel", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);

    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());
    // user-b has no email on the fixture; it renders as a classified label now.
    expect(screen.getByText("Unknown or unresolved user")).toBeInTheDocument();

    await selectProvider("X (Twitter)");

    // Scoped to X: the total is the twitter spend across users ($0.10 + $0.20),
    // not the all-providers sum. The server did that scoping, not the client.
    await waitFor(() => expect(screen.getByTestId("total-cost")).toHaveTextContent("$0.30"));

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

  // SUPERSEDES "is X-only by default: allocated caveat shown, no provider selector".
  // That test encoded ENG-664's deliberate X-only scoping; ENG-1837 AC1 reverses
  // it now that six more vendors write to the same ledger.
  it("offers a provider selector and opens on all providers (ENG-1837 AC1)", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    expect(screen.getByTestId("provider-select")).toBeInTheDocument();
    expect(DEFAULT_PROVIDER).toBe("all");
    // The opening request carries the default, so the first paint is the total
    // rather than one vendor's slice.
    expect(aggUrls()[0]).toContain("provider=all");
    expect(screen.getByTestId("total-cost")).toHaveTextContent("$1.24");
    expect(screen.getByTestId("allocated-caveat")).toBeInTheDocument();
  });

  it("lists every provider the server offers, including one with no spend this window", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    await userEvent.click(screen.getByLabelText("Provider"));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    // "v0 (Vercel)" has no row in the fixture — a metered vendor must stay
    // selectable before it accrues spend, or it reads as costing nothing.
    expect(options).toEqual([
      "All providers",
      "LLM (tokens)",
      "Apollo",
      "X (Twitter)",
      "v0 (Vercel)",
    ]);
  });

  it("keeps every option in the picker after a scoped reload against an older backend", async () => {
    // The deploy-window case: portal is new, backend has not shipped
    // availableProviders yet. Selecting X returns an X-only payload; the picker
    // must not shrink to what that payload happens to contain, or the admin is
    // one click from a dead end (CodeRabbit, PR #2841).
    // Apollo is discoverable ONLY from the rows here — it is not a fixed scope
    // and not the always-offered twitter. It is therefore the option that
    // actually disappears if the fallback rebuilds from a scoped payload.
    const legacy: CostAggregation = {
      ...AGG,
      availableProviders: undefined,
      topUsers: [
        {
          ...AGG.topUsers[0],
          byModel: [
            ...AGG.topUsers[0].byModel,
            { model: "apollo:email_reveal", costUsd: 0.05, callCount: 1, totalTokens: 0 },
          ],
        },
        AGG.topUsers[1],
      ],
    };
    const legacyX: CostAggregation = { ...AGG_XSCOPED, availableProviders: undefined };
    routeAxios({ agg: legacy, xAgg: legacyX });
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    await selectProvider("X (Twitter)");
    await waitFor(() => expect(aggUrls().pop()).toContain("provider=twitter"));

    await userEvent.click(screen.getByLabelText("Provider"));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toContain("All providers");
    expect(options).toContain("LLM (tokens)");
    expect(options).toContain("X (Twitter)");
    // The one the scoped payload cannot re-derive.
    expect(options).toContain("Apollo");
  });

  it("refetches server-side with the selected provider, rather than filtering in the browser", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());
    const before = aggUrls().length;

    await selectProvider("Apollo");

    await waitFor(() => expect(aggUrls().length).toBe(before + 1));
    expect(aggUrls().pop()).toContain("provider=apollo");
  });

  it("hides the X reconciliation panel and the X-account rollup under a non-X vendor", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    await selectProvider("Apollo");

    // Both compare against X's own billing cycle / connected accounts, which say
    // nothing about Apollo. Rendering them here would invite a false reading.
    await waitFor(() => expect(screen.queryByTestId("x-recon-panel")).not.toBeInTheDocument());
    expect(screen.queryByTestId("x-account-table")).not.toBeInTheDocument();
    // The dedup caveat is X-specific and must not travel with the vendor change.
    expect(screen.getByTestId("allocated-caveat")).not.toHaveTextContent("upper bound");
  });

  it("warns that an all-vendor total is an undercount while ENG-698 is open", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    // Default is "all". A figure that silently omits ElevenLabs, 2captcha and
    // Placid would read as the vendor envelope being comfortably met.
    expect(screen.getByTestId("undercount-caveat")).toHaveTextContent("undercount");

    await selectProvider("X (Twitter)");
    await waitFor(() => expect(screen.queryByTestId("undercount-caveat")).not.toBeInTheDocument());
  });

  it("uses the complete aggregation totals, not the capped top-users slice", async () => {
    // Server caps topUsers (here 2 rows) but reports the full totals + userCount.
    // The headline must reflect the complete figures, not a sum over the 2 rows.
    const agg: CostAggregation = {
      ...AGG,
      totals: { costUsd: 42.5, callCount: 9999, totalTokens: 0 },
      userCount: 137,
    };
    routeAxios({ agg });
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    // $1.24 would be the sum of the 2 visible rows; the complete total is $42.50.
    expect(screen.getByTestId("total-cost")).toHaveTextContent("$42.50");
    expect(screen.getByTestId("users-with-spend")).toHaveTextContent("137");
  });

  it("surfaces an attribution gap when measured reads exceed allocated", async () => {
    const recon = {
      ...RECON,
      allocated: { ...RECON.allocated, postReadUnits: 4000 },
      reconciliation: {
        ...RECON.reconciliation,
        allocatedPostReadUnits: 4000,
        dedupSavingsUnits: 0,
        attributionGapUnits: 141, // measured 4141 - allocated 4000
      },
    };
    routeAxios({ recon });
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());
    await selectProvider("X (Twitter)");

    const gap = await screen.findByTestId("x-recon-gap");
    expect(gap).toHaveTextContent("141");
  });

  it("degrades gracefully when X reconciliation is unavailable (502)", async () => {
    routeAxios({ reconError: { response: { data: { message: "X app bearer token is not configured" } } } });
    render(<UsageCostByUserTab />);

    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());
    await selectProvider("X (Twitter)");
    const err = await screen.findByTestId("x-recon-error");
    expect(err).toHaveTextContent("bearer token");
    // The rest of the tab still renders.
    expect(screen.getByTestId("total-cost")).toBeInTheDocument();
  });

  it("a quick-range preset reloads the aggregation with a new range", async () => {
    routeAxios();
    render(<UsageCostByUserTab />);
    await waitFor(() => expect(screen.getByText("a@example.com")).toBeInTheDocument());

    await selectProvider("X (Twitter)");
    const before = aggUrls().length;

    await userEvent.click(screen.getByRole("button", { name: "30d" }));

    await waitFor(() => expect(aggUrls().length).toBe(before + 1));
    const lastAgg = aggUrls().pop();
    expect(lastAgg).toMatch(/start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}/);
    // A range change must not silently reset the scope back to the default.
    expect(lastAgg).toContain("provider=twitter");
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
