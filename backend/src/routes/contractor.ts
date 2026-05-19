import express from "express";
import jwt from "jsonwebtoken";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { userDb } from "../services/db";

const router = express.Router();
router.use(authenticateToken);

// GET /api/contractor/assigned-users
// Returns the list of customer users assigned to the logged-in contractor.
router.get("/assigned-users", async (req, res) => {
  try {
    const contractorReq = req as any;
    const contractorUser = contractorReq.user;

    if (!contractorUser.roles || !contractorUser.roles.includes("contractor")) {
      return res.status(403).json({ message: "Contractor access required" });
    }

    const fullUser = await userDb.getUserById(contractorUser.userId);
    if (!fullUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const assignedIds: string[] = (fullUser as any).contractorAssignedUserIds || [];

    const assignedUsers = await Promise.all(
      assignedIds.map(async (userId) => {
        const u = await userDb.getUserById(userId).catch(() => null);
        if (!u) return null;
        return {
          userId: u.userId,
          email: u.email,
          displayName: u.displayName,
          roles: u.roles,
        };
      })
    );

    res.json({ users: assignedUsers.filter(Boolean) });
  } catch (error) {
    console.error("Error fetching contractor assigned users:", error);
    res.status(500).json({ message: "Error fetching assigned users" });
  }
});

// POST /api/contractor/assigned-users/:userId/delegate-access
// Creates a delegate token for the contractor to access a specific user's customer portal.
router.post("/assigned-users/:userId/delegate-access", async (req, res) => {
  try {
    const contractorReq = req as any;
    const contractorUser = contractorReq.user;
    const { userId } = req.params;

    if (!contractorUser.roles || !contractorUser.roles.includes("contractor")) {
      return res.status(403).json({ message: "Contractor access required" });
    }

    // Verify this userId is in the contractor's assigned list
    const fullContractor = await userDb.getUserById(contractorUser.userId);
    if (!fullContractor) {
      return res.status(404).json({ message: "Contractor not found" });
    }

    const assignedIds: string[] = (fullContractor as any).contractorAssignedUserIds || [];
    if (!assignedIds.includes(userId)) {
      return res.status(403).json({ message: "This user is not assigned to you" });
    }

    const targetUser = await userDb.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!targetUser.roles || !targetUser.roles.includes("customer")) {
      return res.status(400).json({ message: "User does not have customer portal access" });
    }

    const delegatePayload = {
      userId: targetUser.userId,
      email: targetUser.email,
      roles: targetUser.roles,
      isAdmin: false,
      delegateAccess: {
        adminUserId: contractorUser.userId,
        adminEmail: contractorUser.email,
        targetUserId: targetUser.userId,
        targetEmail: targetUser.email,
      },
    };

    const delegateToken = jwt.sign(
      delegatePayload,
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "90d" }
    );

    const customerPortalUrl = process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174";

    res.json({
      delegateToken,
      customerPortalUrl: `${customerPortalUrl}/oauth-callback?token=${delegateToken}`,
    });
  } catch (error) {
    console.error("Error creating contractor delegate access:", error);
    res.status(500).json({ message: "Error creating delegate access" });
  }
});

// --- Admin-only endpoints for managing contractor assignments ---

// GET /api/contractor/contractors — list all contractor users with their assigned users
router.get("/contractors", isAdmin, async (req, res) => {
  try {
    const allUsers = await userDb.getAllUsers(false);
    const contractors = allUsers.filter(
      (u: any) => u.roles && u.roles.includes("contractor")
    );

    const result = await Promise.all(
      contractors.map(async (c: any) => {
        const assignedIds: string[] = c.contractorAssignedUserIds || [];
        const assignedUsers = await Promise.all(
          assignedIds.map(async (uid) => {
            const u = await userDb.getUserById(uid).catch(() => null);
            if (!u) return null;
            return { userId: u.userId, email: u.email, displayName: u.displayName };
          })
        );
        return {
          userId: c.userId,
          email: c.email,
          displayName: c.displayName,
          assignedUsers: assignedUsers.filter(Boolean),
        };
      })
    );

    res.json({ contractors: result });
  } catch (error) {
    console.error("Error fetching contractors:", error);
    res.status(500).json({ message: "Error fetching contractors" });
  }
});

// POST /api/contractor/contractors/:contractorId/assigned-users/:userId — assign a user to a contractor
router.post("/contractors/:contractorId/assigned-users/:userId", isAdmin, async (req, res) => {
  try {
    const { contractorId, userId } = req.params;

    const contractor = await userDb.getUserById(contractorId);
    if (!contractor || !contractor.roles?.includes("contractor")) {
      return res.status(404).json({ message: "Contractor not found" });
    }

    const targetUser = await userDb.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    const existing: string[] = (contractor as any).contractorAssignedUserIds || [];
    if (existing.includes(userId)) {
      return res.status(200).json({ message: "User already assigned" });
    }

    await userDb.updateUser(contractorId, {
      contractorAssignedUserIds: [...existing, userId],
    } as any);

    res.json({ message: "User assigned successfully" });
  } catch (error) {
    console.error("Error assigning user to contractor:", error);
    res.status(500).json({ message: "Error assigning user" });
  }
});

// DELETE /api/contractor/contractors/:contractorId/assigned-users/:userId — unassign a user
router.delete("/contractors/:contractorId/assigned-users/:userId", isAdmin, async (req, res) => {
  try {
    const { contractorId, userId } = req.params;

    const contractor = await userDb.getUserById(contractorId);
    if (!contractor || !contractor.roles?.includes("contractor")) {
      return res.status(404).json({ message: "Contractor not found" });
    }

    const existing: string[] = (contractor as any).contractorAssignedUserIds || [];
    await userDb.updateUser(contractorId, {
      contractorAssignedUserIds: existing.filter((id) => id !== userId),
    } as any);

    res.json({ message: "User unassigned successfully" });
  } catch (error) {
    console.error("Error unassigning user from contractor:", error);
    res.status(500).json({ message: "Error unassigning user" });
  }
});

export default router;
