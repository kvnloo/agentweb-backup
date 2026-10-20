import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import axios from "axios";
import AgentRunsInspector from "../AgentRunsInspector";

jest.mock("axios");

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { isAdmin: true },
  }),
}));

jest.mock("../../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
  CUSTOMER_FRONTEND_URL: "https://app.test",
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function run(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    sessionId: "session-1",
    userId: "user-1",
    llmModel: "gemini-test",
    status: "completed",
    startedAt: "2026-10-14T10:00:00.000Z",
    completedAt: "2026-10-14T10:05:00.000Z",
    durationMs: 300_000,
    toolCalls: 4,
    failedToolCalls: 2,
    outcomeVerdict: "degraded",
    outcomeReasons: "failed_tool_calls",
    flags: [
      { code: "side_effecting_tool", severity: "warning", message: "x", evidence: "send_email" },
      { code: "side_effecting_tool", severity: "warning", message: "y", evidence: "create_file" },
    ],
    decisions: [],
    outcomes: [],
    chat: { found: true, sessionId: "session-1", title: "Weekly report", messageCount: 9, firstUserMessage: "Make the weekly report" },
    ...overrides,
  };
}

const TRACE = {
  sessionId: "session-1",
  found: true,
  ask: { text: "Make the weekly report for the client.", truncated: false },
  followUpAsks: [],
  workPlan: {
    title: "Weekly report",
    steps: [
      { stepCount: 1, title: "Load metrics", status: "completed", notes: "Loaded 10 campaigns.", callIds: ["c1", "c2"], closedWithoutCalls: false },
      { stepCount: 2, title: "Write report", status: "completed", notes: "Report written.", callIds: [], closedWithoutCalls: true },
    ],
  },
  setupCallIds: [],
  unassignedCallIds: ["c3", "c4"],
  calls: [
    {
      id: "c1",
      index: 0,
      name: "list_campaigns",
      argsPreview: "client_id=acme",
      argsJson: '{\n  "client_id": "acme"\n}',
      argsTruncated: false,
      status: "failed",
      durationMs: 23,
      endedAt: "2026-10-14T10:00:44.000Z",
      result: "Tool Error: needs account_id",
      resultChars: 28,
      resultTruncated: false,
      error: "needs an explicit account_id",
      recoveredByCallId: "c2",
    },
    {
      id: "c2",
      index: 1,
      name: "list_campaigns",
      argsPreview: "client_id=acme account_id=42",
      argsJson: '{\n  "client_id": "acme",\n  "account_id": 42\n}',
      argsTruncated: false,
      status: "succeeded",
      durationMs: 3600,
      endedAt: "2026-10-14T10:00:59.000Z",
      result: "10 campaigns",
      resultChars: 12,
      resultTruncated: false,
    },
    {
      id: "c3",
      index: 2,
      name: "send_summary",
      argsPreview: "",
      argsJson: "{}",
      argsTruncated: false,
      status: "succeeded",
      durationMs: 41,
      resultChars: 0,
      resultTruncated: false,
    },
    {
      id: "c4",
      index: 3,
      name: "post_to_slack",
      argsPreview: "channel=#reports",
      argsJson: '{\n  "channel": "#reports"\n}',
      argsTruncated: false,
      status: "failed",
      durationMs: 12,
      result: "Tool Error: channel_not_found",
      resultChars: 29,
      resultTruncated: false,
      error: "channel_not_found",
    },
  ],
  callsTruncated: false,
  resultsDegraded: false,
  messagesTruncated: false,
  usage: { promptTokens: 120_000, completionTokens: 3_000, estimatedCostUsd: 0.042 },
  finalResponse: {
    html: '<p>Done: <a href="https://files.test/report.html">report</a> <a href="javascript:alert(1)">bad</a></p><img src="https://img.test/chart.png" alt="chart" onerror="window.__pwned=1"><script>window.__pwned=2</script>',
    truncated: false,
  },
};

function respond(runs: unknown[], options: { trace?: unknown; truncated?: boolean } = {}) {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes("/agent-runs/trace")) return Promise.resolve({ data: { trace: options.trace ?? TRACE } });
    return Promise.resolve({ data: { runs, count: runs.length, scannedEvents: 10, truncated: options.truncated ?? false } });
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.search}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AgentRunsInspector />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("AgentRunsInspector", () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    respond([]);
  });

  it("loads runs for the sessionId in the URL, then that run's trace scoped to its window", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    await waitFor(() =>
      expect(mockedAxios.get).toHaveBeenCalledWith("https://api.test/api/admin/agent-runs?limit=50&sessionId=session-1", {
        headers: { Authorization: "Bearer test-token" },
      })
    );
    await waitFor(() =>
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.test/api/admin/agent-runs/trace?sessionId=session-1&startedAt=2026-10-14T10%3A00%3A00.000Z&completedAt=2026-10-14T10%3A05%3A00.000Z",
        { headers: { Authorization: "Bearer test-token" } }
      )
    );
  });

  it("shows the ask, each step's notes and the calls nested under it", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    expect(await screen.findByText("Make the weekly report for the client.")).toBeInTheDocument();
    expect(screen.getByText("Work plan · 2 of 2 steps completed")).toBeInTheDocument();
    expect(screen.getByText("Step 1 · Load metrics")).toBeInTheDocument();
    expect(screen.getByText("Loaded 10 campaigns.")).toBeInTheDocument();
    expect(screen.getByText("Marked completed with no work besides status updates.")).toBeInTheDocument();
    expect(screen.getByText("After the last step update")).toBeInTheDocument();
  });

  it("opens unrecovered failures, keeps recovered failures and successes closed", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    const open = (await screen.findByText("Tool Error: channel_not_found")).closest("li")!;
    expect(within(open).getByRole("button", { expanded: true })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Step 1 · Load metrics"));
    const recoveredRow = screen.getByText("needs an explicit account_id").closest("li")!;
    expect(within(recoveredRow).getByText("Recovered", { selector: ".MuiChip-label" })).toBeInTheDocument();
    expect(within(recoveredRow).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.queryByText("Tool Error: needs account_id")).not.toBeInTheDocument();

    const okRow = screen.getByText("client_id=acme account_id=42").closest("li")!;
    const toggle = within(okRow).getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(await screen.findByText("10 campaigns")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("starts finished steps collapsed and opens the group holding an unrecovered failure", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    const step1 = (await screen.findByText("Step 1 · Load metrics")).closest("[aria-expanded]")!;
    expect(step1).toHaveAttribute("aria-expanded", "false");
    const step2 = screen.getByText("Step 2 · Write report").closest("[aria-expanded]")!;
    expect(step2).toHaveAttribute("aria-expanded", "true");
    const after = screen.getByText("After the last step update").closest("[aria-expanded]")!;
    expect(after).toHaveAttribute("aria-expanded", "true");
  });

  it("jumps to the first unrecovered failure and moves focus to it", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    const failedRow = (await screen.findByText("Tool Error: channel_not_found")).closest("li")!;
    const toggle = within(failedRow).getByRole("button", { expanded: true });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "First failure" }));
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("names call and step status icons for screen readers", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    expect(await screen.findAllByTitle("Succeeded")).not.toHaveLength(0);
    expect(screen.getByTitle("Failed")).toBeInTheDocument();
    expect(screen.getByTitle("Failed, recovered later")).toBeInTheDocument();
    expect(screen.getAllByTitle("Step completed")).toHaveLength(2);
  });

  it("filters to failed calls only", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    await screen.findByText("client_id=acme account_id=42");
    fireEvent.click(screen.getByRole("button", { name: "Failed (2)" }));
    expect(screen.queryByText("client_id=acme account_id=42")).not.toBeInTheDocument();
    expect(screen.queryByText("send_summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Step 2 · Write report")).not.toBeInTheDocument();
    expect(screen.getByText("needs an explicit account_id")).toBeInTheDocument();
    expect(screen.getByText("post_to_slack")).toBeInTheDocument();
  });

  it("renders the final reply sanitised: no scripts or handlers, links open in a new tab", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    const reply = await screen.findByTestId("final-reply-rendered");
    expect(reply.innerHTML).not.toContain("onerror");
    expect(reply.innerHTML).not.toContain("<script");
    const link = within(reply).getByRole("link", { name: "report" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(reply.innerHTML).not.toContain("javascript:");
    expect(reply.querySelector("img")).toBeNull();
    expect(within(reply).getByRole("link", { name: "[image: chart]" })).toHaveAttribute("href", "https://img.test/chart.png");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    const linkRow = screen.getByText("Links in this reply").parentElement!;
    expect(within(linkRow).getByRole("link", { name: "report" })).toHaveAttribute("href", "https://files.test/report.html");
    expect(within(linkRow).queryByText("bad")).not.toBeInTheDocument();
  });

  it("says a run whose failures were all recovered completed", async () => {
    respond([run({ failedToolCalls: 1 })], { trace: { ...TRACE, calls: TRACE.calls.slice(0, 3), unassignedCallIds: ["c3"] } });
    renderAt("/agent-runs?sessionId=session-1");

    expect(await screen.findByText("Completed · 1 failure, all recovered")).toBeInTheDocument();
  });

  it("states the status in words and groups repeated flags", async () => {
    respond([run()]);
    renderAt("/agent-runs?sessionId=session-1");

    expect(await screen.findByText("Completed · 2 failed calls")).toBeInTheDocument();
    expect(screen.getByText("side effecting tool ×2")).toBeInTheDocument();
    expect(await screen.findByText("2 (1 recovered)")).toBeInTheDocument();
    expect(screen.getByText("$0.042 · 123.0k")).toBeInTheDocument();
  });

  it("copies the full run id", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    respond([run({ runId: "run-0123456789abcdef-long" })]);
    renderAt("/agent-runs?sessionId=session-1");

    fireEvent.click(await screen.findByRole("button", { name: "Copy run id" }));
    expect(writeText).toHaveBeenCalledWith("run-0123456789abcdef-long");
  });

  it("hides the run list for a single run and shows it for several, writing the selection to the URL", async () => {
    respond([run(), run({ runId: "run-2", chat: { found: true, sessionId: "session-1", title: "Second run", messageCount: 2 } })]);
    renderAt("/agent-runs?sessionId=session-1");

    const list = await screen.findByRole("list", { name: "AgentRuns" });
    const listCalls = () => mockedAxios.get.mock.calls.filter(([url]) => !String(url).includes("/trace")).length;
    expect(listCalls()).toBe(1);
    fireEvent.click(within(list).getByText("Second run"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("run=run-2"));
    expect(await screen.findByRole("heading", { name: "Second run" })).toBeInTheDocument();
    expect(listCalls()).toBe(1);
  });

  it("submits the search on Enter and puts the filters in the URL", async () => {
    renderAt("/agent-runs");
    await waitFor(() => expect(mockedAxios.get).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Session ID"), { target: { value: "  session-9 " } });
    fireEvent.submit(screen.getByRole("search"));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("?sessionId=session-9"));
    await waitFor(() =>
      expect(mockedAxios.get).toHaveBeenLastCalledWith("https://api.test/api/admin/agent-runs?limit=50&sessionId=session-9", expect.anything())
    );
  });

  it("explains an empty result and a permissions error", async () => {
    renderAt("/agent-runs?sessionId=missing");
    expect(await screen.findByText("No AgentRuns match this search.")).toBeInTheDocument();

    mockedAxios.get.mockRejectedValue({ isAxiosError: true, response: { status: 403 } });
    (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload runs" }));
    expect(await screen.findByText(/Sign in again with an admin account/)).toBeInTheDocument();
  });

  it("keeps the spine diagnostics: repair counts and failure types", async () => {
    respond([
      run({
        decisions: [{ ts: "2026-10-14T10:00:01.000Z", iteration: 1, toolNames: ["read_file_content"], argsRepairedCount: 1, schemaErrorCount: 1 }],
        outcomes: [
          { ts: "2026-10-14T10:00:02.000Z", eventType: "agent_tool_failed", toolName: "generate_image", errorClass: "repeated_failure", errorMessage: "Tool reached its retry budget.", failureType: "bug" },
        ],
      }),
    ]);
    renderAt("/agent-runs?sessionId=session-1");

    expect(await screen.findByText("1 arg repair(s)")).toBeInTheDocument();
    expect(screen.getByText("1 schema reject(s)")).toBeInTheDocument();
    expect(screen.getByText("generate_image")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
  });

  it("warns when the plan shown is the session's current one", async () => {
    respond([run()], { trace: { ...TRACE, workPlanScope: "session" } });
    renderAt("/agent-runs?sessionId=session-1");

    expect(await screen.findByText(/This session ran again after this run/)).toBeInTheDocument();
  });

  it("falls back to the chat summary when the trace cannot be loaded", async () => {
    mockedAxios.get.mockImplementation((url: string) =>
      url.includes("/trace")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ data: { runs: [run()], count: 1, scannedEvents: 1 } })
    );
    renderAt("/agent-runs?sessionId=session-1");

    expect(await screen.findByText(/Could not load the step-by-step trace/)).toBeInTheDocument();
    expect(screen.getByText("Make the weekly report")).toBeInTheDocument();
  });
});
