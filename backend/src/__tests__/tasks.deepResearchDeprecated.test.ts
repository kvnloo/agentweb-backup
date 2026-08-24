/**
 * ENG-804 follow-up: deep research was deprecated in agent-engine
 * (task_monitor.py, commit e94a8e4a, 2026-01-01) but the backend never
 * stopped accepting isDeepResearch: true on task/template create or
 * update. Any task that ends up with isDeepResearch: true will always
 * fail in agent-engine and always page oncall for a permanent,
 * non-actionable failure. These tests lock in that isDeepResearch can
 * never be persisted as true from any entry point, regardless of what
 * the client sends or what an older stored template still has set.
 */
import { taskTemplateDb, taskDb, userDb } from '../services/db';

jest.mock('../services/db');
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn() }),
      put: jest.fn().mockReturnValue({ promise: jest.fn() }),
      query: jest.fn().mockReturnValue({ promise: jest.fn() }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn() }),
      update: jest.fn().mockReturnValue({ promise: jest.fn() }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn() })
    }))
  },
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn() }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn() }),
    putObject: jest.fn().mockReturnValue({ promise: jest.fn() }),
    deleteObject: jest.fn().mockReturnValue({ promise: jest.fn() })
  })),
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn() })
  })),
  config: { update: jest.fn() }
}));

import { createTask, updateTask } from '../controllers/tasks';

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockTaskTemplateDb = taskTemplateDb as jest.Mocked<typeof taskTemplateDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

function mockReqRes(body: any, params: any = {}) {
  const req: any = { user: { userId: 'user123' }, body, params };
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  };
  return { req, res };
}

describe('Deep research deprecation (ENG-804 follow-up)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // updateTask looks up the acting user and short-circuits the
    // ownership/org-share check for admins - keep these tests focused on
    // isDeepResearch handling, not permission logic.
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user123', isAdmin: true } as any);
  });

  describe('createTask - no template', () => {
    it('forces isDeepResearch false even when client sends true', async () => {
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'task-1' } as any);

      const { req, res } = mockReqRes({
        name: 'Test task',
        prompt: 'Do something',
        isDeepResearch: true
      });

      await createTask(req, res);

      expect(mockTaskDb.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ isDeepResearch: false })
      );
    });
  });

  describe('createTask - from template', () => {
    it('forces isDeepResearch false even when the stored template has it true', async () => {
      mockTaskTemplateDb.getTemplateById.mockResolvedValue({
        templateId: 'tmpl-1',
        userId: 'user123',
        published: true,
        isDeepResearch: true, // older template predating the deprecation
        name: 'Old deep research template'
      } as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'task-2' } as any);

      const { req, res } = mockReqRes({
        name: 'Test task',
        prompt: 'Do something',
        templateId: 'tmpl-1'
      });

      await createTask(req, res);

      expect(mockTaskDb.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ isDeepResearch: false })
      );
    });

    it('forces isDeepResearch false even when client explicitly requests true with a template', async () => {
      mockTaskTemplateDb.getTemplateById.mockResolvedValue({
        templateId: 'tmpl-1',
        userId: 'user123',
        published: true,
        isDeepResearch: false,
        name: 'Template'
      } as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'task-3' } as any);

      const { req, res } = mockReqRes({
        name: 'Test task',
        prompt: 'Do something',
        templateId: 'tmpl-1',
        isDeepResearch: true
      });

      await createTask(req, res);

      expect(mockTaskDb.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ isDeepResearch: false })
      );
    });
  });

  describe('updateTask', () => {
    it('forces isDeepResearch false when client sends true', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({ taskId: 'task-4', userId: 'user123' } as any);
      mockTaskDb.updateTask.mockResolvedValue({ taskId: 'task-4' } as any);

      const { req, res } = mockReqRes({ isDeepResearch: true }, { id: 'task-4' });

      await updateTask(req, res);

      expect(mockTaskDb.updateTask).toHaveBeenCalledWith(
        'task-4',
        expect.objectContaining({ isDeepResearch: false })
      );
    });

    it('allows explicitly turning isDeepResearch off', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({ taskId: 'task-5', userId: 'user123', isDeepResearch: true } as any);
      mockTaskDb.updateTask.mockResolvedValue({ taskId: 'task-5' } as any);

      const { req, res } = mockReqRes({ isDeepResearch: false }, { id: 'task-5' });

      await updateTask(req, res);

      expect(mockTaskDb.updateTask).toHaveBeenCalledWith(
        'task-5',
        expect.objectContaining({ isDeepResearch: false })
      );
    });

    it('does not touch isDeepResearch when not provided in the update', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({ taskId: 'task-6', userId: 'user123', isDeepResearch: false } as any);
      mockTaskDb.updateTask.mockResolvedValue({ taskId: 'task-6' } as any);

      const { req, res } = mockReqRes({ name: 'Renamed task' }, { id: 'task-6' });

      await updateTask(req, res);

      const updateArgs = mockTaskDb.updateTask.mock.calls[0][1] as any;
      expect(updateArgs).not.toHaveProperty('isDeepResearch');
    });
  });
});
