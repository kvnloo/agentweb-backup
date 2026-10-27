import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth';
import { getSmartleadPushService } from '../services/smartleadPushRuntime';
import { scrubSmartleadSecrets } from '../services/smartleadService';

/**
 * Push a CRM list into the customer's own Smartlead campaign (ENG-673). Thin: every rule lives in SmartleadPushService; this only
 * authenticates, rate limits and translates its results to HTTP. Pushing is off unless SMARTLEAD_PUSH_ENABLED=true (503 otherwise).
 */
const router = express.Router();

const perUser = (req: any) => String(req.user?.userId ?? 'anonymous');
const limiter = (limit: number, message: string) =>
  rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: perUser, validate: { keyGeneratorIpFallback: false }, message: { error: message, code: 'rate_limited' } });

// A preview reads a whole list and calls Smartlead, and a start begins sending to real people: both are limited per user.
const previewLimiter = limiter(30, 'Too many previews. Try again in a few minutes.');
const startLimiter = limiter(10, 'Too many push attempts. Try again in a few minutes.');

function send(res: express.Response, result: { ok: boolean; status?: number; [k: string]: any }, okStatus = 200) {
  if (result.ok) {
    const { ok: _ok, ...body } = result;
    return res.status(body.started === true ? 202 : okStatus).json(body);
  }
  const { ok: _ok, status, message, code, details } = result;
  return res.status(status ?? 500).json({ error: message, code, ...(details !== undefined ? { details } : {}) });
}

const wrap = (fn: (req: any, res: express.Response) => Promise<unknown>) => async (req: any, res: express.Response) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error('[SmartleadPush] route error:', scrubSmartleadSecrets(error instanceof Error ? error.message : String(error)));
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Nothing was sent.', code: 'internal_error' });
  }
};

// The user's own Smartlead campaigns, for the picker.
router.get('/campaigns', authenticateToken, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().campaigns(req.user.userId, typeof req.query.accountId === 'string' ? req.query.accountId : undefined));
}));

router.post('/preview', authenticateToken, previewLimiter, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().preview(req.user.userId, req.body ?? {}));
}));

router.post('/start', authenticateToken, startLimiter, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().start(req.user.userId, req.body ?? {}));
}));

router.get('/lists/:listId/runs', authenticateToken, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().history(req.user.userId, req.params.listId));
}));

router.get('/runs/:runId', authenticateToken, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().status(req.user.userId, req.params.runId));
}));

router.post('/runs/:runId/pause', authenticateToken, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().pause(req.user.userId, req.params.runId));
}));

router.post('/runs/:runId/resume', authenticateToken, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().resume(req.user.userId, req.params.runId));
}));

router.post('/runs/:runId/cancel', authenticateToken, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().cancel(req.user.userId, req.params.runId));
}));

export default router;
