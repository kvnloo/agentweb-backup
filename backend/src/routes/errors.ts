import express, { Request, Response } from 'express';
import { reportUIError } from '../utils/errorReporter';

const router = express.Router();

/**
 * POST /api/errors/report
 * Accepts frontend error reports (React error boundary, window.onerror, unhandledrejection).
 * Unauthenticated so errors on the login page are captured too.
 * Dedup in reportUIError prevents flooding.
 */
router.post('/report', async (req: Request, res: Response) => {
  const { operation, errorMessage, context } = req.body;

  if (!operation || !errorMessage) {
    return res.status(400).json({ error: 'operation and errorMessage are required' });
  }

  const userId = (req as any).user?.userId;

  // Fire-and-forget — respond immediately, don't block on Notion/email
  reportUIError({
    operation: `frontend:${String(operation).slice(0, 100)}`,
    errorMessage: String(errorMessage).slice(0, 1000),
    userId,
    context: {
      Source: 'frontend',
      ...(context && typeof context === 'object' ? context : {}),
    },
  }).catch((err: Error) => console.error('[errors route] reportUIError failed:', err));

  res.json({ ok: true });
});

export default router;
