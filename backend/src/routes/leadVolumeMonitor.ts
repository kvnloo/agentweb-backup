/**
 * ENG-1551 — lead volume & attribution monitor API.
 *
 * One route, mirroring `clientHealth.ts`'s shape exactly: admin-only (enforced in the service
 * layer, same as `assessClientHealth`), identifier resolved the same way, ad-account filtering
 * the same way. This is the tool a future "Lead Volume & Attribution Monitor" skill calls — see
 * `services/leadVolumeMonitorService.ts`'s doc comment for why the resolver is intentionally not
 * reimplemented here.
 */

import express, { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { monitorLeadVolume } from '../services/leadVolumeMonitorService';

const router = express.Router();

/**
 * GET /api/lead-volume-monitor/:clientEmail?since=YYYY-MM-DD&until=YYYY-MM-DD
 *
 * `since`/`until` are optional — defaults to a 60-day trailing window. Admin-only.
 */
router.get('/:clientEmail', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const clientEmail = decodeURIComponent(req.params.clientEmail);
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const until = typeof req.query.until === 'string' ? req.query.until : undefined;

    const result = await monitorLeadVolume(userId, clientEmail, authReq.user.isAdmin, { since, until });
    return res.json(result);
  } catch (error) {
    console.error('GET /api/lead-volume-monitor/:clientEmail error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
