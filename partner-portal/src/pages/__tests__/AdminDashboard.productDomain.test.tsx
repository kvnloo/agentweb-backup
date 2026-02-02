import { render, screen, within } from "@testing-library/react";
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

  it("should display product domain in SEO/AEO column when configured", async () => {
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

    // Find the SEO/AEO column for the user
    const userRow = screen.getByText("user1@example.com").closest("tr");
    expect(userRow).toBeInTheDocument();

    // Check that product domain is displayed
    expect(within(userRow!).getByText(/Product:/)).toBeInTheDocument();
    expect(within(userRow!).getByText(/app\.example\.com/)).toBeInTheDocument();
  });

  it("should display 'No Product Domain' when not configured", async () => {
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
          seoDomains: ["example.com"],
          googleAnalyticsPropertyId: "123456789",
          // productDomain not set
        },
      ],
    };

    render(
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    );

    const userRow = screen.getByText("user2@example.com").closest("tr");
    expect(userRow).toBeInTheDocument();

    // Check that "No Product Domain" is displayed
    expect(within(userRow!).getByText("No Product Domain")).toBeInTheDocument();
  });

  it("should display all SEO/AEO fields together", async () => {
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

    const userRow = screen.getByText("user3@example.com").closest("tr");
    expect(userRow).toBeInTheDocument();

    // Check all fields are present
    expect(within(userRow!).getByText("domain1.com")).toBeInTheDocument();
    expect(within(userRow!).getByText("domain2.com")).toBeInTheDocument();
    expect(within(userRow!).getByText(/GA: 987654321/)).toBeInTheDocument();
    expect(within(userRow!).getByText(/Clarity: xyz789/)).toBeInTheDocument();
    expect(within(userRow!).getByText(/Product: app\.domain1\.com/)).toBeInTheDocument();
  });

  it("should handle users with only product domain and no other SEO fields", async () => {
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
          // No GA or Clarity
        },
      ],
    };

    render(
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    );

    const userRow = screen.getByText("user4@example.com").closest("tr");
    expect(userRow).toBeInTheDocument();

    // Check product domain is shown
    expect(within(userRow!).getByText(/Product: app\.example\.org/)).toBeInTheDocument();

    // Check that other fields show "No" messages
    expect(within(userRow!).getByText("No domains")).toBeInTheDocument();
    expect(within(userRow!).getByText("No GA ID")).toBeInTheDocument();
  });
});
