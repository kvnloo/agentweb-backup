import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { loopCoordinatorService } from '../services/loopCoordinatorService';
import { loopDb } from '../services/db';

const router = express.Router();

// GET /api/loops/status — list all loops and their state
router.get('/status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const status = loopCoordinatorService.getStatus();
    res.json({ loops: status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/loops/start — start a registered loop
router.post('/start', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { loopId } = req.body;
    if (!loopId) {
      res.status(400).json({ error: 'loopId is required' });
      return;
    }

    await loopCoordinatorService.startLoop(loopId);
    const status = loopCoordinatorService.getLoopStatus(loopId);
    res.json({ message: `Loop "${loopId}" started`, loop: status });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/loops/stop — stop a running loop
router.post('/stop', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { loopId } = req.body;
    if (!loopId) {
      res.status(400).json({ error: 'loopId is required' });
      return;
    }

    await loopCoordinatorService.stopLoop(loopId);
    const status = loopCoordinatorService.getLoopStatus(loopId);
    res.json({ message: `Loop "${loopId}" stopped`, loop: status });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/loops/:loopId/runs — get execution history for a loop
router.get('/:loopId/runs', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { loopId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const runs = await loopDb.getLoopRuns(loopId, limit);
    res.json({ runs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
