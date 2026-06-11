/**
 * Tests for the read_file_content Emma tool contract.
 *
 * AgentMode's Tool Gateway owns schema repair/retry before this tool executes.
 * Keep the tool itself narrow: it should declare and use the canonical
 * `file_url` argument, not grow per-tool alias/missing-arg logic.
 */

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    readFileContent: jest.fn(),
    createHtmlFile: jest.fn(),
    createHtmlFromTemplate: jest.fn(),
    updateHtmlFile: jest.fn(),
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

  it('declares only the canonical file_url input (gateway owns alias repair)', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    const props = (tool?.definition.inputSchema as any)?.properties || {};

    expect(props.file_url).toBeDefined();
    expect(props.url).toBeUndefined();
    expect((tool?.definition.inputSchema as any)?.required).toEqual(['file_url']);
  });

  it('calls readFileContent with the canonical file_url', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    (agentModeService.readFileContent as jest.Mock).mockResolvedValue({
      success: true,
      content: 'hello from attachment'
    });

    const result = await tool.execute(
      { file_url: 'https://example.com/pasted-text.txt' },
      { userId: 'user-123', sessionId: 'sess-1' }
    );

    expect(agentModeService.readFileContent).toHaveBeenCalledWith('https://example.com/pasted-text.txt');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello from attachment' }]
    });
  });

  it('delegates missing file_url to the service guard instead of local alias logic', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    (agentModeService.readFileContent as jest.Mock).mockResolvedValue({
      success: false,
      message: 'file_url is required and must be a non-empty HTTP or HTTPS URL.',
      error: 'Missing file_url'
    });

    const result = await tool.execute({}, { userId: 'user-123', sessionId: 'sess-1' });

    expect(agentModeService.readFileContent).toHaveBeenCalledWith(undefined);
    expect(result).toMatchObject({ isError: true });
    expect(result.content?.[0]?.text).toContain('file_url is required');
  });
});

describe('HTML Emma tools contract cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('install_skills declares non-empty skillIds at the schema layer', () => {
    const tool = emmaToolRegistry.getTool('install_skills');
    const skillIdsSchema = (tool?.definition.inputSchema as any)?.properties?.skillIds;

    expect(skillIdsSchema).toMatchObject({
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
    });
  });

  it('update_html_file declares replacement_json as a gateway-owned alias', () => {
    const tool = emmaToolRegistry.getTool('update_html_file');
    const operationsSchema = (tool?.definition.inputSchema as any)?.properties?.operations_json;

    expect(operationsSchema?.['x-aliases']).toContain('replacement_json');
  });

  it('coding_agent declares common argument drift as gateway-owned aliases', () => {
    const tool = emmaToolRegistry.getTool('coding_agent');
    const props = (tool?.definition.inputSchema as any)?.properties || {};

    expect(props.page_id?.['x-aliases']).toContain('landing_page_id');
    expect(props.task_description?.['x-aliases']).toContain('instructions');
  });

  it('create_html_file delegates canonical required args to the service', async () => {
    const tool = emmaToolRegistry.getTool('create_html_file');
    if (!tool) throw new Error('Tool create_html_file not found');

    (agentModeService.createHtmlFile as jest.Mock).mockResolvedValue({ success: true, s3_url: 'https://example.com/doc.html' });

    const result = await tool.execute(
      {
        title: 'Weekly Report',
        content_draft: 'Full report body',
        format_requirements: 'Use brand colors',
        document_type: 'email'
      },
      { userId: 'user-123', sessionId: 'sess-1' }
    );

    expect(agentModeService.createHtmlFile).toHaveBeenCalledWith(
      'Weekly Report',
      'Full report body',
      'Use brand colors',
      'user-123',
      'sess-1',
      'email'
    );
    expect(result).toEqual({ success: true, s3_url: 'https://example.com/doc.html' });
  });

  it('update_html_file delegates required fields after parsing operations JSON', async () => {
    const tool = emmaToolRegistry.getTool('update_html_file');
    if (!tool) throw new Error('Tool update_html_file not found');

    (agentModeService.updateHtmlFile as jest.Mock).mockResolvedValue({ success: true, s3_url: 'https://example.com/updated.html' });

    const operations = [{ action: 'replaceInner', selector: 'h1', html: 'New title' }];
    const result = await tool.execute(
      {
        file_url: 'https://example.com/source.html',
        update_type: 'css',
        operations_json: JSON.stringify(operations)
      },
      { userId: 'user-123', sessionId: 'sess-1' }
    );

    expect(agentModeService.updateHtmlFile).toHaveBeenCalledWith(
      'https://example.com/source.html',
      'css',
      operations,
      'user-123',
      'sess-1'
    );
    expect(result).toEqual({ success: true, s3_url: 'https://example.com/updated.html' });
  });

  it('create_html_from_template delegates template_id after parsing JSON values', async () => {
    const tool = emmaToolRegistry.getTool('create_html_from_template');
    if (!tool) throw new Error('Tool create_html_from_template not found');

    (agentModeService.createHtmlFromTemplate as jest.Mock).mockResolvedValue({ success: true, s3_url: 'https://example.com/template.html' });

    const result = await tool.execute(
      {
        template_id: 'tpl_123',
        variable_values_json: JSON.stringify({ title: 'Hello' }),
        array_variable_values_json: JSON.stringify({ links_n: [] })
      },
      { llmModel: 'anthropic.claude-sonnet-4-6', userId: 'user-123', sessionId: 'sess-1' }
    );

    expect(agentModeService.createHtmlFromTemplate).toHaveBeenCalledWith(
      'anthropic.claude-sonnet-4-6',
      'tpl_123',
      { title: 'Hello' },
      { links_n: [] },
      'user-123',
      'sess-1'
    );
    expect(result).toEqual({ success: true, s3_url: 'https://example.com/template.html' });
  });
});
