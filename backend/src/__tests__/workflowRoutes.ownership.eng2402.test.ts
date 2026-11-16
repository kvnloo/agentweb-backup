/**
 * ENG-2402: POST /:id/run and PUT .../tasks/:taskId/rerun must enforce ownership.
 */
import express from 'express';
import request from 'supertest';

const mockGetWorkflow = jest.fn();
const mockGetWorkflowExecution = jest.fn();
const mockCreateWorkflowExecution = jest.fn();
const mockUpdateWorkflowExecution = jest.fn();
const mockGetTaskById = jest.fn();
const mockCreateTaskExecution = jest.fn();

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-test-user'] };
    next();
  },
}));
jest.mock('../controllers/workflows', () => {
  const noop = (_req: any, res: any) => res.status(200).end();
  return {
    listWorkflows: noop, getWorkflow: noop, createWorkflow: noop, updateWorkflow: noop,
    deleteWorkflow: noop, getWorkflowExecutions: noop, generateWorkflow: noop,
  };
});
jest.mock('../services/workflowDb', () => ({
  WorkflowService: jest.fn().mockImplementation(() => ({
    getWorkflow: mockGetWorkflow,
    getWorkflowExecution: mockGetWorkflowExecution,
    createWorkflowExecution: mockCreateWorkflowExecution,
    updateWorkflowExecution: mockUpdateWorkflowExecution,
  })),
}));
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: (...a: any[]) => mockGetTaskById(...a),
    createTaskExecution: (...a: any[]) => mockCreateTaskExecution(...a),
    getTaskExecutionById: jest.fn(),
  },
}));
jest.mock('../services/workflow', () => ({}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../routes/workflows').default;
const app = express();
app.use(express.json());
app.use('/api/workflows', router);

const yamlWith = (taskId?: string) =>
  `nodes:\n  - id: n1\n    data:\n      prompt: hi\n${taskId ? `      taskId: ${taskId}\n` : ''}edges: []\n`;

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateWorkflowExecution.mockResolvedValue({});
  mockUpdateWorkflowExecution.mockResolvedValue({ ok: true });
  mockCreateTaskExecution.mockResolvedValue(undefined);
});

describe('POST /api/workflows/:id/run', () => {
  it('403 when caller does not own the workflow', async () => {
    mockGetWorkflow.mockResolvedValue({ userId: 'owner', yaml: yamlWith() });
    const res = await request(app).post('/api/workflows/w1/run').set('x-test-user', 'attacker');
    expect(res.status).toBe(403);
    expect(mockCreateWorkflowExecution).not.toHaveBeenCalled();
  });

  it('403 when a referenced task belongs to someone else', async () => {
    mockGetWorkflow.mockResolvedValue({ userId: 'owner', yaml: yamlWith('t-other') });
    mockGetTaskById.mockResolvedValue({ taskId: 't-other', userId: 'someone-else' });
    const res = await request(app).post('/api/workflows/w1/run').set('x-test-user', 'owner');
    expect(res.status).toBe(403);
    expect(mockCreateWorkflowExecution).not.toHaveBeenCalled();
  });

  it('400 when a referenced task does not exist', async () => {
    mockGetWorkflow.mockResolvedValue({ userId: 'owner', yaml: yamlWith('t-missing') });
    mockGetTaskById.mockResolvedValue(null);
    const res = await request(app).post('/api/workflows/w1/run').set('x-test-user', 'owner');
    expect(res.status).toBe(400);
  });

  it('owner with owned task runs', async () => {
    mockGetWorkflow.mockResolvedValue({ userId: 'owner', yaml: yamlWith('t-mine') });
    mockGetTaskById.mockResolvedValue({ taskId: 't-mine', userId: 'owner' });
    const res = await request(app).post('/api/workflows/w1/run').set('x-test-user', 'owner');
    expect(res.status).toBe(200);
    expect(mockCreateWorkflowExecution).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/workflows/:wid/executions/:eid/tasks/:tid/rerun', () => {
  const exec = (over: any = {}) => ({
    workflowId: 'w1', userId: 'owner', status: 'completed',
    tasks: [{ taskId: 'task-1', prompt: 'p', status: 'failed' }], ...over,
  });
  const url = '/api/workflows/w1/executions/e1/tasks/task-1/rerun';

  it('403 when caller does not own the execution', async () => {
    mockGetWorkflowExecution.mockResolvedValue(exec());
    const res = await request(app).put(url).set('x-test-user', 'attacker').send({ prompt: 'x' });
    expect(res.status).toBe(403);
    expect(mockCreateTaskExecution).not.toHaveBeenCalled();
  });

  it('404 when execution belongs to a different workflow', async () => {
    mockGetWorkflowExecution.mockResolvedValue(exec({ workflowId: 'w2' }));
    const res = await request(app).put(url).set('x-test-user', 'owner').send({});
    expect(res.status).toBe(404);
    expect(mockCreateTaskExecution).not.toHaveBeenCalled();
  });

  it('owner rerun succeeds', async () => {
    mockGetWorkflowExecution.mockResolvedValue(exec());
    const res = await request(app).put(url).set('x-test-user', 'owner').send({});
    expect(res.status).toBe(200);
    expect(mockCreateTaskExecution).toHaveBeenCalledTimes(1);
  });
});
