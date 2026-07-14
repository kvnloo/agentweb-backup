/**
 * Admin v0 credit-monitor route.
 *
 * Mounted at /api/admin (alongside the main admin router) so the path is:
 *   GET /api/admin/v0/credits            — cached (5 min TTL) balance snapshot
 *   GET /api/admin/v0/credits?refresh=1  — bypass the cache
 *
 * Auth is applied per-route (authenticateToken + isAdmin) so mounting this
 * router does not change middleware behavior for any other /api/admin path.
 *
 * On any v0 API failure the route returns 502 with the error surfaced —
 * never fabricated/zero balances.
 */

import express, { Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { AuthRequest } from "../types/express";
import { getV0Credits } from "../services/v0BillingService";

const router = express.Router();

router.get(
  "/v0/credits",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const refresh = String(req.query.refresh || "");
      const forceRefresh = refresh === "1" || refresh === "true";
      const dto = await getV0Credits({ forceRefresh });
      return res.json(dto);
    } catch (error) {
      console.error("[adminV0Credits] v0 billing fetch failed:", error);
      return res.status(502).json({
        message: "Failed to fetch v0 billing",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export default router;
