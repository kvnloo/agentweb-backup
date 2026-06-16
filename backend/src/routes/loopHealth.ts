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
 */
router.get('/reliability-trend', async (req: Request, res: Response) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));
    const windowLabel = req.query.window === '7d' ? '7d' : '24h';
    const dynamo = awsDynamoAdapter();
    const trend = await readReliabilityTrend(dynamo, { limit: days, windowLabel });
    return res.status(200).json({ windowLabel, count: trend.length, snapshots: trend });
  } catch (err) {
    console.error('[loopHealth] failed to read reliability trend:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
