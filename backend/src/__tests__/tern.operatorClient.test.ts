import axios from 'axios';
import { AgentWebOperatorClient } from '../tern/operatorClient';

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
