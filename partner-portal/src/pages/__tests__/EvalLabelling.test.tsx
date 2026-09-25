import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
