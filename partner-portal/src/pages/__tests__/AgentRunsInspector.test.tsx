import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";
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
});
