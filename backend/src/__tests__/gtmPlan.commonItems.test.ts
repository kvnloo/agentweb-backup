import request from "supertest";
import express from "express";

// Mock aws-sdk before importing routes
const mockGet = jest.fn();
const mockUpdate = jest.fn();

jest.mock("aws-sdk", () => {
  const mockDocClient = {
    query: jest.fn(),
    get: mockGet,
    put: jest.fn(),
    update: mockUpdate,
    delete: jest.fn(),
    scan: jest.fn(),
  };
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: 'https://mock-s3-url.com/file', Key: 'mock-key' }) }),
      getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      putObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
    })),
    config: {
      update: jest.fn(),
    },
  };
});

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      userId: "user-123",
      email: "user@example.com",
      isAdmin: false,
    };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock("../services/gtmPlanNotificationService", () => ({
  sendGTMPlanUpdateNotifications: jest.fn(),
  sendPhaseStatusReport: jest.fn(),
  sendPlanStatusReport: jest.fn(),
}));

import gtmPlanRoutes from "../routes/gtmPlan";
import { settingsService } from "../services/settingsService";

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use("/api/gtm-plan", gtmPlanRoutes);

describe("GTM Plan Common Items routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/gtm-plan/common-items", () => {
    it("returns empty array when no setting exists", async () => {
      mockSettingsService.getSetting.mockResolvedValue(null as any);

      const res = await request(app)
        .get("/api/gtm-plan/common-items")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(mockSettingsService.getSetting).toHaveBeenCalledWith("gtm_common_items");
      expect(res.body).toEqual({ success: true, data: [] });
    });

    it("returns parsed categories", async () => {
      const categories = [
        {
          id: "cat-1",
          name: "Content Marketing",
          sortOrder: 1,
          items: [
            { id: "ci-1", title: "Create blog strategy", sortOrder: 1 },
          ],
        },
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: "gtm_common_items",
        settingValue: JSON.stringify(categories),
        updatedAt: "2024-01-01T00:00:00Z",
        updatedBy: "admin@example.com",
      });

      const res = await request(app)
        .get("/api/gtm-plan/common-items")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(categories);
    });
  });

  describe("POST /api/gtm-plan/:planId/add-common-items", () => {
    const mockPlan = {
      planId: "plan-123",
      userId: "user-123",
      title: "Test Plan",
      status: "in_progress",
      phases: [
        {
          id: "phase-1",
          title: "Phase 1",
          status: "in_progress",
          workItems: [],
        },
      ],
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    it("adds items to an existing phase", async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const updatedPlan = {
        ...mockPlan,
        phases: [
          {
            ...mockPlan.phases[0],
            workItems: [
              { id: expect.any(String), title: "Item A", description: null, dri: null, status: "pending", notes: null, dueDate: null },
            ],
            status: "in_progress",
          },
        ],
      };
      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: updatedPlan }),
      });

      const res = await request(app)
        .post("/api/gtm-plan/plan-123/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({
          items: [{ title: "Item A", description: "Desc A" }],
          targetPhaseId: "phase-1",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalled();
      const updateCall = mockUpdate.mock.calls[0][0];
      expect(updateCall.Key).toEqual({ planId: "plan-123" });
    });

    it("creates a new phase with items", async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      mockUpdate.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: { ...mockPlan, phases: [...mockPlan.phases, { id: "phase-new", title: "New Phase", workItems: [] }] },
        }),
      });

      const res = await request(app)
        .post("/api/gtm-plan/plan-123/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({
          items: [
            { title: "Item X" },
            { title: "Item Y", description: "Description Y" },
          ],
          newPhaseName: "New Phase",
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalled();
      // Verify the phases array passed to update includes the new phase
      const updateCall = mockUpdate.mock.calls[0][0];
      const phasesValue = updateCall.ExpressionAttributeValues[":phases"];
      expect(phasesValue).toHaveLength(2); // original + new
      expect(phasesValue[1].title).toBe("New Phase");
      expect(phasesValue[1].workItems).toHaveLength(2);
      expect(phasesValue[1].workItems[0].title).toBe("Item X");
      expect(phasesValue[1].workItems[1].title).toBe("Item Y");
    });

    it("rejects empty items array", async () => {
      const res = await request(app)
        .post("/api/gtm-plan/plan-123/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ items: [], targetPhaseId: "phase-1" })
        .expect(400);

      expect(res.body.error).toBe("items must be a non-empty array");
    });

    it("rejects missing destination", async () => {
      const res = await request(app)
        .post("/api/gtm-plan/plan-123/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ items: [{ title: "Item A" }] })
        .expect(400);

      expect(res.body.error).toBe("Either targetPhaseId or newPhaseName is required");
    });

    it("rejects item without title", async () => {
      const res = await request(app)
        .post("/api/gtm-plan/plan-123/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ items: [{ title: "" }], targetPhaseId: "phase-1" })
        .expect(400);

      expect(res.body.error).toBe("Each item must have a title");
    });

    it("returns 404 when plan not found", async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: null }),
      });

      const res = await request(app)
        .post("/api/gtm-plan/plan-999/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ items: [{ title: "Item A" }], targetPhaseId: "phase-1" })
        .expect(404);

      expect(res.body.error).toBe("GTM Plan not found");
    });

    it("returns 403 when plan belongs to different user", async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { ...mockPlan, userId: "other-user" },
        }),
      });

      const res = await request(app)
        .post("/api/gtm-plan/plan-123/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ items: [{ title: "Item A" }], targetPhaseId: "phase-1" })
        .expect(403);

      expect(res.body.error).toBe("Access denied");
    });

    it("returns 404 when target phase not found", async () => {
      mockGet.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockPlan }),
      });

      const res = await request(app)
        .post("/api/gtm-plan/plan-123/add-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ items: [{ title: "Item A" }], targetPhaseId: "nonexistent-phase" })
        .expect(404);

      expect(res.body.error).toBe("Target phase not found");
    });
  });
});
