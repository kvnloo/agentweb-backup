import { EmmaLoopExecutor, EmmaLoopConfig } from '../services/emmaLoopExecutor';

// Mock the fetch function globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('EmmaLoopExecutor', () => {
  const defaultConfig: EmmaLoopConfig = {
    systemUserId: 'admin-user-id',
    prompt: 'Check campaign health for all clients',
    baseUrl: 'http://localhost:3001',
    jwtSecret: 'test-secret',
  };

  let executor: EmmaLoopExecutor;

  beforeEach(() => {
    jest.clearAllMocks();
    executor = new EmmaLoopExecutor(defaultConfig);
  });

  // FAIL test 1: Session creation failure
  it('should return failed status when session creation fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal server error' }),
    });

    const result = await executor.executeTick();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('session creation');
  });

  // FAIL test 2: Message send failure
  it('should return failed status when message send fails', async () => {
    // Session creation succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'test-session-123' }),
    });

    // Message send fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'LLM service unavailable' }),
    });

    const result = await executor.executeTick();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('message send');
  });

  // FAIL test 3: Network error
  it('should return failed status on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await executor.executeTick();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('ECONNREFUSED');
  });

  // SUCCESS test 4: Full tick succeeds
  it('should return completed status with summary on successful execution', async () => {
    // Session creation succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'test-session-456' }),
    });

    // Message send succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        response: 'Campaign health check complete. 2 clients need attention: Client A has CPL spike (+40%), Client B budget underspending.',
      }),
    });

    const result = await executor.executeTick();

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('Campaign health check complete');
  });

  // SUCCESS test 5: Auth header includes JWT
  it('should include Authorization header with valid JWT in requests', async () => {
    // Session creation succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 'test-session-789' }),
    });

    // Message send succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: 'Done' }),
    });

    await executor.executeTick();

    // Both calls should have Authorization header
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [sessionUrl, sessionOpts] = mockFetch.mock.calls[0];
    expect(sessionUrl).toBe('http://localhost:3001/api/agent-mode/sessions');
    expect(sessionOpts.headers['Authorization']).toMatch(/^Bearer /);

    const [messageUrl, messageOpts] = mockFetch.mock.calls[1];
    expect(messageUrl).toBe('http://localhost:3001/api/agent-mode/generate');
    expect(messageOpts.headers['Authorization']).toMatch(/^Bearer /);
    expect(JSON.parse(messageOpts.body)).toHaveProperty('sessionId', 'test-session-789');
    expect(JSON.parse(messageOpts.body)).toHaveProperty('userMessage', defaultConfig.prompt);
  });

  // Edge case: truncates long summaries
  it('should truncate summary to 2000 chars max', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 's1' }),
    });

    const longResponse = 'x'.repeat(5000);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: longResponse }),
    });

    const result = await executor.executeTick();

    expect(result.status).toBe('completed');
    expect(result.summary!.length).toBeLessThanOrEqual(2000);
  });
});
