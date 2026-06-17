import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import AgentRunsInspector from "../AgentRunsInspector";

jest.mock("axios");

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { isAdmin: true },
  }),
}));

jest.mock("../../config", () => ({
  buildApiUrl: (path: string) => `https://api.test${path}`,
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("AgentRunsInspector", () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.get.mockResolvedValue({
      data: {
        runs: [],
        scannedEvents: 0,
        count: 0,
        filters: { limit: 200 },
      },
    });
  });

  it("loads runs filtered by the sessionId query parameter", async () => {
    render(
      <MemoryRouter initialEntries={["/agent-runs?sessionId=session-123"]}>
        <AgentRunsInspector />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.test/api/admin/agent-runs?limit=200&sessionId=session-123",
        { headers: { Authorization: "Bearer test-token" } }
      );
    });
  });

  it("renders Tool Gateway repair and schema reject counts on decisions", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        runs: [
          {
            runId: "run-1",
            sessionId: "session-1",
            status: "completed",
            toolCalls: 2,
            failedToolCalls: 1,
            flags: [],
            decisions: [
              {
                ts: "2026-06-17T01:00:00.000Z",
                iteration: 1,
                toolNames: ["read_file_content", "wait_seconds"],
                argsRepairedCount: 1,
                schemaErrorCount: 1,
              },
            ],
            outcomes: [],
            events: [],
          },
        ],
        scannedEvents: 3,
        count: 1,
        filters: { limit: 200 },
      },
    });

    render(
      <MemoryRouter initialEntries={["/agent-runs"]}>
        <AgentRunsInspector />
      </MemoryRouter>
    );

    expect(await screen.findByText("1 arg repair(s)")).toBeInTheDocument();
    expect(screen.getByText("1 schema reject(s)")).toBeInTheDocument();
  });

  it("renders tool failure types in the timeline", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        runs: [
          {
            runId: "run-2",
            sessionId: "session-2",
            status: "completed",
            toolCalls: 1,
            failedToolCalls: 1,
            flags: [],
            decisions: [],
            outcomes: [
              {
                ts: "2026-06-17T01:00:01.000Z",
                eventType: "agent_tool_failed",
                toolName: "generate_image",
                errorClass: "repeated_failure",
                errorMessage: "Tool reached its retry budget.",
                failureType: "bug",
              },
            ],
            events: [],
          },
        ],
        scannedEvents: 3,
        count: 1,
        filters: { limit: 200 },
      },
    });

    render(
      <MemoryRouter initialEntries={["/agent-runs"]}>
        <AgentRunsInspector />
      </MemoryRouter>
    );

    expect(await screen.findByText("generate_image")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
  });
});
