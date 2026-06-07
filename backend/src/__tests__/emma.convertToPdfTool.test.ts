/**
 * Tests for the convert_to_pdf Emma tool registration.
 *
 * Customer bug: landscape 16:9 HTML presentations were rendered with the
 * default portrait PDF settings, clipping the right side. The tool must expose
 * an orientation parameter and pass it through to the PDF conversion pipeline.
 */

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    convertToPdf: jest.fn(),
  },
}));

import { emmaToolRegistry } from '../emma/registry';
import { agentModeService } from '../services/agentModeService';

import '../emma/tools';

describe('convert_to_pdf Emma tool', () => {
  const toolName = 'convert_to_pdf';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  it('exposes an optional orientation parameter for portrait or landscape PDFs', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    const props = (tool?.definition.inputSchema as any)?.properties || {};

    expect(props.orientation).toEqual(
      expect.objectContaining({
        type: 'string',
        enum: ['portrait', 'landscape'],
      })
    );
    expect((tool?.definition.inputSchema as any)?.required).toEqual([
      'source_url',
      'output_filename',
    ]);
  });

  it('passes landscape orientation through to agentModeService.convertToPdf', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const mockResponse = { success: true, pdf_url: 'https://example.com/deck.pdf' };
    (agentModeService.convertToPdf as jest.Mock).mockResolvedValue(mockResponse);

    const result = await tool.execute(
      {
        source_url: 'https://example.com/deck.html',
        output_filename: 'deck',
        orientation: 'landscape',
      },
      { userId: 'user-123' }
    );

    expect(agentModeService.convertToPdf).toHaveBeenCalledWith(
      'https://example.com/deck.html',
      'deck',
      'user-123',
      'landscape'
    );
    expect(result).toEqual(mockResponse);
  });
});
