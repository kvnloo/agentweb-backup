import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

import { chatbotDb } from '../services/chatbotService';
import { taskDb } from '../services/db';
import { agentModeController } from '../controllers/agentModeController';

describe('AgentModeController - Session load email campaign sync', () => {
  const mockUser = { userId: 'user-1', isAdmin: false } as any;

  const makeReq = (sessionId: string) => ({
    params: { sessionId },
    user: mockUser,
  }) as unknown as Request;

  const makeRes = () => {
    const res: any = {};
    res.json = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates execution and adds HTML URLs when none exists', async () => {
    const session = {
      sessionId: 'sess-123',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/path/report.html' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      emailCampaignTaskId: 'task-abc',
    };
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session);
    (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue(null);

    const req = makeReq('sess-123');
    const res = makeRes();

    await agentModeController.getSession(req, res);

    expect(taskDb.createTaskExecution).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'agentmode_sess-123', taskId: 'task-abc', userId: 'user-1' })
    );
    // First call updates result_files
    expect(taskDb.updateTaskExecution).toHaveBeenNthCalledWith(
      1,
      'agentmode_sess-123',
      expect.objectContaining({
        result_files: expect.arrayContaining([
          expect.objectContaining({ url: expect.stringContaining('report.html'), is_html: true })
        ])
      })
    );
    // Second call updates completedAt
    expect(taskDb.updateTaskExecution).toHaveBeenNthCalledWith(
      2,
      'agentmode_sess-123',
      expect.objectContaining({ completedAt: expect.any(String) })
    );
  });

  it('updates existing execution to include missing HTML URLs', async () => {
    const existing = {
      executionId: 'agentmode_sess-123',
      result_files: [ { url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/path/old.html', filename: 'old.html', token: 't', is_html: true } ]
    };
    const session = {
      sessionId: 'sess-123',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { role: 'assistant', content: 'Old: https://agentweb-user-files.s3.us-west-2.amazonaws.com/path/old.html New: https://agentweb-user-files.s3.us-west-2.amazonaws.com/path/new.html' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      emailCampaignTaskId: 'task-abc',
    };
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session);
    (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue(existing);

    const req = makeReq('sess-123');
    const res = makeRes();

    await agentModeController.getSession(req, res);

    // Should add new.html but not duplicate old.html
    expect(taskDb.updateTaskExecution).toHaveBeenCalledWith(
      'agentmode_sess-123',
      expect.objectContaining({
        result_files: expect.arrayContaining([
          expect.objectContaining({ url: expect.stringContaining('/new.html'), is_html: true })
        ])
      })
    );
  });

  it('does not sync if session has no emailCampaignTaskId', async () => {
    const session = {
      sessionId: 'sess-123',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { role: 'assistant', content: 'Report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/path/report.html' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session);

    const req = makeReq('sess-123');
    const res = makeRes();

    await agentModeController.getSession(req, res);

    // Should not call task execution sync
    expect(taskDb.getTaskExecutionById).not.toHaveBeenCalled();
    expect(taskDb.createTaskExecution).not.toHaveBeenCalled();
    expect(taskDb.updateTaskExecution).not.toHaveBeenCalled();
  });

  it('does not sync if session has no HTML URLs', async () => {
    const session = {
      sessionId: 'sess-123',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'No HTML reports here' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      emailCampaignTaskId: 'task-abc',
    };
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session);

    const req = makeReq('sess-123');
    const res = makeRes();

    await agentModeController.getSession(req, res);

    // Should not create/update execution if no HTML URLs found
    expect(taskDb.createTaskExecution).not.toHaveBeenCalled();
    expect(taskDb.updateTaskExecution).not.toHaveBeenCalled();
  });

  it('handles sync errors gracefully without failing session load', async () => {
    const session = {
      sessionId: 'sess-123',
      userId: 'user-1',
      title: 'Test',
      messages: [
        { role: 'assistant', content: 'Report: https://agentweb-user-files.s3.us-west-2.amazonaws.com/path/report.html' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      emailCampaignTaskId: 'task-abc',
    };
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session);
    (taskDb.getTaskExecutionById as jest.Mock).mockRejectedValue(new Error('Database error'));

    const req = makeReq('sess-123');
    const res = makeRes();

    // Should not throw, just log the error
    await expect(agentModeController.getSession(req, res)).resolves.not.toThrow();
    expect(res.json).toHaveBeenCalled();
  });
});


