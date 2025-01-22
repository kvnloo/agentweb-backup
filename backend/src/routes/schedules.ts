import express from 'express';
import { createSchedule, getSchedulesByTaskId, updateSchedule, deleteSchedule } from '../controllers/schedules';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// Apply authentication middleware to all schedule routes
router.use(authenticateToken);

// Schedule routes
router.post('/', createSchedule);
router.get('/task/:taskId', getSchedulesByTaskId);
router.put('/:scheduleId', updateSchedule);
router.delete('/:scheduleId', deleteSchedule);

export default router; 