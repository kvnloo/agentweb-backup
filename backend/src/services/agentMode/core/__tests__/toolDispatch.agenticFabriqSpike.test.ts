/**
 * ENG-1685 spike: protects the AgentMode "behavior-preserving by default"
 * hard invariant. The flag/allowlist check lives in toolDispatch.ts's runOne,
 * so this is the one place that can prove:
 *
 *   1. Flag OFF (or user not allow-listed) → the `email` tool call reaches
 *      ports.executePreparedAgentTool EXACTLY as it did before this spike
 *      existed — the AF bridge is never even imported-and-called.
 *   2. Flag ON + user allow-listed → ONLY the `email` tool routes through the
 *      AF bridge; every other tool name is completely unaffected.
 *
 * This is deliberately a separate file from toolDispatch.test.ts (rather than
 * editing that large shared suite) so the ENG-1685-specific concern — and its
 * mock of integrations/agenticFabriq — stays isolated and easy to delete
 * alongside the rest of the spike if it's rejected.
 */

import { executePreparedTools, type ExecutePreparedToolsInput, type ToolDispatchPorts } from '../toolDispatch';

const mockIsEligible = jest.fn();
const mockRunEmailToolThroughAgenticFabriq = jest.fn();

jest.mock('../../../../integrations/agenticFabriq', () => ({
  isUserEligibleForAgenticFabriqSpike: (...args: unknown[]) => mockIsEligible(...args),
  runEmailToolThroughAgenticFabriq: (...args: unknown[]) => mockRunEmailToolThroughAgenticFabriq(...args),
}));

const mockStartSpan = jest.fn(() => ({}));
jest.mock('../../../../observability/tracing', () => ({
  startRunChildSpan: (...args: unknown[]) => (mockStartSpan as any)(...args),
  endExecuteToolSpan: jest.fn(),
}));

function toolCall(id: string, name: string, args: string) {
  return { id, type: 'function', function: { name, arguments: args } };
}

function makePorts(overrides: Partial<ToolDispatchPorts> = {}): ToolDispatchPorts {
  const base: ToolDispatchPorts = {
    evaluateAgentToolPolicy: () => ({ allowed: true, effect: 'read', flags: [] }) as any,
    validateAndRepairToolArgs: (i: any) => ({ status: 'valid', args: i.args }),
    getToolInputSchema: () => undefined,
    executeAgentToolThroughGateway: async (i) => {
      try {
        const result = await i.execute();
        return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
      } catch (error) {
        return { status: 'error', error, durationMs: 1, policyDecision: i.policyDecision };
      }
    },
    executePreparedAgentTool: jest.fn(async (i: any) => ({ success: true, echo: i.toolName, source: 'direct' })),
    toolResultError: () => null,
    recordToolTelemetry: () => undefined,
    extractMinimalToolResult: (r: any) => r,
    extractToolContent: (r: any) => (typeof r === 'string' ? r : JSON.stringify(r)),
    formatToolError: (_name: string, msg: string) => `ERR: ${msg}`,
    uploadScreenshotToS3: async () => ({ url: 'https://s3/shot.png' }),
    uploadFileToS3WithPath: async () => ({ success: true, key: 'k' }),
    buildCrmDataChangedPayload: () => null,
    crmDataChangedEvent: 'crm:data-changed',
    socketEmit: undefined,
  };
  return { ...base, ...overrides };
}

function makeInput(
  calls: any[],
  ports: ToolDispatchPorts,
  overrides: Partial<ExecutePreparedToolsInput> = {},
): ExecutePreparedToolsInput {
  return {
    toolCalls: calls,
    messages: [],
    toolCallsLedger: [],
    iteration: 0,
    agentRuntimeRunId: 'run-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    llmModel: 'gpt-test',
    mockMode: false,
    screenshotUrl: undefined,
    isDelegatedAccess: false,
    hasAdminAccess: true,
    isInteractiveShare: false,
    adminSkillToolNames: [],
    excludeTools: undefined,
    publishedSkillsCount: 0,
    sessionAssociatedSkillIdsCount: 0,
    allowedToolNames: new Set<string>(),
    toolResponseS3Threshold: 10_000,
    maxToolContentSize: 300_000,
    ports,
    ...overrides,
  } as ExecutePreparedToolsInput;
}

describe('ENG-1685 Agentic Fabriq spike gate in toolDispatch.ts', () => {
  beforeEach(() => {
    mockIsEligible.mockReset();
    mockRunEmailToolThroughAgenticFabriq.mockReset();
  });

  it('flag/allowlist OFF: the email tool routes through executePreparedAgentTool exactly as before — the AF bridge is never called', async () => {
    mockIsEligible.mockReturnValue(false);
    const ports = makePorts();
    const input = makeInput([toolCall('t1', 'email', JSON.stringify({ action: 'search', query: 'invoice' }))], ports);

    await executePreparedTools(input);

    expect(ports.executePreparedAgentTool).toHaveBeenCalledTimes(1);
    expect(mockRunEmailToolThroughAgenticFabriq).not.toHaveBeenCalled();
    expect((input.toolCallsLedger[0] as any).error).toBeUndefined(); // completed successfully via the direct path
  });

  it('mock mode preserves direct mock isolation even for an eligible user', async () => {
    mockIsEligible.mockReturnValue(true);
    const ports = makePorts();
    const input = makeInput(
      [toolCall('t1', 'email', JSON.stringify({ action: 'search', query: 'invoice' }))],
      ports,
      { mockMode: true },
    );

    await executePreparedTools(input);

    expect(ports.executePreparedAgentTool).toHaveBeenCalledTimes(1);
    expect(mockRunEmailToolThroughAgenticFabriq).not.toHaveBeenCalled();
  });

  it('flag/allowlist ON + eligible user: the email tool routes through the AF bridge instead of executePreparedAgentTool', async () => {
    mockIsEligible.mockReturnValue(true);
    mockRunEmailToolThroughAgenticFabriq.mockResolvedValue({
      outcome: { emails: [{ id: 'm1' }], source: 'agentic_fabriq' },
      spikeMeta: { matchedToolName: 'google_gmail_search_messages', latencyMs: 42, discoveredToolCount: 5, connectionStatus: 'connected' },
    });
    const ports = makePorts();
    const input = makeInput([toolCall('t1', 'email', JSON.stringify({ action: 'search', query: 'invoice' }))], ports);

    await executePreparedTools(input);

    expect(mockRunEmailToolThroughAgenticFabriq).toHaveBeenCalledTimes(1);
    expect(ports.executePreparedAgentTool).not.toHaveBeenCalled();
  });

  it('flag/allowlist ON: a DIFFERENT tool (not "email") is completely unaffected — still routes direct', async () => {
    mockIsEligible.mockReturnValue(true);
    const ports = makePorts();
    const input = makeInput([toolCall('t1', 'search_web', JSON.stringify({ query: 'x' }))], ports);

    await executePreparedTools(input);

    expect(ports.executePreparedAgentTool).toHaveBeenCalledTimes(1);
    expect(mockRunEmailToolThroughAgenticFabriq).not.toHaveBeenCalled();
    // Eligibility is checked only after the tool-name gate — never called for a non-email tool.
    expect(mockIsEligible).not.toHaveBeenCalled();
  });

  it('a bridge failure propagates as a tool error rather than silently falling back to the direct path', async () => {
    mockIsEligible.mockReturnValue(true);
    mockRunEmailToolThroughAgenticFabriq.mockRejectedValue(new Error('agentic fabriq unavailable'));
    const ports = makePorts();
    const input = makeInput([toolCall('t1', 'email', JSON.stringify({ action: 'search', query: 'x' }))], ports);

    await executePreparedTools(input);

    expect(ports.executePreparedAgentTool).not.toHaveBeenCalled();
    const ledgerEntry = input.toolCallsLedger[0] as any;
    expect(String(ledgerEntry.error ?? '')).toMatch(/Agentic Fabriq canary request failed/);
  });
});


describe('hostile canary dispatch', () => {
  beforeEach(() => { mockIsEligible.mockReturnValue(true); mockRunEmailToolThroughAgenticFabriq.mockReset(); });
  it.each(['send', 'reply', 'delete', '/private/user-1/account-1'])('blocks %s before bridge dispatch without direct fallback', async (action) => {
    const ports = makePorts();
    const input = makeInput([toolCall('t1', 'email', JSON.stringify({ action }))], ports);
    await executePreparedTools(input);
    expect(mockRunEmailToolThroughAgenticFabriq).not.toHaveBeenCalled();
    expect(ports.executePreparedAgentTool).not.toHaveBeenCalled();
    expect(String((input.toolCallsLedger[0] as any).error)).toContain('read-only');
  });
  it('redacts arbitrary bridge failures from ledger output', async () => {
    mockRunEmailToolThroughAgenticFabriq.mockRejectedValue(new Error('user-1 account-1 /api/users/user-1 token-secret'));
    const input = makeInput([toolCall('t1', 'email', JSON.stringify({ action: 'search' }))], makePorts());
    await executePreparedTools(input);
    const error = String((input.toolCallsLedger[0] as any).error);
    expect(error).toContain('Agentic Fabriq canary request failed');
    expect(error).not.toMatch(/user-1|account-1|api\/users|token-secret/);
  });
});


it('omits raw identifiers and argument content from the canary execution span', async () => {
  mockStartSpan.mockClear();
  mockIsEligible.mockReturnValue(true);
  mockRunEmailToolThroughAgenticFabriq.mockRejectedValue(new Error('sensitive-account /api/private'));
  const input = makeInput([toolCall('t1', 'email', JSON.stringify({ action: 'search', account_id: 'sensitive-account', query: 'private-content' }))], makePorts());
  await executePreparedTools(input);
  const attributes = JSON.stringify((mockStartSpan.mock.calls as any)[0][2]);
  expect(attributes).not.toMatch(/sess-1|user-1|sensitive-account|private-content|api\/private/);
});
