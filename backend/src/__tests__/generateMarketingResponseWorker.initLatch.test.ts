/**
 * ENG-1852 follow-up — the worker must latch on the service's OWN verdict.
 *
 * ensureInitialized() previously set its module-level `initialized = true` on mere
 * RESOLUTION of agentModeService.initialize(). That call resolves even when
 * initialization degraded, because every step inside it swallows its own errors — so in
 * the forked worker, the exact process where ENG-1852 manifested, a degraded init became
 * permanent and the service's retry path never ran.
 *
 * This file exists because a review reverted that fix wholesale (`initialized = true`)
 * and all five worker suites stayed green: none asserted the behaviour, and all three
 * mocked agentModeService WITHOUT `isInitialized`, so the flag read `undefined`, the
 * worker treated every init as degraded, and every test silently exercised the retry
 * branch while asserting nothing about it.
 *
 * Driven through the real `process.on('message')` handler, the same seam the sibling
 * worker suites use — there is no exported function to call directly.
 */

export {}; // module scope: without this the const declarations below are globals and
         // collide with the sibling worker suites, which tsc --noEmit catches but the
         // CI build does not, since tsconfig.build.json excludes the test directories.

const initialize = jest.fn().mockResolvedValue(undefined);
const generateMarketingResponse = jest.fn();
// Starts DEGRADED. The worker runs ensureInitialized() once at module load, so if the
// mock reported healthy then, the worker would latch before any message arrives and no
// message could ever exercise the retry path.
let isInitialized = false;

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    initialize,
    generateMarketingResponse,
    releaseSessionMcpClients: jest.fn().mockResolvedValue(undefined),
    // A getter, so a test can flip the verdict between messages the way a real degraded
    // init would.
    get isInitialized() {
      return isInitialized;
    },
  },
}));

jest.mock('../workers/workerShutdownGuards', () => ({
  installWorkerShutdownGuards: jest.fn(),
}));

describe('worker init latch (ENG-1852)', () => {
  let handleMessage: (message: any) => Promise<void>;
  let originalSend: any;

  beforeAll(() => {
    const handlers: Array<(m: any) => Promise<void>> = [];
    jest.spyOn(process, 'on').mockImplementation(((event: string, handler: any) => {
      if (event === 'message') handlers.push(handler);
      return process;
    }) as any);

    require('../workers/generateMarketingResponseWorker');

    (process.on as any).mockRestore?.();
    handleMessage = handlers[0];
    expect(typeof handleMessage).toBe('function');
  });

  beforeEach(() => {
    initialize.mockClear(); // drops the module-load call
    generateMarketingResponse.mockReset();
    generateMarketingResponse.mockResolvedValue({
      content: 'ok', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [],
    });
    originalSend = process.send;
    process.send = jest.fn() as any;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  const send = (requestId: string) =>
    handleMessage({
      type: 'generateMarketingResponse',
      requestId,
      params: {
        messageContent: 'go',
        sessionHistory: [],
        userId: 'user-1',
        llmModel: 'gpt-5-chat-2',
        sessionId: 'sess-1',
        turnStartMs: Date.now(),
      },
    });

  it('re-initializes on the next message while the service reports degraded', async () => {
    isInitialized = false;

    await send('r1');
    await send('r2');

    // Latching on "the promise resolved" makes this 1 and strands the worker on a
    // degraded service for the life of the process — which is the bug.
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('stops re-initializing once the service reports healthy', async () => {
    isInitialized = false;
    await send('r3');
    expect(initialize).toHaveBeenCalledTimes(1);

    isInitialized = true;
    await send('r4');   // this one latches
    await send('r5');   // so this one must not re-init

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
