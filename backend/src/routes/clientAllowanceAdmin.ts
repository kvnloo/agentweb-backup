import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { userDb } from '../services/db';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from '../services/subscriptionService';
import { checkTokenUsage, getUserTokenAllowance, getUserTokenUsage, resolveBillingUserId } from '../services/tokenUsageService';
import { recordAdminAudit } from '../services/adminAuditLog';
import { grantMonthlyLlmUsageCredit } from '../services/llmUsageCreditService';
import { changeClientSubscription, ClientAllowanceError, grantClientCostCredit, inspectClientAllowance } from '../services/clientAllowanceAdminService';

const router = express.Router();
router.use(authenticateToken, isAdmin);

const deps = {
  getUserByEmail: userDb.getUserByEmail.bind(userDb),
  getUserById: userDb.getUserById.bind(userDb),
  resolveBillingUserId,
  getUserSubscriptionType,
  getUserTokenUsage,
  getUserTokenAllowance,
  checkTokenUsage,
  getSubscriptionTypeConfig,
  updateUser: userDb.updateUser.bind(userDb),
  grantMonthlyLlmUsageCredit,
  recordAdminAudit,
};

function sendError(res: express.Response, error: unknown) {
  if (error instanceof ClientAllowanceError) {
    const status = error.code === 'CLIENT_NOT_FOUND' ? 404
      : error.code === 'CLIENT_ALLOWANCE_CONFLICT' ? 409 : 400;
    return res.status(status).json({ message: error.message, code: error.code });
  }
  console.error('[clientAllowanceAdmin] request failed:', error);
  return res.status(500).json({ message: 'Client allowance operation failed' });
}

router.get('/client-allowance', async (req, res) => {
  try {
    return res.json(await inspectClientAllowance(String(req.query.email || ''), deps));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/client-allowance/subscription', async (req, res) => {
  try {
    const { email, subscriptionType, reason, confirmed } = req.body || {};
    if (confirmed !== true) return res.status(400).json({ message: 'confirmed: true is required for a mutation' });
    const actor = (req as any).user || {};
    return res.json(await changeClientSubscription({
      email, subscriptionType, reason,
      actor: { userId: actor.userId, email: actor.email },
    }, deps));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/client-allowance/cost-credit', async (req, res) => {
  try {
    const { email, amountUsd, idempotencyKey, reason, confirmed } = req.body || {};
    if (confirmed !== true) return res.status(400).json({ message: 'confirmed: true is required for a mutation' });
    const actor = (req as any).user || {};
    return res.json(await grantClientCostCredit({
      email, amountUsd, idempotencyKey, reason,
      actor: { userId: actor.userId, email: actor.email },
    }, deps));
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
