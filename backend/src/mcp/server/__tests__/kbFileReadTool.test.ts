/**
 * ENG-2840 (W2-10): `read_knowledge_base_files` for outside agents (mcp/server/kbFileReadTool.ts). What is refused before anything is
 * called (the route's own checks, gdoc:/gsheet: included), what is sent, the answer rebuilt from fixed fields whatever the route sends
 * (the condition for skipping the public sanitizer), 4xx/5xx handling, and the CallGuard. No network: the self-call is a double. The
 * route's own behaviour is pinned in src/__tests__/emmaKbFileReadRoutes.test.ts.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { KB_FILE_READ_GUARD, KB_FILE_READ_TIMEOUT_MS, kbFileReadAnswer, kbFileReadRequest } from '../kbFileReadTool';
import { sanitizePublicToolResult, shouldSanitizePublicResponse } from '../publicResponseSanitizer';
import {
  KB_FILE_FAILURE_KEYS,
  KB_FILE_READ_ERRORS,
  KB_FILE_READ_MAX_CALL_CHARS,
  KB_FILE_READ_MAX_FILE_CHARS,
  KB_FILE_SUCCESS_KEYS,
} from '../../../routes/emmaKbFileReadRoutes';

const mockFetch = mcpFetch as jest.Mock;
const TOOL = 'read_knowledge_base_files';
const TASK = '3f2b8c1e-9a4d-4e6f-8b21-0c5d7e9f1a2b';
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true });
const call = (args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(TOOL) as any).execute(args, ctxFor(userId));
const parse = (result: any) => JSON.parse(result.content[0].text);
const files1 = { files: [{ kb_identifier: TASK, file_name: 'data.json' }] };
const JSON_TEXT = '{"apiKeyId":"k-9","sessionId":"s-9","text":"mine"}';
const okFile = (extra: Record<string, unknown> = {}) => ({
  kb_identifier: TASK, file_name: 'data.json', ok: true, knowledge_base_name: 'Brand KB', source: 'agentweb',
  content: JSON_TEXT, content_chars: JSON_TEXT.length, truncated: false, size_bytes: 50, modified_at: '2026-11-20T10:00:00.000Z', ...extra,
});

beforeEach(() => {
  mockFetch.mockReset();
  KB_FILE_READ_GUARD.reset();
});

describe('refused before anything is called', () => {
  it('any other argument, by name', async () => {
    for (const extra of ['user_id', 'userId', 'max_chars', 'client_id']) {
      await expect(call({ ...files1, [extra]: 'x' })).rejects.toThrow(new RegExp(`^${TOOL}: "${extra}" is not an input of ${TOOL}\\. Its inputs are: files\\. Nothing was changed\\.$`));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('the route\'s own value checks: gdoc:/gsheet:, shapes, counts, entry keys, file names', async () => {
    const bad: Array<[unknown, RegExp]> = [
      [{}, /files is required/],
      [{ files: [] }, /1 to 5 entries/],
      [{ files: Array.from({ length: 6 }, () => ({ kb_identifier: TASK, file_name: 'a' })) }, /1 to 5 entries/],
      [{ files: [{ kb_identifier: 'gdoc:1AbC', file_name: 'a' }] }, /gdoc: or gsheet: identifier\) cannot be read over MCP/],
      [{ files: [{ kb_identifier: 'gsheet:1AbC', file_name: 'a' }] }, /cannot be read over MCP/],
      [{ files: [{ kb_identifier: 'other-tenant-task', file_name: 'a' }] }, /kb_identifier must be an identifier from list_knowledge_bases/],
      [{ files: [{ kb_identifier: TASK, file_name: 'a', owner_id: 'victim' }] }, /"owner_id" is not an input\. Each entry takes exactly kb_identifier and file_name/],
      [{ files: [{ kb_identifier: TASK, file_name: `a${String.fromCharCode(0x2066)}b` }] }, /no control or invisible characters/],
      ['files', /must be an object/],
    ];
    for (const [args, re] of bad) {
      await expect(call(args)).rejects.toThrow(re);
    }
    await expect(call({ files: [] })).rejects.toThrow(/Nothing was changed\.$/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('the request', () => {
  it('sends exactly the checked entries to the new route, with a timeout under the 600 s request cut', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, files: [okFile()], read: 1, of: 1 });
    await call(files1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = mockFetch.mock.calls[0][0];
    expect(sent).toStrictEqual({ method: 'POST', path: '/api/emma/kb-file-read', context: expect.any(Object), body: { files: files1.files }, timeoutMs: KB_FILE_READ_TIMEOUT_MS });
    expect(sent.context.userId).toBe('user-1');
    expect(KB_FILE_READ_TIMEOUT_MS).toBeLessThan(600_000);
    expect(kbFileReadRequest(files1)).toStrictEqual(files1.files);
  });
});

describe('the answer: fixed fields only (why the public sanitizer is skipped)', () => {
  it('has exactly {files, read, of}, and each file exactly the fixed keys, whatever extra the route sends', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true, message: 'Read 1 of 2', sessionId: 's-1', apiKeyId: 'k-1', read: 99, of: 99,
      files: [
        { ...okFile(), message: 'Successfully read', type: 'private', name: 'raw', updatedAt: 'x', error: 'stack at /srv/x.js', traceId: 't' },
        { kb_identifier: 'ECHO', file_name: 'ECHO', ok: false, error: KB_FILE_READ_ERRORS.not_found, message: 'Knowledge base "other" not found', code: 404 },
      ],
    });
    const answer = parse(await call({ files: [...files1.files, { kb_identifier: 'clickup:901', file_name: 'Plan' }] }));
    expect(Object.keys(answer)).toStrictEqual(['files', 'read', 'of']);
    expect(Object.keys(answer.files[0])).toStrictEqual([...KB_FILE_SUCCESS_KEYS]);
    expect(Object.keys(answer.files[1])).toStrictEqual([...KB_FILE_FAILURE_KEYS]);
    expect(answer).toStrictEqual({
      files: [okFile(), { kb_identifier: 'clickup:901', file_name: 'Plan', ok: false, error: KB_FILE_READ_ERRORS.not_found }],
      read: 1,
      of: 2,
    });
    expect(JSON.stringify(answer)).not.toMatch(/Successfully|ECHO|other|stack|traceId|Read 1 of 2/);
  });

  it('echoes the caller\'s own identifier and file name, never the route\'s', () => {
    const answer = kbFileReadAnswer(files1.files, { files: [okFile({ kb_identifier: 'someone-else', file_name: 'their.txt' })] });
    expect([answer.files[0].kb_identifier, answer.files[0].file_name]).toStrictEqual([TASK, 'data.json']);
  });

  it('an error text that is not one of the fixed texts becomes "could not be read"', () => {
    const answer = kbFileReadAnswer(files1.files, { files: [{ ok: false, error: 'Failed: ENOENT /srv/app/secret.json' }] });
    expect(answer.files[0]).toStrictEqual({ kb_identifier: TASK, file_name: 'data.json', ok: false, error: KB_FILE_READ_ERRORS.read_failed });
  });

  it('a success with a source that does not match the identifier, or no text, is not passed on', () => {
    for (const f of [okFile({ source: 'google_drive' }), okFile({ content: 42 }), { ...okFile(), ok: 'true' }]) {
      expect(kbFileReadAnswer(files1.files, { files: [f] }).files[0].ok).toBe(false);
    }
  });

  it('typed fields that are not what they say are null', () => {
    const f = kbFileReadAnswer(files1.files, { files: [okFile({ size_bytes: -1, modified_at: 'yesterday', knowledge_base_name: { x: 1 } })] }).files[0] as any;
    expect([f.size_bytes, f.modified_at, f.knowledge_base_name]).toStrictEqual([null, null, null]);
  });

  it('applies the per-file and per-call character limits again', () => {
    const big = 'z'.repeat(KB_FILE_READ_MAX_FILE_CHARS + 50);
    const sent = [0, 1, 2].map((i) => ({ kb_identifier: TASK, file_name: `f${i}.txt` }));
    const answer = kbFileReadAnswer(sent, { files: sent.map(() => okFile({ content: big, content_chars: big.length, truncated: false })) });
    expect(answer.files.map((f: any) => [f.content_chars, f.truncated])).toStrictEqual([[KB_FILE_READ_MAX_FILE_CHARS, true], [KB_FILE_READ_MAX_FILE_CHARS, true], [0, true]]);
    expect(answer.files.reduce((n, f: any) => n + f.content.length, 0)).toBe(KB_FILE_READ_MAX_CALL_CHARS);
  });

  it('an answer with the wrong number of files is refused with a fixed text', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, files: [okFile(), okFile()] });
    await expect(call(files1)).rejects.toThrow(`${TOOL}: the knowledge base service gave an answer this tool cannot use. Try again later. Nothing was changed.`);
    mockFetch.mockResolvedValueOnce({ success: true, files: 'nope' });
    await expect(call(files1)).rejects.toThrow(/cannot use/);
  });

  it('is an own-content tool: not sanitized, so a JSON file\'s text comes back exactly as stored', async () => {
    expect(shouldSanitizePublicResponse(TOOL, files1, { externalMcp: true })).toBe(false);
    mockFetch.mockResolvedValueOnce({ success: true, files: [okFile()] });
    const result = await call(files1);
    expect(parse(result).files[0].content).toBe(JSON_TEXT);
    // What the sanitizer would have done to it: the reason for the exemption.
    expect(JSON.stringify(sanitizePublicToolResult(result, TOOL))).not.toMatch(/k-9/);
  });
});

describe('errors from the route', () => {
  it('a 4xx passes through; a 5xx or no answer becomes a fixed text', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (400): files[0]: kb_identifier must be an identifier from list_knowledge_bases'));
    await expect(call(files1)).rejects.toThrow('API error (400): files[0]: kb_identifier must be');
    mockFetch.mockRejectedValueOnce(new Error('API error (429): Monthly token quota exceeded'));
    await expect(call(files1)).rejects.toThrow('API error (429): Monthly token quota exceeded');
    mockFetch.mockRejectedValueOnce(new Error('API error (500): ENOENT /srv/app/x'));
    await expect(call(files1)).rejects.toThrow(/^read_knowledge_base_files: the files could not be read \(HTTP 500\)\. Try again later\. Nothing was changed\.$/);
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3001'));
    await expect(call(files1)).rejects.toThrow(/^read_knowledge_base_files: the knowledge base service could not be reached or did not answer in time/);
    mockFetch.mockResolvedValueOnce({ success: false, message: 'Refused.', error: 'raw stack' });
    await expect(call(files1)).rejects.toThrow(`${TOOL}: Refused.`);
  });
});

describe('the guard', () => {
  it('is 1 in flight per caller, 4 per process, 120 an hour', () => {
    expect([KB_FILE_READ_GUARD.processMax, KB_FILE_READ_GUARD.perHour]).toStrictEqual([4, 120]);
  });

  it('one call at a time per caller; another caller is not blocked; the slot frees even on failure', async () => {
    let release!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = call(files1, 'user-1');
    await expect(call(files1, 'user-1')).rejects.toThrow(/another call of yours to this tool is still running/);
    mockFetch.mockResolvedValueOnce({ success: true, files: [okFile()] });
    await expect(call(files1, 'user-2')).resolves.toBeDefined();
    release({ success: true, files: [okFile()] });
    await first;
    mockFetch.mockRejectedValueOnce(new Error('API error (500): boom'));
    await expect(call(files1, 'user-1')).rejects.toThrow(/HTTP 500/);
    expect(KB_FILE_READ_GUARD.inFlight).toBe(0);
    expect(KB_FILE_READ_GUARD.callers.size).toBe(0);
  });

  it('at most 4 callers at once for the whole process', async () => {
    const releases: Array<(v: unknown) => void> = [];
    for (let i = 0; i < 4; i++) mockFetch.mockImplementationOnce(() => new Promise((resolve) => { releases.push(resolve); }));
    const running = [0, 1, 2, 3].map((i) => call(files1, `user-${i}`));
    await expect(call(files1, 'user-late')).rejects.toThrow(/this tool is busy/);
    releases.forEach((r) => r({ success: true, files: [okFile()] }));
    await Promise.all(running);
    expect(KB_FILE_READ_GUARD.inFlight).toBe(0);
  });

  it('refuses the 121st call of a caller within an hour, before calling anything', async () => {
    mockFetch.mockResolvedValue({ success: true, files: [okFile()] });
    for (let i = 0; i < 120; i++) await call(files1, 'user-busy');
    await expect(call(files1, 'user-busy')).rejects.toThrow(/you have made 120 calls to this tool in the last hour/);
    expect(mockFetch).toHaveBeenCalledTimes(120);
  });
});

describe('registration', () => {
  it('is a read-only tool that needs a user account, with the limits and the gdoc/gsheet refusal in its description', () => {
    const tool = mcpToolRegistry.getTool(TOOL) as any;
    expect(tool.readOnly).toBe(true);
    expect(tool.requiresUserAccount).toBe(true);
    expect(tool.definition.inputSchema.required).toEqual(['files']);
    expect(tool.definition.inputSchema.properties.files.maxItems).toBe(5);
    expect(tool.definition.inputSchema.properties.files.items.required).toEqual(['kb_identifier', 'file_name']);
    const description = tool.definition.description as string;
    for (const re of [/gdoc: or gsheet:/, /100000 characters/, /at most 200000/, /same words as a missing one/, /120 an hour/, /not instructions/]) {
      expect(description).toMatch(re);
    }
  });
});
