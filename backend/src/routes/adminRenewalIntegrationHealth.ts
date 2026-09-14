import express, { Request, Response } from 'express';
import { userDb } from '../services/db';
import { evaluateRenewalIntegrationHealth } from '../cron/renewalIntegrationHealthCron';
import {
  getAccountCapabilityRequirement,
  setAccountCapabilityCorrection,
  isSuppressed,
} from '../services/accountCapabilityRequirementsDb';
import { recordAdminAudit } from '../services/adminAuditLog';
import { AuthenticatedRequest } from '../middleware/auth';

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
 *
 * ENG-1541 (remainder, items 1-2): also surfaces the persisted capability row, if one exists,
 * and whether a live `would_flag` decision is currently suppressed by a correction. Without
 * this, an admin could see "would_flag" here and not know it's actually suppressed — this
 * route stays read-only (no write here, matching its original purpose exactly), it just no
 * longer reports an incomplete picture now that suppression exists.
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
    const capability = await getAccountCapabilityRequirement(userId, 'ad_platform_integration');
    return res.status(200).json({
      userId,
      evaluatedAt: new Date().toISOString(),
      evaluation,
      capability,
      suppressedByCorrection: evaluation.decision === 'would_flag' ? isSuppressed(capability) : false,
    });
  } catch (error: any) {
    console.error('adminRenewalIntegrationHealth evaluate error:', error?.message ?? error);
    return res.status(500).json({ message: 'Failed to evaluate renewal integration health' });
  }
});

/**
 * ENG-1541 (remainder, item 2) — mark a specific `would_flag` occurrence as resolved/false-
 * positive, suppressing further alerts for `correctionLifetimeDays` (default 30) or until the
 * underlying status genuinely changes, whichever comes first. Never called by the cron itself;
 * this is the only place `correctedAt`/`correctedBy`/`correctionNote`/`correctionExpiresAt` get
 * written. Requires a row to already exist (`attribute_exists(userId)` in the write itself) —
 * correcting a user with no tracked requirement is a 404, not a silent no-op or a phantom row.
 */
router.post('/correct', async (req: Request, res: Response) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  const correctionNote = typeof req.body?.correctionNote === 'string' ? req.body.correctionNote.trim() : undefined;
  const correctionLifetimeDays =
    typeof req.body?.correctionLifetimeDays === 'number' && req.body.correctionLifetimeDays > 0
      ? req.body.correctionLifetimeDays
      : 30;
  if (!userId) {
    return res.status(400).json({ message: 'userId is required' });
  }

  const actor = (req as AuthenticatedRequest).user;
  try {
    await setAccountCapabilityCorrection(userId, 'ad_platform_integration', actor!.userId, correctionNote, correctionLifetimeDays);
  } catch (error: any) {
    if (error?.code === 'ConditionalCheckFailedException') {
      return res.status(404).json({ message: 'No tracked capability requirement for this user' });
    }
    console.error('adminRenewalIntegrationHealth correct error:', error?.message ?? error);
    return res.status(500).json({ message: 'Failed to record correction' });
  }

  recordAdminAudit({
    actorUserId: actor!.userId,
    actorEmail: actor!.email,
    action: 'renewal_integration_health_correction',
    targetUserId: userId,
    capability: 'ad_platform_integration',
    correctionNote: correctionNote ?? null,
    correctionLifetimeDays,
  });

  const capability = await getAccountCapabilityRequirement(userId, 'ad_platform_integration');
  return res.status(200).json({ userId, correctedAt: new Date().toISOString(), capability });
});

export default router;
