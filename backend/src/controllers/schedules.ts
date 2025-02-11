import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../middleware/auth';
import { scheduleDb, Schedule } from '../services/scheduleDb';
import { calculateNextRunTime, isValidFrequency, Frequency } from '../utils/scheduleUtils';

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

    const schedules = await scheduleDb.getSchedulesByTaskId(taskId);
    
    // Filter schedules to only return those belonging to the user
    const userSchedules = schedules.filter(schedule => schedule.userId === userId);
    res.json(userSchedules);
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

    if (schedule.userId !== userId) {
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

    await scheduleDb.updateSchedule(scheduleId, updates);
    res.json({ message: 'Schedule updated successfully' });
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

    if (schedule.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to delete this schedule' });
    }

    await scheduleDb.deleteSchedule(scheduleId);
    res.json({ message: 'Schedule deleted successfully' });
  } catch (error) {
    console.error('Error deleting schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
} 