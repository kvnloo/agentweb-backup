/**
 * ENG-2196: Chat History shows no Satisfaction column by default. The unvalidated legacy score,
 * the lazy judge scoring that fills it and the admin override appear only after an admin turns
 * on the "Show unvalidated legacy score" disclosure.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import AdminDashboard from "../AdminDashboard";

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "test-token", user: { isAdmin: true } }),
}));

jest.mock("../../contexts/AdminContext", () => ({
  useAdmin: () => ({
    users: [],
    waitlist: [],
    taskAnalytics: {},
    userAnalytics: {},
    agentModeAnalytics: {},
    loadUsers: jest.fn(),
    loadWaitlist: jest.fn(),
    loadAnalytics: jest.fn(),
    updateWaitlistStatus: jest.fn(),
    loading: false,
    error: "",
    updateWaitlistSupportNote: jest.fn(),
    deleteWaitlistEntry: jest.fn(),
    deleteUser: jest.fn(),
    addToWaitlist: jest.fn(),
    createUserFromWaitlist: jest.fn(),
    setUsers: jest.fn(),
  }),
}));

jest.mock("../../components/admin/ImageModelsSettings", () => () => <div />);
jest.mock("../../components/admin/DefaultPromptsSettings", () => () => <div />);
jest.mock("../../components/admin/BenchmarksTab", () => () => <div />);
jest.mock("../../components/admin/SubscriptionTypesTab", () => () => <div />);
jest.mock("../../components/admin/AdminCharts", () => ({
  UserGrowthChart: () => <div />,
  TaskGrowthChart: () => <div />,
  ExecutionTrendsChart: () => <div />,
  ExecutionStatusChart: () => <div />,
  UserTypeChart: () => <div />,
  AgentModeSessionGrowthChart: () => <div />,
  AgentModeSessionTypesChart: () => <div />,
}));

jest.mock("../../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
  CUSTOMER_FRONTEND_URL: "https://customer.test",
}));

jest.mock("react-router-dom", () => {
  const actual = jest.requireActual("react-router-dom");
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams("tab=chat-history"), jest.fn()],
  };
});

const SESSION = {
  sessionId: "sess-0001-aaaa-bbbb",
  userId: "user-1",
  title: "Weekly report",
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T11:00:00.000Z",
  messageCount: 4,
  satisfactionScore: { score: 4, reason: "ok", evaluatedMessageIndex: 1 },
};

const scoreCalls = () =>
  jest.mocked(axios.post).mock.calls.filter(([url]) => String(url).includes("/api/admin/chat-sessions/score"));

/** jsdom has no IntersectionObserver; the chat list's infinite scroll only needs it to exist. */
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("AdminDashboard chat history — legacy satisfaction behind a disclosure (ENG-2196)", () => {
  beforeAll(() => {
    Object.defineProperty(window, "IntersectionObserver", { writable: true, configurable: true, value: NoopIntersectionObserver });
  });

  beforeEach(() => {
    jest.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes("/api/admin/chat-sessions")) return { data: { sessions: [SESSION], nextCursor: null } };
      if (url.includes("/api/settings/scoring-judges")) return { data: { judges: [] } };
      return { data: [] };
    });
    jest.mocked(axios.post).mockResolvedValue({ data: { scores: {}, failed: [] } });
  });

  afterEach(() => jest.clearAllMocks());

  it("shows no Satisfaction column and scores nothing by default", async () => {
    render(
      <MemoryRouter initialEntries={["/admin?tab=chat-history"]}>
        <AdminDashboard />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Weekly report")).toBeInTheDocument();
    expect(screen.getByText("Show unvalidated legacy score")).toBeInTheDocument();
    expect(screen.queryByText("Satisfaction")).not.toBeInTheDocument();
    expect(screen.queryByText("Default: 4")).not.toBeInTheDocument();
    expect(scoreCalls()).toHaveLength(0);
  });

  it("shows the unvalidated column, its scores and the scoring trigger once disclosed", async () => {
    render(
      <MemoryRouter initialEntries={["/admin?tab=chat-history"]}>
        <AdminDashboard />
      </MemoryRouter>,
    );
    await screen.findByText("Weekly report");
    await userEvent.click(screen.getByLabelText("Show unvalidated legacy score"));
    expect(await screen.findByText("Satisfaction")).toBeInTheDocument();
    expect(screen.getByText("unvalidated")).toBeInTheDocument();
    expect(screen.getByText("Default: 4")).toBeInTheDocument();
    await waitFor(() => expect(scoreCalls()).toHaveLength(1));
    expect(scoreCalls()[0][1]).toEqual({ sessionIds: [SESSION.sessionId] });
  });
});
