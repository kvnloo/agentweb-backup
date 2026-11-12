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
    '/api/agent-mode/sessions/',
  ])('allows %s', (p) => expect(() => assertSafeSelfCallPath(p)).not.toThrow());

  it.each([
    '/api/tasks/../agent-mode/sessions?/execute',
    '/api/tasks/./execute',
    '/api/tasks//execute',
    '/api/tasks/%2e%2e/execute',
    '/api/tasks/a%2Fb/execute',
    '/api/tasks/a%5cb/execute',
    '/api/tasks/a\\b/execute',
    '/api/tasks/a#b/execute',
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

  it('the reproduced steering value is refused and nothing is sent', async () => {
    await expect(run('../agent-mode/sessions?')).rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
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
