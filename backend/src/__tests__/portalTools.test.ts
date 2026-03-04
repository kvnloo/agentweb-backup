/**
 * Tests for portal MCP tools (portal_* prefix).
 *
 * Each tool is tested via the mcpToolRegistry.execute() path to validate:
 * - userId presence check
 * - Ownership verification (cross-user access denied)
 * - Correct service functions called with correct args
 * - Error handling (not found, access denied)
 */

// ─── Mock db.ts service layer ───────────────────────────────────────────────

const mockGetTasksByUserId = jest.fn();
const mockGetTaskById = jest.fn();
const mockCreateTask = jest.fn();
const mockUpdateTask = jest.fn();
const mockDeleteTask = jest.fn();
const mockCreateTaskExecution = jest.fn();
const mockGetTaskExecutions = jest.fn();
const mockGetTaskExecutionById = jest.fn();

const mockGetScheduleById = jest.fn();
const mockGetSchedulesByTaskId = jest.fn();
const mockCreateSchedule = jest.fn();
const mockUpdateSchedule = jest.fn();
const mockDeleteSchedule = jest.fn();

jest.mock('../services/db', () => ({
  taskDb: {
    getTasksByUserId: (...args: any[]) => mockGetTasksByUserId(...args),
    getTaskById: (...args: any[]) => mockGetTaskById(...args),
    createTask: (...args: any[]) => mockCreateTask(...args),
    updateTask: (...args: any[]) => mockUpdateTask(...args),
    deleteTask: (...args: any[]) => mockDeleteTask(...args),
    createTaskExecution: (...args: any[]) => mockCreateTaskExecution(...args),
    getTaskExecutions: (...args: any[]) => mockGetTaskExecutions(...args),
    getTaskExecutionById: (...args: any[]) => mockGetTaskExecutionById(...args),
  },
  scheduleDb: {
    getScheduleById: (...args: any[]) => mockGetScheduleById(...args),
    getSchedulesByTaskId: (...args: any[]) => mockGetSchedulesByTaskId(...args),
    createSchedule: (...args: any[]) => mockCreateSchedule(...args),
    updateSchedule: (...args: any[]) => mockUpdateSchedule(...args),
    deleteSchedule: (...args: any[]) => mockDeleteSchedule(...args),
  },
  userDb: { getUserById: jest.fn() },
}));

// ─── Mock uuid ───────────────────────────────────────────────────────────────

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid-1234'),
}));

// ─── Mock AWS SDK (needed by agentApiKeyService imported transitively) ──────

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
    },
    S3: jest.fn(() => ({})),
  },
}));

// ─── Import registry AFTER mocks ────────────────────────────────────────────

import { mcpToolRegistry } from '../mcp/server/registry';

// Force tool registration by importing portalTools
import '../mcp/server/portalTools';

// ─── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = 'user-abc-123';
const OTHER_USER = 'user-other-456';
const TASK_ID = 'task-xyz-789';
const EXEC_ID = 'exec-qwe-321';
const SCHED_ID = 'sched-rty-654';

function ownedTask(overrides: any = {}) {
  return {
    taskId: TASK_ID,
    userId: USER_ID,
    name: 'Test Task',
    prompt: 'Do something',
    status: 'active',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function ownedSchedule(overrides: any = {}) {
  return {
    scheduleId: SCHED_ID,
    taskId: TASK_ID,
    userId: USER_ID,
    frequency: 'daily',
    nextRunTime: '2025-01-02T00:00:00.000Z',
    status: 'active',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe('Portal MCP Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Auth checks (shared pattern) ──────────────────────────────────────

  describe('Authentication', () => {
    const toolNames = [
      'portal_list_tasks',
      'portal_get_task',
      'portal_create_task',
      'portal_update_task',
      'portal_delete_task',
      'portal_execute_task',
      'portal_get_task_executions',
      'portal_get_execution_details',
      'portal_list_schedules',
      'portal_create_schedule',
      'portal_update_schedule',
      'portal_delete_schedule',
    ];

    it.each(toolNames)('%s should reject when no userId in context', async (toolName) => {
      await expect(
        mcpToolRegistry.execute(toolName, {}, {})
      ).rejects.toThrow('Authentication required');
    });

    it.each(toolNames)('%s should reject when context is undefined', async (toolName) => {
      await expect(
        mcpToolRegistry.execute(toolName, {}, undefined)
      ).rejects.toThrow('Authentication required');
    });
  });

  // ─── Task tools ────────────────────────────────────────────────────────

  describe('portal_list_tasks', () => {
    it('should return tasks for the authenticated user', async () => {
      mockGetTasksByUserId.mockResolvedValue([ownedTask(), ownedTask({ taskId: 'task-2', name: 'Task 2' })]);

      const result = await mcpToolRegistry.execute('portal_list_tasks', {}, { userId: USER_ID });

      expect(mockGetTasksByUserId).toHaveBeenCalledWith(USER_ID);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].taskId).toBe(TASK_ID);
    });

    it('should return empty array when user has no tasks', async () => {
      mockGetTasksByUserId.mockResolvedValue([]);

      const result = await mcpToolRegistry.execute('portal_list_tasks', {}, { userId: USER_ID });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual([]);
    });
  });

  describe('portal_get_task', () => {
    it('should return task details for owned task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask());

      const result = await mcpToolRegistry.execute('portal_get_task', { taskId: TASK_ID }, { userId: USER_ID });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.taskId).toBe(TASK_ID);
      expect(parsed.name).toBe('Test Task');
    });

    it('should reject access to another user\'s task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask({ userId: OTHER_USER }));

      await expect(
        mcpToolRegistry.execute('portal_get_task', { taskId: TASK_ID }, { userId: USER_ID })
      ).rejects.toThrow('Access denied');
    });

    it('should throw when task not found', async () => {
      mockGetTaskById.mockResolvedValue(undefined);

      await expect(
        mcpToolRegistry.execute('portal_get_task', { taskId: 'nonexistent' }, { userId: USER_ID })
      ).rejects.toThrow('Task not found');
    });
  });

  describe('portal_create_task', () => {
    it('should create a task with required fields', async () => {
      mockCreateTask.mockResolvedValue(ownedTask());

      const result = await mcpToolRegistry.execute(
        'portal_create_task',
        { name: 'Test Task', prompt: 'Do something' },
        { userId: USER_ID }
      );

      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'mock-uuid-1234',
          userId: USER_ID,
          name: 'Test Task',
          prompt: 'Do something',
          status: 'active',
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.taskId).toBe(TASK_ID);
    });

    it('should pass optional category and description', async () => {
      mockCreateTask.mockResolvedValue(ownedTask());

      await mcpToolRegistry.execute(
        'portal_create_task',
        { name: 'T', prompt: 'P', category: 'marketing', description: 'Desc' },
        { userId: USER_ID }
      );

      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'marketing',
          description: 'Desc',
        })
      );
    });
  });

  describe('portal_update_task', () => {
    it('should update owned task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask());
      mockUpdateTask.mockResolvedValue(ownedTask({ name: 'Updated' }));

      const result = await mcpToolRegistry.execute(
        'portal_update_task',
        { taskId: TASK_ID, name: 'Updated' },
        { userId: USER_ID }
      );

      expect(mockUpdateTask).toHaveBeenCalledWith(TASK_ID, { name: 'Updated' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.name).toBe('Updated');
    });

    it('should reject update to another user\'s task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask({ userId: OTHER_USER }));

      await expect(
        mcpToolRegistry.execute('portal_update_task', { taskId: TASK_ID, name: 'Hack' }, { userId: USER_ID })
      ).rejects.toThrow('Access denied');
    });
  });

  describe('portal_delete_task', () => {
    it('should delete owned task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask());
      mockDeleteTask.mockResolvedValue(undefined);

      const result = await mcpToolRegistry.execute(
        'portal_delete_task',
        { taskId: TASK_ID },
        { userId: USER_ID }
      );

      expect(mockDeleteTask).toHaveBeenCalledWith(TASK_ID);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
    });

    it('should reject delete of another user\'s task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask({ userId: OTHER_USER }));

      await expect(
        mcpToolRegistry.execute('portal_delete_task', { taskId: TASK_ID }, { userId: USER_ID })
      ).rejects.toThrow('Access denied');
    });
  });

  describe('portal_execute_task', () => {
    it('should create a pending execution for owned task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask());
      mockCreateTaskExecution.mockResolvedValue({
        executionId: 'mock-uuid-1234',
        taskId: TASK_ID,
        userId: USER_ID,
        status: 'pending',
      });

      const result = await mcpToolRegistry.execute(
        'portal_execute_task',
        { taskId: TASK_ID },
        { userId: USER_ID }
      );

      expect(mockCreateTaskExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: TASK_ID,
          userId: USER_ID,
          status: 'pending',
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('pending');
    });
  });

  describe('portal_get_task_executions', () => {
    it('should return executions for owned task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask());
      mockGetTaskExecutions.mockResolvedValue([
        { executionId: 'e1', status: 'completed', startTime: '2025-01-01T00:00:00.000Z' },
        { executionId: 'e2', status: 'pending', startTime: '2025-01-02T00:00:00.000Z' },
      ]);

      const result = await mcpToolRegistry.execute(
        'portal_get_task_executions',
        { taskId: TASK_ID },
        { userId: USER_ID }
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].executionId).toBe('e1');
    });
  });

  describe('portal_get_execution_details', () => {
    it('should return execution details for owned execution', async () => {
      mockGetTaskExecutionById.mockResolvedValue({
        executionId: EXEC_ID,
        taskId: TASK_ID,
        userId: USER_ID,
        status: 'completed',
        result: 'Done!',
      });

      const result = await mcpToolRegistry.execute(
        'portal_get_execution_details',
        { executionId: EXEC_ID },
        { userId: USER_ID }
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.executionId).toBe(EXEC_ID);
      expect(parsed.result).toBe('Done!');
    });

    it('should reject access to another user\'s execution', async () => {
      mockGetTaskExecutionById.mockResolvedValue({
        executionId: EXEC_ID,
        userId: OTHER_USER,
      });

      await expect(
        mcpToolRegistry.execute('portal_get_execution_details', { executionId: EXEC_ID }, { userId: USER_ID })
      ).rejects.toThrow('Access denied');
    });

    it('should throw when execution not found', async () => {
      mockGetTaskExecutionById.mockResolvedValue(undefined);

      await expect(
        mcpToolRegistry.execute('portal_get_execution_details', { executionId: 'missing' }, { userId: USER_ID })
      ).rejects.toThrow('Execution not found');
    });
  });

  // ─── Schedule tools ────────────────────────────────────────────────────

  describe('portal_list_schedules', () => {
    it('should return schedules for owned task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask());
      mockGetSchedulesByTaskId.mockResolvedValue([ownedSchedule()]);

      const result = await mcpToolRegistry.execute(
        'portal_list_schedules',
        { taskId: TASK_ID },
        { userId: USER_ID }
      );

      expect(mockGetSchedulesByTaskId).toHaveBeenCalledWith(TASK_ID);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].scheduleId).toBe(SCHED_ID);
    });
  });

  describe('portal_create_schedule', () => {
    it('should create a schedule for owned task', async () => {
      mockGetTaskById.mockResolvedValue(ownedTask());
      mockCreateSchedule.mockResolvedValue(ownedSchedule());

      const result = await mcpToolRegistry.execute(
        'portal_create_schedule',
        {
          taskId: TASK_ID,
          frequency: 'daily',
          nextRunTime: '2025-01-02T00:00:00.000Z',
          scheduleName: 'My Schedule',
        },
        { userId: USER_ID }
      );

      expect(mockCreateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: TASK_ID,
          userId: USER_ID,
          frequency: 'daily',
          status: 'active',
          scheduleName: 'My Schedule',
        })
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.scheduleId).toBe(SCHED_ID);
    });
  });

  describe('portal_update_schedule', () => {
    it('should update owned schedule', async () => {
      mockGetScheduleById.mockResolvedValue(ownedSchedule());
      mockUpdateSchedule.mockResolvedValue(ownedSchedule({ status: 'inactive' }));

      const result = await mcpToolRegistry.execute(
        'portal_update_schedule',
        { scheduleId: SCHED_ID, status: 'inactive' },
        { userId: USER_ID }
      );

      expect(mockUpdateSchedule).toHaveBeenCalledWith(SCHED_ID, { status: 'inactive' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('inactive');
    });

    it('should reject update to another user\'s schedule', async () => {
      mockGetScheduleById.mockResolvedValue(ownedSchedule({ userId: OTHER_USER }));

      await expect(
        mcpToolRegistry.execute('portal_update_schedule', { scheduleId: SCHED_ID, status: 'inactive' }, { userId: USER_ID })
      ).rejects.toThrow('Access denied');
    });
  });

  describe('portal_delete_schedule', () => {
    it('should delete owned schedule', async () => {
      mockGetScheduleById.mockResolvedValue(ownedSchedule());
      mockDeleteSchedule.mockResolvedValue(undefined);

      const result = await mcpToolRegistry.execute(
        'portal_delete_schedule',
        { scheduleId: SCHED_ID },
        { userId: USER_ID }
      );

      expect(mockDeleteSchedule).toHaveBeenCalledWith(SCHED_ID);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
    });

    it('should reject delete of another user\'s schedule', async () => {
      mockGetScheduleById.mockResolvedValue(ownedSchedule({ userId: OTHER_USER }));

      await expect(
        mcpToolRegistry.execute('portal_delete_schedule', { scheduleId: SCHED_ID }, { userId: USER_ID })
      ).rejects.toThrow('Access denied');
    });

    it('should throw when schedule not found', async () => {
      mockGetScheduleById.mockResolvedValue(undefined);

      await expect(
        mcpToolRegistry.execute('portal_delete_schedule', { scheduleId: 'missing' }, { userId: USER_ID })
      ).rejects.toThrow('Schedule not found');
    });
  });

  // ─── Tool registration verification ────────────────────────────────────

  describe('Tool registration', () => {
    const expectedTools = [
      'portal_list_tasks',
      'portal_get_task',
      'portal_create_task',
      'portal_update_task',
      'portal_delete_task',
      'portal_execute_task',
      'portal_get_task_executions',
      'portal_get_execution_details',
      'portal_list_schedules',
      'portal_create_schedule',
      'portal_update_schedule',
      'portal_delete_schedule',
    ];

    it.each(expectedTools)('should have %s registered in the registry', (toolName) => {
      expect(mcpToolRegistry.getTool(toolName)).toBeDefined();
    });

    it('should have all 12 portal tools registered', () => {
      const allTools = mcpToolRegistry.getToolNames();
      const portalTools = allTools.filter(n => n.startsWith('portal_'));
      expect(portalTools).toHaveLength(12);
    });
  });
});
