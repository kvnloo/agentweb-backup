import request from 'supertest';
import express from 'express';
import scheduleRoutes from '../routes/schedules';
import { scheduleDb } from '../services/scheduleDb';
import { taskDb, userDb } from '../services/db';
import { authenticateToken } from '../middleware/auth';

// Mock the dependencies
jest.mock('../services/scheduleDb');
jest.mock('../services/db');
jest.mock('../middleware/auth');
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

let app: express.Application;

describe('Schedules Controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create a fresh Express app for each test
    app = express();
    app.use(express.json());
    
    // Mock authenticateToken to pass through with default user
    mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
      // Default to regular user, can be overridden in tests
      (req as any).user = {
        userId: 'test-user-1',
        email: 'test@example.com'
      };
      next();
      return undefined;
    });
    
    app.use('/api/schedules', scheduleRoutes);
  });

  describe('GET /api/schedules/task/:taskId', () => {
    const taskId = 'task-123';
    const userId = 'test-user-1';
    const otherUserId = 'test-user-2';

    const mockTask = {
      taskId,
      userId,
      name: 'Test Task',
      prompt: 'Test prompt',
      status: 'active',
      createdAt: new Date().toISOString()
    };

    const mockSchedules = [
      {
        scheduleId: 'schedule-1',
        taskId,
        userId: otherUserId, // Schedule created by different user
        frequency: 'daily',
        status: 'active',
        nextRunTime: new Date().toISOString(),
        createdAt: new Date().toISOString()
      },
      {
        scheduleId: 'schedule-2',
        taskId,
        userId, // Schedule created by task owner
        frequency: 'weekly',
        status: 'active',
        nextRunTime: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    ];

    it('should return all schedules for a task when user owns the task', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });
      mockScheduleDb.getSchedulesByTaskId.mockResolvedValue(mockSchedules);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockSchedules);
      expect(mockTaskDb.getTaskById).toHaveBeenCalledWith(taskId);
      expect(mockScheduleDb.getSchedulesByTaskId).toHaveBeenCalledWith(taskId);
      // Should return ALL schedules, not filtered by schedule.userId
      expect(response.body.length).toBe(2);
    });

    it('should return all schedules for a task when user is admin', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'admin-user',
        email: 'admin@example.com',
        isAdmin: true
      });
      mockScheduleDb.getSchedulesByTaskId.mockResolvedValue(mockSchedules);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockSchedules);
      expect(mockTaskDb.getTaskById).toHaveBeenCalledWith(taskId);
      expect(mockScheduleDb.getSchedulesByTaskId).toHaveBeenCalledWith(taskId);
    });

    it('should return 403 when user does not own the task', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        ...mockTask,
        userId: otherUserId // Task owned by different user
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Not authorized to view schedules for this task');
      expect(mockScheduleDb.getSchedulesByTaskId).not.toHaveBeenCalled();
    });

    it('should return 404 when task does not exist', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
      expect(mockScheduleDb.getSchedulesByTaskId).not.toHaveBeenCalled();
    });

    it('should return 404 when user does not exist', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('User not found');
    });
  });

  describe('PUT /api/schedules/:scheduleId', () => {
    const scheduleId = 'schedule-123';
    const taskId = 'task-123';
    const userId = 'test-user-1';
    const otherUserId = 'test-user-2';

    const mockSchedule = {
      scheduleId,
      taskId,
      userId: otherUserId, // Schedule created by different user
      frequency: 'daily',
      status: 'active',
      nextRunTime: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    const mockTask = {
      taskId,
      userId, // Task owned by current user
      name: 'Test Task',
      prompt: 'Test prompt',
      status: 'active',
      createdAt: new Date().toISOString()
    };

    it('should update schedule when user owns the task (not schedule)', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Schedule updated successfully');
      expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith(scheduleId);
      expect(mockTaskDb.getTaskById).toHaveBeenCalledWith(taskId);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalled();
    });

    it('should update schedule when user is admin', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'admin-user',
        email: 'admin@example.com',
        isAdmin: true
      });
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Schedule updated successfully');
    });

    it('should return 403 when user does not own the task', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue({
        ...mockTask,
        userId: otherUserId // Task owned by different user
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Not authorized to update this schedule');
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    });

    it('should return 404 when schedule does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(null);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Schedule not found');
    });

    it('should return 404 when task does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(null);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should update frequency when provided', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ frequency: 'weekly' });

      expect(response.status).toBe(200);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalled();
      const updateCall = mockScheduleDb.updateSchedule.mock.calls[0];
      expect(updateCall[1].frequency).toBe('weekly');
    });

    it('should return 400 when no valid updates provided', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No valid updates provided');
    });
  });

  describe('DELETE /api/schedules/:scheduleId', () => {
    const scheduleId = 'schedule-123';
    const taskId = 'task-123';
    const userId = 'test-user-1';
    const otherUserId = 'test-user-2';

    const mockSchedule = {
      scheduleId,
      taskId,
      userId: otherUserId, // Schedule created by different user
      frequency: 'daily',
      status: 'active',
      nextRunTime: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    const mockTask = {
      taskId,
      userId, // Task owned by current user
      name: 'Test Task',
      prompt: 'Test prompt',
      status: 'active',
      createdAt: new Date().toISOString()
    };

    it('should delete schedule when user owns the task (not schedule)', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });
      mockScheduleDb.deleteSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Schedule deleted successfully');
      expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith(scheduleId);
      expect(mockTaskDb.getTaskById).toHaveBeenCalledWith(taskId);
      expect(mockScheduleDb.deleteSchedule).toHaveBeenCalledWith(scheduleId);
    });

    it('should delete schedule when user is admin', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'admin-user',
        email: 'admin@example.com',
        isAdmin: true
      });
      mockScheduleDb.deleteSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Schedule deleted successfully');
    });

    it('should return 403 when user does not own the task', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue({
        ...mockTask,
        userId: otherUserId // Task owned by different user
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Not authorized to delete this schedule');
      expect(mockScheduleDb.deleteSchedule).not.toHaveBeenCalled();
    });

    it('should return 404 when schedule does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(null);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Schedule not found');
    });

    it('should return 404 when task does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(null);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 when user does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(null);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('User not found');
    });
  });

  describe('Task ownership vs Schedule ownership', () => {
    const scheduleId = 'schedule-123';
    const taskId = 'task-123';
    const taskOwnerId = 'task-owner';
    const scheduleCreatorId = 'schedule-creator';
    const unauthorizedUserId = 'unauthorized-user';

    const mockSchedule = {
      scheduleId,
      taskId,
      userId: scheduleCreatorId, // Schedule created by schedule-creator
      frequency: 'daily',
      status: 'active',
      nextRunTime: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    const mockTask = {
      taskId,
      userId: taskOwnerId, // Task owned by task-owner
      name: 'Test Task',
      prompt: 'Test prompt',
      status: 'active',
      createdAt: new Date().toISOString()
    };

    it('should allow task owner to update schedule created by different user', async () => {
      // Override auth middleware to set task owner as the user
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = {
          userId: taskOwnerId,
          email: 'taskowner@example.com'
        };
        next();
        return undefined;
      });

      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: taskOwnerId,
        email: 'taskowner@example.com',
        isAdmin: false
      });
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      // Task owner should be able to update, even though they didn't create the schedule
      expect(response.status).toBe(200);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalled();
    });

    it('should allow task owner to delete schedule created by different user', async () => {
      // Override auth middleware to set task owner as the user
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = {
          userId: taskOwnerId,
          email: 'taskowner@example.com'
        };
        next();
        return undefined;
      });

      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: taskOwnerId,
        email: 'taskowner@example.com',
        isAdmin: false
      });
      mockScheduleDb.deleteSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      // Task owner should be able to delete, even though they didn't create the schedule
      expect(response.status).toBe(200);
      expect(mockScheduleDb.deleteSchedule).toHaveBeenCalled();
    });

    it('should NOT allow schedule creator to update if they do not own the task', async () => {
      // Override auth middleware to set schedule creator as the user
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = {
          userId: scheduleCreatorId,
          email: 'schedulecreator@example.com'
        };
        next();
        return undefined;
      });

      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: scheduleCreatorId,
        email: 'schedulecreator@example.com',
        isAdmin: false
      });

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      // Schedule creator should NOT be able to update if they don't own the task
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Not authorized to update this schedule');
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    });

    it('should NOT allow schedule creator to delete if they do not own the task', async () => {
      // Override auth middleware to set schedule creator as the user
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = {
          userId: scheduleCreatorId,
          email: 'schedulecreator@example.com'
        };
        next();
        return undefined;
      });

      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: scheduleCreatorId,
        email: 'schedulecreator@example.com',
        isAdmin: false
      });

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      // Schedule creator should NOT be able to delete if they don't own the task
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Not authorized to delete this schedule');
      expect(mockScheduleDb.deleteSchedule).not.toHaveBeenCalled();
    });

    it('should return all schedules for task owner, regardless of who created them', async () => {
      // Override auth middleware to set task owner as the user
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = {
          userId: taskOwnerId,
          email: 'taskowner@example.com'
        };
        next();
        return undefined;
      });

      const schedulesByDifferentUsers = [
        {
          scheduleId: 'schedule-1',
          taskId,
          userId: scheduleCreatorId,
          frequency: 'daily',
          status: 'active',
          nextRunTime: new Date().toISOString(),
          createdAt: new Date().toISOString()
        },
        {
          scheduleId: 'schedule-2',
          taskId,
          userId: 'another-user',
          frequency: 'weekly',
          status: 'active',
          nextRunTime: new Date().toISOString(),
          createdAt: new Date().toISOString()
        }
      ];

      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId: taskOwnerId,
        email: 'taskowner@example.com',
        isAdmin: false
      });
      mockScheduleDb.getSchedulesByTaskId.mockResolvedValue(schedulesByDifferentUsers);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      // Task owner should see ALL schedules, regardless of who created them
      expect(response.status).toBe(200);
      expect(response.body.length).toBe(2);
      expect(response.body).toEqual(schedulesByDifferentUsers);
    });
  });
});

