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

  it('passes acceptance checks through the registered tool and records verified success', async () => {
    mockedRunCodingAgent.mockResolvedValue({
      success: true,
      message: 'Updated the simple landing page headline.\n\nAcceptance passed (1/1 checks).',
      iterations: 2,
      previewUrl: 'https://preview.example',
      branch: 'draft/session-smoke-12',
      acceptanceStatus: 'passed',
      acceptance: {
        status: 'passed',
        summary: 'Acceptance passed (1/1 checks).',
        checks: [{
          id: 'check_1',
          type: 'browser_eval',
          label: 'Hero headline changed',
          status: 'passed',
          expected: true,
          actual: true,
          message: 'Browser assertion passed.',
        }],
      },
    });

    const acceptanceChecks = [{
      type: 'browser_eval',
      label: 'Hero headline changed',
      script: 'return document.body.innerText.includes("Launch Faster");',
    }];
    const ports = makePorts({ userId: 'user-smoke', sessionId: 'session-smoke-1234567890' });
    const input = makeInput([
      toolCall('call-1', {
        page_id: 'lp_smoke',
        task_description: 'Change the hero headline to Launch Faster.',
        acceptance_checks: acceptanceChecks,
      }),
    ], ports);

    const result = await executePreparedTools(input);

    expect(mockedRunCodingAgent).toHaveBeenCalledWith(
      'Change the hero headline to Launch Faster.',
      expect.objectContaining({
        pageId: 'lp_smoke',
        userId: 'user-smoke',
        sessionId: 'session-smoke-1234567890',
        draftBranch: 'draft/session-smoke-12',
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
    mockedRunCodingAgent.mockResolvedValue({
      success: false,
      message: 'Updated the simple landing page headline.\n\nAcceptance failed (1/1 checks failed).\n- Hero headline changed: Browser assertion failed.',
      iterations: 2,
      previewUrl: 'https://preview.example',
      branch: 'draft/session-smoke-12',
      acceptanceStatus: 'failed',
      acceptance: {
        status: 'failed',
        summary: 'Acceptance failed (1/1 checks failed).',
        checks: [{
          id: 'check_1',
          type: 'browser_eval',
          label: 'Hero headline changed',
          status: 'failed',
          expected: true,
          actual: false,
          message: 'Browser assertion failed.',
        }],
      },
    });

    const ports = makePorts({ userId: 'user-smoke', sessionId: 'session-smoke-1234567890' });
    const input = makeInput([
      toolCall('call-1', {
        page_id: 'lp_smoke',
        task_description: 'Change the hero headline to Launch Faster.',
        acceptance_checks: [{
          type: 'browser_eval',
          label: 'Hero headline changed',
          script: 'return document.body.innerText.includes("Launch Faster");',
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
            label: 'Hero headline changed',
            status: 'failed',
            message: 'Browser assertion failed.',
          })],
        },
      },
    });
    expect(input.messages[0].content).toContain('ERR: Updated the simple landing page headline.');
  });
});
