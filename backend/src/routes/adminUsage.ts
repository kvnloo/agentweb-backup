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
  getCostAggregation,
  getUserOrgUsageRollup,
  getXAllocatedTotals,
  currentXBillingCycle,
  getUserXBreakdown,
  getUserXOrgRollup,
} from "../services/usageAnalyticsService";
import { twitterService } from "../services/twitterService";
import { buildUnitEconomicsReport } from "../services/llmUnitEconomicsService";
import { listSpendEventsBounded } from "../services/spendEventDb";
import { boundBreakdownRows, buildSpendBreakdown, explainPause, resolveAllowanceInputs } from "../services/spendReadModel";
import { projectMonth } from "../services/spendProjection";
import { LLM_SPEND_LEDGER_STARTED_ON } from "../services/spendLedgerDualWrite";
import { measureLlmLedgerCoverage } from "../services/spendReconciliation";
import { UsageRecordRow, usageRecordDb } from "../services/usageRecordDb";
import { getSubscriptionTypeConfig } from "../services/subscriptionService";
import { getLlmUsageCreditAdjustment } from "../services/llmUsageCreditService";
import { orgDb, userDb } from "../services/db";
import { checkTokenUsage, resolveBillingUserId } from "../services/tokenUsageService";
import { describeEnforcement } from "../services/enforcementStateView";

const router = express.Router();

/**
 * ENG-1841 bounds on the interactive spend breakdown.
 *
 * MAX_EVENTS caps the read. The largest subject-month on production was 542
 * events on 2026-09-15 (2,450 across every subject for the whole of September),
 * so this leaves ~90x headroom while making the work bounded by construction.
 * ROWS_PER_CUT caps each detail list in the response; the portal renders 25.
 */
export const SPEND_BREAKDOWN_MAX_EVENTS = 50_000;
export const SPEND_BREAKDOWN_ROWS_PER_CUT = 100;

/**
 * Every aggregate row billed to `billingUserId` in `month`, by keyed query.
 *
 * The aggregate table is partitioned by the ACTING user, so the rows billed to
 * an org owner live under each member's partition. Rather than scanning the
 * table for `billingUserId` (CodeRabbit, PR #2904 — scans are not allowed on
 * a per-request path, and a billingUserId GSI is a data-plane change, ENG-1273),
 * this queries the partitions that can hold them: the owner, the org's current
 * members, and every acting user the ledger itself saw this month.
 *
 * A former member with aggregate rows but no ledger events is the one actor
 * this cannot see. That can only make the aggregate side SMALLER than the
 * ledger, which the coverage check reports as drift — `partial`, never a false
 * `full`.
 */
/** Aggregate-partition queries run at once by the coverage read. */
export const AGGREGATE_READ_CONCURRENCY = 8;

async function readAggregateRowsForBillingSubject(
  billingUserId: string,
  month: string,
  events: ReadonlyArray<{ actingUserId: string }>,
) {
  const actors = new Set<string>([billingUserId, ...events.map((e) => e.actingUserId).filter(Boolean)]);
  const owner = await userDb.getUserById(billingUserId);
  if (owner?.orgId) {
    for (const member of await orgDb.getOrgMembers(owner.orgId)) actors.add(member.userId);
  }

  // Bounded fan-out: a large org must not burst one query per member at once
  // (CodeRabbit, PR #2904). Batches keep an admin read from contributing to
  // throttling on the table every LLM call writes to.
  const rows: UsageRecordRow[] = [];
  const queue = [...actors];
  for (let i = 0; i < queue.length; i += AGGREGATE_READ_CONCURRENCY) {
    const batch = await Promise.all(
      queue
        .slice(i, i + AGGREGATE_READ_CONCURRENCY)
        .map((actor) => usageRecordDb.queryByUserDateRange(actor, `${month}-01`, `${month}-31`)),
    );
    rows.push(...batch.flat());
  }
  // A member's partition also holds rows billed to someone else (their own
  // subscription, or before they pooled), so keep only this subject's.
  return rows.filter((row) => row.billingUserId === billingUserId);
}

/**
 * ENG-1250 §7: the spend breakdown for one billing subject and month, built
 * from the immutable ledger.
 *
 * Exists because §7's requirement is that "no admin should need direct
 * DynamoDB inspection to explain a pause" — and until this, nothing outside
 * the ledger modules could read AW-SpendEvents at all.
 *
 * READ-ONLY, and deliberately so: it reports what the ledger says and cannot
 * pause, unpause, or alter a balance. ENG-1250 AC6 keeps enforcement with
 * Harsha, and a read model must never become the thing that pauses an account.
 */
router.get(
  "/users/:billingUserId/spend/breakdown",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const { billingUserId: requestedUserId } = req.params as { billingUserId: string };
      const month = String(req.query.month || "");

      if (!BILLING_USER_ID_RE.test(requestedUserId)) {
        return res.status(400).json({ error: "billingUserId is not a valid identifier" });
      }
      if (!MONTH_RE.test(month)) {
        return res.status(400).json({ error: "month must be YYYY-MM with a real month" });
      }

      // Resolve to the billing ROOT before reading the ledger (ENG-1838).
      //
      // Spend events are partitioned by billingUserId and buildSpendBreakdown
      // filters on it exactly, so an org MEMBER's id matches nothing and the
      // response is a complete, well-formed, entirely empty breakdown. That is
      // the worst possible failure here: the screen exists to explain a pause,
      // and it would answer "this account has spent nothing" about an account
      // that has spent plenty.
      //
      // Nothing upstream guarantees the caller holds a billing root — the admin
      // cost tables are keyed by the ACTING user (usageAnalyticsService groups
      // topUsers on `item.userId`), so drilling in from one hands this route a
      // member id routinely. Resolving is a no-op for a root and correct for a
      // member, and it uses the same predicate the live gate bills through, so
      // the two cannot disagree about who pays.
      const billingUserId = await resolveBillingUserId(requestedUserId);

      // The GSI is keyed on occurredAt, so the range is the calendar month.
      // `-31` is safe for every month: it is an upper bound on a string
      // comparison, not a date that has to exist.
      // ENG-1841: bounded read. Past the ceiling the events are incomplete and
      // every total built from them would be understated, so the endpoint says
      // so instead of answering with a confident wrong number.
      const { events, exceeded } = await listSpendEventsBounded(
        billingUserId,
        `${month}-01`,
        `${month}-31`,
        SPEND_BREAKDOWN_MAX_EVENTS,
      );
      if (exceeded) {
        return res.status(422).json({
          error:
            `This billing subject has more than ${SPEND_BREAKDOWN_MAX_EVENTS.toLocaleString()} spend events in ${month} — ` +
            "too many to summarise exactly here. Use the reconciliation report for this month.",
          code: "spend_breakdown_too_large",
          eventLimit: SPEND_BREAKDOWN_MAX_EVENTS,
        });
      }
      const breakdown = buildSpendBreakdown(billingUserId, month, events);

      const allowance = await resolveAllowanceInputs(billingUserId, month, {
        getUser: (id) => userDb.getUserById(id) as any,
        getTierConfig: (tier) => getSubscriptionTypeConfig(tier) as any,
        getCreditAdjustment: (ledger, m) => getLlmUsageCreditAdjustment(ledger as any, m),
      });

      // Computed from the SAME events the breakdown reports, so the
      // explanation and the numbers behind it can never disagree.
      // The policy MUST be threaded: without it projectMonth evaluates with no
      // policy, returns full_choice unconditionally, and no pause is ever
      // explained — the opposite of what this endpoint exists for.
      const projection = projectMonth(billingUserId, month, events, allowance, allowance.policy as any);

      // ENG-1934: the aggregate rail for the same subject and month, read only
      // when the month can hold LLM events at all. A failed read degrades the
      // coverage to "partial" rather than failing the breakdown.
      const aggregateRows =
        month >= LLM_SPEND_LEDGER_STARTED_ON.slice(0, 7)
          ? await readAggregateRowsForBillingSubject(billingUserId, month, events).catch((error: any) => {
              console.error("[adminUsage] LLM coverage read failed:", error?.message || error);
              return null;
            })
          : null;

      return res.json({
        // Totals are over the whole month; only the detail row lists are
        // bounded, with what was left out counted in `omitted` (ENG-1841).
        ...boundBreakdownRows(breakdown, SPEND_BREAKDOWN_ROWS_PER_CUT),
        // Echoed so the UI can say WHOSE ledger this is when the two differ —
        // an admin who opened a member must see they are reading the org's
        // spend, not that member's.
        requestedUserId,
        allowance,
        projection,
        // SHADOW (spendProjection): the ledger's hypothetical pause, which
        // nothing enforces. Not rendered as a pause (ENG-1874) — `enforcement`
        // below is the real decision.
        pause: explainPause(projection, breakdown),
        // ENG-1886: whether the account is ACTUALLY paused — the enforcer's own
        // result, not a recomputation. Current month only; a failed read is
        // reported as unreadable rather than failing the breakdown.
        enforcement: await checkTokenUsage(billingUserId)
          .then((status) => describeEnforcement(status, month))
          .catch((error: any) => {
            console.error("[adminUsage] enforcement state read failed:", error?.message || error);
            return { available: false as const, reason: "unreadable" as const, message: "Could not read the enforcer's state" };
          }),
        // ENG-1934: how much of this month's LLM spend the total includes,
        // measured against the aggregate rail. The allowance comparison is only
        // meaningful beside it.
        llmLedger: measureLlmLedgerCoverage(month, events, aggregateRows),
      });
    } catch (error: any) {
      console.error("[adminUsage] spend breakdown failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to build spend breakdown" });
    }
  }
);


const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 01-12 only. A bare \d{2} accepted 2026-00 and 2026-13, which reach the query
// and return a successful EMPTY result instead of a 400 — a caller with a typo
// gets "no spend" rather than "bad month" (CodeRabbit, PR #2811).
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Ids are opaque but bounded: uuids, numeric ids, and `anon_<uuid>` sessions. */
const BILLING_USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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
 * Org-aware X (Twitter) rollup for the admin per-user X-cost modal (ENG-664) —
 * the X sibling of /usage/org-rollup. Rolls allocated X spend across all org
 * members (owner + members) with a per-member breakdown. Solo users get a
 * single-member rollup. X is observe-only, so there is no quota reconciliation.
 */
router.get(
  "/users/:userId/usage/x-org-rollup",
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

      const result = await getUserXOrgRollup(userId, month);
      return res.json(result);
    } catch (error) {
      console.error("[adminUsage] x-org-rollup failed:", error);
      return res.status(500).json({
        message: "Failed to load X org rollup",
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

      // Provider scope (ENG-664): absent → "llm" (the LLM Costs tab sends no
      // provider param and must never show vendor rows); "twitter"/vendor or "all"
      // are opt-in. Validated to a safe token so it can't inject anything downstream.
      const provider = String(req.query.provider || "llm");
      if (!/^[a-z0-9._-]+$/.test(provider)) {
        return res.status(400).json({ message: "provider must be a simple token (a-z0-9._-)" });
      }

      const result = await getCostAggregation(start, end, topUsersLimit, provider);
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
      // Allocated is an upper bound: >= measured, because allocated counts every
      // read while X dedups repeats within a UTC day. If measured EXCEEDS allocated,
      // our best-effort metering missed successful X calls — an attribution gap.
      // Surface it explicitly (AC3: attribution is never silently dropped) instead
      // of letting the dedup clamp swallow the negative and read as "0 deduped".
      const attributionGapUnits = Math.max(0, measured.projectUsage - allocated.postReadUnits);
      if (attributionGapUnits > 0) {
        console.warn(
          `[adminUsage] x-reconciliation: measured reads (${measured.projectUsage}) exceed allocated (${allocated.postReadUnits}) by ${attributionGapUnits} — X metering attribution gap (missed instrumentation).`
        );
      }
      return res.json({
        cycle,
        measured,
        allocated,
        reconciliation: {
          allocatedPostReadUnits: allocated.postReadUnits,
          measuredPostReadUnits: measured.projectUsage,
          // >= 0 — allocated over-counts reads X deduped within a UTC day.
          dedupSavingsUnits: Math.max(0, allocated.postReadUnits - measured.projectUsage),
          // >= 0 — nonzero means we under-recorded (measured > allocated), i.e. an
          // internal attribution gap operators should see, not hidden by the clamp.
          attributionGapUnits,
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

/**
 * ENG-1139 — per-billing-subject unit economics for a billing period.
 *
 * Admin-only, same per-route `authenticateToken + isAdmin` as every other route
 * in this file (AC6: no customer surface can reach COGS, thresholds or the price
 * book). Extends the ENG-353 admin surface rather than adding a parallel
 * dashboard (AC7).
 *
 *   GET /api/admin/usage/unit-economics?month=YYYY-MM
 *       [&tier=Pro][&state=hard_only][&account=<id-or-email substring>]
 *       [&model=<model id>][&purchasedOnly=true]
 */
router.get(
  "/usage/unit-economics",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const month = String(req.query.month || "");
      if (!MONTH_RE.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const report = await buildUnitEconomicsReport(month, {
        tier: req.query.tier ? String(req.query.tier) : undefined,
        usageState: req.query.state ? String(req.query.state) : undefined,
        account: req.query.account ? String(req.query.account) : undefined,
        model: req.query.model ? String(req.query.model) : undefined,
        purchasedOnly: String(req.query.purchasedOnly || "") === "true",
      });
      return res.json(report);
    } catch (error) {
      console.error("[adminUsage] unit-economics failed:", error);
      return res.status(500).json({
        message: "Failed to build the unit-economics report",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * ENG-2771: a named client's effective allowance for the CURRENT month, for
 * Emma's admin-only `inspect_client_usage` tool.
 *
 * READ-ONLY. It resolves the billing owner and re-labels the enforcer's own
 * `checkTokenUsage` result via `describeEnforcement` — the same path the spend
 * breakdown's `enforcement` field uses — so there is no second computation.
 * No tier, bonus or counter mutation lives here (those stay ENG-528/ENG-1482).
 */
router.get(
  "/usage/enforcement",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      for (const key of ["email", "userId"] as const) {
        const raw = req.query[key];
        if (raw !== undefined && typeof raw !== "string") {
          return res.status(400).json({ error: `${key} must be a single string value` });
        }
      }
      const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
      let userId = typeof req.query.userId === "string" ? req.query.userId.trim() : "";
      if (!email && !userId) return res.status(400).json({ error: "email or userId is required" });
      if (email && userId) return res.status(400).json({ error: "Pass email or userId, not both" });
      if (userId) {
        if (!BILLING_USER_ID_RE.test(userId)) {
          return res.status(400).json({ error: "userId is not a valid identifier" });
        }
        const user: any = await userDb.getUserById(userId);
        if (!user?.userId) return res.status(404).json({ error: "User not found", found: false });
      } else {
        const user: any = await userDb.getUserByEmail(email);
        if (!user?.userId) return res.status(404).json({ error: "User not found", found: false });
        userId = user.userId;
      }
      if (!BILLING_USER_ID_RE.test(userId)) {
        return res.status(400).json({ error: "userId is not a valid identifier" });
      }
      const billingUserId = await resolveBillingUserId(userId);
      const enforcement = await checkTokenUsage(billingUserId)
        .then((status) => describeEnforcement(status, status.month))
        .catch((error: any) => {
          console.error("[adminUsage] enforcement state read failed:", error?.message || error);
          return { available: false as const, reason: "unreadable" as const, message: "Could not read the enforcer's state" };
        });
      return res.json({ requestedUserId: userId, email: email || null, billingUserId, enforcement });
    } catch (error: any) {
      console.error("[adminUsage] usage enforcement lookup failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to read usage enforcement state" });
    }
  },
);

export default router;
