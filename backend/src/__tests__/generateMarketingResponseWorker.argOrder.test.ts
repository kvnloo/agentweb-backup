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

  it('passes turnStartMs and publishAuthorizationOverride in declaration order', async () => {
    const authorization = { authorized: true, tools: ['post_on_connected_account'] };
    const turnStartMs = 1_760_000_000_000;

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
        requireWorkPlanDisposition: true,
      },
    });

    expect(generateMarketingResponse).toHaveBeenCalledTimes(1);
    const args = generateMarketingResponse.mock.calls[0];

    // The trailing arguments, in the order generateMarketingResponse declares them.
    // Asserted by VALUE SHAPE as well as position, so a swap cannot pass: a number is
    // never an authorization, and an authorization is never a deadline.
    // ENG-669 PR-C: modelRouting is now the LAST declared parameter, after ENG-2072's isUnattendedRun — see the
    // note in generateMarketingResponseWorker.ts about keeping this list in sync.
    expect(args[args.length - 6]).toBe(turnStartMs);
    expect(args[args.length - 5]).toEqual(authorization);
    expect(args[args.length - 4]).toBeUndefined();
    expect(args[args.length - 3]).toBe(true);
    expect(args[args.length - 2]).toBeUndefined(); // isUnattendedRun, not supplied by this test
    expect(args[args.length - 1]).toBeUndefined(); // modelRouting, not supplied by this test
    expect(typeof args[args.length - 6]).toBe('number');
  });

  it('ENG-669 PR-C: passes modelRouting as the last declared argument', async () => {
    const modelRouting = { llmSelected: 'agentweb-model', llmRoutingReason: 'chat task: table default', llmRoutingTableVersion: 't1' };
    await handleMessage({
      type: 'generateMarketingResponse',
      requestId: 'req-3',
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gemini-3.5-flash',
        sessionId: 'sess-1',
        isUnattendedRun: true,
        modelRouting,
      },
    });

    const args = generateMarketingResponse.mock.calls[0];
    expect(args[args.length - 1]).toEqual(modelRouting);
    expect(args[args.length - 2]).toBe(true);
  });

  it('ENG-2072: passes isUnattendedRun right before modelRouting', async () => {
    await handleMessage({
      type: 'generateMarketingResponse',
      requestId: 'req-2',
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gpt-5-chat-2',
        sessionId: 'sess-1',
        isUnattendedRun: true,
      },
    });

    expect(generateMarketingResponse).toHaveBeenCalledTimes(1);
    const args = generateMarketingResponse.mock.calls[0];
    expect(args[args.length - 2]).toBe(true);
  });
});
