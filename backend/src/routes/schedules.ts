import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  createSchedule,
  getSchedulesByTaskId,
  updateSchedule,
  deleteSchedule
} from '../controllers/schedules';

const router = express.Router();

// Helper function to wrap async handlers
const asyncHandler = (fn: (req: AuthenticatedRequest, res: Response) => Promise<any>) => {
  return (req: Request, res: Response, next: express.NextFunction) => {
    Promise.resolve(fn(req as AuthenticatedRequest, res)).catch(next);
  };
};

// All routes require authentication
router.use(authenticateToken);

// Schedule routes
router.post('/', asyncHandler(createSchedule));
router.get('/task/:taskId', asyncHandler(getSchedulesByTaskId));
router.put('/:scheduleId', asyncHandler(updateSchedule));
router.delete('/:scheduleId', asyncHandler(deleteSchedule));

export default router; 