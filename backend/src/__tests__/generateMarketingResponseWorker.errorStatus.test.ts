/**
 * ENG-1670 — generateMarketingResponse preserves the original provider error's
 * .status/.code on the Error it throws (e.g. 429 from a rate-limited call), so
 * agentModeController's classifyZeroAssistantFailure can classify a scheduled
 * run's failure correctly instead of falling through to the generic 'system'
 * bucket. That only works if the worker actually forwards .status/.code back
 * to the parent process over IPC — prod-verified it previously didn't.
 */

export {};

const generateMarketingResponse = jest.fn();

// ENG-1852: the worker imports the module's own exported singleton (not a fresh
// `new AgentModeService()`), so a value-shaped mock is what the real import resolves to.
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    // Present deliberately — the worker latches on it; omitting it makes every test
    // here run the degraded/retry branch without asserting anything.
    isInitialized: true,
    initialize: jest.fn().mockResolvedValue(undefined),
    generateMarketingResponse,
    releaseSessionMcpClients: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../workers/workerShutdownGuards', () => ({
  installWorkerShutdownGuards: jest.fn(),
}));

describe('ENG-1670 — the worker forwards status/code on a generateMarketingResponse failure', () => {
  let handleMessage: (message: any) => Promise<void>;

  beforeAll(() => {
    const handlers: Array<(m: any) => Promise<void>> = [];
    const realOn = process.on.bind(process);
    jest.spyOn(process, 'on').mockImplementation(((event: string, handler: any) => {
      if (event === 'message') handlers.push(handler);
      return process;
    }) as any);

    require('../workers/generateMarketingResponseWorker');

    (process.on as any).mockRestore?.();
    void realOn;
    handleMessage = handlers[0];
    expect(typeof handleMessage).toBe('function');
  });

  let originalSend: any;

  beforeEach(() => {
    generateMarketingResponse.mockReset();
    originalSend = process.send;
    process.send = jest.fn() as any;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('includes status and code in the error message sent to the parent', async () => {
    const rateLimitError: any = new Error('I\'m currently experiencing high demand. Please wait a moment and try again.');
    rateLimitError.status = 429;
    rateLimitError.code = 'rate_limit_exceeded';
    generateMarketingResponse.mockRejectedValue(rateLimitError);

    await handleMessage({
      type: 'generateMarketingResponse',
      requestId: 'req-1',
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gemini-3.7-flash',
        sessionId: 'sess-1',
      },
    });

    const errorCall = (process.send as jest.Mock).mock.calls.find(
      (call) => call[0]?.type === 'error'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0]).toMatchObject({
      status: 429,
      code: 'rate_limit_exceeded',
    });
  });

  it('omits status/code when the error carries none', async () => {
    generateMarketingResponse.mockRejectedValue(new Error('Generic failure'));

    await handleMessage({
      type: 'generateMarketingResponse',
      requestId: 'req-2',
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gemini-3.7-flash',
        sessionId: 'sess-2',
      },
    });

    const errorCall = (process.send as jest.Mock).mock.calls.find(
      (call) => call[0]?.type === 'error'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0]).not.toHaveProperty('status');
    expect(errorCall![0]).not.toHaveProperty('code');
  });

  // ENG-1670: whether OpenRouter actually sent a Retry-After header is
  // conditional, not guaranteed — persisting the answer (not just the
  // friendly message) means a future recurrence of this failure class is
  // self-diagnosing from the durable session record instead of needing logs
  // that expire in 14 days, which is what made the ORIGINAL investigation
  // into this failure class unable to answer this exact question at all.
  it('forwards retryAfterHeaderPresent and retryAfterMs when the wrapped error carries them', async () => {
    const rateLimitError: any = new Error('I\'m currently experiencing high demand. Please wait a moment and try again.');
    rateLimitError.status = 429;
    rateLimitError.retryAfterHeaderPresent = true;
    rateLimitError.retryAfterMs = 20000;
    generateMarketingResponse.mockRejectedValue(rateLimitError);

    await handleMessage({
      type: 'generateMarketingResponse',
      requestId: 'req-3',
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gemini-3.7-flash',
        sessionId: 'sess-3',
      },
    });

    const errorCall = (process.send as jest.Mock).mock.calls.find(
      (call) => call[0]?.type === 'error'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0]).toMatchObject({
      retryAfterHeaderPresent: true,
      retryAfterMs: 20000,
    });
  });

  it('forwards retryAfterHeaderPresent: false when no header was present', async () => {
    const rateLimitError: any = new Error('I\'m currently experiencing high demand. Please wait a moment and try again.');
    rateLimitError.status = 429;
    rateLimitError.retryAfterHeaderPresent = false;
    generateMarketingResponse.mockRejectedValue(rateLimitError);

    await handleMessage({
      type: 'generateMarketingResponse',
      requestId: 'req-4',
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gemini-3.7-flash',
        sessionId: 'sess-4',
      },
    });

    const errorCall = (process.send as jest.Mock).mock.calls.find(
      (call) => call[0]?.type === 'error'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall![0]).toMatchObject({ retryAfterHeaderPresent: false });
    expect(errorCall![0]).not.toHaveProperty('retryAfterMs');
  });
});
