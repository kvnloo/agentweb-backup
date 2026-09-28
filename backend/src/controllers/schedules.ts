import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../middleware/auth';
import { scheduleDb, Schedule } from '../services/scheduleDb';
import { calculateNextRunTime, isValidFrequency, Frequency } from '../utils/scheduleUtils';
import { userDb, taskDb, orgDb } from '../services/db';
import { canViewItem, canEditItem } from '../services/orgShareService';
import type { OrgRole } from '../services/orgAuthz';

// Schedules are task-scoped, so they follow the same org-share permission
// model tasks.ts uses for getTask/updateTask (canViewItem/canEditItem gated
// by the 'knowledgeBase' feature toggle) rather than a separate schedule-only
// sharing config — a schedule is just a timetable attached to a task, and
// mirroring the task's own sharing rules keeps "can I edit this task" and
// "can I schedule this task" from silently diverging.
async function resolveTaskOrgContext(
  taskOwnerId: string,
  actingUser: { userId: string; orgId?: string; orgRole?: OrgRole }
) {
  const ownerUser = taskOwnerId !== actingUser.userId ? await userDb.getUserById(taskOwnerId) : null;
  const ownerOrgId = ownerUser?.orgId ?? actingUser.orgId;
  const org = (actingUser.orgId && ownerOrgId === actingUser.orgId)
    ? await orgDb.getOrgById(actingUser.orgId)
    : null;
  return { org, ownerOrgId };
}

export async function createSchedule(req: AuthenticatedRequest, res: Response) {
  try {
    const { taskId, frequency } = req.body;
    const userId = req.user?.userId;

    if (!taskId || !frequency || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!isValidFrequency(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }

    // Load the task and confirm ownership before creating a schedule against it.
    // 404 (not 403) so the endpoint does not confirm which task ids exist.
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Check if user is admin, owns the task, or has org-share edit access to it
    const user = await userDb.getUserById(userId);
    if (!user?.isAdmin) {
      const { org, ownerOrgId } = await resolveTaskOrgContext(task.userId, { userId, orgId: user?.orgId, orgRole: user?.orgRole });
      if (!canEditItem({ userId: task.userId }, { userId, orgId: user?.orgId, orgRole: user?.orgRole }, org, ownerOrgId, 'knowledgeBase')) {
        return res.status(404).json({ error: 'Task not found' });
      }
    }

    const schedule: Schedule = {
      scheduleId: uuidv4(),
      taskId,
      userId,
      frequency,
      status: 'active',
      nextRunTime: calculateNextRunTime(frequency as Frequency),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await scheduleDb.createSchedule(schedule);
    res.status(201).json(schedule);
  } catch (error) {
    console.error('Error creating schedule:', error);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
}

export async function getSchedulesByTaskId(req: AuthenticatedRequest, res: Response) {
  try {
    const { taskId } = req.params;
    const userId = req.user?.userId;

    if (!taskId || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get the task to check ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Verify user exists and check task ownership
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user is admin, owns the task, or has org-share view access to it
    if (!user.isAdmin) {
      const { org, ownerOrgId } = await resolveTaskOrgContext(task.userId, { userId, orgId: user.orgId, orgRole: user.orgRole });
      if (!canViewItem({ userId: task.userId }, { userId, orgId: user.orgId, orgRole: user.orgRole }, org, ownerOrgId, 'knowledgeBase')) {
        return res.status(403).json({ error: 'Not authorized to view schedules for this task' });
      }
    }

    // Return all schedules for the task
    const schedules = await scheduleDb.getSchedulesByTaskId(taskId);
    res.json(schedules);
  } catch (error) {
    console.error('Error getting schedules:', error);
    res.status(500).json({ error: 'Failed to get schedules' });
  }
}

export async function updateSchedule(req: AuthenticatedRequest, res: Response) {
  try {
    const { scheduleId } = req.params;
    const { frequency, status } = req.body;
    const userId = req.user?.userId;

    if (!scheduleId || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const schedule = await scheduleDb.getScheduleById(scheduleId);
    
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Get the task to check ownership
    const task = await taskDb.getTaskById(schedule.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Verify user exists and check task ownership
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user is admin, owns the task, or has org-share edit access to it
    if (!user.isAdmin) {
      const { org, ownerOrgId } = await resolveTaskOrgContext(task.userId, { userId, orgId: user.orgId, orgRole: user.orgRole });
      if (!canEditItem({ userId: task.userId }, { userId, orgId: user.orgId, orgRole: user.orgRole }, org, ownerOrgId, 'knowledgeBase')) {
        return res.status(403).json({ error: 'Not authorized to update this schedule' });
      }
    }

    const updates: Partial<Schedule> = {
      updatedAt: new Date().toISOString()
    };

    if (frequency) {
      if (!isValidFrequency(frequency)) {
        return res.status(400).json({ error: 'Invalid frequency' });
      }
      updates.frequency = frequency;
      updates.nextRunTime = calculateNextRunTime(frequency as Frequency);
    }

    if (status) {
      if (!['active', 'paused'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updates.status = status;
    }

    // Only proceed if there are actual updates to apply
    if (Object.keys(updates).length > 1) { // More than just updatedAt
      await scheduleDb.updateSchedule(scheduleId, updates);
      res.json({ message: 'Schedule updated successfully' });
    } else {
      res.status(400).json({ error: 'No valid updates provided' });
    }
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
}

export async function deleteSchedule(req: AuthenticatedRequest, res: Response) {
  try {
    const { scheduleId } = req.params;
    const userId = req.user?.userId;

    if (!scheduleId || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const schedule = await scheduleDb.getScheduleById(scheduleId);
    
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    // Get the task to check ownership
    const task = await taskDb.getTaskById(schedule.taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Verify user exists and check task ownership
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user is admin, owns the task, or has org-share edit access to it
    if (!user.isAdmin) {
      const { org, ownerOrgId } = await resolveTaskOrgContext(task.userId, { userId, orgId: user.orgId, orgRole: user.orgRole });
      if (!canEditItem({ userId: task.userId }, { userId, orgId: user.orgId, orgRole: user.orgRole }, org, ownerOrgId, 'knowledgeBase')) {
        return res.status(403).json({ error: 'Not authorized to delete this schedule' });
      }
    }

    await scheduleDb.deleteSchedule(scheduleId);
    res.json({ message: 'Schedule deleted successfully' });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
} 