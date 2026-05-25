import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

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
    getUserById: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock("../services/analyticsConfigResolver", () => ({
  resolveAnalyticsConfig: jest.fn().mockResolvedValue({ properties: [], source: "self" }),
  resolveConfigTarget: jest.fn(),
}));

import authRoutes from "../routes/auth";
import { userDb } from "../services/db";
import { resolveConfigTarget } from "../services/analyticsConfigResolver";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockResolveTarget = resolveConfigTarget as jest.Mock;

const userToken = jwt.sign(
  { userId: "u-1", email: "u@x.com" },
  JWT_SECRET
);

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

describe("GET /api/auth/me canEditAnalyticsConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Non-customer role avoids subscription-service dynamic imports.
    mockUserDb.getUserById.mockResolvedValue({
      userId: "u-1",
      email: "u@x.com",
      roles: ["partner"],
    } as any);
  });

  test("editor → canEditAnalyticsConfig true", async () => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.canEditAnalyticsConfig).toBe(true);
  });

  test("plain member → canEditAnalyticsConfig false", async () => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.canEditAnalyticsConfig).toBe(false);
  });
});
