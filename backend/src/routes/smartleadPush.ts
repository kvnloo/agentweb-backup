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

// An agent over MCP (a self-call, marked from the signed token; a header would be spoofable) has its own bucket, so a looping agent
// cannot lock the person out of the approval dialog.
const perUser = (req: any) => `${String(req.user?.userId ?? 'anonymous')}:${req.isSelfCall === true ? 'agent' : 'ui'}`;
const limiter = (limit: number, message: string) =>
  rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: perUser, validate: { keyGeneratorIpFallback: false }, message: { error: message, code: 'rate_limited' } });

// A preview reads a whole list and calls Smartlead, and a start begins sending to real people: both are limited per user.
const previewLimiter = limiter(30, 'Too many previews. Try again in a few minutes.');
const startLimiter = limiter(10, 'Too many push attempts. Try again in a few minutes.');
// Listing campaigns spends the customer's own Smartlead API budget, which a running push also needs.
const campaignsLimiter = limiter(30, 'Too many requests. Try again in a few minutes.');
const releaseLimiter = limiter(30, 'Too many requests. Try again in a few minutes.');
// A campaign's numbers, read from Smartlead on the customer's own API budget (for agents over MCP; Emma reads the service directly).
const statsLimiter = limiter(30, 'Too many requests. Try again in a few minutes.');

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
router.get('/campaigns', authenticateToken, campaignsLimiter, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().campaigns(req.user.userId, typeof req.query.accountId === 'string' ? req.query.accountId : undefined));
}));

// How one of the user's campaigns is doing, as Smartlead counts it.
router.get('/campaigns/:campaignId/stats', authenticateToken, statsLimiter, wrap(async (req, res) => {
  const campaignId = /^\d{1,15}$/.test(String(req.params.campaignId)) ? Number(req.params.campaignId) : NaN;
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) {
    return res.status(400).json({ error: 'campaignId must be a positive whole number', code: 'invalid_request' });
  }
  send(res, await getSmartleadPushService().campaignStats(req.user.userId, campaignId, typeof req.query.accountId === 'string' ? req.query.accountId : undefined));
}));

router.post('/preview', authenticateToken, previewLimiter, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().preview(req.user.userId, req.body ?? {}));
}));

router.post('/start', authenticateToken, startLimiter, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().start(req.user.userId, req.body ?? {}));
}));

// A list editor releases leads from Smartlead: AgentWeb's own senders may email them again. Changes nothing in Smartlead.
router.post('/leads/release', authenticateToken, releaseLimiter, wrap(async (req, res) => {
  send(res, await getSmartleadPushService().release(req.user.userId, req.body ?? {}));
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
