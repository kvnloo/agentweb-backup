/**
 * ENG-827 / ENG-907 — the worker hands generateMarketingResponse its trailing arguments
 * POSITIONALLY, and both of them arrive off `message.params`, which is `any`.
 *
 * That combination is invisible to the type-checker: passing the publish authorization
 * where the deadline goes, and the deadline where the authorization goes, compiles
 * perfectly clean. It happened once already, resolving a merge that landed ENG-907's
 * `turnStartMs` and ENG-827's `publishAuthorizationOverride` in the same signature.
 *
 * The consequence is not subtle. The prompt would be built from a number instead of the
 * caller's resolved authorization, so a scheduled run's system prompt and its
 * required-function checker stop agreeing — which is exactly the refusal-and-retry loop
 * this ticket exists to kill — while the turn's wall-clock budget measures against an
 * authorization object.
 *
 * So this pins the ORDER, not the values.
 */

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

describe('ENG-827 — the worker forwards the publish authorization in the right slot', () => {
  let handleMessage: (message: any) => Promise<void>;
  let originalSend: any;

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

  beforeEach(() => {
    generateMarketingResponse.mockReset();
    generateMarketingResponse.mockResolvedValue({
      content: 'ok',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });
    originalSend = process.send;
    process.send = jest.fn() as any;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  it('passes turnStartMs, publishAuthorizationOverride, and the policy fallback in declaration order', async () => {
    const authorization = { authorized: true, tools: ['post_on_connected_account'] };
    const turnStartMs = 1_760_000_000_000;
    const transientFallbackModel = 'gemini-3.1-flash-lite';

    await handleMessage({
      type: 'generateMarketingResponse',
      requestId: 'req-1',
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gpt-5-chat-2',
        sessionId: 'sess-1',
        publishAuthorizationOverride: authorization,
        turnStartMs,
        transientFallbackModel,
      },
    });

    expect(generateMarketingResponse).toHaveBeenCalledTimes(1);
    const args = generateMarketingResponse.mock.calls[0];

    // The trailing arguments, in the order generateMarketingResponse declares them.
    // Asserted by VALUE SHAPE as well as position, so a swap cannot pass: a number is
    // never an authorization, and an authorization is never a deadline.
    expect(args[args.length - 5]).toBe(turnStartMs);
    expect(args[args.length - 4]).toEqual(authorization);
    expect(args[args.length - 3]).toBe(transientFallbackModel);
    expect(args[args.length - 2]).toBeUndefined();
    expect(args[args.length - 1]).toBeUndefined();
    expect(typeof args[args.length - 5]).toBe('number');
  });
});
