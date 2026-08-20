import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import AdminDashboard from "../AdminDashboard";

const setUsers = jest.fn();

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
    users: [{
      userId: "credit-user",
      email: "credit-user@example.com",
      roles: ["customer"],
      isAdmin: false,
      isActive: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      subscriptionType: "Pro",
    }],
    waitlist: [],
    taskAnalytics: {},
    userAnalytics: {},
    agentModeAnalytics: {},
    loadUsers: jest.fn(),
    loadWaitlist: jest.fn(),
    loadAnalytics: jest.fn(),
    updateWaitlistStatus: jest.fn(),
    deleteWaitlistEntry: jest.fn(),
    deleteUser: jest.fn(),
    addToWaitlist: jest.fn(),
    createUserFromWaitlist: jest.fn(),
    setUsers,
    loading: false,
    error: "",
  }),
}));

jest.mock("../../components/admin/ImageModelsSettings", () => () => <div />);
jest.mock("../../components/admin/DefaultPromptsSettings", () => () => <div />);
jest.mock("../../components/admin/BenchmarksTab", () => () => <div />);
jest.mock("../../components/admin/SubscriptionTypesTab", () => () => <div />);
jest.mock("../../components/admin/AdminCharts", () => ({
  UserGrowthChart: () => <div />, TaskGrowthChart: () => <div />,
  ExecutionTrendsChart: () => <div />, ExecutionStatusChart: () => <div />,
  UserTypeChart: () => <div />, AgentModeSessionGrowthChart: () => <div />,
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
    useSearchParams: () => [new URLSearchParams("tab=users"), jest.fn()],
  };
});

async function openUsageCreditDialog() {
  const actor = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/admin?tab=users"]}>
      <AdminDashboard />
    </MemoryRouter>
  );
  const email = await screen.findByText("credit-user@example.com");
  const row = email.closest("tr");
  expect(row).not.toBeNull();
  await actor.click(within(row!).getAllByRole("button")[0]);
  await actor.click(await screen.findByRole("button", { name: "Grant one-time usage credit" }));
  return actor;
}

describe("AdminDashboard one-time usage credit default", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockResolvedValue({ data: [] });
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: { granted: true, month: "2026-08", totalAdminGrantedUsd: 500 },
    });
  });

  it("prefills the standard one-time provider-cost credit at $500", async () => {
    await openUsageCreditDialog();
    expect(screen.getByLabelText("Provider usage credit (USD)")).toHaveValue(500);
  });

  it("explains that $500 is the standard grant while leaving the field editable", async () => {
    await openUsageCreditDialog();
    expect(screen.getByText(/standard one-time grant is \$500/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Provider usage credit (USD)")).not.toHaveAttribute("readonly");
  });

  it("submits $500 when the admin accepts the default", async () => {
    const actor = await openUsageCreditDialog();
    fireEvent.change(screen.getByLabelText(/Reason \/ campaign/), {
      target: { value: "GROW-106 founder grant" },
    });
    await actor.click(screen.getByRole("button", { name: "Grant Credit" }));
    expect(axios.post).toHaveBeenCalledWith(
      "https://api.test/api/admin/users/credit-user/llm-usage-credit",
      expect.objectContaining({ amountUsd: 500, reason: "GROW-106 founder grant" }),
      expect.any(Object)
    );
  });

  it("still requires an audit reason before granting", async () => {
    await openUsageCreditDialog();
    expect(screen.getByRole("button", { name: "Grant Credit" })).toBeDisabled();
  });
});
