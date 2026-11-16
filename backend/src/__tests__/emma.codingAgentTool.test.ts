/**
 * Tests for the coding_agent Emma tool (registration, model selection).
 */

// Mock agentModeService before importing tools.ts so the registered handlers bind
// to the mocked singleton (mirrors emma.describeImageTool.test.ts).
const mockGetDefaultModel = jest.fn().mockResolvedValue('configured-default-model');
jest.mock('../services/agentModeService', () => ({
  agentModeService: { getDefaultModel: (...a: any[]) => mockGetDefaultModel(...a) },
}));

// Control the coding agent runner and the usage meter.
const mockRunCodingAgent = jest.fn();
jest.mock('../services/codingAgentService', () => ({
  LANDING_PAGE_PREVIEW_BRANCH: 'draft/agentweb-preview',
  runCodingAgent: (...a: any[]) => mockRunCodingAgent(...a),
}));

import { emmaToolRegistry } from '../emma/registry';
// Import tools.ts to ensure tools are registered
import '../emma/tools';

describe('coding_agent Emma tool', () => {
  const toolName = 'coding_agent';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  // ENG-2648: no hard-coded model id. The chat's model wins; without one the configured system default is used.
  describe('model passed to the coding agent', () => {
    beforeEach(() => mockRunCodingAgent.mockResolvedValue({ success: true, message: 'done', iterations: 1 }));
    const run = async (context: Record<string, unknown>) => {
      const tool = emmaToolRegistry.getTool(toolName);
      if (!tool) throw new Error(`Tool ${toolName} not found`);
      await tool.execute({ page_id: 'page-1', task_description: 'change the hero' }, context);
      return mockRunCodingAgent.mock.calls[0][1].llmModel;
    };

    it("uses the chat's model when the context has one (no default lookup)", async () => {
      expect(await run({ userId: 'user-123', sessionId: 'sess-1', llmModel: 'openrouter/openai/gpt-6-sol' })).toBe('openrouter/openai/gpt-6-sol');
      expect(mockGetDefaultModel).not.toHaveBeenCalled();
    });

    it('falls back to the configured system default model, never a hard-coded id', async () => {
      expect(await run({ userId: 'user-123', sessionId: 'sess-1' })).toBe('configured-default-model');
      expect(mockGetDefaultModel).toHaveBeenCalledTimes(1);
    });
  });
});
