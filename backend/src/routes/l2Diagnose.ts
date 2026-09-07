/**
 * ENG-1553 — L2 diagnose API.
 *
 * One route so far, mirroring `leadVolumeMonitor.ts`'s shape: admin-only (enforced at the
 * `app.ts` mount point, same as every sibling admin route), identifier resolved the same way.
 */

import express, { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { diagnoseLeadsAtZero } from '../services/l2DiagnoseService';

const router = express.Router();

/**
 * GET /api/l2-diagnose/leads-at-zero/:clientEmail
 *
 * Admin-only. Diagnoses, per connected Meta ad account, why leads are at zero — discriminating
 * between pixel/CAPI failure, landing-page unreachability, budget exhaustion (always unchecked —
 * no evidence source exists), genuine demand drop, and normal variance.
 */
router.get('/leads-at-zero/:clientEmail', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const clientEmail = decodeURIComponent(req.params.clientEmail);
    const result = await diagnoseLeadsAtZero(userId, clientEmail, authReq.user.isAdmin);
    return res.json(result);
  } catch (error) {
    console.error('GET /api/l2-diagnose/leads-at-zero/:clientEmail error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
