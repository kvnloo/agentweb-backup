import express from "express";
import { AuthRequest } from "../types/express";
import { agencyService } from "../services/agencyService";

const router = express.Router();

/**
 * Separate router for client-side team routes.
 * Mounted at /api/teams to handle: DELETE /api/teams/:teamId/agencies/:agencyTeamId
 */
export const agencyTeamRoutes = express.Router();

/**
 * POST /api/agencies/:agencyTeamId/clients
 * Link a client team to an agency.
 * Body: { clientTeamId: string }
 * Auth: authenticated user (agency admin check to be added in Team P1 integration)
 */
router.post("/:agencyTeamId/clients", async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { agencyTeamId } = req.params;
    const { clientTeamId } = req.body;

    if (!clientTeamId) {
      return res.status(400).json({
        success: false,
        message: "clientTeamId is required in request body",
      });
    }

    const link = await agencyService.linkClient(
      agencyTeamId,
      clientTeamId,
      userId
    );

    return res.status(201).json({
      success: true,
      data: link,
    });
  } catch (error: any) {
    if (error.message?.includes("already linked")) {
      return res.status(409).json({
        success: false,
        message: error.message,
      });
    }
    if (error.message?.includes("Cannot link a team to itself")) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
    console.error("POST /api/agencies/:agencyTeamId/clients error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/agencies/:agencyTeamId/clients
 * List all clients managed by an agency.
 * Auth: authenticated user
 */
router.get("/:agencyTeamId/clients", async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { agencyTeamId } = req.params;
    const clients = await agencyService.getAgencyClients(agencyTeamId);

    return res.json({
      success: true,
      data: clients,
    });
  } catch (error) {
    console.error("GET /api/agencies/:agencyTeamId/clients error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * DELETE /api/agencies/:agencyTeamId/clients/:clientTeamId
 * Unlink a client from an agency (agency-side).
 * Auth: authenticated user (agency admin)
 */
router.delete(
  "/:agencyTeamId/clients/:clientTeamId",
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const { agencyTeamId, clientTeamId } = req.params;

      await agencyService.unlinkClient(agencyTeamId, clientTeamId);

      return res.json({
        success: true,
        message: `Client ${clientTeamId} unlinked from agency ${agencyTeamId}`,
      });
    } catch (error: any) {
      if (error.message?.includes("not found")) {
        return res.status(404).json({
          success: false,
          message: error.message,
        });
      }
      console.error(
        "DELETE /api/agencies/:agencyTeamId/clients/:clientTeamId error:",
        error
      );
      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * GET /api/agencies/:agencyTeamId/clients/:clientTeamId/check
 * Check if an agency has active access to a client.
 * Auth: authenticated user
 */
router.get(
  "/:agencyTeamId/clients/:clientTeamId/check",
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const { agencyTeamId, clientTeamId } = req.params;
      const isLinked = await agencyService.isAgencyForClient(
        agencyTeamId,
        clientTeamId
      );

      return res.json({
        success: true,
        data: { isLinked },
      });
    } catch (error) {
      console.error(
        "GET /api/agencies/:agencyTeamId/clients/:clientTeamId/check error:",
        error
      );
      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * DELETE /api/teams/:teamId/agencies/:agencyTeamId
 * Revoke agency access (client-side).
 * Auth: authenticated user (client team owner)
 */
agencyTeamRoutes.delete(
  "/:teamId/agencies/:agencyTeamId",
  async (req: AuthRequest, res) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const { teamId, agencyTeamId } = req.params;

      const result = await agencyService.revokeAgencyAccess(
        agencyTeamId,
        teamId
      );

      return res.json({
        success: true,
        message: `Agency ${agencyTeamId} access revoked by client ${teamId}`,
        data: result,
      });
    } catch (error: any) {
      if (error.message?.includes("not found")) {
        return res.status(404).json({
          success: false,
          message: error.message,
        });
      }
      console.error(
        "DELETE /api/teams/:teamId/agencies/:agencyTeamId error:",
        error
      );
      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export default router;
