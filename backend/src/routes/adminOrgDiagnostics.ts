import express, { Request, Response } from 'express';
import { findOrphanedOrgJoinRequests } from '../services/orphanedOrgJoinRequestService';

const router = express.Router();

router.get('/orphaned-org-join-requests', async (_req: Request, res: Response) => {
  try {
    return res.status(200).json(await findOrphanedOrgJoinRequests());
  } catch (error: any) {
    console.error('adminOrgDiagnostics orphaned-org-join-requests error:', error?.message ?? error);
    return res.status(500).json({ message: 'Failed to inspect orphaned organization join requests' });
  }
});

export default router;
