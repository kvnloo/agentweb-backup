/**
 * ENG-1477 follow-up (defense-in-depth): create_html_file and save_file did
 * not set `additionalProperties: false`, so a genuinely NEW (non-duplicate)
 * argument key — one the quote-repair heuristic in
 * repairToolCallArguments.ts might inject, or that a model might simply
 * hallucinate — would pass straight through validateAndRepairToolArgs
 * unflagged. Both handlers only ever read named fields (title, content_draft,
 * format_requirements, document_type / file_name, file_content), so an extra
 * key was already inert in practice — but that safety was incidental to how
 * the handler happens to be written, not guaranteed by the schema the
 * gateway actually validates against. This locks the guarantee in at the
 * schema level and confirms it doesn't regress the existing alias repairs.
 */
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';

describe.each(['create_html_file', 'save_file'])('%s schema hardening', (toolName) => {
  const tool: any = emmaToolRegistry.getTool(toolName);
  const schema = tool?.definition?.inputSchema;

  it('is registered with additionalProperties: false', () => {
    expect(tool).toBeTruthy();
    expect(schema.additionalProperties).toBe(false);
  });

  it('rejects a genuinely unrecognized argument the handler never reads', () => {
    const baseArgs = toolName === 'create_html_file'
      ? { title: 'T', content_draft: 'body' }
      : { file_name: 'f.txt', file_content: 'body' };

    const result = validateAndRepairToolArgs({
      toolName,
      args: { ...baseArgs, unexpected_injected_field: 'should not pass through' },
      inputSchema: schema,
      effect: 'internal_write',
    });

    expect(result.status).toBe('invalid');
    expect(result.issues.map((issue: any) => issue.code)).toContain('unknown_property');
  });
});

describe('create_html_file real schema still repairs known aliases with additionalProperties: false', () => {
  it('remaps file_name/html_content to title/content_draft', () => {
    const schema = emmaToolRegistry.getTool('create_html_file')?.definition?.inputSchema;
    const result = validateAndRepairToolArgs({
      toolName: 'create_html_file',
      args: { file_name: 'Q3 Report', html_content: '<h1>Hi</h1>' },
      inputSchema: schema,
      effect: 'internal_write',
    });

    expect(result.status).toBe('repaired');
    expect(result.args).toEqual({ title: 'Q3 Report', content_draft: '<h1>Hi</h1>' });
  });
});

describe('save_file real schema still repairs known aliases with additionalProperties: false', () => {
  it('remaps filename/content to file_name/file_content', () => {
    const schema = emmaToolRegistry.getTool('save_file')?.definition?.inputSchema;
    const result = validateAndRepairToolArgs({
      toolName: 'save_file',
      args: { filename: 'report.html', content: '<html>Saved</html>' },
      inputSchema: schema,
      effect: 'internal_write',
    });

    expect(result.status).toBe('repaired');
    expect(result.args).toEqual({ file_name: 'report.html', file_content: '<html>Saved</html>' });
  });
});
