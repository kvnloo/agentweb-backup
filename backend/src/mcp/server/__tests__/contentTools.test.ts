/**
 * ENG-2840 (W2-8): the six content tools for outside agents (contentTools.ts). What each sends to its route, what is refused before
 * anything is called (arguments by name, own-storage URLs only, sizes, shapes), the fixed-field answers, error handling, and the
 * per-caller guards. No network: the self-call is a double; the routes' own checks have their own tests.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { CallGuard, GUARDS, MAX_ANALYSIS_FILES, MAX_HTML_OPERATIONS, TIMEOUTS_MS, ownStorageUrl } from '../contentTools';
import { MCP_TOOL_SIDE_EFFECTS } from '../toolAnnotationPolicy';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true });
const call = (name: string, args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(name) as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const OWN = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-1/files/1/abc/report.html';
const OWN_IMG = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-1/files/1/abc/pic.png';
const OWN_CSV = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user-1/files/1/abc/data.csv';

beforeEach(() => {
  mockFetch.mockReset();
  Object.values(GUARDS).forEach((g) => g.reset());
});

describe('own storage URLs only', () => {
  it('accepts a URL of AgentWeb\'s bucket and refuses every other host, scheme and shape before any call', async () => {
    expect(ownStorageUrl('t', 'u', OWN)).toBe(OWN);
    const bad = ['https://example.com/x.html', 'http://agentweb-user-files.s3.us-west-2.amazonaws.com/users/u/x.html', 'data:image/png;base64,AAAA',
      'https://evil.com/agentweb-user-files.s3.amazonaws.com/users/u/x', ` ${OWN}`, `${OWN}${String.fromCharCode(0x202e)}`, 'file:///etc/passwd', 42, '', undefined];
    for (const [tool, field] of [['update_html_file', 'file_url'], ['describe_image', 'image_url']] as const) {
      for (const url of bad) {
        const args = tool === 'update_html_file' ? { file_url: url, update_type: 'css', operations: [{ action: 'remove', selector: 'p' }] } : { image_url: url };
        await expect(call(tool, args)).rejects.toThrow(new RegExp(`^${tool}: ${field}`));
      }
    }
    for (const url of bad.filter((u) => u !== undefined && u !== '')) {
      await expect(call('perform_data_analysis', { file_urls: [url], analysis_instruction: 'sum' })).rejects.toThrow(/file_urls\[0\]/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('list_html_templates', () => {
  const templates = [
    { template_id: 't1', template_name: 'Welcome', type: ['email'], subject: 'Hi', variables: ['name'], arrayVariables: [], created_at: 'a', updated_at: 'b', html_content: '<p>secret</p>', ownerId: 'u' },
    { template_id: 't2', template_name: 'LP', type: ['landing_page'], subject: '', variables: [], arrayVariables: ['items'], isPublic: true },
  ];
  it('answers fixed fields only (never the HTML) and filters by type in the wrapper', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, email_templates: templates });
    const all = parse(await call('list_html_templates', {}));
    expect(all.count).toBe(2);
    expect(JSON.stringify(all)).not.toMatch(/html_content|secret|ownerId/);
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/api/emma/html-templates' }));
    mockFetch.mockResolvedValueOnce({ success: true, email_templates: templates });
    const lp = parse(await call('list_html_templates', { type: 'landing_page' }));
    expect(lp.templates.map((t: any) => t.template_id)).toEqual(['t2']);
  });
  it('refuses an unknown type or argument before any call', async () => {
    await expect(call('list_html_templates', { type: 'sms' })).rejects.toThrow(/type must be "email" or "landing_page"/);
    await expect(call('list_html_templates', { user_id: 'x' })).rejects.toThrow(/"user_id" is not an input/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('create_html_file', () => {
  it('sends title, draft and options to the create-html route with a long timeout, never a session or model; answers fixed fields', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, s3_url: OWN, filename: 'f.html', title: 'T', document_type: 'email', message: 'm', error: 'x' });
    const a = parse(await call('create_html_file', { title: 'T', content_draft: '# Hello\nworld', format_requirements: 'blue', document_type: 'email' }));
    expect(a).toEqual({ s3_url: OWN, filename: 'f.html', title: 'T', document_type: 'email' });
    const req = mockFetch.mock.calls[0][0];
    expect(req).toMatchObject({ method: 'POST', path: '/api/emma/create-html', timeoutMs: TIMEOUTS_MS.create_html_file });
    expect(req.body).toEqual({ title: 'T', content_draft: '# Hello\nworld', format_requirements: 'blue', document_type: 'email' });
  });
  it('refuses bad inputs before any call', async () => {
    const cases: Array<[any, RegExp]> = [
      [{ content_draft: 'x' }, /title is required/],
      [{ title: 'T' }, /content_draft is required/],
      [{ title: 'x'.repeat(301), content_draft: 'x' }, /title is 301 characters/],
      [{ title: 'T', content_draft: 'x'.repeat(90_001) }, /content_draft is 90001 characters/],
      [{ title: `a${String.fromCharCode(10)}b`, content_draft: 'x' }, /title holds control/],
      [{ title: 'T', content_draft: 'x', document_type: 'pdf' }, /document_type must be/],
      [{ title: 'T', content_draft: 'x', session_id: 's' }, /"session_id" is not an input/],
      [{ title: 'T', content_draft: 'x', llm_model: 'opus' }, /"llm_model" is not an input/],
    ];
    for (const [args, re] of cases) await expect(call('create_html_file', args)).rejects.toThrow(re);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('create_html_from_template', () => {
  it('sends the id and the value objects; never a model or session', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, s3_url: OWN, final_subject: 'S', template_id: 't1', template_name: 'W', filename: 'f.html' });
    const a = parse(await call('create_html_from_template', { template_id: 't1', variable_values: { name: 'Ada' }, array_variable_values: { items: ['a', 'b'] } }));
    expect(a).toEqual({ s3_url: OWN, final_subject: 'S', template_id: 't1', template_name: 'W', filename: 'f.html' });
    expect(mockFetch.mock.calls[0][0].body).toEqual({ template_id: 't1', variable_values: { name: 'Ada' }, array_variable_values: { items: ['a', 'b'] } });
  });
  it('refuses wrong shapes and oversize values before any call', async () => {
    const big = { a: 'x'.repeat(50_001) };
    const cases: Array<[any, RegExp]> = [
      [{ template_id: 't1', variable_values: { name: 5 } }, /variable_values.name must be text/],
      [{ template_id: 't1', variable_values: ['x'] }, /variable_values must be an object/],
      [{ template_id: 't1', array_variable_values: { items: 'a' } }, /array_variable_values.items must be a list/],
      [{ template_id: 't1', variable_values: { 'bad key': 'x' } }, /is not a variable name/],
      [{ template_id: 't1', variable_values: big }, /bytes; at most 50000/],
      [{ template_id: ' t1' }, /template_id is not a valid id/],
      [{ template_id: 't1', llm_model: 'x' }, /"llm_model" is not an input/],
    ];
    for (const [args, re] of cases) await expect(call('create_html_from_template', args)).rejects.toThrow(re);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('update_html_file', () => {
  it('sends own-storage URL, type and operations; answers fixed fields', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, s3_url: OWN, message: 'ok', operations_applied: 1, operations: [{ index: 0, success: true }], error: 'x' });
    const a = parse(await call('update_html_file', { file_url: OWN, update_type: 'css', operations: [{ action: 'replaceInner', selector: 'h1', html: 'Hi' }] }));
    expect(a).toEqual({ s3_url: OWN, message: 'ok', operations_applied: 1, operations: [{ index: 0, success: true }] });
    expect(mockFetch.mock.calls[0][0].body).toEqual({ file_url: OWN, update_type: 'css', operations: [{ action: 'replaceInner', selector: 'h1', html: 'Hi' }] });
  });
  it('refuses the legacy part mode, unknown actions, too many operations and full edits without a hash', async () => {
    const ops = (n: number) => Array.from({ length: n }, () => ({ action: 'remove', selector: 'p' }));
    const cases: Array<[any, RegExp]> = [
      [{ file_url: OWN, update_type: 'part', operations: ops(1) }, /update_type must be "css" or "full"/],
      [{ file_url: OWN, update_type: 'css', operations: [{ action: 'eval', selector: 'p' }] }, /action must be one of/],
      [{ file_url: OWN, update_type: 'css', operations: ops(MAX_HTML_OPERATIONS + 1) }, /1 to 50 operations/],
      [{ file_url: OWN, update_type: 'css', operations: [] }, /1 to 50 operations/],
      [{ file_url: OWN, update_type: 'full', operations: [{ new_content: '<p>' }] }, /old_content_hash/],
    ];
    for (const [args, re] of cases) await expect(call('update_html_file', args)).rejects.toThrow(re);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('describe_image', () => {
  it('sends an image request for an own-storage image without a model; answers description and model only', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, description: 'a cat', model: 'vision-1', imageUrl: OWN_IMG });
    const a = parse(await call('describe_image', { image_url: OWN_IMG, prompt: 'what animal?' }));
    expect(a).toEqual({ description: 'a cat', model: 'vision-1' });
    expect(mockFetch.mock.calls[0][0]).toMatchObject({ path: '/api/emma/describe-media', body: { type: 'image', url: OWN_IMG, prompt: 'what animal?' } });
    expect(mockFetch.mock.calls[0][0].body.llm_model).toBeUndefined();
  });
  it('another account\'s file is refused by the route in its own words', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'File not found or you do not have access to it.', error: 'File not accessible' });
    await expect(call('describe_image', { image_url: OWN_IMG })).rejects.toThrow('describe_image: File not found or you do not have access to it.');
  });
});

describe('perform_data_analysis', () => {
  it('sends own-storage file URLs and the instruction with a long timeout; answers analysis, code and file links', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, analysis: 'mean 3', codeExecuted: 'print(3)', fileUrls: [OWN_IMG], formattedContent: 'x', message: 'm' });
    const a = parse(await call('perform_data_analysis', { file_urls: [OWN_CSV], analysis_instruction: 'mean of column a' }));
    expect(a).toEqual({ analysis: 'mean 3', codeExecuted: 'print(3)', fileUrls: [OWN_IMG] });
    expect(mockFetch.mock.calls[0][0]).toMatchObject({ path: '/api/emma/data-analysis', timeoutMs: TIMEOUTS_MS.perform_data_analysis, body: { file_urls: [OWN_CSV], analysis_instruction: 'mean of column a' } });
  });
  it('inline data with no files works; more than 5 files or an oversize instruction is refused', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, analysis: 'ok' });
    await expect(call('perform_data_analysis', { analysis_instruction: 'sum 1,2,3' })).resolves.toBeDefined();
    expect(mockFetch.mock.calls[0][0].body.file_urls).toEqual([]);
    await expect(call('perform_data_analysis', { file_urls: Array(MAX_ANALYSIS_FILES + 1).fill(OWN_CSV), analysis_instruction: 'x' })).rejects.toThrow(/at most 5 storage URLs/);
    await expect(call('perform_data_analysis', { analysis_instruction: 'x'.repeat(20_001) })).rejects.toThrow(/20001 characters/);
  });
});

describe('errors', () => {
  it('a refusal carries only the route message; a 4xx passes through; a 5xx or timeout is a fixed text that says whether a file may exist', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'Template "zz" not found', error: 'stack at /srv' });
    await expect(call('create_html_from_template', { template_id: 'zz' })).rejects.toThrow(/^create_html_from_template: Template "zz" not found\.$/);
    mockFetch.mockRejectedValueOnce(new Error('API error (429): Monthly token quota exceeded'));
    await expect(call('describe_image', { image_url: OWN_IMG })).rejects.toThrow('API error (429): Monthly token quota exceeded');
    mockFetch.mockRejectedValueOnce(new Error('API error (500): ENOENT /srv/x'));
    await expect(call('create_html_file', { title: 'T', content_draft: 'x' })).rejects.toThrow(/HTTP 500\).*A file may or may not have been created/);
    mockFetch.mockRejectedValueOnce(new Error('timeout of 960000ms exceeded'));
    await expect(call('describe_image', { image_url: OWN_IMG })).rejects.toThrow(/did not answer in time\. Nothing was changed\./);
  });
});

describe('guards', () => {
  it('one call at a time per caller; another caller is not blocked; the slot frees on failure too', async () => {
    let release!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = call('describe_image', { image_url: OWN_IMG }, 'u1');
    await expect(call('describe_image', { image_url: OWN_IMG }, 'u1')).rejects.toThrow(/another call of yours to this tool is still running/);
    mockFetch.mockResolvedValueOnce({ success: true, description: 'd' });
    await expect(call('describe_image', { image_url: OWN_IMG }, 'u2')).resolves.toBeDefined();
    release({ success: true, description: 'x' });
    await first;
    mockFetch.mockRejectedValueOnce(new Error('API error (500): x'));
    await expect(call('describe_image', { image_url: OWN_IMG }, 'u1')).rejects.toThrow(/HTTP 500/);
    expect(GUARDS.describe_image.inFlight).toBe(0);
  });
  it('the process cap and the hourly cap', () => {
    const g = new CallGuard('t', 2, 3);
    g.enter('a', 0); g.enter('b', 0);
    expect(() => g.enter('c', 0)).toThrow(/busy/);
    g.leave('a'); g.leave('b');
    g.enter('a', 1); g.leave('a');
    g.enter('a', 2); g.leave('a');
    expect(() => g.enter('a', 3)).toThrow(/3 calls to this tool in the last hour/);
    expect(() => g.enter('a', 60 * 60_000 + 1)).not.toThrow();
  });
});

describe('registration', () => {
  it('read tools are read-only, the others write; all need a user account', () => {
    const expected: Record<string, 'read' | 'write'> = { list_html_templates: 'read', describe_image: 'read', create_html_file: 'write', create_html_from_template: 'write', update_html_file: 'write', perform_data_analysis: 'write' };
    for (const [name, kind] of Object.entries(expected)) {
      const tool = mcpToolRegistry.getTool(name) as any;
      expect({ name, readOnly: Boolean(tool.readOnly), account: tool.requiresUserAccount }).toEqual({ name, readOnly: kind === 'read', account: true });
      expect(MCP_TOOL_SIDE_EFFECTS[name]).toBe(kind);
      expect(Object.keys(tool.definition.inputSchema.properties)).not.toContain('llm_model');
    }
  });
});
