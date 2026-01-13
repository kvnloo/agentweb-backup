import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import AdminDashboard from "../AdminDashboard";

const setSearchParamsMock = jest.fn();
let searchParams = new URLSearchParams("tab=users");
let mockAdminContext: any = {};

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
  useAuth: () => ({
    token: "test-token",
    user: { isAdmin: true },
  }),
}));

jest.mock("../../contexts/AdminContext", () => ({
  useAdmin: () => mockAdminContext,
}));

jest.mock("../../components/admin/ImageModelsSettings", () => () => <div data-testid="mock-image-models" />);
jest.mock("../../components/admin/DefaultPromptsSettings", () => () => <div data-testid="mock-default-prompts" />);
jest.mock("../../components/admin/BenchmarksTab", () => () => <div data-testid="mock-benchmarks" />);
jest.mock("../../components/admin/SubscriptionTypesTab", () => () => <div data-testid="mock-subscriptions" />);
jest.mock("../../components/admin/AdminCharts", () => ({
  UserGrowthChart: () => <div data-testid="mock-chart" />,
  TaskGrowthChart: () => <div data-testid="mock-chart" />,
  ExecutionTrendsChart: () => <div data-testid="mock-chart" />,
  ExecutionStatusChart: () => <div data-testid="mock-chart" />,
  UserTypeChart: () => <div data-testid="mock-chart" />,
  AgentModeSessionGrowthChart: () => <div data-testid="mock-chart" />,
  AgentModeSessionTypesChart: () => <div data-testid="mock-chart" />,
}));

jest.mock("../../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
  CUSTOMER_FRONTEND_URL: "https://customer.test",
}));

jest.mock("react-router-dom", () => {
  const actual = jest.requireActual("react-router-dom");
  return {
    ...actual,
    useSearchParams: () => [searchParams, setSearchParamsMock],
  };
});

const baseAdminContext = {
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
};

const getTableEmails = (table: HTMLElement) => {
  const rows = within(table).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
};

describe("AdminDashboard sorting", () => {
  beforeEach(() => {
    setSearchParamsMock.mockClear();
    (axios.get as jest.Mock).mockResolvedValue({ data: [] });
  });

  it("defaults Users table to Created desc and toggles on click", async () => {
    searchParams = new URLSearchParams("tab=users");
    mockAdminContext = {
      ...baseAdminContext,
      users: [
        {
          userId: "old",
          email: "old@example.com",
          isAdmin: false,
          isActive: true,
          createdAt: "2026-01-01T10:00:00.000Z",
        },
        {
          userId: "new",
          email: "new@example.com",
          isAdmin: false,
          isActive: true,
          createdAt: "2026-01-03T10:00:00.000Z",
        },
      ],
    };

    render(
      <MemoryRouter initialEntries={["/admin?tab=users"]}>
        <AdminDashboard />
      </MemoryRouter>
    );

    const table = await screen.findByRole("table");
    expect(getTableEmails(table)).toEqual(["new@example.com", "old@example.com"]);

    const user = userEvent.setup();
    await user.click(screen.getByText("Created"));
    expect(getTableEmails(table)).toEqual(["old@example.com", "new@example.com"]);
  });

  it("defaults Waitlist table to Joined desc", async () => {
    searchParams = new URLSearchParams("tab=waitlist");
    mockAdminContext = {
      ...baseAdminContext,
      waitlist: [
        {
          email: "older@example.com",
          status: "pending",
          joinedAt: "2026-01-02T10:00:00.000Z",
          createdAt: "2026-01-01T10:00:00.000Z",
        },
        {
          email: "newer@example.com",
          status: "pending",
          joinedAt: "2026-01-05T10:00:00.000Z",
          createdAt: "2026-01-04T10:00:00.000Z",
        },
      ],
    };

    render(
      <MemoryRouter initialEntries={["/admin?tab=waitlist"]}>
        <AdminDashboard />
      </MemoryRouter>
    );

    const table = await screen.findByRole("table");
    expect(getTableEmails(table)).toEqual(["newer@example.com", "older@example.com"]);
  });
});
