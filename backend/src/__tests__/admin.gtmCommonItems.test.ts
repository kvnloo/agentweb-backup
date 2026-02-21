import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { settingsService } from "../services/settingsService";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      userId: "admin-user-1",
      email: "admin@example.com",
      isAdmin: true,
    };
    next();
  },
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock("../services/db", () => ({
  userDb: { getAllUsers: jest.fn() },
  taskDb: {},
  subscriberDb: {},
  crmDb: { getLeadListById: jest.fn() },
}));

jest.mock("../services/waitlistDb", () => ({
  waitlistDb: { list: jest.fn() },
}));

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("Admin GTM Common Items routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/admin/gtm-common-items", () => {
    it("returns empty array when no setting exists", async () => {
      mockSettingsService.getSetting.mockResolvedValue(null as any);

      const res = await request(app)
        .get("/api/admin/gtm-common-items")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(mockSettingsService.getSetting).toHaveBeenCalledWith("gtm_common_items");
      expect(res.body).toEqual({ success: true, data: [] });
    });

    it("returns parsed categories when setting exists", async () => {
      const categories = [
        {
          id: "cat-1",
          name: "Paid Ads",
          sortOrder: 1,
          items: [
            { id: "ci-1", title: "Set up Google Ads", sortOrder: 1 },
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
        .get("/api/admin/gtm-common-items")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(categories);
    });
  });

  describe("PUT /api/admin/gtm-common-items", () => {
    it("saves categories successfully", async () => {
      const categories = [
        {
          id: "cat-1",
          name: "SEO",
          sortOrder: 1,
          items: [
            { id: "ci-1", title: "Keyword research", sortOrder: 1 },
          ],
        },
      ];
      mockSettingsService.setSetting.mockResolvedValue({} as any);

      const res = await request(app)
        .put("/api/admin/gtm-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ categories })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(categories);
      expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
        "gtm_common_items",
        JSON.stringify(categories),
        "GTM common work items by category",
        "admin@example.com"
      );
    });

    it("rejects non-array categories", async () => {
      const res = await request(app)
        .put("/api/admin/gtm-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ categories: "not-an-array" })
        .expect(400);

      expect(res.body.error).toBe("categories must be an array");
    });

    it("rejects category without name", async () => {
      const res = await request(app)
        .put("/api/admin/gtm-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ categories: [{ id: "cat-1", name: "", sortOrder: 1, items: [] }] })
        .expect(400);

      expect(res.body.error).toBe("Each category must have a name");
    });

    it("rejects item without title", async () => {
      const res = await request(app)
        .put("/api/admin/gtm-common-items")
        .set("Authorization", "Bearer test-token")
        .send({
          categories: [
            {
              id: "cat-1",
              name: "SEO",
              sortOrder: 1,
              items: [{ id: "ci-1", title: "", sortOrder: 1 }],
            },
          ],
        })
        .expect(400);

      expect(res.body.error).toBe("Each item must have a title");
    });

    it("saves empty categories array", async () => {
      mockSettingsService.setSetting.mockResolvedValue({} as any);

      const res = await request(app)
        .put("/api/admin/gtm-common-items")
        .set("Authorization", "Bearer test-token")
        .send({ categories: [] })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });
});
