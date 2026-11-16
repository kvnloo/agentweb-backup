/**
 * ENG-2113 (parity review P1): the process-wide instance is wired to the real login-host provider and to the production guard on the legacy bridge. Nothing tested that
 * wiring: `allowLegacyBridge: () => true` or `protocolStatus: () => "match"` survived the whole suite. Here the instance runs against a fake provider, and the question
 * asked is the one that matters: did the turn go on past the transport choice (`prepareTurnContext` was reached) or was it refused up front?
 */
const mockProvider = {
  workerProtocol: jest.fn<number | undefined, []>(),
  protocolStatus: jest.fn<'match' | 'mismatch' | 'unknown', []>(),
  invalidateProtocol: jest.fn(),
  client: jest.fn(() => ({}) as never),
};
const prepareTurnContext = jest.fn(async () => {
  throw new Error('STOP-HERE: the transport was accepted');
});

jest.mock('../loginHostProvider', () => ({ getLoginHostProvider: () => mockProvider }));
jest.mock('../../agentModeService', () => ({ agentModeService: { prepareTurnContext: (...a: unknown[]) => (prepareTurnContext as any)(...a), trimToolMessagesForContext: (m: unknown) => m } }));
jest.mock('../../chatbotService', () => ({ chatbotDb: { addMessagesToSession: jest.fn() } }));
jest.mock('../../agentMode/incrementalPersist', () => ({ stripImageDataForPersistence: (m: unknown) => m }));
jest.mock('../../agentMode/core/toolDispatch', () => ({ seedSearchCallCountFromHistory: () => 0 }));
jest.mock('../../agentMode/core/termination', () => ({ EMPTY_FINAL_RESPONSE_FALLBACK: 'EMPTY' }));
jest.mock('../../../utils/sseProgress', () => ({ isCancelled: () => false }));
jest.mock('../toolBridgeService', () => ({ emmaToolBridgeExecutor: {}, toolBridgeMcp: { listTools: () => undefined, callTool: () => undefined } }));
jest.mock('../attemptUsageJournal', () => ({ getAttemptUsageJournal: () => ({ record: jest.fn() }) }));
jest.mock('../llmConnectionDb', () => ({ LlmConnectionDb: class {} }));

import { claudeCodeBackend } from '../claudeCodeBackendInstance';

const params = () =>
  ({
    decision: { route: 'claude_subscription', connectionId: 'conn-1', epoch: 1, alias: 'sonnet', modelId: 'm', ownerUserId: 'u1' },
    sessionId: 's1',
    userId: 'u1',
    messageContent: 'go',
    sessionHistory: [],
    llmModel: 'm',
  }) as never;

describe('the process-wide Claude backend is wired to the real provider and the production guard', () => {
  const env = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE;
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  const outcome = async () => {
    const err: any = await claudeCodeBackend.run(params()).catch((e) => e);
    return { code: err?.code as string | undefined, reached: prepareTurnContext.mock.calls.length > 0 };
  };
  const logged = () => (console.error as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');

  it('PRODUCTION with CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE=true and a protocol-3 worker: refused as host_unavailable, nothing opened (the flag is ignored in production)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE = 'true';
    mockProvider.workerProtocol.mockReturnValue(3);
    mockProvider.protocolStatus.mockReturnValue('match');
    expect(await outcome()).toEqual({ code: 'host_unavailable', reached: false });
    expect(logged()).toContain('relay_refused cause=protocol_too_old');
  });

  it('outside production the same flag does allow the legacy bridge for a known protocol-3 worker (the turn goes on)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE = 'true';
    mockProvider.workerProtocol.mockReturnValue(3);
    mockProvider.protocolStatus.mockReturnValue('match');
    expect((await outcome()).reached).toBe(true);
  });

  it('without the flag a known protocol-3 worker is refused even outside production', async () => {
    process.env.NODE_ENV = 'development';
    mockProvider.workerProtocol.mockReturnValue(3);
    mockProvider.protocolStatus.mockReturnValue('match');
    expect(await outcome()).toEqual({ code: 'host_unavailable', reached: false });
  });

  it('the provider\'s REAL protocol status is read: an unknown or mismatched status is refused whatever the worker protocol says', async () => {
    for (const status of ['unknown', 'mismatch'] as const) {
      jest.clearAllMocks();
      mockProvider.workerProtocol.mockReturnValue(4);
      mockProvider.protocolStatus.mockReturnValue(status);
      expect(await outcome()).toEqual({ code: 'host_unavailable', reached: false });
      expect(logged()).toContain(`relay_refused cause=protocol_${status}`);
    }
  });

  it('a matching protocol-4 worker goes on to the relay (and the provider was asked for both answers)', async () => {
    mockProvider.workerProtocol.mockReturnValue(4);
    mockProvider.protocolStatus.mockReturnValue('match');
    expect((await outcome()).reached).toBe(true);
    expect(mockProvider.workerProtocol).toHaveBeenCalled();
    expect(mockProvider.protocolStatus).toHaveBeenCalled();
  });
});
