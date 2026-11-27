/**
 * ENG-2840 (W2-10): `POST /api/emma/kb-file-read` (routes/emmaKbFileReadRoutes.ts), the route behind the MCP `read_knowledge_base_files`.
 * Pinned here: Emma's reader runs once per entry with `req.user.userId` only; the body is checked by name and value before anything runs
 * (gdoc:/gsheet: refused); each result is fixed fields; every failure is one fixed text per class ("not authorized" reads as "not found")
 * with no raw exception text, no message of Emma's and no id but the caller's; base64 is refused; the per-file and per-call character
 * limits and the start window hold. The router stands in for emmaApi's (its auth and budget middleware have their own tests).
 */
import express, { Router } from 'express';
import request from 'supertest';

const mockRead = jest.fn();
jest.mock('../emma/impl/knowledgeBase', () => ({ readSingleKnowledgeBaseFile: (...args: unknown[]) => mockRead(...args) }));

import {
  KB_FILE_READ_ERRORS,
  KB_FILE_READ_MAX_CALL_CHARS,
  KB_FILE_READ_MAX_FILE_CHARS,
  KB_FILE_READ_START_WINDOW_MS,
  KB_FILE_SUCCESS_KEYS,
  KB_FILE_FAILURE_KEYS,
  checkKbFileReadBody,
  classifyFailure,
  isBase64Blob,
  readKbFiles,
  registerKbFileReadRoutes,
} from '../routes/emmaKbFileReadRoutes';

const TASK_UUID = '3f2b8c1e-9a4d-4e6f-8b21-0c5d7e9f1a2b';
const TASK_NUMERIC = '1732700000000';
const DRIVE = 'gdrive:1AbC_dEf-GhIjKlMnOpQrStUv';

let requestExtras: Record<string, unknown> = {};
const router = Router();
router.use((req: any, _res: any, next: any) => {
  req.user = { userId: 'caller-1', email: 'caller@example.com', isAdmin: true };
  Object.assign(req, requestExtras);
  next();
});
registerKbFileReadRoutes(router);
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/emma', router);

const post = (body: unknown) => request(app).post('/api/emma/kb-file-read').send(body as any);
const one = (kb_identifier: string, file_name = 'notes.txt') => ({ files: [{ kb_identifier, file_name }] });
const taskOk = (content: string, extra: Record<string, unknown> = {}) => ({
  success: true, message: 'Successfully read knowledge base file "x"', kb_identifier: 'echo-of-something-else', file_name: 'other.txt',
  name: 'Brand KB', content, size: 1234, type: 'private', updatedAt: '2026-11-20T10:00:00.000Z', ...extra,
});

beforeEach(() => {
  mockRead.mockReset();
  requestExtras = {};
  jest.restoreAllMocks();
});

describe('identity: req.user.userId only', () => {
  it('reads each entry as the caller, with only the checked values, whatever else the request carries', async () => {
    requestExtras = { delegateInfo: { adminUserId: 'admin-9', isDelegated: true }, isSelfCall: true };
    mockRead.mockResolvedValue(taskOk('hello'));
    const res = await post({ files: [{ kb_identifier: TASK_UUID, file_name: 'a.md' }, { kb_identifier: TASK_NUMERIC, file_name: 'knowledge-base.txt' }] });
    expect(res.status).toBe(200);
    expect(mockRead.mock.calls).toStrictEqual([[TASK_UUID, 'a.md', 'caller-1'], [TASK_NUMERIC, 'knowledge-base.txt', 'caller-1']]);
  });

  it('refuses identity fields in the body or in an entry by name (400), reading nothing', async () => {
    for (const body of [
      { files: [{ kb_identifier: TASK_UUID, file_name: 'a' }], userId: 'victim' },
      { files: [{ kb_identifier: TASK_UUID, file_name: 'a', user_id: 'victim' }] },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not an input/);
    }
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('bad input is refused (400) before anything runs, never echoing a value', () => {
  it.each<[string, unknown, RegExp]>([
    ['no files', {}, /files is required/],
    ['files not a list', { files: 'a' }, /files is required/],
    ['empty list', { files: [] }, /files must hold 1 to 5 entries \(it holds 0\)/],
    ['six entries', { files: Array.from({ length: 6 }, () => ({ kb_identifier: TASK_UUID, file_name: 'a' })) }, /files must hold 1 to 5 entries \(it holds 6\)/],
    ['entry not an object', { files: ['x'] }, /files\[0\] must be an object/],
    ['gdoc by id', one('gdoc:1AbCdEf'), /files\[0\]: a Google Doc or Sheet opened by id .* cannot be read over MCP/],
    ['gsheet by id', one('gsheet:1AbCdEf'), /cannot be read over MCP/],
    ['GDOC in capitals', one('GDOC:1AbCdEf'), /cannot be read over MCP/],
    ['not a task id', one('abc'), /kb_identifier must be an identifier from list_knowledge_bases/],
    ['short digits', one('12345'), /kb_identifier must be/],
    ['clickup-folder (reference only)', one('clickup-folder:123'), /kb_identifier must be/],
    ['drive id with a quote', one("gdrive:abc' or name contains 'x"), /kb_identifier must be/],
    ['drive id with a path', one('gdrive:../../x'), /kb_identifier must be/],
    ['empty drive id', one('gdrive:'), /kb_identifier must be/],
    ['foreplay-swipefile with a suffix', one('foreplay-swipefile:1'), /kb_identifier must be/],
    ['kb_identifier not text', { files: [{ kb_identifier: 5, file_name: 'a' }] }, /kb_identifier must be/],
    ['blank file_name', one(TASK_UUID, '   '), /file_name is required and must be 1 to 255 characters/],
    ['long file_name', one(TASK_UUID, 'a'.repeat(256)), /file_name is required/],
    ['file_name with a newline', one(TASK_UUID, 'a\nb'), /no control or invisible characters/],
    ['file_name with a bidi override', one(TASK_UUID, `a${String.fromCharCode(0x202e)}txt.exe`), /no control or invisible/],
    ['file_name with a zero-width space', one(TASK_UUID, `a${String.fromCharCode(0x200b)}b`), /no control or invisible/],
    ['file_name not text', { files: [{ kb_identifier: TASK_UUID, file_name: ['a'] }] }, /file_name is required/],
    ['a list body', [1], /must be an object/],
  ])('%s', async (_label, body, re) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(re);
    expect(res.body.message).not.toMatch(/1AbCdEf|\.\.\/|victim/);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('a bad entry anywhere refuses the whole call', async () => {
    const res = await post({ files: [{ kb_identifier: TASK_UUID, file_name: 'a' }, { kb_identifier: 'gsheet:x', file_name: 'b' }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^files\[1\]:/);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('accepts every identifier shape list_knowledge_bases returns', () => {
    for (const id of [TASK_UUID, TASK_UUID.toUpperCase(), TASK_NUMERIC, DRIVE, 'clickup:9012345', 'clickup-tasks:9012345', 'foreplay-board:Bd_12-x', 'foreplay-swipefile']) {
      expect(checkKbFileReadBody(one(id))).toEqual({ ok: true, files: [{ kb_identifier: id, file_name: 'notes.txt' }] });
    }
  });
});

describe('the answer: fixed fields only', () => {
  it('a read file has exactly the fixed keys; Emma\'s message, type, echo and raw name field do not leave', async () => {
    mockRead.mockResolvedValueOnce(taskOk('{"apiKeyId":"k","text":"mine"}', { error: 'stack at /srv/x.js', sessionId: 's-1' }));
    const res = await post(one(TASK_UUID, 'data.json'));
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      read: 1,
      of: 1,
      files: [{
        kb_identifier: TASK_UUID, file_name: 'data.json', ok: true, knowledge_base_name: 'Brand KB', source: 'agentweb',
        content: '{"apiKeyId":"k","text":"mine"}', content_chars: 30, truncated: false, size_bytes: 1234, modified_at: '2026-11-20T10:00:00.000Z',
      }],
    });
    expect(Object.keys(res.body.files[0])).toStrictEqual([...KB_FILE_SUCCESS_KEYS]);
    expect(JSON.stringify(res.body)).not.toMatch(/Successfully|private|echo-of-something-else|other\.txt|stack|s-1/);
  });

  it('maps each source from the identifier, with its own date field', async () => {
    mockRead
      .mockResolvedValueOnce({ success: true, name: 'Marketing', content: 'doc', size: 77, type: 'google-drive', modifiedTime: '2026-10-01T08:00:00Z' })
      .mockResolvedValueOnce({ success: true, name: 'Workspace', content: 'cu doc', size: 6, type: 'clickup', dateUpdated: '1732700000000' })
      .mockResolvedValueOnce({ success: true, name: 'Workspace', content: 'cu task', size: 7, type: 'clickup-tasks', dateUpdated: 'never' })
      .mockResolvedValueOnce({ success: true, name: 'Acme', content: 'ad', size: 2, type: 'foreplay-board' });
    const res = await post({ files: [
      { kb_identifier: DRIVE, file_name: 'Plan' },
      { kb_identifier: 'clickup:901', file_name: 'Doc' },
      { kb_identifier: 'clickup-tasks:901', file_name: 'Task' },
      { kb_identifier: 'foreplay-board:b1', file_name: 'Ad' },
    ] });
    expect(res.body.files.map((f: any) => [f.source, f.size_bytes, f.modified_at])).toStrictEqual([
      ['google_drive', 77, '2026-10-01T08:00:00.000Z'],
      ['clickup', null, '2024-11-27T09:33:20.000Z'],
      ['clickup_tasks', null, null],
      ['foreplay', null, null],
    ]);
    expect(res.body.read).toBe(4);
  });

  it('a failed file has exactly the fixed keys', async () => {
    mockRead.mockResolvedValueOnce({ success: false, message: `Knowledge base "${TASK_UUID}" not found` });
    const res = await post(one(TASK_UUID));
    expect(res.body).toStrictEqual({ success: true, read: 0, of: 1, files: [{ kb_identifier: TASK_UUID, file_name: 'notes.txt', ok: false, error: KB_FILE_READ_ERRORS.not_found }] });
    expect(Object.keys(res.body.files[0])).toStrictEqual([...KB_FILE_FAILURE_KEYS]);
  });
});

describe('failures: one fixed text per class, nothing of Emma\'s words', () => {
  const sa = 'shared-drive@agentweb-prod.iam.gserviceaccount.com';
  it.each<[string, Record<string, unknown>, keyof typeof KB_FILE_READ_ERRORS]>([
    ['task missing', { success: false, message: 'Knowledge base "x" not found' }, 'not_found'],
    ['task not authorized', { success: false, message: 'Not authorized to access this knowledge base file' }, 'not_found'],
    ['file not in metadata', { success: false, message: 'Knowledge base file "a" not found in metadata' }, 'not_found'],
    ['file not in storage', { success: false, message: 'Knowledge base file "a" not found in storage' }, 'not_found'],
    ['empty default file', { success: false, message: 'Knowledge base file "knowledge-base.txt" is empty or does not exist' }, 'not_found'],
    ['drive folder not registered', { success: false, message: 'Not authorized to access this Google Drive folder' }, 'not_found'],
    ['drive file absent', { success: false, message: 'File "a" not found in Google Drive folder "Secret Plans"' }, 'not_found'],
    ['drive throttled', { success: false, message: 'File "a" was not found, but Google Drive rate-limited the scan of folder "X"' }, 'rate_limited'],
    ['drive root unreadable', { success: false, message: `File "a" not found — the Google Drive folder "X" itself could not be accessed. Share it with ${sa} to allow access.` }, 'search_incomplete'],
    ['drive scan cut', { success: false, message: 'File "a" not found in Google Drive folder "X" — but the folder scan did not cover the whole tree, so this is not a confirmed absence.' }, 'search_incomplete'],
    ['drive name query failed', { success: false, message: 'Could not determine whether "a" is in Google Drive folder "X" — the file search itself failed (timeout).' }, 'search_incomplete'],
    ['drive duplicates', { success: false, message: 'Multiple files named "a" found in Google Drive folder "X": "a" in "1AbCdEfSecretFolderId"' }, 'ambiguous'],
    ['drive raw failure', { success: false, message: 'Failed to read Google Drive file "a": invalid_grant at /srv/app/node_modules/gaxios', code: 400 }, 'read_failed'],
    ['drive 429', { success: false, message: 'Failed to read Google Drive file "a": Quota exceeded', code: 429 }, 'rate_limited'],
    ['clickup not connected', { success: false, message: 'ClickUp not connected' }, 'not_connected'],
    ['clickup workspace not yours', { success: false, message: 'Not authorized to access this ClickUp workspace' }, 'not_found'],
    ['clickup doc absent', { success: false, message: 'Document "a" not found in ClickUp workspace "Other Co"' }, 'not_found'],
    ['clickup 429', { success: false, message: 'Failed to read ClickUp task "a": Request failed with status code 429', code: 429 }, 'rate_limited'],
    ['foreplay not connected', { success: false, message: 'Foreplay not connected' }, 'not_connected'],
    ['foreplay ad absent', { success: false, message: 'Ad "a" not found in Foreplay Board b1' }, 'not_found'],
    ['unknown words', { success: false, message: 'Something new happened with token sk-live-123' }, 'read_failed'],
    ['no answer at all', {}, 'read_failed'],
  ])('%s', async (_label, result, kind) => {
    mockRead.mockResolvedValueOnce(result);
    const res = await post(one(TASK_UUID));
    expect(res.body.files[0]).toStrictEqual({ kb_identifier: TASK_UUID, file_name: 'notes.txt', ok: false, error: KB_FILE_READ_ERRORS[kind] });
    expect(JSON.stringify(res.body)).not.toMatch(/Secret|Other Co|gserviceaccount|node_modules|sk-live|invalid_grant|Quota/);
  });

  it('"not authorized" and "not found" are the same words', () => {
    expect(classifyFailure({ success: false, message: 'Not authorized to access this knowledge base file' }))
      .toBe(classifyFailure({ success: false, message: 'Knowledge base "x" not found' }));
  });

  it('a thrown error is a fixed text (429 is rate limited); the raw text stays in the server log', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockRead.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:443 /srv/app/creds.json'));
    mockRead.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { response: { status: 429 } }));
    const res = await post({ files: [{ kb_identifier: TASK_UUID, file_name: 'a' }, { kb_identifier: 'clickup:9', file_name: 'b' }] });
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.error)).toStrictEqual([KB_FILE_READ_ERRORS.read_failed, KB_FILE_READ_ERRORS.rate_limited]);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|creds/);
    expect(log).toHaveBeenCalled();
  });
});

describe('text only', () => {
  it('refuses Emma\'s base64 answer for a binary file, including her 1,000,000-character cut of one', async () => {
    const b64 = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256)).toString('base64');
    mockRead.mockResolvedValueOnce(taskOk(b64));
    mockRead.mockResolvedValueOnce({ success: true, name: 'F', content: `${'QUJD'.repeat(250_000)}\n\n[Content truncated due to size limit]`, size: 9e6, modifiedTime: '2026-01-01T00:00:00Z' });
    const res = await post({ files: [{ kb_identifier: TASK_UUID, file_name: 'photo.png' }, { kb_identifier: DRIVE, file_name: 'clip.mp4' }] });
    expect(res.body.files.map((f: any) => f.error)).toStrictEqual([KB_FILE_READ_ERRORS.not_text, KB_FILE_READ_ERRORS.not_text]);
    expect(res.body.read).toBe(0);
  });

  it('keeps text that merely looks like base64 when the name says text, and ordinary text of any name', () => {
    expect(isBase64Blob('agentweb', 'token.txt', 'QUJDRA==')).toBe(false);
    expect(isBase64Blob('google_drive', 'Q3 Plan', 'Plain words, with spaces.')).toBe(false);
    expect(isBase64Blob('clickup', 'Doc', 'QUJDRA==')).toBe(false);
    expect(isBase64Blob('google_drive', 'Q3 Plan', 'QUJDRA==')).toBe(true);
    expect(isBase64Blob('agentweb', 'a.bin', 'abc')).toBe(false);
  });
});

describe('size limits', () => {
  it(`cuts one file at ${KB_FILE_READ_MAX_FILE_CHARS} characters and says so; Emma's own cut marker is removed`, async () => {
    mockRead.mockResolvedValueOnce(taskOk('a'.repeat(KB_FILE_READ_MAX_FILE_CHARS + 5)));
    mockRead.mockResolvedValueOnce({ success: true, name: 'Acme', content: 'ad text\n\n[Content truncated due to size limit]', size: 60000 });
    const res = await post({ files: [{ kb_identifier: TASK_UUID, file_name: 'big.txt' }, { kb_identifier: 'foreplay-swipefile', file_name: 'Ad' }] });
    const [big, ad] = res.body.files;
    expect([big.content_chars, big.truncated, big.content.length]).toStrictEqual([KB_FILE_READ_MAX_FILE_CHARS, true, KB_FILE_READ_MAX_FILE_CHARS]);
    expect([ad.content, ad.truncated]).toStrictEqual(['ad text', true]);
  });

  it('never splits a surrogate pair at the cut', async () => {
    mockRead.mockResolvedValueOnce(taskOk(`${'a'.repeat(KB_FILE_READ_MAX_FILE_CHARS - 1)}\u{1F600}tail`));
    const res = await post(one(TASK_UUID));
    expect(res.body.files[0].content_chars).toBe(KB_FILE_READ_MAX_FILE_CHARS - 1);
  });

  it(`returns at most ${KB_FILE_READ_MAX_CALL_CHARS} characters a call; a file past that is not read at all`, async () => {
    mockRead.mockResolvedValue(taskOk('b'.repeat(KB_FILE_READ_MAX_FILE_CHARS + 10)));
    const files = Array.from({ length: 3 }, (_, i) => ({ kb_identifier: TASK_UUID, file_name: `f${i}.txt` }));
    const res = await post({ files });
    expect(res.body.files.map((f: any) => f.ok)).toStrictEqual([true, true, false]);
    expect(res.body.files[2].error).toBe(KB_FILE_READ_ERRORS.call_limit);
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(res.body.files.reduce((n: number, f: any) => n + (f.content_chars ?? 0), 0)).toBe(KB_FILE_READ_MAX_CALL_CHARS);
    expect([res.body.read, res.body.of]).toStrictEqual([2, 3]);
  });

  it('a file read when the call is near its limit gets only what is left, marked truncated', async () => {
    mockRead.mockResolvedValueOnce(taskOk('c'.repeat(KB_FILE_READ_MAX_FILE_CHARS)));
    mockRead.mockResolvedValueOnce(taskOk('d'.repeat(KB_FILE_READ_MAX_FILE_CHARS - 10)));
    mockRead.mockResolvedValueOnce(taskOk('e'.repeat(50)));
    const res = await post({ files: [0, 1, 2].map((i) => ({ kb_identifier: TASK_UUID, file_name: `f${i}.txt` })) });
    expect(res.body.files.map((f: any) => [f.content_chars, f.truncated])).toStrictEqual([[KB_FILE_READ_MAX_FILE_CHARS, false], [KB_FILE_READ_MAX_FILE_CHARS - 10, false], [10, true]]);
  });

  it('starts no read after the start window; those files say so', async () => {
    let clock = 0;
    mockRead.mockImplementation(async () => { clock += KB_FILE_READ_START_WINDOW_MS + 1; return taskOk('x'); });
    const answer = await readKbFiles([{ kb_identifier: TASK_UUID, file_name: 'a' }, { kb_identifier: TASK_UUID, file_name: 'b' }], 'caller-1', () => clock);
    expect(answer.files.map((f) => f.ok)).toStrictEqual([true, false]);
    expect((answer.files[1] as any).error).toBe(KB_FILE_READ_ERRORS.out_of_time);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });
});
