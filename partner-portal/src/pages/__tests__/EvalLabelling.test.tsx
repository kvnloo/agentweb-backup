import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import EvalLabelling, { type GoldenCaseView } from "../EvalLabelling";

jest.mock("axios", () => {
  const actual = jest.requireActual("axios");
  return { __esModule: true, default: { get: jest.fn(), put: jest.fn(), isAxiosError: actual.isAxiosError } };
});

const mockAuth = { token: "test-token", user: { isAdmin: true } };
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => mockAuth,
}));

jest.mock("../../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
}));

const mockedAxios = jest.mocked(axios);
const AUTH = { headers: { Authorization: "Bearer test-token" } };

const CASE: GoldenCaseView = {
  caseId: "agent#sessionId#session-1",
  surface: "agent",
  taskType: "fp_catalogue",
  sourceRef: { kind: "sessionId", id: "session-1" },
  criteria: ["task_success", "tool_correctness", "groundedness", "instruction_compliance"],
  labels: {},
  split: "test",
  version: 3,
};

const DEV_CASE: GoldenCaseView = {
  ...CASE,
  caseId: "agent#sessionId#session-2",
  sourceRef: { kind: "sessionId", id: "session-2" },
  split: "dev",
  version: 1,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <EvalLabelling />
    </MemoryRouter>,
  );
}

function routeGets(provisioned: boolean) {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/api/admin/eval/golden-cases/status")) return { data: { provisioned } };
    if (url.includes("/api/admin/eval/golden-cases?surface=agent")) return { data: { cases: [CASE] } };
    if (url.includes("/api/admin/chat-sessions?sessionId=session-1")) {
      return { data: { sessions: [{ title: "Synthetic session", messages: [{ role: "user", content: "Is it on?" }, { role: "assistant", content: "Yes." }] }] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

function routeGetsTestAndDev() {
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/api/admin/eval/golden-cases/status")) return { data: { provisioned: true } };
    if (url.includes("/api/admin/eval/golden-cases?surface=agent")) return { data: { cases: [CASE, DEV_CASE] } };
    if (url.includes("/api/admin/chat-sessions?sessionId=session-1") || url.includes("/api/admin/chat-sessions?sessionId=session-2")) {
      return { data: { sessions: [{ title: "Synthetic session", messages: [{ role: "user", content: "Is it on?" }, { role: "assistant", content: "Yes." }] }] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

describe("EvalLabelling (ENG-2135)", () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.put.mockReset();
    mockAuth.user = { isAdmin: true };
  });

  it("shows the not-provisioned message and loads no cases until OPS-2", async () => {
    routeGets(false);
    renderPage();
    expect(await screen.findByText(/not provisioned yet \(OPS-2, ENG-2147\)/)).toBeInTheDocument();
    expect(mockedAxios.get).toHaveBeenCalledWith("https://api.test/api/admin/eval/golden-cases/status", AUTH);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("lists cases, loads the source through the admin chat API with the useAuth token, and saves labels", async () => {
    routeGets(true);
    mockedAxios.put.mockResolvedValue({ data: { case: { ...CASE, labels: { task_success: "fail" }, notes: "claimed publish", version: 4, labeller: "admin@example.com" } } });
    renderPage();

    expect(await screen.findByText("Synthetic session")).toBeInTheDocument();
    expect(screen.getByText("Is it on?")).toBeInTheDocument();
    expect(mockedAxios.get).toHaveBeenCalledWith("https://api.test/api/admin/chat-sessions?sessionId=session-1", AUTH);

    fireEvent.click(screen.getByRole("button", { name: "task_success fail" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "claimed publish" } });
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));

    await waitFor(() => {
      expect(mockedAxios.put).toHaveBeenCalledWith(
        "https://api.test/api/admin/eval/golden-cases/agent%23sessionId%23session-1/labels",
        { labels: { task_success: "fail" }, notes: "claimed publish", expectedVersion: 3 },
        AUTH,
      );
    });
    expect(await screen.findByText("Labels saved.")).toBeInTheDocument();
    expect(screen.getByText("1/4")).toBeInTheDocument();
  });

  it("renders the ENG-2189 behaviour criteria with their help text and saves their labels", async () => {
    const behaviourCase = { ...CASE, criteria: [...CASE.criteria, "argued_with_instruction", "escalated_when_not_required", "failed_to_escalate"] };
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/admin/eval/golden-cases/status")) return { data: { provisioned: true } };
      if (url.includes("/api/admin/eval/golden-cases?surface=agent")) return { data: { cases: [behaviourCase] } };
      if (url.includes("/api/admin/chat-sessions?sessionId=session-1")) return { data: { sessions: [{ title: "Synthetic session", messages: [] }] } };
      throw new Error(`unexpected GET ${url}`);
    });
    mockedAxios.put.mockResolvedValue({ data: { case: { ...behaviourCase, labels: { argued_with_instruction: "pass" }, version: 4 } } });
    renderPage();

    await screen.findByText("Synthetic session");
    expect(screen.getByText(/Pass = the agent refused, pushed back on, or asked approval/)).toBeInTheDocument();
    expect(screen.getByText(/Pass = the agent handed work or a decision back to the human/)).toBeInTheDocument();
    expect(screen.getByText(/Pass = the agent hit a blocker/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "argued_with_instruction pass" }));
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));
    await waitFor(() => {
      expect(mockedAxios.put).toHaveBeenCalledWith(
        "https://api.test/api/admin/eval/golden-cases/agent%23sessionId%23session-1/labels",
        { labels: { argued_with_instruction: "pass" }, notes: "", expectedVersion: 3 },
        AUTH,
      );
    });
  });

  it("drops the saved confirmation as soon as a label or the note changes (#3079 review)", async () => {
    routeGets(true);
    mockedAxios.put.mockResolvedValue({ data: { case: { ...CASE, labels: { task_success: "pass" }, version: 4 } } });
    renderPage();
    await screen.findByText("Synthetic session");
    fireEvent.click(screen.getByRole("button", { name: "task_success pass" }));
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));
    expect(await screen.findByText("Labels saved.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "task_success fail" }));
    expect(screen.queryByText("Labels saved.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));
    expect(await screen.findByText("Labels saved.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "edited" } });
    expect(screen.queryByText("Labels saved.")).not.toBeInTheDocument();
  });

  it("locks the labels and note while a save is in flight (#3079 review)", async () => {
    routeGets(true);
    let resolvePut: (value: unknown) => void = () => undefined;
    mockedAxios.put.mockReturnValue(new Promise((resolve) => { resolvePut = resolve; }));
    renderPage();
    await screen.findByText("Synthetic session");
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));

    expect(screen.getByRole("button", { name: "task_success pass" })).toBeDisabled();
    expect(screen.getByLabelText("Note")).toBeDisabled();

    resolvePut({ data: { case: { ...CASE, version: 4 } } });
    expect(await screen.findByText("Labels saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "task_success pass" })).not.toBeDisabled();
  });

  it("explains a version conflict instead of overwriting another labeller", async () => {
    routeGets(true);
    mockedAxios.put.mockRejectedValue(Object.assign(new Error("conflict"), { isAxiosError: true, response: { status: 409, data: { error: "version_conflict" } } }));
    renderPage();
    await screen.findByText("Synthetic session");
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));
    expect(await screen.findByText(/Someone saved this case after you opened it/)).toBeInTheDocument();
  });

  it("renders nothing but an access message for a non-admin and makes no requests", () => {
    mockAuth.user = { isAdmin: false };
    renderPage();
    expect(screen.getByText("Admin access required")).toBeInTheDocument();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("ignores a superseded surface load that finishes after the current one", async () => {
    const creativeCase: GoldenCaseView = {
      ...CASE,
      caseId: "creative#candidateId#cand-1",
      surface: "creative",
      taskType: "creative_image",
      sourceRef: { kind: "candidateId", id: "cand-1" },
      criteria: ["hook"],
    };
    let resolveAgent: (value: { data: { cases: GoldenCaseView[] } }) => void = () => undefined;
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.endsWith("/status")) return Promise.resolve({ data: { provisioned: true } });
      if (url.includes("surface=agent")) return new Promise((resolve) => { resolveAgent = resolve; });
      if (url.includes("surface=creative")) return Promise.resolve({ data: { cases: [creativeCase] } });
      if (url.includes("/api/human-eval/candidates/cand-1")) return Promise.resolve({ data: { candidate: { reviewType: "creative_image", feedback: [] } } });
      if (url.includes("/api/admin/chat-sessions")) return Promise.resolve({ data: { sessions: [] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderPage();
    await waitFor(() => expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("surface=agent"), AUTH));
    fireEvent.click(screen.getByRole("tab", { name: "Creatives" }));
    expect(await screen.findByText("cand-1")).toBeInTheDocument();
    resolveAgent({ data: { cases: [CASE] } });
    await waitFor(() => expect(screen.getByText("1 cases · 0 fully labelled")).toBeInTheDocument());
    expect(screen.queryByText("session-1")).not.toBeInTheDocument();
  });

  it("selects a case from the keyboard", async () => {
    const second: GoldenCaseView = { ...CASE, caseId: "agent#sessionId#session-2", sourceRef: { kind: "sessionId", id: "session-2" } };
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/status")) return { data: { provisioned: true } };
      if (url.includes("surface=agent")) return { data: { cases: [CASE, second] } };
      if (url.includes("sessionId=session-2")) return { data: { sessions: [{ title: "Second session", messages: [] }] } };
      if (url.includes("sessionId=session-1")) return { data: { sessions: [{ title: "Synthetic session", messages: [] }] } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPage();
    await screen.findByText("Synthetic session");
    const row = screen.getByText("session-2").closest("tr");
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });
    expect(await screen.findByText("Second session")).toBeInTheDocument();
  });

  it("keeps the list least-labelled first after a save", async () => {
    const second: GoldenCaseView = { ...CASE, caseId: "agent#sessionId#session-2", sourceRef: { kind: "sessionId", id: "session-2" } };
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/status")) return { data: { provisioned: true } };
      if (url.includes("surface=agent")) return { data: { cases: [CASE, second] } };
      return { data: { sessions: [{ title: "Synthetic session", messages: [] }] } };
    });
    mockedAxios.put.mockResolvedValue({ data: { case: { ...CASE, labels: { task_success: "pass" }, version: 4 } } });
    renderPage();
    await screen.findByText("Synthetic session");
    const firstColumn = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(firstColumn()[0]).toContain("session-1");
    fireEvent.click(screen.getByRole("button", { name: "task_success pass" }));
    fireEvent.click(screen.getByRole("button", { name: "Save labels" }));
    await screen.findByText("Labels saved.");
    expect(firstColumn()[0]).toContain("session-2");
  });

  it("renders a draft's suggestion chip and rationale, and applies it only on explicit click without saving (ENG-2200)", async () => {
    const draftCase: GoldenCaseView = {
      ...CASE,
      draft: {
        labels: { task_success: { label: "pass", rationale: "The tool result confirms the task completed." } },
        model: "claude-opus-5-5",
        generatedAt: "2026-09-20T12:00:00.000Z",
      },
    };
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/status")) return { data: { provisioned: true } };
      if (url.includes("surface=agent")) return { data: { cases: [draftCase] } };
      if (url.includes("sessionId=session-1")) return { data: { sessions: [{ title: "Synthetic session", messages: [] }] } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPage();
    await screen.findByText("Synthetic session");

    expect(screen.getByText("AI suggests: Pass")).toBeInTheDocument();
    expect(screen.getByText("The tool result confirms the task completed.")).toBeInTheDocument();
    expect(screen.getByText(/AI-drafted suggestions available \(model: claude-opus-5-5/)).toBeInTheDocument();

    // Not pre-set: the toggle starts unselected even though a draft exists for this criterion.
    expect(screen.getByRole("button", { name: "task_success pass" })).not.toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(screen.getByRole("button", { name: "task_success pass" })).toHaveAttribute("aria-pressed", "true");
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it("fills every unlabelled criterion with its draft suggestion on 'Apply all suggestions', without saving", async () => {
    const draftCase: GoldenCaseView = {
      ...CASE,
      labels: { tool_correctness: "fail" },
      draft: {
        labels: {
          task_success: { label: "pass", rationale: "Looks right." },
          tool_correctness: { label: "pass", rationale: "Should not override the existing human label." },
          groundedness: { label: "na", rationale: "No claims made." },
        },
        model: "claude-opus-5-5",
        generatedAt: "2026-09-20T12:00:00.000Z",
      },
    };
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/status")) return { data: { provisioned: true } };
      if (url.includes("surface=agent")) return { data: { cases: [draftCase] } };
      if (url.includes("sessionId=session-1")) return { data: { sessions: [{ title: "Synthetic session", messages: [] }] } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPage();
    await screen.findByText("Synthetic session");

    fireEvent.click(screen.getByRole("button", { name: "Apply all suggestions" }));

    expect(screen.getByRole("button", { name: "task_success pass" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "groundedness na" })).toHaveAttribute("aria-pressed", "true");
    // Already human-labelled criterion keeps its existing label, not the draft's.
    expect(screen.getByRole("button", { name: "tool_correctness fail" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "tool_correctness pass" })).toHaveAttribute("aria-pressed", "false");
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it("renders no draft UI for a case without a draft (no regression)", async () => {
    routeGets(true);
    renderPage();
    await screen.findByText("Synthetic session");
    expect(screen.queryByText(/AI suggests:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI-drafted suggestions available/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply all suggestions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use suggestion" })).not.toBeInTheDocument();
  });

  it("renders the source panel before the labels panel so reviewers read before judging (ENG-2219)", async () => {
    routeGets(true);
    renderPage();
    await screen.findByText("Synthetic session");

    const sourceHeading = screen.getByRole("heading", { name: "Source" });
    const labelsHeading = screen.getByRole("heading", { name: "Labels" });
    expect(sourceHeading.compareDocumentPosition(labelsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a loading state instead of a false-empty list while a surface's cases are still in flight (ENG-2219)", async () => {
    let resolveCreative: (value: { data: { cases: GoldenCaseView[] } }) => void = () => undefined;
    mockedAxios.get.mockImplementation((url: string) => {
      if (url.endsWith("/status")) return Promise.resolve({ data: { provisioned: true } });
      if (url.includes("surface=agent")) return Promise.resolve({ data: { cases: [CASE] } });
      if (url.includes("surface=creative")) return new Promise((resolve) => { resolveCreative = resolve; });
      if (url.includes("/api/admin/chat-sessions")) return Promise.resolve({ data: { sessions: [{ title: "Synthetic session", messages: [] }] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderPage();
    await screen.findByText("Synthetic session");

    fireEvent.click(screen.getByRole("tab", { name: "Creatives" }));

    // While the creative surface's cases are still in flight, the list shows a loading state,
    // never the "0 cases" false-empty state that a naive reset-then-fetch would flash.
    expect(await screen.findByText("Loading cases…")).toBeInTheDocument();
    expect(screen.queryByText(/cases · .* fully labelled/)).not.toBeInTheDocument();

    resolveCreative({ data: { cases: [] } });
    await waitFor(() => expect(screen.getByText("0 cases · 0 fully labelled")).toBeInTheDocument());
  });

  it("leaves pairwise calibration cases to their own page and links to it (ENG-2142)", async () => {
    const single: GoldenCaseView = { ...CASE, caseId: "creative#candidateId#cand-1", surface: "creative", taskType: "creative_image", sourceRef: { kind: "candidateId", id: "cand-1" }, criteria: ["hook"] };
    const pair: GoldenCaseView = {
      ...single,
      caseId: "creative#candidatePair#cand-2#cand-3",
      taskType: "creative_pairwise",
      sourceRef: { kind: "candidateId", id: "cand-2" },
      criteria: ["pairwise_preference"],
      pair: { candidateIdB: "cand-3", batch: "2026-W39", position: 0, batchSize: 1, category: "ad", placement: "unknown", signal: "unscored" },
    };
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/status")) return { data: { provisioned: true } };
      if (url.includes("surface=agent")) return { data: { cases: [] } };
      if (url.includes("surface=creative")) return { data: { cases: [single, pair] } };
      if (url.includes("/api/human-eval/candidates/")) return { data: { candidate: { reviewType: "creative_image", feedback: [] } } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPage();
    expect(screen.getByRole("link", { name: "weekly creative calibration" })).toHaveAttribute("href", "/eval-labelling/calibration");
    fireEvent.click(screen.getByRole("tab", { name: "Creatives" }));
    expect(await screen.findByText("1 cases · 0 fully labelled")).toBeInTheDocument();
    expect(screen.getByText("cand-1")).toBeInTheDocument();
    expect(screen.queryByText("cand-2")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "pairwise_preference pass" })).not.toBeInTheDocument();
  });

  describe("split filter", () => {
    const selectSplit = async (label: "All" | "test" | "dev") => {
      const combobox = screen.getByLabelText("Split");
      fireEvent.mouseDown(combobox);
      const option = await screen.findByRole("option", { name: label });
      fireEvent.click(option);
    };

    it("defaults to All and shows every case", async () => {
      routeGetsTestAndDev();
      renderPage();
      expect(await screen.findByText("2 cases · 0 fully labelled")).toBeInTheDocument();
      expect(screen.getByText("session-1")).toBeInTheDocument();
      expect(screen.getByText("session-2")).toBeInTheDocument();
    });

    it("filters the list to only the selected split, without refetching", async () => {
      routeGetsTestAndDev();
      renderPage();
      await screen.findByText("2 cases · 0 fully labelled");
      const getCallCount = mockedAxios.get.mock.calls.length;

      await selectSplit("test");

      expect(screen.getByText("1 of 2 cases · 0 fully labelled")).toBeInTheDocument();
      expect(screen.getByText("session-1")).toBeInTheDocument();
      expect(screen.queryByText("session-2")).not.toBeInTheDocument();
      // Purely a client-side filter over the already-loaded cases — no new request.
      expect(mockedAxios.get.mock.calls.length).toBe(getCallCount);
    });

    it("shows a no-cases message when a split has no matches", async () => {
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.endsWith("/status")) return { data: { provisioned: true } };
        if (url.includes("surface=agent")) return { data: { cases: [CASE] } };
        throw new Error(`unexpected GET ${url}`);
      });
      renderPage();
      await screen.findByText("1 cases · 0 fully labelled");

      await selectSplit("dev");

      expect(screen.getByText("No dev cases.")).toBeInTheDocument();
      expect(screen.getByText("0 of 1 cases · 0 fully labelled")).toBeInTheDocument();
    });

    it("keeps the open case in the detail pane even when a filter change hides it from the list", async () => {
      routeGetsTestAndDev();
      renderPage();
      // session-1 (split "test") loads first and is auto-selected.
      expect(await screen.findByText("Synthetic session")).toBeInTheDocument();

      await selectSplit("dev");

      // The list no longer shows session-1's row, but its detail pane stays open —
      // filtering must never silently discard unsaved work in an open case.
      expect(screen.queryByText("session-1")).not.toBeInTheDocument();
      expect(screen.getByText("Synthetic session")).toBeInTheDocument();
    });
  });

  describe("quick mode (ENG-665)", () => {
    const WP1: GoldenCaseView = { ...CASE, caseId: "agent#sessionId#wp-1", taskType: "work_plan_session", sourceRef: { kind: "sessionId", id: "wp-1" }, version: 0 };
    const WP2: GoldenCaseView = { ...CASE, caseId: "agent#sessionId#wp-2", taskType: "work_plan_session", sourceRef: { kind: "sessionId", id: "wp-2" }, version: 0 };

    const routeQuick = (cases: GoldenCaseView[]) => {
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.endsWith("/status")) return { data: { provisioned: true } };
        if (url.includes("surface=agent")) return { data: { cases } };
        const m = url.match(/chat-sessions\?sessionId=(.+)$/);
        if (m) return { data: { sessions: [{ title: `Session ${m[1]}`, messages: [{ role: "user", content: `ask ${m[1]}` }] }] } };
        throw new Error(`unexpected GET ${url}`);
      });
    };
    const choose = async (label: string, option: string) => {
      fireEvent.mouseDown(screen.getByRole("combobox", { name: label }));
      fireEvent.click(await screen.findByRole("option", { name: option }));
      await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    };
    const savedAs = (c: GoldenCaseView, labels: GoldenCaseView["labels"]) => ({ data: { case: { ...c, labels, version: c.version + 1, labeller: "admin@example.com" } } });

    it("filters the list by task type without refetching", async () => {
      routeQuick([CASE, WP1, WP2]);
      renderPage();
      await screen.findByText("3 cases · 0 fully labelled");
      const calls = mockedAxios.get.mock.calls.length;

      await choose("Task type", "work_plan_session");

      expect(screen.getByText("2 of 3 cases · 0 fully labelled")).toBeInTheDocument();
      expect(screen.queryByText("session-1")).not.toBeInTheDocument();
      expect(screen.getByText("wp-1")).toBeInTheDocument();
      expect(mockedAxios.get.mock.calls.length).toBe(calls);
    });

    it("saves one criterion on a 1/2/3 keypress, keeps the case's other labels, and opens the next unlabelled case", async () => {
      // Least-labelled first: wp-1 (no labels) is listed before wp-2 (a groundedness label).
      const labelledElsewhere = { ...WP2, labels: { groundedness: "fail" as const } };
      routeQuick([labelledElsewhere, WP1]);
      mockedAxios.put
        .mockResolvedValueOnce(savedAs(WP1, { task_success: "fail" }))
        .mockResolvedValueOnce(savedAs(labelledElsewhere, { groundedness: "fail", task_success: "pass" }));
      renderPage();
      await screen.findByText("Session wp-1");

      await choose("Quick mode", "task success only");
      expect(screen.getByTestId("eval-labelling-count")).toHaveTextContent("0 of 2 labelled for task success");
      expect(screen.queryByRole("button", { name: "Save labels" })).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: "2" });
      await waitFor(() => {
        expect(mockedAxios.put).toHaveBeenCalledWith(
          "https://api.test/api/admin/eval/golden-cases/agent%23sessionId%23wp-1/labels",
          { labels: { task_success: "fail" }, notes: "", expectedVersion: 0 },
          AUTH,
        );
      });
      expect(await screen.findByText("Session wp-2")).toBeInTheDocument();
      expect(screen.getByTestId("eval-labelling-count")).toHaveTextContent("1 of 2 labelled for task success");

      fireEvent.keyDown(window, { key: "1" });
      await waitFor(() => {
        expect(mockedAxios.put).toHaveBeenLastCalledWith(
          "https://api.test/api/admin/eval/golden-cases/agent%23sessionId%23wp-2/labels",
          { labels: { groundedness: "fail", task_success: "pass" }, notes: "", expectedVersion: 0 },
          AUTH,
        );
      });
      expect(await screen.findByText("All 2 cases in this list are labelled for task success.")).toBeInTheDocument();
    });

    it("saves on a button click too, and says when every case in the list is labelled", async () => {
      routeQuick([WP1]);
      mockedAxios.put.mockResolvedValueOnce(savedAs(WP1, { task_success: "pass" }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");

      fireEvent.click(screen.getByRole("button", { name: "quick task_success pass" }));

      expect(await screen.findByText("All 1 cases in this list are labelled for task success.")).toBeInTheDocument();
      expect(mockedAxios.put).toHaveBeenCalledTimes(1);
    });

    it("ignores modified keys, other keys, and a second keypress while a save is in flight", async () => {
      routeQuick([WP1, WP2]);
      let resolvePut: (v: unknown) => void = () => undefined;
      mockedAxios.put.mockImplementationOnce(() => new Promise((r) => { resolvePut = r; }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");

      fireEvent.keyDown(window, { key: "1", ctrlKey: true });
      fireEvent.keyDown(window, { key: "1", metaKey: true });
      fireEvent.keyDown(window, { key: "4" });
      expect(mockedAxios.put).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "1" });
      fireEvent.keyDown(window, { key: "1" });
      expect(mockedAxios.put).toHaveBeenCalledTimes(1);

      resolvePut(savedAs(WP1, { task_success: "pass" }));
      expect(await screen.findByText("Session wp-2")).toBeInTheDocument();
    });

    it("blinds an AI-labelled case: the save carries only the human's label and clears the AI note", async () => {
      const aiCase = { ...WP1, labels: { task_success: "pass" as const, groundedness: "pass" as const }, notes: "[AI-LABEL] Written by a model.", version: 2 };
      routeQuick([aiCase]);
      mockedAxios.put.mockResolvedValueOnce(savedAs(aiCase, { task_success: "fail" }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");
      expect(screen.getByTestId("eval-labelling-count")).toHaveTextContent("0 of 1 labelled for task success");

      fireEvent.keyDown(window, { key: "2" });

      await waitFor(() => {
        expect(mockedAxios.put).toHaveBeenCalledWith(
          "https://api.test/api/admin/eval/golden-cases/agent%23sessionId%23wp-1/labels",
          { labels: { task_success: "fail" }, notes: "", expectedVersion: 2 },
          AUTH,
        );
      });
    });

    it("explains a version conflict and stays on the case", async () => {
      routeQuick([WP1, WP2]);
      mockedAxios.put.mockRejectedValueOnce(Object.assign(new Error("conflict"), { isAxiosError: true, response: { status: 409, data: {} } }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");

      fireEvent.keyDown(window, { key: "1" });

      expect(await screen.findByText(/Someone saved this case after you opened it/)).toBeInTheDocument();
      expect(screen.getByText("Session wp-1")).toBeInTheDocument();
    });

    it("a save that finishes after the admin opened another case updates the list but does not move them (#3616 review)", async () => {
      routeQuick([WP1, WP2]);
      let resolvePut: (v: unknown) => void = () => undefined;
      mockedAxios.put.mockImplementationOnce(() => new Promise((r) => { resolvePut = r; }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");

      fireEvent.keyDown(window, { key: "1" });
      fireEvent.click(screen.getByText("wp-2"));
      expect(await screen.findByText("Session wp-2")).toBeInTheDocument();

      resolvePut(savedAs(WP1, { task_success: "pass" }));
      await waitFor(() => expect(screen.getByTestId("eval-labelling-count")).toHaveTextContent("1 of 2 labelled for task success"));
      expect(screen.getByText("Session wp-2")).toBeInTheDocument();
    });

    it("a save that finishes after a surface switch does not bring the old surface's list back (#3616 review)", async () => {
      const CREATIVE: GoldenCaseView = { ...CASE, caseId: "creative#candidateId#c-1", surface: "creative", taskType: "creative_image", sourceRef: { kind: "candidateId", id: "c-1" }, criteria: ["hook"] };
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.endsWith("/status")) return { data: { provisioned: true } };
        if (url.includes("surface=agent")) return { data: { cases: [WP1, WP2] } };
        if (url.includes("surface=creative")) return { data: { cases: [CREATIVE] } };
        if (url.includes("chat-sessions")) return { data: { sessions: [{ title: "Session wp-1", messages: [] }] } };
        if (url.includes("/api/human-eval/candidates/")) return { data: { candidate: { reviewType: "creative_image" } } };
        throw new Error(`unexpected GET ${url}`);
      });
      let resolvePut: (v: unknown) => void = () => undefined;
      mockedAxios.put.mockImplementationOnce(() => new Promise((r) => { resolvePut = r; }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");

      fireEvent.keyDown(window, { key: "1" });
      fireEvent.click(screen.getByRole("tab", { name: "Creatives" }));
      expect(await screen.findByText("c-1")).toBeInTheDocument();

      resolvePut(savedAs(WP1, { task_success: "pass" }));
      await waitFor(() => expect(mockedAxios.put).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByText("c-1")).toBeInTheDocument();
      expect(screen.queryByText("wp-1")).not.toBeInTheDocument();
      expect(screen.queryByText("wp-2")).not.toBeInTheDocument();
    });

    it("a late save advances within the filters as they are now, not as they were when it started (#3616 review)", async () => {
      // wp-2-dev sorts right after wp-1, so it is "next" unless the current filter is applied.
      const DEV_WP: GoldenCaseView = { ...WP2, caseId: "agent#sessionId#wp-2-dev", sourceRef: { kind: "sessionId", id: "wp-2-dev" }, split: "dev" };
      const WP3: GoldenCaseView = { ...WP2, caseId: "agent#sessionId#wp-3", sourceRef: { kind: "sessionId", id: "wp-3" } };
      routeQuick([WP1, DEV_WP, WP3]);
      let resolvePut: (v: unknown) => void = () => undefined;
      mockedAxios.put.mockImplementationOnce(() => new Promise((r) => { resolvePut = r; }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");

      fireEvent.keyDown(window, { key: "1" });
      await choose("Split", "test");
      resolvePut(savedAs(WP1, { task_success: "pass" }));

      expect(await screen.findByText("Session wp-3")).toBeInTheDocument();
      expect(screen.queryByText("Session wp-2-dev")).not.toBeInTheDocument();
    });

    it("returning to a case while its save is still in flight cannot start a second save (#3616 review)", async () => {
      routeQuick([WP1, WP2]);
      let resolvePut: (v: unknown) => void = () => undefined;
      mockedAxios.put.mockImplementationOnce(() => new Promise((r) => { resolvePut = r; }));
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");

      fireEvent.keyDown(window, { key: "1" });
      fireEvent.click(screen.getByText("wp-2"));
      await screen.findByText("Session wp-2");
      fireEvent.click(screen.getByText("wp-1"));
      await screen.findByText("Session wp-1");

      expect(screen.getByRole("button", { name: "quick task_success fail" })).toBeDisabled();
      fireEvent.keyDown(window, { key: "2" });
      expect(mockedAxios.put).toHaveBeenCalledTimes(1);

      resolvePut(savedAs(WP1, { task_success: "pass" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "quick task_success fail" })).toBeEnabled());
    });

    it("turning quick mode off brings back the full form", async () => {
      routeQuick([WP1]);
      renderPage();
      await screen.findByText("Session wp-1");
      await choose("Quick mode", "task success only");
      expect(screen.queryByRole("button", { name: "Save labels" })).not.toBeInTheDocument();

      await choose("Quick mode", "Off (all criteria)");

      expect(screen.getByRole("button", { name: "Save labels" })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "1" });
      expect(mockedAxios.put).not.toHaveBeenCalled();
    });
  });
});
