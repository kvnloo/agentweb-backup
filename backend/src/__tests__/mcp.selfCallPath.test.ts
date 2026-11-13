/**
 * ENG-2963: MCP tools build self-call URLs from caller arguments. Reproduced on the test environment 2026-11-12: `execute_task`
 * with task_id "../agent-mode/sessions?" created a chat instead of running a task. Now:
 *  - tools escape the ids they put in a path, so "?" or "/" in an id stays inside that path segment;
 *  - mcpFetch refuses any path that a dot segment, an empty segment, a backslash, a "#" or an encoded dot/slash could redirect,
 *    before anything is sent.
 */
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(async (id: string) => ({ userId: id, email: 'u@example.com', isAdmin: false })) } }));
import { assertSafeSelfCallPath, mcpFetch } from '../mcp/server/httpClient';

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) });
  (global as any).fetch = fetchMock;
});

const context = { overrideToken: 'test-token' } as any;
const sentPath = () => new URL(fetchMock.mock.calls[0][0]).pathname;

describe('assertSafeSelfCallPath', () => {
  it.each([
    '/api/tasks/abc/execute',
    '/api/crm/lists/list_1_x/leads?limit=5',
    '/api/landing-pages/v0/generated/p1/files?branch=feature/x', // a slash in the query is fine
    '/api/tasks/abc%3F/execute', // an escaped "?" stays in its segment
    '/api/tasks/t1/knowledge-base/files/tasks%2Ft1%2Fknowledge-base-files%2F123_a.txt', // a file key: an escaped slash stays in its segment
    '/api/lead-volume-monitor/Acme%2FWest?days=7',
    '/api/agent-mode/sessions/',
  ])('allows %s', (p) => expect(() => assertSafeSelfCallPath(p)).not.toThrow());

  it.each([
    '/api/tasks/../agent-mode/sessions?/execute',
    '/api/tasks/./execute',
    '/api/tasks//execute',
    '/api/tasks/%2e%2e/execute',
    '/api/tasks/a\\b/execute',
    '/api/tasks/a#b/execute',
    '/api/tasks/abc?x=1#frag', // a raw # after the ? is refused too
    '/api/tasks/abc?x=a\\b',
    '/api/tasks/a\nb/execute',
    '/mcp',
    'http://evil.example/api/x',
  ])('refuses %j', (p) => expect(() => assertSafeSelfCallPath(p)).toThrow(/not allowed/));
});

describe('mcpFetch never sends a redirectable path', () => {
  it('refuses before any request is made', async () => {
    await expect(mcpFetch({ method: 'POST', path: '/api/tasks/../agent-mode/sessions?/execute', context })).rejects.toThrow(/Nothing was sent/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a safe path unchanged', async () => {
    await mcpFetch({ method: 'GET', path: '/api/tasks/abc/executions', context });
    expect(sentPath()).toBe('/api/tasks/abc/executions');
  });
});

describe('execute_task (the reproduced case)', () => {
  // Registering apiTools needs its collaborators stubbed only for import; the tool under test uses mcpFetch for real.
  let registry: typeof import('../mcp/server/registry').mcpToolRegistry;
  beforeAll(async () => {
    jest.resetModules();
    registry = (await import('../mcp/server/registry')).mcpToolRegistry;
    await import('../mcp/server/apiTools');
  });

  const run = (taskId: string) => registry.getTool('execute_task')!.execute({ task_id: taskId }, { userId: 'u-1' });

  it('the reproduced steering value stays inside the task id: the route it hits is still /api/tasks/:id/execute', async () => {
    await run('../agent-mode/sessions?');
    expect(sentPath()).toBe('/api/tasks/..%2Fagent-mode%2Fsessions%3F/execute');
    expect(new URL(fetchMock.mock.calls[0][0]).search).toBe('');
  });

  it('if a tool forgets to escape, the guard still refuses the steering value before anything is sent', async () => {
    await expect(mcpFetch({ method: 'POST', path: '/api/tasks/../agent-mode/sessions?/execute', context })).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a key with slashes (knowledge-base file) still reaches its route, escaped in one segment', async () => {
    await mcpFetch({ method: 'DELETE', path: `/api/tasks/t1/knowledge-base/files/${encodeURIComponent('tasks/t1/knowledge-base-files/123_a.txt')}`, context });
    expect(sentPath()).toBe('/api/tasks/t1/knowledge-base/files/tasks%2Ft1%2Fknowledge-base-files%2F123_a.txt');
  });

  it('a "?" in an id stays inside the task id', async () => {
    await run('abc?x=1');
    expect(sentPath()).toBe('/api/tasks/abc%3Fx%3D1/execute');
  });

  it('a normal id goes where it always did', async () => {
    await run('task_123');
    expect(sentPath()).toBe('/api/tasks/task_123/execute');
  });
});

describe('delete_knowledge_base_file still works (its stored file keys contain slashes)', () => {
  it('sends the escaped key as one path segment and reports the delete', async () => {
    jest.resetModules();
    const registry = (await import('../mcp/server/registry')).mcpToolRegistry;
    await import('../mcp/server/apiTools');
    const key = 'tasks/kb1/knowledge-base-files/123_a.txt';
    let deleted = false;
    const json = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (init?.method === 'DELETE') { deleted = true; return json({ success: true }); }
      return json({ taskId: 'kb1', userId: 'u-1', knowledgeBaseFiles: deleted ? [] : [{ filename: 'a.txt', key }] });
    });
    const res: any = await registry.getTool('delete_knowledge_base_file')!.execute({ kb_id: 'kb1', file_name: 'a.txt' }, { userId: 'u-1' });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ success: true, deleted: true, file_key: key });
    const del = fetchMock.mock.calls.find((c) => c[1]?.method === 'DELETE')!;
    expect(new URL(del[0]).pathname).toBe('/api/tasks/kb1/knowledge-base/files/tasks%2Fkb1%2Fknowledge-base-files%2F123_a.txt');
  });
});
