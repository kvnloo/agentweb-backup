import express, { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { assessClientHealth, listAllClients } from "../services/clientHealthService";

const router = express.Router();

/**
 * GET /api/client-health
 * List all clients with quick health indicators.
 * Admin-only (enforced by middleware + service layer).
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Pass isAdmin from req.user — for _svc (mcpFetch) tokens issued during delegated sessions,
    // auth middleware already elevates isAdmin to true so the service-level DB check can be skipped.
    const result = await listAllClients(userId, authReq.user.isAdmin);
    return res.json(result);
  } catch (error) {
    console.error("GET /api/client-health error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/client-health/:clientEmail
 * Get detailed health assessment for a specific client.
 * Admin-only (enforced by middleware + service layer).
 */
router.get("/:clientEmail", async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const clientEmail = decodeURIComponent(req.params.clientEmail);
    const result = await assessClientHealth(userId, clientEmail, authReq.user.isAdmin);
    return res.json(result);
  } catch (error) {
    console.error("GET /api/client-health/:clientEmail error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/client-health/:clientId/notes
 * Save a note for a client. Currently a no-op placeholder
 * that returns success (notes are stored client-side for now).
 */
router.post("/:clientId/notes", async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Notes storage is a Phase 3 feature — for now acknowledge the save
    return res.json({
      success: true,
      message: "Note saved",
    });
  } catch (error) {
    console.error("POST /api/client-health/:clientId/notes error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;
