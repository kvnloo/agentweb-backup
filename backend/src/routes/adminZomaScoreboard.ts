/**
 * ENG-2902 — Zoma launch scoreboard (admin only; definitions in services/zomaScoreboard.ts).
 *   GET  /api/admin/zoma/scoreboard                  per-user rows + summary (read-only)
 *   POST /api/admin/zoma/scoreboard/verify-first-ads provider check of pending go-live approvals;
 *        records a first successful ad only when the Meta read-back is ACTIVE with >= 1 impression.
 */
import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { buildZomaScoreboard, defaultFirstAdDeps, verifyZomaFirstAds } from '../services/zomaScoreboard';

const router = express.Router();

router.get('/zoma/scoreboard', authenticateToken, isAdmin, async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await buildZomaScoreboard());
  } catch (error) {
    console.error('[zoma-scoreboard] build failed:', error instanceof Error ? error.message : error);
    res.status(503).json({ message: 'Scoreboard unavailable' });
  }
});

router.post('/zoma/scoreboard/verify-first-ads', authenticateToken, isAdmin, async (req, res) => {
  const userId = typeof req.body?.userId === 'string' && req.body.userId ? req.body.userId : undefined;
  try {
    res.set('Cache-Control', 'no-store').json({ results: await verifyZomaFirstAds(defaultFirstAdDeps(), { userId }) });
  } catch (error) {
    console.error('[zoma-scoreboard] first-ad verification failed:', error instanceof Error ? error.message : error);
    res.status(503).json({ message: 'First-ad verification unavailable' });
  }
});

export default router;
