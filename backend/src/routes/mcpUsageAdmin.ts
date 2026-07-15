import express, { Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { AuthRequest } from '../types/express';
import { buildMcpUsageReport } from '../services/mcpUsageEventsService';

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/mcp-usage', authenticateToken, isAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');

    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      return res.status(400).json({ message: 'start and end query params are required (YYYY-MM-DD)' });
    }
    if (start > end) {
      return res.status(400).json({ message: 'start must be <= end' });
    }

    const report = await buildMcpUsageReport({ start, end });
    return res.json(report);
  } catch (error) {
    console.error('[mcpUsageAdmin] report failed:', error);
    return res.status(500).json({
      message: 'Failed to load MCP usage report',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
