/**
 * Tests for the read_file_content Emma tool contract.
 *
 * The AgentMode attachment prompt gives the model file URLs. In production the
 * model passed `url` while the tool implementation only read `file_url`, which
 * forwarded undefined into readFileContent and crashed on startsWith().
 */

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    readFileContent: jest.fn(),
  },
}));

import { emmaToolRegistry } from '../emma/registry';
import { agentModeService } from '../services/agentModeService';

// Import tools.ts to ensure tools are registered.
import '../emma/tools';

describe('read_file_content Emma tool', () => {
  const toolName = 'read_file_content';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  it('accepts url as a backwards-compatible alias for file_url', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const mockResponse = { success: true, content: 'hello from attachment' };
    (agentModeService.readFileContent as jest.Mock).mockResolvedValue(mockResponse);

    const result = await tool.execute(
      { url: 'https://example.com/pasted-text.txt' },
      { userId: 'user-123', sessionId: 'sess-1' }
    );

    expect(agentModeService.readFileContent).toHaveBeenCalledWith('https://example.com/pasted-text.txt');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello from attachment' }]
    });
  });

  it('prefers file_url over url when both are present', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    (agentModeService.readFileContent as jest.Mock).mockResolvedValue({ success: true });

    await tool.execute(
      {
        file_url: 'https://example.com/canonical.txt',
        url: 'https://example.com/alias.txt'
      },
      { userId: 'user-123', sessionId: 'sess-1' }
    );

    expect(agentModeService.readFileContent).toHaveBeenCalledWith('https://example.com/canonical.txt');
  });

  it('returns a tool error instead of calling readFileContent with undefined', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const result = await tool.execute({}, { userId: 'user-123', sessionId: 'sess-1' });

    expect(agentModeService.readFileContent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result.content?.[0]?.text).toContain('file_url is required');
  });
});
