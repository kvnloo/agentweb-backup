/**
 * Onboarding variant serving — GET /api/onboarding/variants/:step
 *
 * Returns the active copy variant for a given onboarding step and user.
 * Assignment is deterministic (hash(userId+step) % weight-buckets) so a
 * user always gets the same variant across devices and sessions.
 *
 * Errors degrade gracefully: a 500 or S3 outage returns HTTP 200 with
 * { variant: null } so the frontend falls back to hardcoded control copy
 * without breaking onboarding.
 */

import express from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { readConfig, resolveVariant } from '../services/onboardingLoopConfig';

const router = express.Router();

/**
 * GET /api/onboarding/variants/:step?userId=<id>
 *
 * userId query param is optional — if omitted, falls back to the
 * authenticated user's ID. Allows the frontend to pre-fetch variants
 * for an anonymous session using a stable client-side UUID.
 */
router.get('/variants/:step', authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const step = req.params.step;
    if (!step) {
      return res.status(400).json({ message: 'step param required' });
    }

    const userId =
      (typeof req.query.userId === 'string' && req.query.userId)
        ? req.query.userId
        : authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const { config } = await readConfig();

    if (config.paused) {
      return res.status(200).json({ variant: null, reason: 'loop_paused' });
    }

    const variant = resolveVariant(config, step, userId);
    return res.status(200).json({ variant });
  } catch (err) {
    // Degrade gracefully — frontend falls back to control copy.
    console.error('[onboardingVariants] Failed to resolve variant:', err);
    return res.status(200).json({ variant: null, reason: 'error' });
  }
});

export default router;
