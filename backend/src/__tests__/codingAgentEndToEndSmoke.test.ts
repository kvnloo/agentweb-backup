import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { runCodingAgent } from '../services/codingAgentService';
import {
  executePreparedTools,
  type ExecutePreparedToolsInput,
  type ToolDispatchPorts,
} from '../services/agentMode/core/toolDispatch';
import { toolResultError } from '../utils/toolResultError';

jest.mock('../services/codingAgentService', () => ({
  LANDING_PAGE_PREVIEW_BRANCH: 'draft/agentweb-preview',
  runCodingAgent: jest.fn(),
}));

function toolCall(id: string, args: Record<string, unknown>) {
  return {
    id,
    type: 'function',
    function: {
      name: 'coding_agent',
      arguments: JSON.stringify(args),
    },
  };
}

function makePorts(context: Record<string, unknown>): ToolDispatchPorts {
  return {
    evaluateAgentToolPolicy: () => ({ allowed: true, effect: 'write', flags: [] }) as any,
    validateAndRepairToolArgs: (i: any) => ({ status: 'valid', args: i.args }),
    getToolInputSchema: () => emmaToolRegistry.getTool('coding_agent')?.definition?.inputSchema,
    executeAgentToolThroughGateway: async (i) => {
      try {
        const result = await i.execute();
        return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
      } catch (error) {
        return { status: 'error', error, durationMs: 1, policyDecision: i.policyDecision };
      }
    },
    executePreparedAgentTool: async (i: any) => emmaToolRegistry.execute(i.toolName, i.functionArgs, context),
    toolResultError,
    recordToolTelemetry: () => undefined,
    extractMinimalToolResult: (result: any) => result,
    extractToolContent: (result: any) => JSON.stringify(result),
    formatToolError: (_name: string, message: string) => `ERR: ${message}`,
    uploadScreenshotToS3: async () => null,
    uploadFileToS3WithPath: async () => ({ success: true, key: 'unused' }),
    buildCrmDataChangedPayload: () => null,
    crmDataChangedEvent: 'crm:data-changed',
  };
}

function makeInput(calls: any[], ports: ToolDispatchPorts): ExecutePreparedToolsInput {
  return {
    toolCalls: calls,
    messages: [],
    toolCallsLedger: [],
    iteration: 0,
    agentRuntimeRunId: 'run-smoke',
    sessionId: 'session-smoke-1234567890',
    userId: 'user-smoke',
    llmModel: 'anthropic.claude-sonnet-4-6',
    mockMode: false,
    isDelegatedAccess: false,
    hasAdminAccess: true,
    isInteractiveShare: false,
    adminSkillToolNames: [],
    publishedSkillsCount: 0,
    sessionAssociatedSkillIdsCount: 0,
    allowedToolNames: new Set<string>(['coding_agent']),
    toolResponseS3Threshold: 100_000,
    maxToolContentSize: 300_000,
    ports,
  };
}

describe('coding_agent acceptance end-to-end smoke', () => {
  const mockedRunCodingAgent = runCodingAgent as jest.MockedFunction<typeof runCodingAgent>;

  beforeEach(() => {
    mockedRunCodingAgent.mockReset();
  });

  it('does not expose browser_eval in the public coding_agent acceptance schema', () => {
    const schema = emmaToolRegistry.getTool('coding_agent')?.definition?.inputSchema as any;
    const typeEnum = schema?.properties?.acceptance_checks?.items?.properties?.type?.enum;
    expect(typeEnum).toEqual([
      'http_status',
      'text_present',
      'selector_exists',
      'no_console_errors',
      'no_external_hosts',
    ]);
    expect(typeEnum).not.toContain('browser_eval');
  });

  it('passes acceptance checks through the registered tool and records verified success', async () => {
    const token = 'aw_smoke_6f3a91c2';
    mockedRunCodingAgent.mockResolvedValue({
      success: true,
      message: `Updated the simple landing page token.\n\nAcceptance passed (1/1 checks).`,
      iterations: 2,
      previewUrl: 'https://preview.example',
      branch: 'draft/agentweb-preview',
      acceptanceStatus: 'passed',
      acceptance: {
        status: 'passed',
        summary: 'Acceptance passed (1/1 checks).',
        checks: [{
          id: 'check_1',
          type: 'text_present',
          label: 'Opaque token visible',
          status: 'passed',
          expected: true,
          actual: true,
          message: `Found expected text "${token}".`,
        }],
      },
    });

    const acceptanceChecks = [{
      type: 'text_present',
      label: 'Opaque token visible',
      text: token,
    }];
    const ports = makePorts({ userId: 'user-smoke', sessionId: 'session-smoke-1234567890' });
    const input = makeInput([
      toolCall('call-1', {
        page_id: 'lp_smoke',
        task_description: `Add opaque verification token ${token} to the requested landing page content.`,
        acceptance_checks: acceptanceChecks,
      }),
    ], ports);

    const result = await executePreparedTools(input);

    expect(mockedRunCodingAgent).toHaveBeenCalledWith(
      `Add opaque verification token ${token} to the requested landing page content.`,
      expect.objectContaining({
        pageId: 'lp_smoke',
        userId: 'user-smoke',
        sessionId: 'session-smoke-1234567890',
        draftBranch: 'draft/agentweb-preview',
        acceptanceChecks,
      }),
    );
    expect(result.pendingCounterUpdates).toEqual({ coding_agent: 1 });
    expect(result.failedCounterUpdates).toEqual({});
    expect(input.toolCallsLedger[0]).toMatchObject({
      name: 'coding_agent',
      result: {
        success: true,
        previewUrl: 'https://preview.example',
        acceptanceStatus: 'passed',
        acceptance: { summary: 'Acceptance passed (1/1 checks).' },
        is_staging: true,
      },
    });
    expect(input.messages[0].content).toContain('"acceptanceStatus":"passed"');
  });

  it('turns failed acceptance into a failed tool call while preserving check details for the UI', async () => {
    const token = 'aw_smoke_b51d72ae';
    mockedRunCodingAgent.mockResolvedValue({
      success: false,
      message: `Updated the simple landing page token.\n\nAcceptance failed (1/1 checks failed).\n- Opaque token visible: Did not find expected text "${token}".`,
      iterations: 2,
      previewUrl: 'https://preview.example',
      branch: 'draft/agentweb-preview',
      acceptanceStatus: 'failed',
      acceptance: {
        status: 'failed',
        summary: 'Acceptance failed (1/1 checks failed).',
        checks: [{
          id: 'check_1',
          type: 'text_present',
          label: 'Opaque token visible',
          status: 'failed',
          expected: true,
          actual: false,
          message: `Did not find expected text "${token}".`,
        }],
      },
    });

    const ports = makePorts({ userId: 'user-smoke', sessionId: 'session-smoke-1234567890' });
    const input = makeInput([
      toolCall('call-1', {
        page_id: 'lp_smoke',
        task_description: `Add opaque verification token ${token} to the requested landing page content.`,
        acceptance_checks: [{
          type: 'text_present',
          label: 'Opaque token visible',
          text: token,
        }],
      }),
    ], ports);

    const result = await executePreparedTools(input);

    expect(result.pendingCounterUpdates).toEqual({});
    expect(result.failedCounterUpdates).toEqual({ coding_agent: 1 });
    expect(input.toolCallsLedger[0]).toMatchObject({
      name: 'coding_agent',
      error: expect.stringContaining('Acceptance failed (1/1 checks failed).'),
      result: {
        success: false,
        acceptanceStatus: 'failed',
        previewUrl: 'https://preview.example',
        acceptance: {
          summary: 'Acceptance failed (1/1 checks failed).',
          checks: [expect.objectContaining({
            label: 'Opaque token visible',
            status: 'failed',
            message: `Did not find expected text "${token}".`,
          })],
        },
      },
    });
    expect(input.messages[0].content).toContain('ERR: Updated the simple landing page token.');
  });
});
