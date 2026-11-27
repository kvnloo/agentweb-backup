// ENG-2816: the typed-chat dispatcher refuses a share visitor's owner-only tools in its preflight (unchanged wording), and a
// tool it does run carries the visitor's restriction down to the executor, which enforces it again.
import { executePreparedTools, type ExecutePreparedToolsInput, type ToolDispatchPorts } from '../services/agentMode/core/toolDispatch';
import { toolResultError } from '../utils/toolResultError';

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});

function makePorts(executePreparedAgentTool: jest.Mock): ToolDispatchPorts {
  return {
    evaluateAgentToolPolicy: () => ({ allowed: true, effect: 'write', flags: [] }) as any,
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
    executePreparedAgentTool,
    toolResultError,
    recordToolTelemetry: () => undefined,
    extractMinimalToolResult: (result: any) => result,
    extractToolContent: (result: any) => JSON.stringify(result),
    formatToolError: (_n: string, message: string) => `ERR: ${message}`,
    uploadScreenshotToS3: async () => null,
    uploadFileToS3WithPath: async () => ({ success: true, key: 'unused' }),
    buildCrmDataChangedPayload: () => null,
    crmDataChangedEvent: 'crm:data-changed',
  };
}

function makeInput(calls: any[], ports: ToolDispatchPorts, over: Partial<ExecutePreparedToolsInput> = {}): ExecutePreparedToolsInput {
  return {
    toolCalls: calls,
    messages: [],
    toolCallsLedger: [],
    iteration: 0,
    agentRuntimeRunId: 'run-1',
    sessionId: 'session-share-1234567890',
    userId: 'owner-user',
    llmModel: 'gpt-4',
    mockMode: false,
    isDelegatedAccess: false,
    hasAdminAccess: false,
    isInteractiveShare: true,
    adminSkillToolNames: ['get_user_by_id'],
    publishedSkillsCount: 0,
    sessionAssociatedSkillIdsCount: 0,
    allowedToolNames: new Set<string>(['save_memory', 'read_brand_guidelines', 'get_user_by_id', 'connect_account', 'manage_scheduled_chat', 'install_skills']),
    toolResponseS3Threshold: 100_000,
    maxToolContentSize: 300_000,
    ports,
    ...over,
  };
}

const toolMessages = (input: ExecutePreparedToolsInput) => input.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));

describe('executePreparedTools for a share-link visitor (ENG-2816)', () => {
  it('refuses an owner-only tool before it reaches the executor, with the same wording as always', async () => {
    const exec = jest.fn();
    const input = makeInput([call('c1', 'save_memory', { content: 'x' })], makePorts(exec));
    await executePreparedTools(input);
    expect(exec).not.toHaveBeenCalled();
    expect(toolMessages(input).join('\n')).toContain(`Tool \\"save_memory\\" acts on the owner's organization settings or memory and is not available in shared sessions. The owner can use it in Agent Mode in their own session.`);
  });

  // ENG-3170: Full control = everything a customer can do. The early refusal asks the link (through an optional port); an admin tool is never lifted.
  describe('a link whose owner turned on full control', () => {
    it('does not turn away an owner-only tool or connect_account, and runs them', async () => {
      const exec = jest.fn().mockResolvedValue({ ok: true });
      const ports = { ...makePorts(exec), shareLinkFullControl: jest.fn().mockResolvedValue(true) };
      const input = makeInput([call('c1', 'save_memory', { content: 'x' }), call('c2', 'connect_account')], ports);
      await executePreparedTools(input);
      expect(exec).toHaveBeenCalledTimes(2);
      expect(ports.shareLinkFullControl).toHaveBeenCalledWith('session-share-1234567890');
      expect(toolMessages(input).join('\n')).not.toContain('not available in shared sessions');
    });

    it('still refuses an ADMIN tool', async () => {
      const exec = jest.fn();
      const ports = { ...makePorts(exec), shareLinkFullControl: jest.fn().mockResolvedValue(true) };
      const input = makeInput([call('c1', 'get_user_by_id')], ports);
      await executePreparedTools(input);
      expect(exec).not.toHaveBeenCalled();
      expect(toolMessages(input).join('\n')).toContain('Tool \\"get_user_by_id\\" is not available in shared sessions.');
    });

    it.each([['says no', jest.fn().mockResolvedValue(false)], ['is not wired', undefined]])('keeps the refusal when the link %s', async (_label, port) => {
      const exec = jest.fn();
      const ports: ToolDispatchPorts = { ...makePorts(exec), ...(port ? { shareLinkFullControl: port as any } : {}) };
      const input = makeInput([call('c1', 'save_memory', { content: 'x' })], ports);
      await executePreparedTools(input);
      expect(exec).not.toHaveBeenCalled();
      expect(toolMessages(input).join('\n')).toContain('is not available in shared sessions');
    });

    it('asks nothing for an ordinary tool, and nothing outside a share session', async () => {
      const exec = jest.fn().mockResolvedValue({ ok: true });
      const ask = jest.fn().mockResolvedValue(true);
      await executePreparedTools(makeInput([call('c1', 'read_brand_guidelines')], { ...makePorts(exec), shareLinkFullControl: ask }));
      await executePreparedTools(makeInput([call('c2', 'save_memory', { content: 'x' })], { ...makePorts(exec), shareLinkFullControl: ask }, { isInteractiveShare: false }));
      expect(ask).not.toHaveBeenCalled();
    });
  });

  it('refuses an admin tool and connect_account with the share wording', async () => {
    const exec = jest.fn();
    const input = makeInput([call('c1', 'get_user_by_id'), call('c2', 'connect_account')], makePorts(exec));
    await executePreparedTools(input);
    expect(exec).not.toHaveBeenCalled();
    const text = toolMessages(input).join('\n');
    expect(text).toContain('Tool \\"get_user_by_id\\" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.');
    expect(text).toContain('Account connections are not available in shared sessions.');
  });

  it('hands the visitor restriction to the executor for a tool it does run', async () => {
    const exec = jest.fn().mockResolvedValue({ ok: true });
    const input = makeInput([call('c1', 'read_brand_guidelines')], makePorts(exec));
    await executePreparedTools(input);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toMatchObject({ toolName: 'read_brand_guidelines', restrictionProfile: 'share_visitor' });
  });

  it('hands the restriction to the executor on the eager install_skills path too', async () => {
    const exec = jest.fn().mockResolvedValue({ success: true });
    const input = makeInput([call('c1', 'install_skills', { skillIds: ['x'] })], makePorts(exec));
    await executePreparedTools(input);
    const installCalls = exec.mock.calls.filter((c) => c[0].toolName === 'install_skills');
    expect(installCalls.length).toBeGreaterThan(0);
    for (const c of installCalls) expect(c[0]).toMatchObject({ restrictionProfile: 'share_visitor' });
  });

  it('keeps schedule tools available to a visitor (they are not blocked: schedules a visitor makes are marked instead)', async () => {
    const exec = jest.fn().mockResolvedValue({ ok: true });
    const input = makeInput([call('c1', 'manage_scheduled_chat', { action: 'create' })], makePorts(exec));
    await executePreparedTools(input);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toMatchObject({ toolName: 'manage_scheduled_chat', restrictionProfile: 'share_visitor' });
  });
});

describe('executePreparedTools for the owner (ENG-2816, unchanged)', () => {
  it('passes no restriction to the executor and does not refuse owner-only tools', async () => {
    const exec = jest.fn().mockResolvedValue({ ok: true });
    const input = makeInput(
      [call('c1', 'save_memory', { content: 'x' }), call('c2', 'read_brand_guidelines')],
      makePorts(exec),
      { isInteractiveShare: false, hasAdminAccess: false },
    );
    await executePreparedTools(input);
    expect(exec).toHaveBeenCalledTimes(2);
    for (const c of exec.mock.calls) expect(c[0]).not.toHaveProperty('restrictionProfile');
  });

  it('still says "requires admin access" (not the share wording) for an admin tool in a normal non-admin session', async () => {
    const exec = jest.fn();
    const input = makeInput([call('c1', 'get_user_by_id')], makePorts(exec), { isInteractiveShare: false, hasAdminAccess: false });
    await executePreparedTools(input);
    expect(exec).not.toHaveBeenCalled();
    expect(toolMessages(input).join('\n')).toContain('requires admin access. This session does not have admin privileges.');
  });
});
