/**
 * Admin shadow-usage analytics routes (Ship 1).
 *
 * Mounted at /api/admin (after the main admin router) so the paths are:
 *   GET /api/admin/users/:userId/usage/by-model-day?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   GET /api/admin/users/:userId/usage/comparison?month=YYYY-MM
 *   GET /api/admin/usage/cost-aggregation?start=YYYY-MM-DD&end=YYYY-MM-DD[&topUsers=N]
 *
 * Auth is applied per-route (authenticateToken + isAdmin) so mounting this
 * router does not change middleware behavior for any other /api/admin path.
 */

import express, { Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { AuthRequest } from "../types/express";
import {
  getUserUsageByModelDay,
  getUsageComparison,
  getCostAggregation,
  getUserOrgUsageRollup,
} from "../services/usageAnalyticsService";

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

router.get(
  "/users/:userId/usage/by-model-day",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const { userId } = req.params as { userId: string };
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");

      if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
        return res
          .status(400)
          .json({ message: "start and end query params are required (YYYY-MM-DD)" });
      }
      if (start > end) {
        return res.status(400).json({ message: "start must be <= end" });
      }

      const result = await getUserUsageByModelDay(userId, start, end);
      return res.json(result);
    } catch (error) {
      console.error("[adminUsage] by-model-day failed:", error);
      return res.status(500).json({
        message: "Failed to load usage",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

router.get(
  "/users/:userId/usage/comparison",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const { userId } = req.params as { userId: string };
      const month = String(req.query.month || "");

      if (!MONTH_RE.test(month)) {
        return res
          .status(400)
          .json({ message: "month query param is required (YYYY-MM)" });
      }

      const result = await getUsageComparison(userId, month);
      return res.json(result);
    } catch (error) {
      console.error("[adminUsage] comparison failed:", error);
      return res.status(500).json({
        message: "Failed to load usage comparison",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * Org-aware cost rollup for the admin per-user cost modal (ENG-200 follow-up).
 * Given the clicked user, rolls gross burn across all org members and reconciles
 * it against the org OWNER's quota counter — the fix for the member "false leak"
 * and owner "burn lags" display bugs. Solo users get a single-user rollup.
 */
router.get(
  "/users/:userId/usage/org-rollup",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const { userId } = req.params as { userId: string };
      const month = String(req.query.month || "");

      if (!MONTH_RE.test(month)) {
        return res
          .status(400)
          .json({ message: "month query param is required (YYYY-MM)" });
      }

      const result = await getUserOrgUsageRollup(userId, month);
      return res.json(result);
    } catch (error) {
      console.error("[adminUsage] org-rollup failed:", error);
      return res.status(500).json({
        message: "Failed to load org usage rollup",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * Cross-user cost aggregation for the admin cost dashboard (ENG-366 / ENG-353).
 * The 7d/30d presets are expressed by the caller as explicit start/end dates —
 * the API takes only the custom-range form.
 */
router.get(
  "/usage/cost-aggregation",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const start = String(req.query.start || "");
      const end = String(req.query.end || "");

      if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
        return res
          .status(400)
          .json({ message: "start and end query params are required (YYYY-MM-DD)" });
      }
      if (start > end) {
        return res.status(400).json({ message: "start must be <= end" });
      }

      let topUsersLimit = 10;
      if (req.query.topUsers !== undefined) {
        topUsersLimit = Number(req.query.topUsers);
        if (!Number.isInteger(topUsersLimit) || topUsersLimit < 1 || topUsersLimit > 100) {
          return res
            .status(400)
            .json({ message: "topUsers must be an integer between 1 and 100" });
        }
      }

      const result = await getCostAggregation(start, end, topUsersLimit);
      return res.json(result);
    } catch (error) {
      console.error("[adminUsage] cost-aggregation failed:", error);
      return res.status(500).json({
        message: "Failed to load cost aggregation",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export default router;
