/**
 * Tests for the describe_image tool registered in emmaToolRegistry.
 *
 * describe_image intentionally uses the configured agent_mode_default_model rather
 * than the chat's selected model. The handler must therefore call
 * agentModeService.describeImage with NO model argument (undefined), so the model
 * is resolved to the default inside describeImage. Forwarding the chat model here
 * is what previously routed every call to Vertex Opus 4.8.
 */

// Mock agentModeService before importing tools.ts so the registered handler binds
// to the mocked singleton.
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    describeImage: jest.fn(),
  },
}));

import { emmaToolRegistry } from '../emma/registry';
import { agentModeService } from '../services/agentModeService';

// Import tools.ts to ensure tools are registered
import '../emma/tools';

describe('describe_image Emma tool', () => {
  const toolName = 'describe_image';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  it('does not expose an llmModel input (uses the default model, not a caller-chosen one)', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    const props = (tool?.definition.inputSchema as any)?.properties || {};
    expect(props.llmModel).toBeUndefined();
    expect(props.image_url).toBeDefined();
  });

  it('calls describeImage with undefined model so the default model is used — NOT the chat model', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const mockResponse = { success: true, description: 'a logo' };
    (agentModeService.describeImage as jest.Mock).mockResolvedValue(mockResponse);

    const args = { image_url: 'https://example.com/chart.png', prompt: 'describe it' };
    // The chat is on anthropic.claude-opus-4-8 — this must NOT be forwarded to describeImage.
    const context = { llmModel: 'anthropic.claude-opus-4-8', userId: 'user-123', sessionId: 'sess-1' };

    const result = await tool.execute(args, context);

    expect(agentModeService.describeImage).toHaveBeenCalledWith(
      undefined,
      'https://example.com/chart.png',
      'describe it'
    );
    // Guard against regressing to forwarding the chat model
    expect(agentModeService.describeImage).not.toHaveBeenCalledWith(
      'anthropic.claude-opus-4-8',
      expect.anything(),
      expect.anything()
    );
    expect(result).toEqual(mockResponse);
  });

  it('passes through image_url with no prompt (prompt undefined)', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    (agentModeService.describeImage as jest.Mock).mockResolvedValue({ success: true });

    await tool.execute({ image_url: 'https://example.com/a.png' }, { llmModel: 'gpt-5.5' });

    expect(agentModeService.describeImage).toHaveBeenCalledWith(
      undefined,
      'https://example.com/a.png',
      undefined
    );
  });
});
