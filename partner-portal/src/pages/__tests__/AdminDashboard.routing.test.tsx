import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import AdminDashboard from "../AdminDashboard";

const setSearchParamsMock = jest.fn();

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { isAdmin: true },
  }),
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
    updateWaitlistSupportNote: jest.fn(),
    deleteWaitlistEntry: jest.fn(),
    deleteUser: jest.fn(),
    addToWaitlist: jest.fn(),
    createUserFromWaitlist: jest.fn(),
    setUsers: jest.fn(),
  }),
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
    useSearchParams: () => [new URLSearchParams(""), setSearchParamsMock],
  };
});

describe("AdminDashboard routing", () => {
  beforeEach(() => {
    setSearchParamsMock.mockClear();
  });

  it("redirects /admin to admin?tab=users", async () => {
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminDashboard />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(setSearchParamsMock).toHaveBeenCalledWith({ tab: "users" });
    });
  });
});
