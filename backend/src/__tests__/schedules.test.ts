import request from 'supertest';
import express from 'express';
import scheduleRoutes from '../routes/schedules';
import { scheduleDb } from '../services/scheduleDb';
import { taskDb, userDb, orgDb } from '../services/db';
import { authenticateToken } from '../middleware/auth';

// Mock the dependencies
jest.mock('../services/scheduleDb');
jest.mock('../services/db');
jest.mock('../middleware/auth');
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

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

  describe('POST /api/schedules', () => {
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

    it('should create schedule when user owns the task', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });
      mockScheduleDb.createSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      expect(response.status).toBe(201);
      expect(mockTaskDb.getTaskById).toHaveBeenCalledWith(taskId);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalled();
    });

    it('should allow an admin to create a schedule for another user\'s task', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        ...mockTask,
        userId: otherUserId // Task owned by a different user
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId: 'admin-user',
        email: 'admin@example.com',
        isAdmin: true
      });
      mockScheduleDb.createSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      expect(response.status).toBe(201);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalled();
    });

    it('should return 404 without creating a schedule when the task belongs to another user', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        ...mockTask,
        userId: otherUserId // Task owned by a different user
      });
      mockUserDb.getUserById.mockResolvedValue({
        userId,
        email: 'test@example.com',
        isAdmin: false
      });

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('should return 404 without creating a schedule when the task does not exist', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        scheduleId: 'schedule-2',
        taskId,
        userId, // Schedule created by task owner
        frequency: 'weekly',
        status: 'active',
        nextRunTime: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
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
      mockTaskDb.getTaskById.mockResolvedValue(undefined);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
      expect(mockScheduleDb.getSchedulesByTaskId).not.toHaveBeenCalled();
    });

    it('should return 404 when user does not exist', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(undefined);

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
      mockScheduleDb.getScheduleById.mockResolvedValue(null as any);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Schedule not found');
    });

    it('should return 404 when task does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(undefined);

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
      mockScheduleDb.getScheduleById.mockResolvedValue(null as any);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Schedule not found');
    });

    it('should return 404 when task does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 when user does not exist', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
      mockUserDb.getUserById.mockResolvedValue(undefined);

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          scheduleId: 'schedule-2',
          taskId,
          userId: 'another-user',
          frequency: 'weekly',
          status: 'active',
          nextRunTime: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
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

  describe('Org-share access (knowledgeBase feature)', () => {
    const taskId = 'task-123';
    const scheduleId = 'schedule-123';
    const ownerId = 'task-owner';
    const orgId = 'org-1';
    const orgOwnerId = 'org-owner-id';

    const mockTask = {
      taskId,
      userId: ownerId,
      name: 'Test Task',
      prompt: 'Test prompt',
      status: 'active',
      createdAt: new Date().toISOString()
    };

    const mockSchedule = {
      scheduleId,
      taskId,
      userId: ownerId,
      frequency: 'daily',
      status: 'active',
      nextRunTime: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const asActingUser = (userId: string) => {
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = { userId, email: `${userId}@example.com` };
        next();
        return undefined;
      });
    };

    const orgSharingEnabled = () => ({
      orgId,
      ownerUserId: orgOwnerId,
      shareSettings: { knowledgeBase: { enabled: true, editors: [] } }
    });

    const orgSharingDisabled = () => ({
      orgId,
      ownerUserId: orgOwnerId,
      shareSettings: { knowledgeBase: { enabled: false, editors: [] } }
    });

    const orgWithEditor = (editorUserId: string) => ({
      orgId,
      ownerUserId: orgOwnerId,
      shareSettings: { knowledgeBase: { enabled: false, editors: [editorUserId] } }
    });

    beforeEach(() => {
      mockTaskDb.getTaskById.mockResolvedValue(mockTask);
    });

    it('createSchedule: org admin can schedule an org-mate\'s task when sharing is enabled', async () => {
      const orgAdminId = 'org-admin';
      asActingUser(orgAdminId);
      mockUserDb.getUserById.mockImplementation(async (id: string) =>
        id === orgAdminId
          ? { userId: orgAdminId, email: 'a@example.com', isAdmin: false, orgId, orgRole: 'admin' as any }
          : { userId: ownerId, email: 'o@example.com', isAdmin: false, orgId }
      );
      mockOrgDb.getOrgById.mockResolvedValue(orgSharingEnabled() as any);
      mockScheduleDb.createSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      expect(response.status).toBe(201);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalled();
    });

    it('createSchedule: a plain org member (not editor/admin) is still blocked even when sharing is enabled', async () => {
      const memberId = 'org-plain-member';
      asActingUser(memberId);
      mockUserDb.getUserById.mockImplementation(async (id: string) =>
        id === memberId
          ? { userId: memberId, email: 'm@example.com', isAdmin: false, orgId, orgRole: 'member' as any }
          : { userId: ownerId, email: 'o@example.com', isAdmin: false, orgId }
      );
      mockOrgDb.getOrgById.mockResolvedValue(orgSharingEnabled() as any);

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      // Viewing is fanned out to plain members when enabled, but editing (including
      // scheduling) still requires org:content:manage or a listed editor.
      expect(response.status).toBe(404);
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it('createSchedule: a listed editor can schedule the task even when the feature is otherwise disabled', async () => {
      const editorId = 'org-editor';
      asActingUser(editorId);
      mockUserDb.getUserById.mockImplementation(async (id: string) =>
        id === editorId
          ? { userId: editorId, email: 'e@example.com', isAdmin: false, orgId, orgRole: 'member' as any }
          : { userId: ownerId, email: 'o@example.com', isAdmin: false, orgId }
      );
      mockOrgDb.getOrgById.mockResolvedValue(orgWithEditor(editorId) as any);
      mockScheduleDb.createSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      expect(response.status).toBe(201);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalled();
    });

    it('getSchedulesByTaskId: a plain org member CAN view schedules when sharing is enabled', async () => {
      const memberId = 'org-plain-member';
      asActingUser(memberId);
      mockUserDb.getUserById.mockResolvedValue({ userId: memberId, email: 'm@example.com', isAdmin: false, orgId });
      mockOrgDb.getOrgById.mockResolvedValue(orgSharingEnabled() as any);
      mockScheduleDb.getSchedulesByTaskId.mockResolvedValue([mockSchedule]);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(mockScheduleDb.getSchedulesByTaskId).toHaveBeenCalledWith(taskId);
    });

    it('getSchedulesByTaskId: a plain org member is blocked when sharing is disabled', async () => {
      const memberId = 'org-plain-member';
      asActingUser(memberId);
      mockUserDb.getUserById.mockResolvedValue({ userId: memberId, email: 'm@example.com', isAdmin: false, orgId });
      mockOrgDb.getOrgById.mockResolvedValue(orgSharingDisabled() as any);

      const response = await request(app)
        .get(`/api/schedules/task/${taskId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(403);
      expect(mockScheduleDb.getSchedulesByTaskId).not.toHaveBeenCalled();
    });

    it('updateSchedule: an org admin can update a schedule on an org-mate\'s task', async () => {
      const orgAdminId = 'org-admin';
      asActingUser(orgAdminId);
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockUserDb.getUserById.mockImplementation(async (id: string) =>
        id === orgAdminId
          ? { userId: orgAdminId, email: 'a@example.com', isAdmin: false, orgId, orgRole: 'admin' as any }
          : { userId: ownerId, email: 'o@example.com', isAdmin: false, orgId }
      );
      mockOrgDb.getOrgById.mockResolvedValue(orgSharingEnabled() as any);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .put(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token')
        .send({ status: 'paused' });

      expect(response.status).toBe(200);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalled();
    });

    it('deleteSchedule: a listed editor can delete a schedule on an org-mate\'s task', async () => {
      const editorId = 'org-editor';
      asActingUser(editorId);
      mockScheduleDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockUserDb.getUserById.mockImplementation(async (id: string) =>
        id === editorId
          ? { userId: editorId, email: 'e@example.com', isAdmin: false, orgId, orgRole: 'member' as any }
          : { userId: ownerId, email: 'o@example.com', isAdmin: false, orgId }
      );
      mockOrgDb.getOrgById.mockResolvedValue(orgWithEditor(editorId) as any);
      mockScheduleDb.deleteSchedule.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/schedules/${scheduleId}`)
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(mockScheduleDb.deleteSchedule).toHaveBeenCalled();
    });

    it('createSchedule: a different org entirely stays blocked (cross-tenant, not just cross-user)', async () => {
      const outsiderId = 'outsider-different-org';
      asActingUser(outsiderId);
      mockUserDb.getUserById.mockImplementation(async (id: string) =>
        id === outsiderId
          ? { userId: outsiderId, email: 'x@example.com', isAdmin: false, orgId: 'org-2', orgRole: 'admin' as any }
          : { userId: ownerId, email: 'o@example.com', isAdmin: false, orgId }
      );

      const response = await request(app)
        .post('/api/schedules')
        .set('Authorization', 'Bearer test-token')
        .send({ taskId, frequency: 'daily' });

      // resolveTaskOrgContext only resolves an org when ownerOrgId === actingUser.orgId,
      // so a same-privilege admin of a DIFFERENT org never even reaches orgDb.getOrgById.
      expect(response.status).toBe(404);
      expect(mockOrgDb.getOrgById).not.toHaveBeenCalled();
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });
  });
});

