import { render, screen, waitFor } from "@testing-library/react";
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
jest.mock("../../components/admin/McpServersTab", () => () => <div data-testid="mock-mcp-servers" />);
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
  users: [
    {
      userId: "u1",
      email: "user1@example.com",
      isAdmin: false,
      isActive: true,
      createdAt: "2026-02-10T00:00:00.000Z",
      roles: ["customer"],
    },
  ],
  waitlist: [
    {
      email: "wait1@example.com",
      status: "pending",
      joinedAt: "2026-02-10T00:00:00.000Z",
      createdAt: "2026-02-10T00:00:00.000Z",
    },
  ],
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

describe("AdminDashboard CRM sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminContext = { ...baseAdminContext };
    (axios.get as jest.Mock).mockImplementation((url: string) => {
      if (url.includes("/api/admin/subscription-types")) {
        return Promise.resolve({ data: [{ name: "Basic" }] });
      }
      if (url.includes("/api/admin/crm-sync/users")) {
        return Promise.resolve({ data: { source: "users", listId: "users-list", lastSyncAt: null } });
      }
      if (url.includes("/api/admin/crm-sync/waitlist")) {
        return Promise.resolve({ data: { source: "waitlist", listId: "waitlist-list", lastSyncAt: null } });
      }
      return Promise.resolve({ data: [] });
    });
    (axios.put as jest.Mock).mockResolvedValue({ data: { success: true } });
    (axios.post as jest.Mock).mockResolvedValue({
      data: { success: true, message: "Synced", lastSyncAt: "2026-02-10T12:00:00.000Z" },
    });
  });

  it("opens users CRM sync dialog and saves config then starts sync", async () => {
    searchParams = new URLSearchParams("tab=users");
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/admin?tab=users"]}>
        <AdminDashboard />
      </MemoryRouter>
    );

    await user.click(await screen.findByRole("button", { name: "Sync to CRM" }));
    expect(await screen.findByText("Sync Users to CRM")).toBeInTheDocument();

    const leadListInput = screen.getByLabelText("Lead List ID");
    await user.clear(leadListInput);
    await user.type(leadListInput, "new-users-list");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(axios.put).toHaveBeenCalledWith(
      "https://api.test/api/admin/crm-sync/users",
      { listId: "new-users-list" },
      { headers: { Authorization: "Bearer test-token" } }
    );

    await user.click(screen.getByRole("button", { name: "Start Syncing" }));
    expect(axios.post).toHaveBeenCalledWith(
      "https://api.test/api/admin/crm-sync/users/start",
      { forceFullSync: false },
      { headers: { Authorization: "Bearer test-token" } }
    );
  });

  it("supports force full sync from waitlist tab", async () => {
    searchParams = new URLSearchParams("tab=waitlist");
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/admin?tab=waitlist"]}>
        <AdminDashboard />
      </MemoryRouter>
    );

    await user.click(await screen.findByRole("button", { name: "Sync to CRM" }));
    expect(await screen.findByText("Sync Waitlist to CRM")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Force full sync"));
    await user.click(screen.getByRole("button", { name: "Start Syncing" }));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        "https://api.test/api/admin/crm-sync/waitlist/start",
        { forceFullSync: true },
        { headers: { Authorization: "Bearer test-token" } }
      );
    });
  });
});
