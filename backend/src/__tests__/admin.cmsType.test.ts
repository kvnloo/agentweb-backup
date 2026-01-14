import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { userDb } from "../services/db";

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("Admin CMS Type endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should update CMS Type to Basehub", async () => {
    const userId = "user-1";
    const mockUser = {
      userId,
      email: "user@example.com",
      cmsType: undefined,
    };

    const updatedUser = {
      ...mockUser,
      cmsType: "Basehub" as const,
    };

    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockUserDb.updateUser.mockResolvedValue(updatedUser as any);

    const res = await request(app)
      .put(`/api/admin/users/${userId}/cms-type`)
      .send({ cmsType: "Basehub" })
      .expect(200);

    expect(mockUserDb.getUserById).toHaveBeenCalledWith(userId);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
      cmsType: "Basehub",
    });
    expect(res.body.cmsType).toBe("Basehub");
  });

  it("should update CMS Type to Webflow", async () => {
    const userId = "user-1";
    const mockUser = {
      userId,
      email: "user@example.com",
      cmsType: "Basehub" as const,
    };

    const updatedUser = {
      ...mockUser,
      cmsType: "Webflow" as const,
    };

    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockUserDb.updateUser.mockResolvedValue(updatedUser as any);

    const res = await request(app)
      .put(`/api/admin/users/${userId}/cms-type`)
      .send({ cmsType: "Webflow" })
      .expect(200);

    expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
      cmsType: "Webflow",
    });
    expect(res.body.cmsType).toBe("Webflow");
  });

  it("should clear CMS Type when null is sent (None option)", async () => {
    const userId = "user-1";
    const mockUser = {
      userId,
      email: "user@example.com",
      cmsType: "Basehub" as const,
    };

    const updatedUser = {
      ...mockUser,
      cmsType: null,
    };

    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockUserDb.updateUser.mockResolvedValue(updatedUser as any);

    const res = await request(app)
      .put(`/api/admin/users/${userId}/cms-type`)
      .send({ cmsType: null })
      .expect(200);

    // Verify that null is passed to updateUser (not undefined)
    expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
      cmsType: null,
    });
    expect(res.body.cmsType).toBeNull();
  });

  it("should clear CMS Type when empty string is sent", async () => {
    const userId = "user-1";
    const mockUser = {
      userId,
      email: "user@example.com",
      cmsType: "Webflow" as const,
    };

    const updatedUser = {
      ...mockUser,
      cmsType: null,
    };

    mockUserDb.getUserById.mockResolvedValue(mockUser as any);
    mockUserDb.updateUser.mockResolvedValue(updatedUser as any);

    const res = await request(app)
      .put(`/api/admin/users/${userId}/cms-type`)
      .send({ cmsType: "" })
      .expect(200);

    // Verify that empty string is converted to null
    expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
      cmsType: null,
    });
    expect(res.body.cmsType).toBeNull();
  });

  it("should return 400 for invalid CMS Type", async () => {
    const userId = "user-1";
    const mockUser = {
      userId,
      email: "user@example.com",
    };

    mockUserDb.getUserById.mockResolvedValue(mockUser as any);

    const res = await request(app)
      .put(`/api/admin/users/${userId}/cms-type`)
      .send({ cmsType: "InvalidType" })
      .expect(400);

    expect(res.body.message).toBe(
      "cmsType must be either 'Basehub' or 'Webflow'"
    );
    expect(mockUserDb.updateUser).not.toHaveBeenCalled();
  });

  it("should return 404 when user does not exist", async () => {
    const userId = "non-existent-user";

    mockUserDb.getUserById.mockResolvedValue(null);

    const res = await request(app)
      .put(`/api/admin/users/${userId}/cms-type`)
      .send({ cmsType: "Basehub" })
      .expect(404);

    expect(res.body.message).toBe("User not found");
    expect(mockUserDb.updateUser).not.toHaveBeenCalled();
  });
});
