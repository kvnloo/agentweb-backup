/**
 * Tests for portal CRUD tools — now API-wrapping tools.
 *
 * The old portal_* tools (direct DB access) have been replaced by
 * manage_task, execute_task, list_tasks, etc. that call REST endpoints
 * via mcpFetch. This test verifies the new tools make correct HTTP calls.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getUnassociatedToolNames: jest.fn().mockReturnValue([]) },
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

const USER_ID = 'user-abc-123';
const TASK_ID = 'task-xyz-789';
const SCHED_ID = 'sched-rty-654';

const context = { userId: USER_ID, agentUserId: USER_ID };

describe('Portal CRUD Tools (API-wrapping)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── FAIL tests ───────────────────────────────────────────────────────

  describe('authentication required', () => {
    it('list_tasks should pass userId in context to mcpFetch', async () => {
      mockMcpFetch.mockResolvedValue([]);
      await mcpToolRegistry.execute('list_tasks', {}, context);
      expect(mockMcpFetch).toHaveBeenCalledWith(
        expect.objectContaining({ context: { userId: USER_ID, agentUserId: USER_ID } })
      );
    });

    it('manage_task create should pass userId in context', async () => {
      mockMcpFetch.mockResolvedValue({ taskId: 'new-1' });
      await mcpToolRegistry.execute('manage_task', {
        action: 'create', name: 'Test', prompt: 'Do things'
      }, context);
      expect(mockMcpFetch).toHaveBeenCalledWith(
        expect.objectContaining({ context: { userId: USER_ID, agentUserId: USER_ID } })
      );
    });

    it('manage_task should handle unknown action gracefully', async () => {
      const result = await mcpToolRegistry.execute('manage_task', { action: 'invalid' }, context);
      expect(result.content[0].text).toContain('Unknown action');
    });
  });

  // ─── Task CRUD tests ──────────────────────────────────────────────────

  describe('list_tasks', () => {
    it('should call GET /api/tasks', async () => {
      mockMcpFetch.mockResolvedValue([{ taskId: TASK_ID, name: 'Test' }]);
      const result = await mcpToolRegistry.execute('list_tasks', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith({
        method: 'GET', path: '/api/tasks',
        context: { userId: USER_ID, agentUserId: USER_ID }
      });
      expect(result.content[0].text).toContain(TASK_ID);
    });
  });

  describe('manage_task - create', () => {
    it('should call POST /api/tasks with correct body', async () => {
      mockMcpFetch.mockResolvedValue({ taskId: TASK_ID });
      await mcpToolRegistry.execute('manage_task', {
        action: 'create', name: 'New Task', prompt: 'Automate login'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST', path: '/api/tasks',
        body: expect.objectContaining({ name: 'New Task', prompt: 'Automate login' })
      }));
    });
  });

  describe('manage_task - get', () => {
    it('should call GET /api/tasks/:taskId', async () => {
      mockMcpFetch.mockResolvedValue({ taskId: TASK_ID, name: 'Test' });
      await mcpToolRegistry.execute('manage_task', { action: 'get', task_id: TASK_ID }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET', path: `/api/tasks/${TASK_ID}`
      }));
    });
  });

  describe('manage_task - update', () => {
    it('should call PUT /api/tasks/:taskId with updates', async () => {
      mockMcpFetch.mockResolvedValue({ taskId: TASK_ID, name: 'Updated' });
      await mcpToolRegistry.execute('manage_task', {
        action: 'update', task_id: TASK_ID, name: 'Updated'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PUT', path: `/api/tasks/${TASK_ID}`,
        body: expect.objectContaining({ name: 'Updated' })
      }));
    });
  });

  describe('manage_task - delete', () => {
    it('should call DELETE /api/tasks/:taskId', async () => {
      mockMcpFetch.mockResolvedValue({ deleted: true });
      await mcpToolRegistry.execute('manage_task', { action: 'delete', task_id: TASK_ID }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'DELETE', path: `/api/tasks/${TASK_ID}`
      }));
    });
  });

  describe('execute_task', () => {
    it('should call POST /api/tasks/:taskId/execute', async () => {
      mockMcpFetch.mockResolvedValue({ executionId: 'exec-1' });
      await mcpToolRegistry.execute('execute_task', { task_id: TASK_ID }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST', path: `/api/tasks/${TASK_ID}/execute`
      }));
    });
  });

  describe('list_task_executions', () => {
    it('should call GET /api/tasks/:taskId/executions for list', async () => {
      mockMcpFetch.mockResolvedValue([]);
      await mcpToolRegistry.execute('list_task_executions', { task_id: TASK_ID }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET', path: `/api/tasks/${TASK_ID}/executions`
      }));
    });

    it('should call GET /api/tasks/:taskId/executions/:execId for specific execution', async () => {
      mockMcpFetch.mockResolvedValue({ executionId: 'exec-1' });
      await mcpToolRegistry.execute('list_task_executions', {
        task_id: TASK_ID, execution_id: 'exec-1'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET', path: `/api/tasks/${TASK_ID}/executions/exec-1`
      }));
    });
  });

  // ─── Schedule tests ───────────────────────────────────────────────────

  describe('list_schedules', () => {
    it('should call GET /api/schedules/task/:taskId', async () => {
      mockMcpFetch.mockResolvedValue([]);
      await mcpToolRegistry.execute('list_schedules', { task_id: TASK_ID }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET', path: `/api/schedules/task/${TASK_ID}`
      }));
    });
  });

  describe('manage_schedule - create', () => {
    it('should call POST /api/schedules', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: SCHED_ID });
      await mcpToolRegistry.execute('manage_schedule', {
        action: 'create', task_id: TASK_ID,
        frequency: 'daily', next_run_time: '2025-01-01T00:00:00Z'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST', path: '/api/schedules',
        body: expect.objectContaining({ taskId: TASK_ID, frequency: 'daily' })
      }));
    });
  });

  describe('manage_schedule - update', () => {
    it('should call PUT /api/schedules/:scheduleId', async () => {
      mockMcpFetch.mockResolvedValue({ scheduleId: SCHED_ID });
      await mcpToolRegistry.execute('manage_schedule', {
        action: 'update', schedule_id: SCHED_ID, status: 'inactive'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PUT', path: `/api/schedules/${SCHED_ID}`
      }));
    });
  });

  describe('manage_schedule - delete', () => {
    it('should call DELETE /api/schedules/:scheduleId', async () => {
      mockMcpFetch.mockResolvedValue({ deleted: true });
      await mcpToolRegistry.execute('manage_schedule', {
        action: 'delete', schedule_id: SCHED_ID
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'DELETE', path: `/api/schedules/${SCHED_ID}`
      }));
    });
  });

  // ─── Old tool names should NOT exist ──────────────────────────────────

  describe('old portal_* tools removed', () => {
    const oldToolNames = [
      'portal_list_tasks', 'portal_get_task', 'portal_create_task',
      'portal_update_task', 'portal_delete_task', 'portal_execute_task',
      'portal_get_task_executions', 'portal_get_execution_details',
      'portal_list_schedules', 'portal_create_schedule',
      'portal_update_schedule', 'portal_delete_schedule'
    ];

    for (const name of oldToolNames) {
      it(`should not have tool: ${name}`, () => {
        expect(mcpToolRegistry.getTool(name)).toBeUndefined();
      });
    }
  });
});
