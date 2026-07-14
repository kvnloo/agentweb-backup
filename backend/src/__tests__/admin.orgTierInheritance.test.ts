import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import adminRoutes from "../routes/admin";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Decode the real JWT so the isAdmin middleware genuinely gates the route.
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ message: "Unauthorized" });
    }
  },
}));

jest.mock("../services/db", () => ({
  userDb: {
    getAllUsers: jest.fn(),
    getUserById: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  crmDb: {},
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
    setSetting: jest.fn().mockResolvedValue(undefined),
  },
}));

import { orgDb, userDb } from "../services/db";
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const adminToken = jwt.sign(
  { userId: "admin-1", email: "admin@example.com", isAdmin: true },
  JWT_SECRET
);

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("GET /api/admin/users — org members inherit the owner's subscription tier (ENG-237)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("member on a Free own-record inherits the paid owner's tier for display", async () => {
    mockUserDb.getAllUsers.mockResolvedValue([
      { userId: "u-owner", email: "o@x.com", orgId: "org-1", orgRole: "owner", subscriptionType: "Pro" },
      { userId: "u-member", email: "m@x.com", orgId: "org-1", orgRole: "member", subscriptionType: "Free" },
    ] as any);
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", name: "MenuSifu", ownerUserId: "u-owner" } as any);

    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const owner = res.body.find((u: any) => u.userId === "u-owner");
    const member = res.body.find((u: any) => u.userId === "u-member");
    expect(owner.subscriptionType).toBe("Pro");
    // The member must show the org's effective tier, not the stale "Free".
    expect(member.subscriptionType).toBe("Pro");
  });

  test("member with no subscriptionType field still inherits the owner's paid tier", async () => {
    mockUserDb.getAllUsers.mockResolvedValue([
      { userId: "u-owner", email: "o@x.com", orgId: "org-1", orgRole: "owner", subscriptionType: "Pro" },
      { userId: "u-member", email: "m@x.com", orgId: "org-1", orgRole: "member" },
    ] as any);
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", name: "MenuSifu", ownerUserId: "u-owner" } as any);

    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    const member = res.body.find((u: any) => u.userId === "u-member");
    expect(member.subscriptionType).toBe("Pro");
  });

  test("member is NOT downgraded when the org owner is on Free", async () => {
    mockUserDb.getAllUsers.mockResolvedValue([
      { userId: "u-owner", email: "o@x.com", orgId: "org-1", orgRole: "owner", subscriptionType: "Free" },
      { userId: "u-member", email: "m@x.com", orgId: "org-1", orgRole: "member", subscriptionType: "Basic" },
    ] as any);
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", name: "Acme", ownerUserId: "u-owner" } as any);

    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    // Owner is not on a paid tier → do not clobber the member's own value.
    const member = res.body.find((u: any) => u.userId === "u-member");
    expect(member.subscriptionType).toBe("Basic");
  });

  test("the org owner's own tier is never overridden", async () => {
    mockUserDb.getAllUsers.mockResolvedValue([
      { userId: "u-owner", email: "o@x.com", orgId: "org-1", orgRole: "owner", subscriptionType: "Pro" },
    ] as any);
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", name: "MenuSifu", ownerUserId: "u-owner" } as any);

    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    const owner = res.body.find((u: any) => u.userId === "u-owner");
    expect(owner.subscriptionType).toBe("Pro");
    expect(owner.isOrgOwner).toBe(true);
  });

  test("solo users (no org) keep their own tier untouched", async () => {
    mockUserDb.getAllUsers.mockResolvedValue([
      { userId: "u-solo", email: "s@x.com", subscriptionType: "Free" },
    ] as any);

    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    const solo = res.body.find((u: any) => u.userId === "u-solo");
    expect(solo.subscriptionType).toBe("Free");
  });

  test("member inherits owner's paid tier even when the owner is filtered out of the list", async () => {
    // Owner not present in getAllUsers (e.g. bot-like filter) → fall back to a direct fetch.
    mockUserDb.getAllUsers.mockResolvedValue([
      { userId: "u-member", email: "m@x.com", orgId: "org-1", orgRole: "member", subscriptionType: "Free" },
    ] as any);
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", name: "MenuSifu", ownerUserId: "u-owner" } as any);
    mockUserDb.getUserById.mockResolvedValue({ userId: "u-owner", subscriptionType: "Pro" } as any);

    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`);

    const member = res.body.find((u: any) => u.userId === "u-member");
    expect(member.subscriptionType).toBe("Pro");
    expect(mockUserDb.getUserById).toHaveBeenCalledWith("u-owner");
  });
});
