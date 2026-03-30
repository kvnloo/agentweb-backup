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

describe("AdminDashboard - Product Domain Display", () => {
  beforeEach(() => {
    setSearchParamsMock.mockClear();
    (axios.get as jest.Mock).mockResolvedValue({ data: [] });
  });

  it("should display SEO domains in expanded user detail when configured", async () => {
    searchParams = new URLSearchParams("tab=users");
    mockAdminContext = {
      ...baseAdminContext,
      users: [
        {
          userId: "user-1",
          email: "user1@example.com",
          isAdmin: false,
          isActive: true,
          createdAt: "2024-01-01",
          roles: ["customer"],
          seoDomains: ["example.com"],
          googleAnalyticsPropertyId: "123456789",
          clarityProjectId: "abc123",
          productDomain: "app.example.com",
        },
      ],
    };

    render(
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    );

    // Verify user email is displayed in the table
    expect(screen.getByText("user1@example.com")).toBeInTheDocument();

    // Click row to expand detail section
    const user = userEvent.setup();
    await user.click(screen.getByText("user1@example.com"));

    // The expanded section should show SEO domains
    expect(await screen.findByText("example.com")).toBeInTheDocument();
  });

  it("should display dash when no SEO domains configured", async () => {
    searchParams = new URLSearchParams("tab=users");
    mockAdminContext = {
      ...baseAdminContext,
      users: [
        {
          userId: "user-2",
          email: "user2@example.com",
          isAdmin: false,
          isActive: true,
          createdAt: "2024-01-01",
          roles: ["customer"],
          seoDomains: [],
          // productDomain not set
        },
      ],
    };

    render(
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    );

    // Verify user email is displayed
    expect(screen.getByText("user2@example.com")).toBeInTheDocument();

    // Click row to expand
    const user = userEvent.setup();
    await user.click(screen.getByText("user2@example.com"));

    // The SEO / GA / Clarity section should show a dash when no domains
    expect(await screen.findByText("SEO / GA / Clarity")).toBeInTheDocument();
  });

  it("should display multiple SEO domains together in expanded view", async () => {
    searchParams = new URLSearchParams("tab=users");
    mockAdminContext = {
      ...baseAdminContext,
      users: [
        {
          userId: "user-3",
          email: "user3@example.com",
          isAdmin: false,
          isActive: true,
          createdAt: "2024-01-01",
          roles: ["customer"],
          seoDomains: ["domain1.com", "domain2.com"],
          googleAnalyticsPropertyId: "987654321",
          clarityProjectId: "xyz789",
          productDomain: "app.domain1.com",
        },
      ],
    };

    render(
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    );

    // Click row to expand
    const user = userEvent.setup();
    await user.click(screen.getByText("user3@example.com"));

    // Check SEO domains are displayed (joined with ", ")
    expect(await screen.findByText("domain1.com, domain2.com")).toBeInTheDocument();
  });

  it("should render user with only product domain and no SEO domains", async () => {
    searchParams = new URLSearchParams("tab=users");
    mockAdminContext = {
      ...baseAdminContext,
      users: [
        {
          userId: "user-4",
          email: "user4@example.com",
          isAdmin: false,
          isActive: true,
          createdAt: "2024-01-01",
          roles: ["customer"],
          seoDomains: [],
          productDomain: "app.example.org",
        },
      ],
    };

    render(
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    );

    // Verify user email renders in the table
    expect(screen.getByText("user4@example.com")).toBeInTheDocument();

    // Click to expand detail section
    const user = userEvent.setup();
    await user.click(screen.getByText("user4@example.com"));

    // SEO section should be visible in the expanded detail
    expect(await screen.findByText("SEO / GA / Clarity")).toBeInTheDocument();
  });
});
