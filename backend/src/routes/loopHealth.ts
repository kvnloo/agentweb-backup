/**
 * GET /api/admin/loops/health — operator visibility into every closed loop.
 *
 * The audit's missing piece (#6): without this, a loop can stall silently
 * (sensor dry, gate never resolving, attribution never grading) and the only
 * way to notice is to read EB logs. This endpoint surfaces, per loop, which of
 * the six lifecycle states it's in (empty / blocked / pending_approval /
 * in_flight / learned / regressed / idle) plus the supporting counts and the
 * last graded outcome.
 *
 * Admin-only (mounted behind authenticateToken + isAdmin in app.ts).
 * Read-only — no mutation. Loop-agnostic: any loop that registers a manifest +
 * learning store shows up automatically, including the agent-mode loop.
 */

import express, { Request, Response } from 'express';
import { getLoopHealthReport } from '../loops/health/loopHealthService';
import { awsDynamoAdapter } from '../loops/adapters/awsAdapters';
import { readReliabilityTrend } from '../cron/agentReliabilitySnapshotCron';
import {
  evaluateBurnIn,
  BURN_IN_DEFAULT_MIN_RUN_COUNT,
  BURN_IN_DEFAULT_TOLERANCE,
} from '../cron/burnInEvaluation';

const router = express.Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const report = await getLoopHealthReport();
    return res.status(200).json(report);
  } catch (err) {
    console.error('[loopHealth] failed to build report:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /api/admin/loops/reliability-trend — the agent-mode daily reliability
 * trend line. Returns the last N daily snapshots (default 14) in date order so
 * the reliability trend is one request away. Read-only.
 *   ?days=30      — number of days (default 14)
 *   ?window=7d    — '24h' (default) or '7d' rolling window
 *
 * `hasData` (ENG-746) states emptiness outright. A bare `count: 0` was
 * ambiguous — it could mean the writer never ran or that the days were quiet —
 * and callers were left to guess. Consumers deciding closure-gate check 4
 * should use /burn-in below rather than interpreting these rates themselves.
 */
router.get('/reliability-trend', async (req: Request, res: Response) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));
    const windowLabel = req.query.window === '7d' ? '7d' : '24h';
    const dynamo = awsDynamoAdapter();
    const trend = await readReliabilityTrend(dynamo, { limit: days, windowLabel });
    return res.status(200).json({
      windowLabel,
      count: trend.length,
      hasData: trend.length > 0,
      snapshots: trend,
    });
  } catch (err) {
    console.error('[loopHealth] failed to read reliability trend:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /api/admin/loops/burn-in — closure-gate check 4, computed (ENG-746).
 *
 * Answers one question: for a change released at `releaseAt`, is the burn-in
 * window clean relative to the pre-release baseline? Returns an explicit
 * three-state verdict — `clean` | `regressed` | `insufficient_data` — plus both
 * sides of the comparison so the judgement is auditable.
 *
 * `passesClosureCheck4` is true only for `clean`. Missing data is reported as
 * `insufficient_data`, never as a pass; an unparseable or absent `releaseAt` is
 * a 400 that still carries `passesClosureCheck4: false`, so no error path can be
 * mistaken for approval.
 *
 * The evidence policy is FIXED, not requester-selected. `minRuns` may only be
 * raised above the default and `tolerance` may only be lowered below it, so a
 * caller can ask for a STRICTER check but can never weaken one — otherwise
 * `?minRuns=0&tolerance=1` would turn any zero-run window, or a 0%-to-100%
 * regression, into `passesClosureCheck4: true`, which is precisely the
 * false-green this endpoint exists to prevent.
 *
 *   ?releaseAt=<ISO>  — required; when the change reached production
 *   ?window=7d        — '24h' (default) or '7d'
 *   ?days=30          — how much trend history to consider (default 30)
 *   ?minRuns=10       — raise the minimum runs a window needs (stricter only)
 *   ?tolerance=0.005  — lower the allowed rate increase (stricter only)
 */
router.get('/burn-in', async (req: Request, res: Response) => {
  try {
    const releaseAtRaw = typeof req.query.releaseAt === 'string' ? req.query.releaseAt : '';
    if (!releaseAtRaw) {
      return res.status(400).json({
        error: 'releaseAt_required',
        passesClosureCheck4: false,
        verdict: 'insufficient_data',
        reason:
          'releaseAt is required — burn-in is meaningless without knowing when the change reached production.',
      });
    }

    const releaseAt = new Date(releaseAtRaw);
    if (Number.isNaN(releaseAt.getTime())) {
      return res.status(400).json({
        error: 'releaseAt_invalid',
        passesClosureCheck4: false,
        verdict: 'insufficient_data',
        reason: `releaseAt '${releaseAtRaw}' is not a parseable ISO timestamp.`,
      });
    }

    const windowLabel = req.query.window === '7d' ? '7d' : '24h';
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));

    // Stricter-only clamps. A request can demand more evidence or less slack;
    // it can never ask for less evidence or more slack.
    const minRunsRaw = Number(req.query.minRuns);
    const minRunCount =
      Number.isFinite(minRunsRaw) && minRunsRaw > BURN_IN_DEFAULT_MIN_RUN_COUNT
        ? Math.floor(minRunsRaw)
        : undefined;

    const toleranceRaw = Number(req.query.tolerance);
    const tolerance =
      Number.isFinite(toleranceRaw) && toleranceRaw >= 0 && toleranceRaw < BURN_IN_DEFAULT_TOLERANCE
        ? toleranceRaw
        : undefined;

    const dynamo = awsDynamoAdapter();
    const snapshots = await readReliabilityTrend(dynamo, { limit: days, windowLabel });

    const assessment = evaluateBurnIn({
      snapshots,
      releaseAt,
      windowLabel,
      ...(minRunCount !== undefined ? { minRunCount } : {}),
      ...(tolerance !== undefined ? { tolerance } : {}),
    });

    return res.status(200).json(assessment);
  } catch (err) {
    console.error('[loopHealth] failed to evaluate burn-in:', err);
    // Fail closed: an error is not a pass.
    return res.status(500).json({
      error: 'internal_error',
      passesClosureCheck4: false,
      verdict: 'insufficient_data',
      reason: 'Burn-in evaluation failed; treat as missing evidence.',
    });
  }
});

export default router;
