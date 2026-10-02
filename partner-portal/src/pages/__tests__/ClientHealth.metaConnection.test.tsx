import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axios from "axios";
import ClientHealth from "../ClientHealth";

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

describe("ClientHealth Meta connection health", () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
    mockedAxios.get.mockImplementation(async (url) => {
      if (url === "https://api.test/api/client-health") {
        return {
          data: {
            success: true,
            clients: [{
              userId: "client-1",
              email: "client@example.com",
              displayName: "Client",
              roles: [],
              has_ads: true,
              ad_connection: "connected",
              ad_connection_all_platforms: "connected",
              has_lander: true,
              has_crm: true,
              last_activity: null,
            }],
          },
        };
      }
      if (url === "https://api.test/api/client-health/client%40example.com") {
        return {
          data: {
            success: true,
            health: {
              client: { userId: "client-1", email: "client@example.com", displayName: "Client" },
              status: "needs-attention",
              status_reasons: [],
              ads_layer: {
                connected: true,
                connection: "connected",
                connection_all_platforms: "connected",
                active_campaigns: 0,
                campaigns_complete: true,
                meta_connection_health: {
                  permissions: "declined",
                  declined_permissions: ["pages_read_engagement"],
                  page_access: "missing",
                  page_count: 0,
                  selected_event: "unknown",
                  reconnect_required: true,
                  reconnect_instructions: "Click Edit access, select all current and future Pages, approve all permissions.",
                },
              },
              lander_layer: { has_lander: true, platforms: ["landing_page"] },
              lead_quality_layer: { has_crm: true, platforms: ["landing_page_lead_capture"] },
              creative_variety: {
                distinct_creatives: 0,
                cannibalization_warning: false,
                fatigue_warning: false,
              },
            },
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it("renders declined permission, missing Page access, unknown selected event, and reconnect guidance", async () => {
    render(<ClientHealth />);

    await userEvent.click(await screen.findByText("Client"));

    expect(await screen.findByText("Meta connection health")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByText("Declined: pages_read_engagement")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Click Edit access, select all current and future Pages, approve all permissions.")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.test/api/client-health/client%40example.com",
        { headers: { Authorization: "Bearer test-token" } },
      );
    });
  });
});
