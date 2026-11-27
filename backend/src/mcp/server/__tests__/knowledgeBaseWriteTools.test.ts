/**
 * ENG-2892: aw_-key MCP tools that write text files to the caller's OWN
 * knowledge base. Pins: runtime identity only (no client_id/user override),
 * foreign or missing KB/file answered identically, writes read back
 * (key + size + sha256), delete confirmed by read-back, text-only + size cap,
 * and tools:read keys denied (apiKeyScopes.ts / toolAnnotationPolicy.ts).
 */
const mockMcpFetch = jest.fn();
jest.mock('../httpClient', () => ({ mcpFetch: (...args: any[]) => mockMcpFetch(...args) }));
jest.mock('../../../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/funding/runFunding', () => ({
  currentRunFunding: () => ({ source: 'test' }),
  resolveRunFunding: jest.fn(),
  withRunFunding: (_f: any, fn: () => any) => fn(),
}));

import { createHash } from 'node:crypto';
import { mcpToolRegistry, withToolAnnotations } from '../registry';
import { KB_TEXT_FILE_MAX_BYTES } from '../apiTools';
import { buildKbListQuery, KB_LIST_TYPES, MAX_KB_LIST_LIMIT, MAX_KB_LIST_OFFSET } from '../knowledgeBaseParams';
import { findScopeDenial } from '../apiKeyScopes';
import { classifyMcpTool } from '../toolAnnotationPolicy';

const TOOLS = ['create_knowledge_base_file', 'update_knowledge_base_file_content', 'delete_knowledge_base_file'];
const API_KEY_CTX = { userId: 'owner-1', externalMcp: true, isInternal: false, authMethod: 'api_key', apiKeyId: 'k1' };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

function run(name: string, args: any, context: any = API_KEY_CTX): Promise<any> {
  return mcpToolRegistry.getTool(name)!.execute(args, context).then((r: any) => JSON.parse(r.content[0].text));
}

/**
 * Fake backend: one task store behind GET /api/tasks/:id and the write routes,
 * so every read-back reflects what the write route actually stored.
 */
function fakeBackend(tasks: Record<string, any>) {
  mockMcpFetch.mockImplementation(async ({ method, path, body }: any) => {
    const taskGet = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskGet) {
      const t = tasks[decodeURIComponent(taskGet[1])];
      if (!t) throw new Error('API error (404): Task not found');
      return JSON.parse(JSON.stringify(t));
    }
    if (path === '/api/emma/create-knowledge-base') {
      tasks['kb-new'] = { taskId: 'kb-new', userId: 'owner-1', knowledgeBaseSize: bytes(body.content), knowledgeBaseFiles: [] };
      return { success: true, taskId: 'kb-new' };
    }
    if (path === '/api/emma/attach-knowledge-base-files') {
      const t = tasks[body.task_id];
      for (const f of body.files) t.knowledgeBaseFiles.push({ filename: f.name, size: bytes(f.content), key: `tasks/${t.taskId}/knowledge-base-files/1_${f.name}` });
      return { success: true };
    }
    if (path === '/api/emma/update-knowledge-base-file') {
      const t = tasks[body.task_id];
      if (body.file_name === 'knowledge-base.txt') t.knowledgeBaseSize = bytes(body.content);
      else t.knowledgeBaseFiles.find((f: any) => f.filename === body.file_name).size = bytes(body.content);
      return { success: true };
    }
    const del = path.match(/^\/api\/tasks\/([^/]+)\/knowledge-base\/files\/(.+)$/);
    if (method === 'DELETE' && del) {
      const t = tasks[decodeURIComponent(del[1])];
      const key = decodeURIComponent(del[2]);
      t.knowledgeBaseFiles = t.knowledgeBaseFiles.filter((f: any) => f.key !== key);
      return { message: 'File deleted successfully', knowledgeBaseFiles: t.knowledgeBaseFiles };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

function seed() {
  return {
    'kb-own': {
      taskId: 'kb-own', userId: 'owner-1', knowledgeBaseSize: 5,
      knowledgeBaseFiles: [{ filename: 'notes.md', size: 3, key: 'tasks/kb-own/knowledge-base-files/0_notes.md' }],
    },
    'kb-foreign': {
      taskId: 'kb-foreign', userId: 'someone-else', knowledgeBaseSize: 5,
      knowledgeBaseFiles: [{ filename: 'secret.md', size: 3, key: 'tasks/kb-foreign/knowledge-base-files/0_secret.md' }],
    },
  };
}

const writeCalls = () => mockMcpFetch.mock.calls.map(([o]) => o).filter((o: any) => o.method !== 'GET');

beforeEach(() => jest.clearAllMocks());

describe('own-account happy path', () => {
  it('creates a file in an own KB and returns the read-back key, size and sha256', async () => {
    fakeBackend(seed());
    const content = '# Plan\nShip it.';
    const res = await run('create_knowledge_base_file', { kb_id: 'kb-own', file_name: 'plan.md', content });
    expect(res).toEqual({
      success: true, kb_id: 'kb-own', file_name: 'plan.md',
      file_key: 'tasks/kb-own/knowledge-base-files/1_plan.md', size_bytes: bytes(content), sha256: sha(content),
    });
    expect(writeCalls()).toEqual([expect.objectContaining({
      method: 'POST', path: '/api/emma/attach-knowledge-base-files',
      body: { task_id: 'kb-own', files: [{ name: 'plan.md', content }] },
      context: expect.objectContaining({ userId: 'owner-1' }),
    })]);
  });

  it('creates a new private KB when kb_id is omitted', async () => {
    fakeBackend(seed());
    const res = await run('create_knowledge_base_file', { kb_name: 'Research', content: 'hello' });
    expect(res).toMatchObject({ success: true, kb_id: 'kb-new', file_name: 'knowledge-base.txt', file_key: 'tasks/kb-new/knowledge-base.txt', size_bytes: 5, sha256: sha('hello') });
    expect(writeCalls()[0]).toMatchObject({ path: '/api/emma/create-knowledge-base', body: { name: 'Research', content: 'hello', knowledge_base_type: 'private' } });
  });

  it('replaces an existing file and reports the read-back size and hash', async () => {
    fakeBackend(seed());
    const content = 'replaced body';
    const res = await run('update_knowledge_base_file_content', { kb_id: 'kb-own', file_name: 'notes.md', content });
    expect(res).toMatchObject({ success: true, file_key: 'tasks/kb-own/knowledge-base-files/0_notes.md', size_bytes: bytes(content), sha256: sha(content) });
    expect(writeCalls()[0]).toMatchObject({ path: '/api/emma/update-knowledge-base-file', body: { task_id: 'kb-own', file_name: 'notes.md', content, mode: 'replace' } });
  });

  it('deletes an own file and confirms removal from the re-read task', async () => {
    const tasks = seed();
    fakeBackend(tasks);
    const res = await run('delete_knowledge_base_file', { kb_id: 'kb-own', file_name: 'notes.md' });
    expect(res).toEqual({ success: true, deleted: true, kb_id: 'kb-own', file_name: 'notes.md', file_key: 'tasks/kb-own/knowledge-base-files/0_notes.md' });
    expect(writeCalls()[0].path).toBe('/api/tasks/kb-own/knowledge-base/files/tasks%2Fkb-own%2Fknowledge-base-files%2F0_notes.md');
    expect(tasks['kb-own'].knowledgeBaseFiles).toEqual([]);
  });

  it('reports failure when the write does not read back', async () => {
    fakeBackend(seed());
    mockMcpFetch.mockImplementationOnce(async () => seed()['kb-own']) // ownership read
      .mockImplementationOnce(async () => ({ success: true })) // attach claims success but stores nothing
      .mockImplementationOnce(async () => seed()['kb-own']); // read-back
    const res = await run('create_knowledge_base_file', { kb_id: 'kb-own', file_name: 'ghost.md', content: 'x' });
    expect(res).toMatchObject({ success: false, error: 'Write could not be verified on read-back' });
  });
});

describe('foreign identifiers are refused without leaking existence', () => {
  it.each([
    ['create_knowledge_base_file', { kb_id: 'kb-foreign', file_name: 'x.md', content: 'x' }],
    ['update_knowledge_base_file_content', { kb_id: 'kb-foreign', file_name: 'secret.md', content: 'x' }],
    ['delete_knowledge_base_file', { kb_id: 'kb-foreign', file_name: 'secret.md' }],
  ])('%s on a foreign KB answers exactly like a missing one and writes nothing', async (tool, args) => {
    fakeBackend(seed());
    const foreign = await run(tool, args);
    const missing = await run(tool, { ...args, kb_id: 'kb-does-not-exist' });
    expect(foreign).toEqual({ success: false, error: 'Knowledge base or file not found' });
    expect(missing).toEqual(foreign);
    expect(writeCalls()).toEqual([]);
  });

  it('a route 403 is answered as not-found too', async () => {
    mockMcpFetch.mockRejectedValue(new Error('API error (403): Access denied'));
    expect(await run('delete_knowledge_base_file', { kb_id: 'kb-org', file_name: 'a.md' }))
      .toEqual({ success: false, error: 'Knowledge base or file not found' });
  });

  it('never deletes a file key that is not recorded on the own KB', async () => {
    fakeBackend(seed());
    const res = await run('delete_knowledge_base_file', { kb_id: 'kb-own', file_name: 'notes.md', file_key: 'tasks/kb-foreign/knowledge-base-files/0_secret.md' });
    expect(res).toEqual({ success: false, error: 'Knowledge base or file not found' });
    expect(writeCalls()).toEqual([]);
  });

  it('update of a non-existent own file is not-found, not a silent create', async () => {
    fakeBackend(seed());
    expect(await run('update_knowledge_base_file_content', { kb_id: 'kb-own', file_name: 'new.md', content: 'x' }))
      .toEqual({ success: false, error: 'Knowledge base or file not found' });
    expect(writeCalls()).toEqual([]);
  });

  it('ignores client_id / user_id overrides and keeps the key owner identity', async () => {
    fakeBackend(seed());
    await run('create_knowledge_base_file', { kb_id: 'kb-foreign', file_name: 'x.md', content: 'x', client_id: 'someone-else', user_id: 'someone-else' });
    for (const [opts] of mockMcpFetch.mock.calls) expect(opts.context.userId).toBe('owner-1');
    expect(writeCalls()).toEqual([]);
  });
});

describe('case-insensitive name conflicts', () => {
  it('rejects a create whose name differs only by case from an existing or main file', async () => {
    fakeBackend(seed());
    for (const file_name of ['NOTES.md', 'Knowledge-Base.txt']) {
      const res = await run('create_knowledge_base_file', { kb_id: 'kb-own', file_name, content: 'x' });
      expect(res.success).toBe(false);
      // The error names the stored file so the caller can update it by exact name.
      expect(res.error).toContain(file_name === 'NOTES.md' ? '"notes.md"' : '"knowledge-base.txt"');
    }
    expect(writeCalls()).toEqual([]);
  });

  it('refuses to delete the main file under a different case', async () => {
    fakeBackend(seed());
    const res = await run('delete_knowledge_base_file', { kb_id: 'kb-own', file_name: 'KNOWLEDGE-BASE.TXT' });
    expect(res.success).toBe(false);
    expect(writeCalls()).toEqual([]);
  });
});

describe('text only, size cap', () => {
  it('rejects oversize content before any API call', async () => {
    const res = await run('create_knowledge_base_file', { kb_id: 'kb-own', file_name: 'big.md', content: 'a'.repeat(KB_TEXT_FILE_MAX_BYTES + 1) });
    expect(res.success).toBe(false);
    expect(res.error).toContain('maximum');
    const upd = await run('update_knowledge_base_file_content', { kb_id: 'kb-own', file_name: 'notes.md', content: 'a'.repeat(KB_TEXT_FILE_MAX_BYTES + 1) });
    expect(upd.error).toContain('maximum');
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('rejects binary content and non-text file names', async () => {
    expect((await run('create_knowledge_base_file', { kb_id: 'kb-own', file_name: 'a.md', content: 'PNG\u0000\u0001' })).error).toContain('binary');
    expect((await run('create_knowledge_base_file', { kb_id: 'kb-own', file_name: 'a.pdf', content: 'x' })).error).toContain('.txt');
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });
});

describe('list_knowledge_bases: the inputs Emma\'s list takes (the service decides what each does)', () => {
  it('sends no query when called with no arguments (as before)', async () => {
    mockMcpFetch.mockResolvedValue({ files: [] });
    await run('list_knowledge_bases', {});
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/api/emma/knowledge-bases', queryParams: {} }));
  });

  it('forwards kb_type, the dates, limit and offset to the route', async () => {
    mockMcpFetch.mockResolvedValue({ files: [] });
    await run('list_knowledge_bases', { kb_type: 'google-drive', modified_after: '2026-04-15', modified_before: '2026-04-22', limit: 25, offset: '50' });
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({ queryParams: { kb_type: 'google-drive', modified_after: '2026-04-15', modified_before: '2026-04-22', limit: '25', offset: '50' } }));
  });

  it('empty, blank and zero values mean "not given"; the kind is matched without regard to case', () => {
    expect(buildKbListQuery({ kb_type: ' Private ', modified_after: ' ', limit: 0, offset: '', modified_before: null })).toEqual({ kb_type: 'private' });
    expect(buildKbListQuery({ limit: '0', offset: 0 })).toEqual({});
    expect(buildKbListQuery(undefined)).toEqual({});
  });

  it.each([
    ['a kind that is not one of the sources', { kb_type: 'dropbox' }, /kb_type must be one of google-drive, private, public, clickup, clickup-tasks, foreplay-swipefile, foreplay-board \(got "dropbox"\)/],
    ['a kind that is not text', { kb_type: 5 }, /kb_type must be one of/],
    ['a date that is not a date', { modified_after: 'last week' }, /modified_after must be a calendar date in YYYY-MM-DD form/],
    ['a date with a time (the service takes dates only)', { modified_after: '2026-04-15T10:00:00Z' }, /modified_after must be a calendar date in YYYY-MM-DD form/],
    ['a date that does not exist', { modified_before: '2026-02-31' }, /modified_before must be a calendar date in YYYY-MM-DD form/],
    ['a date with an impossible month', { modified_before: '2026-13-45' }, /modified_before must be a calendar date in YYYY-MM-DD form/],
    ['a date that is not text', { modified_after: 20260415 }, /modified_after must be text/],
    ['a negative limit', { limit: -1 }, /limit must be a whole number/],
    ['a fractional offset', { offset: 1.5 }, /offset must be a whole number/],
    ['a limit of words', { limit: 'many' }, /limit must be a whole number/],
  ])('%s is refused by name and nothing is sent', async (_label, args, message) => {
    await expect(run('list_knowledge_bases', args)).rejects.toThrow(message);
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('limit and offset have an upper bound (the service has none and would walk a whole Drive folder)', async () => {
    expect(buildKbListQuery({ limit: MAX_KB_LIST_LIMIT, offset: MAX_KB_LIST_OFFSET })).toEqual({ limit: String(MAX_KB_LIST_LIMIT), offset: String(MAX_KB_LIST_OFFSET) });
    await expect(run('list_knowledge_bases', { limit: MAX_KB_LIST_LIMIT + 1 })).rejects.toThrow(/limit must be 1000 or less/);
    await expect(run('list_knowledge_bases', { offset: '100001' })).rejects.toThrow(/offset must be 100000 or less/);
    await expect(run('list_knowledge_bases', { limit: 9007199254740991 })).rejects.toThrow(/limit must be 1000 or less/);
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('modified_after later than modified_before is refused (no file could match); the same day is fine', () => {
    expect(() => buildKbListQuery({ modified_after: '2026-04-22', modified_before: '2026-04-15' })).toThrow(/modified_after must not be later than modified_before/);
    expect(buildKbListQuery({ modified_after: '2026-04-15', modified_before: '2026-04-15' })).toEqual({ modified_after: '2026-04-15', modified_before: '2026-04-15' });
  });

  it('the years 0000 to 0099 are dates too (the service takes them)', () => {
    expect(buildKbListQuery({ modified_after: '0050-01-01' })).toEqual({ modified_after: '0050-01-01' });
    expect(() => buildKbListQuery({ modified_after: '0050-02-30' })).toThrow(/calendar date/);
  });

  it('padded dates and numbers are trimmed and leading zeros dropped', () => {
    expect(buildKbListQuery({ modified_after: ' 2026-04-15 ', limit: ' 025 ', offset: '007' })).toEqual({ modified_after: '2026-04-15', limit: '25', offset: '7' });
  });

  it('a leap day is a date, a non-leap one is not', () => {
    expect(buildKbListQuery({ modified_after: '2024-02-29' })).toEqual({ modified_after: '2024-02-29' });
    expect(() => buildKbListQuery({ modified_after: '2026-02-29' })).toThrow(/calendar date/);
  });

  it('every kind the schema offers is accepted', () => {
    for (const kind of KB_LIST_TYPES) expect(buildKbListQuery({ kb_type: kind })).toEqual({ kb_type: kind });
  });

  it('the description says what each input does (the service applies dates, limit and offset to Google Drive only)', () => {
    const description: string = mcpToolRegistry.getTool('list_knowledge_bases')!.definition.description;
    expect(description).toMatch(/modified_after and modified_before \(dates as YYYY-MM-DD\), limit \(1 to 1000, default 100\) and offset \(0 to 100000\) page and narrow the Google Drive files only/);
    expect(description).toMatch(/"private" and "public" both mean only the platform knowledge bases/);
    expect(description).toMatch(/ClickUp folder entries are listed whatever kb_type is/);
    expect(description).toMatch(/yours, those your organisation shares with you, and public ones/);
  });
});

describe('scopes and annotations', () => {
  const lookup = (name: string) => mcpToolRegistry.getTool(name);
  const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

  it.each(TOOLS)('%s is denied to a tools:read-only key and allowed with tools:execute', (tool) => {
    expect(findScopeDenial(call(tool), ['tools:read'], lookup)).toEqual({ tool, requiredScope: 'tools:execute' });
    expect(findScopeDenial(call(tool), ['tools:execute'], lookup)).toBeNull();
  });

  it.each(TOOLS)('%s is classified write and annotated destructive, externally discoverable', (tool) => {
    expect(classifyMcpTool(tool)).toBe('write');
    const t = mcpToolRegistry.getTool(tool)!;
    expect(withToolAnnotations(t).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(mcpToolRegistry.getToolDefinitions().map((d: any) => d.name)).toContain(tool);
    expect(Object.keys(t.definition.inputSchema.properties)).not.toEqual(expect.arrayContaining(['client_id']));
  });
});
