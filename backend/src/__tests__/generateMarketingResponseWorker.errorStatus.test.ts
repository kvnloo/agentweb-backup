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

jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    generateMarketingResponse,
  })),
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
});
