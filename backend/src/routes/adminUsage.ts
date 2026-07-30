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
  getXAllocatedTotals,
  currentXBillingCycle,
  getUserXBreakdown,
} from "../services/usageAnalyticsService";
import { twitterService } from "../services/twitterService";

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
 * One user's X (Twitter) spend by tool over a date range (ENG-664) — powers the
 * per-user "X Cost" breakdown on the admin user card.
 */
router.get(
  "/users/:userId/usage/x-breakdown",
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

      const result = await getUserXBreakdown(userId, start, end);
      return res.json(result);
    } catch (error) {
      console.error("[adminUsage] x-breakdown failed:", error);
      return res.status(500).json({
        message: "Failed to load X breakdown",
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

/**
 * X (Twitter) usage reconciliation (ENG-664, acceptance criterion 2).
 *
 * Returns X's OWN measured consumption (GET /2/usage/tweets — app-wide, deduped)
 * beside our allocated ledger totals for the SAME billing cycle, so an admin can
 * see how our allocated upper bound tracks the figure X actually bills. The
 * allocated window is derived from X's cap_reset_day so the two are comparable.
 * A failure to reach X (e.g. bearer not configured) is surfaced as 502 without
 * taking down the rest of the usage tab, which loads this panel separately.
 */
router.get(
  "/usage/x-reconciliation",
  authenticateToken,
  isAdmin,
  async (_req: AuthRequest, res: Response) => {
    let measured;
    try {
      measured = await twitterService.getXProjectUsage();
    } catch (error) {
      console.error("[adminUsage] x-reconciliation: X usage fetch failed:", error);
      return res.status(502).json({
        message: "Failed to read X app usage",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    try {
      const cycle = currentXBillingCycle(measured.capResetDay);
      const allocated = await getXAllocatedTotals(cycle.start, cycle.end);
      // Tighter dollar estimate: X's deduped read count × the post-read rate,
      // plus our directly-counted (non-read) allocated spend. Reads are the only
      // dimension X's measured number covers; writes/DMs stay allocated-only.
      const POST_READ_USD = 0.005;
      const measuredReadCostUsd = measured.projectUsage * POST_READ_USD;
      const allocatedNonReadCostUsd = Math.max(0, allocated.costUsd - allocated.postReadUnits * POST_READ_USD);
      return res.json({
        cycle,
        measured,
        allocated,
        reconciliation: {
          allocatedPostReadUnits: allocated.postReadUnits,
          measuredPostReadUnits: measured.projectUsage,
          // >= 0 — allocated over-counts reads X deduped within a UTC day.
          dedupSavingsUnits: Math.max(0, allocated.postReadUnits - measured.projectUsage),
          capUsedPct: measured.projectCap > 0 ? (measured.projectUsage / measured.projectCap) * 100 : null,
          measuredDerivedCostUsd: measuredReadCostUsd + allocatedNonReadCostUsd,
        },
      });
    } catch (error) {
      console.error("[adminUsage] x-reconciliation: allocated totals failed:", error);
      return res.status(500).json({
        message: "Failed to compute X reconciliation",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export default router;
