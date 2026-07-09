/**
 * Tests for the coding_agent tool's per-user usage accounting (ENG-200).
 *
 * The coding agent runs a self-contained multi-turn LLM loop whose token spend is
 * invisible to the parent agent-mode meter. runCodingAgent surfaces the summed usage
 * as result.usageTotals; the tool handler must charge it to the caller's monthly
 * token/cost cap via incrementUserTokenUsage — otherwise the (often high) coding-agent
 * spend never counts against the per-user cap this ticket introduced.
 */

// Mock agentModeService before importing tools.ts so the registered handlers bind
// to the mocked singleton (mirrors emma.describeImageTool.test.ts).
jest.mock('../services/agentModeService', () => ({
  agentModeService: {},
}));

// Control the coding agent runner and the usage meter.
const mockRunCodingAgent = jest.fn();
jest.mock('../services/codingAgentService', () => ({
  LANDING_PAGE_PREVIEW_BRANCH: 'draft/agentweb-preview',
  runCodingAgent: (...a: any[]) => mockRunCodingAgent(...a),
}));

const mockIncrementUserTokenUsage = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/tokenUsageService', () => ({
  incrementUserTokenUsage: (...a: any[]) => mockIncrementUserTokenUsage(...a),
}));

import { emmaToolRegistry } from '../emma/registry';
// Import tools.ts to ensure tools are registered
import '../emma/tools';

describe('coding_agent Emma tool — per-user usage accounting', () => {
  const toolName = 'coding_agent';

  const usageTotals = {
    inputTokens: 300,
    outputTokens: 60,
    cacheReadTokens: 5,
    cacheWriteTokens: 3,
    totalTokens: 368,
    costUsd: 0.00181275,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  it('charges the coding agent usageTotals to the caller via incrementUserTokenUsage', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    mockRunCodingAgent.mockResolvedValue({
      success: true,
      message: 'done',
      iterations: 2,
      branch: 'draft/agentweb-preview',
      usageTotals,
    });

    const result = await tool.execute(
      { page_id: 'page-1', task_description: 'change the hero' },
      { userId: 'user-123', sessionId: 'sess-1', llmModel: 'anthropic.claude-sonnet-4-6' }
    );

    expect(result.success).toBe(true);
    expect(mockIncrementUserTokenUsage).toHaveBeenCalledWith('user-123', 368, 0.00181275);
  });

  it('does not record usage when the runner reports no usageTotals', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    mockRunCodingAgent.mockResolvedValue({
      success: false,
      message: 'not authorized',
      iterations: 0,
      notAuthorized: true,
    });

    await tool.execute(
      { page_id: 'page-1', task_description: 'change the hero' },
      { userId: 'user-123', sessionId: 'sess-1' }
    );

    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });

  it('does not record usage when there is no userId to charge', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    mockRunCodingAgent.mockResolvedValue({
      success: true,
      message: 'done',
      iterations: 2,
      usageTotals,
    });

    await tool.execute(
      { page_id: 'page-1', task_description: 'change the hero' },
      { sessionId: 'sess-1' }
    );

    expect(mockIncrementUserTokenUsage).not.toHaveBeenCalled();
  });
});
