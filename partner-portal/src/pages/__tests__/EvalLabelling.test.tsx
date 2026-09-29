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
    expect(screen.getByText(/Pass = the agent argued or pushed back/)).toBeInTheDocument();
    expect(screen.getByText(/Pass = the agent handed off to a human/)).toBeInTheDocument();
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
});
