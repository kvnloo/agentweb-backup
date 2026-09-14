import express, { Request, Response } from 'express';
import { userDb } from '../services/db';
import { evaluateRenewalIntegrationHealth } from '../cron/renewalIntegrationHealthCron';

const router = express.Router();

/**
 * ENG-1541 — read-only production proof for `renewalIntegrationHealthCron`'s
 * entitlement-exclusion branch.
 *
 * Evaluates ONE real user's current state through `evaluateRenewalIntegrationHealth`
 * — the exact same decision function the daily cron uses — without scanning the
 * full renewal-imminent user set and without sending an alert either way. Requires
 * an explicit userId; this route never widens to a fleet-wide run.
 *
 * A strongly-consistent user read is used deliberately (unlike the cron's own
 * eventually-consistent scan, which is fine for a daily background job): this
 * route exists specifically to be a trustworthy point-in-time proof, so it
 * cannot itself be the thing that introduces staleness into that proof.
 */
router.post('/evaluate', async (req: Request, res: Response) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!userId) {
    return res.status(400).json({ message: 'userId is required' });
  }

  try {
    const user = await userDb.getUserByIdConsistent(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const evaluation = await evaluateRenewalIntegrationHealth(user);
    return res.status(200).json({
      userId,
      evaluatedAt: new Date().toISOString(),
      evaluation,
    });
  } catch (error: any) {
    console.error('adminRenewalIntegrationHealth evaluate error:', error?.message ?? error);
    return res.status(500).json({ message: 'Failed to evaluate renewal integration health' });
  }
});

export default router;
