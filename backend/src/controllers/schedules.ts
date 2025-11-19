import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../middleware/auth';
import { scheduleDb, Schedule } from '../services/scheduleDb';
import { calculateNextRunTime, isValidFrequency, Frequency } from '../utils/scheduleUtils';
import { userDb, taskDb } from '../services/db';

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

    // Check if user is admin or owns the task
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to view schedules for this task' });
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

    // Check if user is admin or owns the task
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to update this schedule' });
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

    // Check if user is admin or owns the task
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to delete this schedule' });
    }

    await scheduleDb.deleteSchedule(scheduleId);
    res.json({ message: 'Schedule deleted successfully' });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
} 