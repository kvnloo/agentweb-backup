import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import axios from "axios";
import EmmaMcpUsageTab from "../EmmaMcpUsageTab";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../../../contexts/AuthContext", () => ({
  useAuth: () => ({ token: "fake-token" }),
}));

jest.mock("../../../config", () => ({
  buildApiUrl: (path: string) => `http://localhost:3000${path}`,
}));

describe("EmmaMcpUsageTab", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("loads and renders Emma MCP funnel metrics", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        start: "2026-07-01",
        end: "2026-07-10",
        summary: {
          oauthStarts: 3,
          authorizedUsers: 2,
          tokenIssuedUsers: 2,
          connectionAttempts: 5,
          connectedUsers: 2,
          toolCalls: 9,
          firstUseUsers: 1,
          firstUseRate: 0.5,
        },
        clients: [
          {
            clientType: "claude_code",
            oauthStarts: 3,
            authorizedUsers: 2,
            tokenIssuedUsers: 2,
            connectionAttempts: 5,
            connectedUsers: 2,
            toolCalls: 9,
            firstUseUsers: 1,
            clientNames: ["Claude Code"],
          },
        ],
        users: [
          {
            userId: "user-1",
            email: "founder@example.com",
            companyName: "Acme",
            oauthAuthorizedAt: "2026-07-09T20:00:00.000Z",
            tokenIssuedAt: "2026-07-09T20:01:00.000Z",
            connectionAttempts: 4,
            firstConnectedAt: "2026-07-09T20:02:00.000Z",
            toolCalls: 9,
            lastUsedAt: "2026-07-09T20:05:00.000Z",
            lastToolName: "create_gtm_plan",
            firstUsedAt: "2026-07-09T20:03:00.000Z",
            firstToolName: "install_skills",
            authMethods: ["oauth"],
            apiKeyIds: [],
            clientIds: ["client-1"],
            clientNames: ["Claude Code"],
            clientTypes: ["claude_code"],
          },
        ],
      },
    });

    render(<EmmaMcpUsageTab />);

    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("founder@example.com")).toBeInTheDocument());
    expect(screen.getAllByText("OAuth starts")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Authorized users")[0]).toBeInTheDocument();
    expect(screen.getByText("Token users")).toBeInTheDocument();
    expect(screen.getAllByText("Tool calls")[0]).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getAllByText("Claude Code")[0]).toBeInTheDocument();
    expect(screen.getByText("create_gtm_plan")).toBeInTheDocument();
    expect(screen.getAllByText("claude mcp add --scope user --transport http emma https://api.agentweb.pro/mcp")[0]).toBeInTheDocument();
    expect(screen.getByText("codex mcp login emma")).toBeInTheDocument();

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:3000/api/admin/mcp-usage?start="),
      { headers: { Authorization: "Bearer fake-token" } }
    );
  });

  it("renders an empty state for date ranges with no MCP usage", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        start: "2026-07-01",
        end: "2026-07-10",
        summary: {
          oauthStarts: 0,
          authorizedUsers: 0,
          tokenIssuedUsers: 0,
          connectionAttempts: 0,
          connectedUsers: 0,
          toolCalls: 0,
          firstUseUsers: 0,
          firstUseRate: 0,
        },
        clients: [],
        users: [],
      },
    });

    render(<EmmaMcpUsageTab />);

    await waitFor(() => {
      expect(screen.getByText("No Emma MCP usage in this date range.")).toBeInTheDocument();
    });
  });

  it("surfaces load failures", async () => {
    mockedAxios.get.mockRejectedValueOnce({
      response: { data: { message: "No report for you" } },
    });

    render(<EmmaMcpUsageTab />);

    await waitFor(() => {
      expect(screen.getByText("No report for you")).toBeInTheDocument();
    });
  });
});
