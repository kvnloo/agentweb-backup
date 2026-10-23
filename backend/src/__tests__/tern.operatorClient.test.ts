import axios from 'axios';
import { AgentWebOperatorClient } from '../tern/operatorClient';
import { displayExecution } from '../tern/operatorModel';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Tern operator API contract', () => {
  const get = jest.fn();
  const post = jest.fn();
  const put = jest.fn();

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    put.mockReset();
    mockedAxios.create.mockReturnValue({ get, post, put } as any);
  });

  it('fetches task summaries and only allows valid records', async () => {
    const client = new AgentWebOperatorClient({ baseUrl: 'https://api.example/', token: 'jwt' });
    get.mockResolvedValueOnce({ data: [
      { taskId: 'one', name: 'One', status: 'active' },
      { name: 'missing ID', status: 'active' },
    ] });
    expect(await client.listTasks()).toEqual([{ taskId: 'one', name: 'One', status: 'active' }]);
    expect(get).toHaveBeenCalledWith('/api/tasks');
    expect(mockedAxios.create).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://api.example',
      headers: expect.objectContaining({ Authorization: 'Bearer jwt' }),
    }));
  });

  it('scopes runs and detail to task IDs checked by the server', async () => {
    const client = new AgentWebOperatorClient({ baseUrl: 'https://api.example', token: 'jwt' });
    get.mockResolvedValueOnce({ data: [
      { taskId: 't 1', executionId: 'e1', status: 'running' },
      { taskId: 'other', executionId: 'e2', status: 'running' },
    ] });
    expect(await client.listExecutions('t 1')).toHaveLength(1);
    expect(get).toHaveBeenCalledWith('/api/tasks/t%201/executions');
    get.mockResolvedValueOnce({ data: { taskId: 't 1', executionId: 'e1', status: 'running' } });
    expect((await client.getExecution('t 1', 'e1')).executionId).toBe('e1');
  });

  it('never sends a kill when the execution changed from running', async () => {
    const client = new AgentWebOperatorClient({ baseUrl: 'https://api.example', token: 'jwt' });
    get.mockResolvedValueOnce({ data: { taskId: 't', executionId: 'e', status: 'completed' } });
    await expect(client.stopExecution('t', 'e')).rejects.toThrow('no longer running');
    expect(put).not.toHaveBeenCalled();
  });

  it('uses exactly the existing execute and kill routes, without retrying mutations', async () => {
    const client = new AgentWebOperatorClient({ baseUrl: 'https://api.example', token: 'jwt' });
    post.mockResolvedValueOnce({ data: { taskId: 't', executionId: 'e', status: 'pending' } });
    expect((await client.startTask('t')).status).toBe('pending');
    expect(post).toHaveBeenCalledWith('/api/tasks/t/execute', {});
    get.mockResolvedValueOnce({ data: { taskId: 't', executionId: 'e', status: 'running' } });
    put.mockResolvedValueOnce({ data: { taskId: 't', executionId: 'e', status: 'killed' } });
    expect((await client.stopExecution('t', 'e')).status).toBe('killed');
    expect(put).toHaveBeenCalledWith('/api/tasks/t/executions/e/kill', {});
  });
});

describe('Read-only authorized execution activity API contract', () => {
  const get = jest.fn();
  const make = () => {
    mockedAxios.create.mockReturnValue({ get, post: jest.fn(), put: jest.fn() } as any);
    return new AgentWebOperatorClient({ baseUrl: 'https://api.example/', token: 'only-in-header' });
  };
  const detail = {
    taskId: 'task 1', executionId: 'execution/1', status: 'running',
    startTime: '2026-10-22T20:00:00Z',
    browser_use_log: 'https://bucket.s3.amazonaws.com/execution_logs/u/activities_execution-secret.log',
    userInteractions: [],
  };
  const event = {
    id: 'browser.0123456789abcdef0123.0',
    when: '2026-10-22 21:00:00,000',
    level: 'INFO', kind: 'action', summary: 'Browser action: navigate',
    raw: 'Authorization: Bearer should-not-copy',
    url: 'https://bucket.s3.amazonaws.com/?token=private',
  };

  beforeEach(() => { get.mockReset(); mockedAxios.create.mockReset(); });

  it('reads the scoped backend activity endpoint, never the public token log URL', async () => {
    const client = make();
    get.mockResolvedValueOnce({ data: detail });
    get.mockResolvedValueOnce({ data: { source: 'browser-log', events: [event] } });
    const selected = await client.getExecutionWithActivity('task 1', 'execution/1');
    expect(get.mock.calls.map(args => args[0])).toEqual([
      '/api/tasks/task%201/executions/execution%2F1',
      '/api/tasks/task%201/executions/execution%2F1/activity',
    ]);
    expect(mockedAxios.create).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer only-in-header' }),
    }));
    expect(selected.activity).toEqual([{
      id: event.id, when: event.when, level: event.level,
      kind: event.kind, summary: event.summary,
    }]);
    const output = JSON.stringify(displayExecution(selected));
    expect(output).toContain('Browser action: navigate');
    for (const secret of ['only-in-header', 'should-not-copy', 'execution-secret.log',
      'token=private', 'browser_use_log', 'Authorization']) expect(output).not.toContain(secret);
  });

  it('keeps an execution without a published browser log genuinely empty', async () => {
    const client = make();
    get.mockResolvedValueOnce({ data: {
      taskId: 't', executionId: 'e', status: 'pending', userInteractions: [],
    } });
    const result = await client.getExecutionWithActivity('t', 'e');
    expect(result.activity).toEqual([]);
    expect(result.activityUnavailable).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('fails closed for auth denial, missing detail and untrusted activity payloads', async () => {
    const client = make();
    get.mockRejectedValueOnce({ response: { status: 403, data: { secret: 'private' } } });
    await expect(client.getExecutionWithActivity('t', 'e')).rejects.toMatchObject({
      response: { status: 403 },
    });
    expect(get).toHaveBeenCalledTimes(1);

    get.mockResolvedValueOnce({ data: detail });
    get.mockResolvedValueOnce({ data: { source: 'browser-log', events: [
      { ...event, id: 'forged', summary: 'Signed URL token=private' },
      { ...event, summary: 'https://evil.example/private?token=123' },
    ] } });
    const result = await client.getExecutionWithActivity('task 1', 'execution/1');
    // Malformed IDs fail validation. Valid IDs with hostile content are still
    // bounded/redacted at both JSON and TSP presentation boundaries.
    expect(result.activity).toHaveLength(1);
    expect(JSON.stringify(displayExecution(result))).not.toContain('token=123');
  });

  it('marks 401/403/502 or malformed activity as unavailable instead of fabricating events', async () => {
    for (const outcome of [
      Promise.reject({ response: { status: 401, data: { Authorization: 'Bearer private' } } }),
      Promise.reject({ response: { status: 403 } }),
      Promise.reject({ response: { status: 502 } }),
      Promise.resolve({ data: { events: [event] } }),
    ]) {
      const client = make();
      get.mockResolvedValueOnce({ data: detail }).mockImplementationOnce(() => outcome);
      const read = await client.getExecutionWithActivity('task 1', 'execution/1');
      expect(read.activity).toEqual([]);
      expect(read.activityUnavailable).toBe(true);
      expect(JSON.stringify(displayExecution(read))).not.toContain('private');
    }
  });

  it('never retries an ambiguous stop write', async () => {
    const getOnly = jest.fn().mockResolvedValue({
      data: { taskId: 't', executionId: 'e', status: 'running' },
    });
    const putOnly = jest.fn().mockRejectedValue(new Error('timeout after possible commit'));
    mockedAxios.create.mockReturnValue({ get: getOnly, put: putOnly } as any);
    const client = new AgentWebOperatorClient({ baseUrl: 'https://api.example', token: 'jwt' });
    await expect(client.stopExecution('t', 'e')).rejects.toThrow('timeout');
    expect(putOnly).toHaveBeenCalledTimes(1);
  });
});
