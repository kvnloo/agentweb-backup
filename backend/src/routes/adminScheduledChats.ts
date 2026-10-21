/**
 * ENG-778 — audited admin inspect + pause/resume for scheduled chats owned by
 * any account. Replaces the ENG-687 DynamoDB break-glass path.
 *
 * Deliberately narrow: one schedule by exact ID, and only `active <-> paused`.
 * No listing, edit, or delete. Customer routes in agentModeController stay
 * owner-scoped and are untouched. Mounted behind authenticateToken + isAdmin
 * (which also refuses delegated sessions).
 *
 * The status write is conditional on the status the admin saw, so a concurrent
 * owner toggle cannot be silently overwritten (409 instead). Only `status` and
 * `updatedAt` are written; runResults, prompt, owner, recipients and
 * nextRunTime are left as they are.
 */
import express, { Request, Response } from 'express';
import { scheduleDb, userDb } from '../services/db';
import { recordAdminAudit } from '../services/adminAuditLog';
import { isSubscriptionFeatureEnabled } from '../services/subscriptionService';
import {
  checkScheduleActivationRecipients,
  deliveryEnforcementEnabled,
  logShadowDecision,
} from '../services/scheduledReportAccess';
import { normalizeEmailList } from '../utils/validation';

const router = express.Router();

const TOGGLEABLE = ['active', 'paused'] as const;

function summarize(schedule: any) {
  return {
    scheduleId: schedule.scheduleId,
    ownerUserId: schedule.userId,
    scheduleName: schedule.scheduleName ?? null,
    status: schedule.status,
    frequency: schedule.frequency,
    nextRunTime: schedule.nextRunTime ?? null,
    lastRunTime: schedule.lastRunTime ?? null,
    emailNotifications: schedule.emailNotifications ?? [],
    runResultCount: Array.isArray(schedule.runResults) ? schedule.runResults.length : 0,
    updatedAt: schedule.updatedAt ?? null,
  };
}

router.get('/:scheduleId', async (req: Request, res: Response) => {
  try {
    const schedule: any = await scheduleDb.getScheduleById(req.params.scheduleId);
    if (!schedule) return res.status(404).json({ error: 'Scheduled chat not found' });
    return res.json({ schedule: summarize(schedule) });
  } catch (error: any) {
    console.error('adminScheduledChats get error:', error?.message ?? error);
    return res.status(500).json({ error: 'Failed to load scheduled chat' });
  }
});

router.patch('/:scheduleId/status', async (req: Request, res: Response) => {
  const actor = req.user as any;
  const { scheduleId } = req.params;
  const { status, expectedStatus } = req.body || {};
  if (!TOGGLEABLE.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be "active" or "paused"' });
  }
  try {
    const schedule: any = await scheduleDb.getScheduleById(scheduleId);
    if (!schedule) return res.status(404).json({ error: 'Scheduled chat not found' });

    const before = schedule.status;
    if (expectedStatus !== undefined && expectedStatus !== before) {
      return res.status(409).json({ error: 'Schedule status changed since it was read', currentStatus: before });
    }
    if (before === status) {
      return res.json({ unchanged: true, schedule: summarize(schedule) });
    }
    if (!TOGGLEABLE.includes(before)) {
      return res.status(409).json({ error: `Only active/paused schedules can be toggled (current: ${before})` });
    }

    if (status === 'active') {
      // A limited schedule that exhausted its runs (runCount 0) would be
      // decremented to -1 (= unlimited) by the scheduler; refuse instead.
      if (typeof schedule.runCount === 'number' && schedule.runCount !== -1 && schedule.runCount <= 0) {
        return res.status(409).json({
          error: 'Schedule has no runs left; set a new run limit before resuming',
          runCount: schedule.runCount,
        });
      }
      // Resuming must clear the same gates the owner would face.
      if ((await isSubscriptionFeatureEnabled(schedule.userId, 'scheduled_chats')) !== true) {
        // Intended: an admin must not re-enable a paid feature the owner's plan lacks.
        console.warn('[admin-scheduled-chats] resume refused: owner plan lacks scheduled_chats', { scheduleId });
        return res.status(403).json({
          error: "Schedule owner's plan does not include scheduled chats",
          code: 'OWNER_PLAN_LACKS_SCHEDULED_CHATS',
        });
      }
      const owner: any = await userDb.getUserById(schedule.userId);
      const remediation = await checkScheduleActivationRecipients({
        scheduleId,
        recipients: normalizeEmailList(schedule.emailNotifications || []),
        ownerEmail: owner?.email,
        schedule,
      });
      if (remediation) {
        if (!deliveryEnforcementEnabled()) {
          logShadowDecision('rejected admin schedule resume', { scheduleId, owner: owner?.email, code: remediation.code });
        } else {
          return res.status(400).json({ error: remediation.safeAction, remediation });
        }
      }
    }

    const updatedAt = new Date().toISOString();
    try {
      await scheduleDb.updateSchedule(scheduleId, { status, updatedAt }, { status: before });
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException' || error?.name === 'ConditionalCheckFailedException') {
        return res.status(409).json({ error: 'Schedule status changed concurrently; re-read and retry' });
      }
      throw error;
    }

    recordAdminAudit({
      actorUserId: actor?.userId,
      actorEmail: actor?.email,
      action: 'scheduled_chat_status_update',
      scheduleId,
      scheduleOwnerUserId: schedule.userId,
      before,
      after: status,
      at: updatedAt,
    });

    return res.json({ schedule: summarize({ ...schedule, status, updatedAt }) });
  } catch (error: any) {
    console.error('adminScheduledChats status error:', error?.message ?? error);
    return res.status(500).json({ error: 'Failed to update scheduled chat status' });
  }
});

export default router;
