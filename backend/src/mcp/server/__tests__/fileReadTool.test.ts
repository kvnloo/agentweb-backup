/**
 * ENG-2840 (W2-7): `read_file_content` for outside agents. What it sends to the route (always own storage only, always a size limit), what
 * is refused before anything is called, the fixed-field answer, and the one-read-at-a-time guard. No network: the self-call is a double.
 * The storage rules themselves live in readFileContent and the route (their own tests).
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { FILE_READS_IN_FLIGHT, READ_FILE_MAX_BYTES, fileReadAnswer, fileReadGuard, readFileRequest, requireRead } from '../fileReadTool';
import { shouldSanitizePublicResponse } from '../publicResponseSanitizer';
import { MCP_TOOL_SIDE_EFFECTS } from '../toolAnnotationPolicy';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true });
const call = (args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool('read_file_content') as any).execute(args, ctxFor(userId));
const URL_OK = 'https://agentweb-files.s3.us-west-2.amazonaws.com/users/user-1/files/1/report.pdf';
const parse = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => {
  mockFetch.mockReset();
  fileReadGuard.reset();
});

describe('the request', () => {
  it('always asks for own storage only and a 10 MB limit, whatever the caller sends', () => {
    expect(READ_FILE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(readFileRequest({ file_url: URL_OK })).toEqual({ file_url: URL_OK, own_storage_only: true, max_bytes: READ_FILE_MAX_BYTES });
  });

  it('refuses any other argument by name, including attempts to lift the limits', () => {
    for (const extra of ['own_storage_only', 'max_bytes', 'user_id', 'url']) {
      expect(() => readFileRequest({ file_url: URL_OK, [extra]: false })).toThrow(new RegExp(`"${extra}" is not an input of read_file_content`));
    }
  });

  it('refuses a missing, padded, too long, non-http or invisible-character URL before any call', async () => {
    const bad = [undefined, '', ' ', ` ${URL_OK}`, 'ftp://x/y', 'file:///etc/passwd', 'https://host', `https://h/${'a'.repeat(2050)}`,
      `https://h/a${String.fromCharCode(0x202e)}b`, `https://h/a${String.fromCharCode(0x2028)}b`, `https://h/a${String.fromCharCode(0)}b`, 42];
    for (const file_url of bad) {
      await expect(call({ file_url })).rejects.toThrow(/^read_file_content: file_url/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('the answer', () => {
  it('passes on only fixed fields: never the URL echo, the route message, or a raw error', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, content: 'hello', content_hash: 'abc', file_type: 'pdf', file_size: 10, content_length: 5, truncated: false, file_url: URL_OK, message: 'Successfully read', error: 'x', sessionId: 's' });
    const answer = parse(await call({ file_url: URL_OK }));
    expect(answer).toEqual({ content: 'hello', truncated: false, file_type: 'pdf', file_size: 10, content_length: 5, content_hash: 'abc' });
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/api/emma/read-file', body: { file_url: URL_OK, own_storage_only: true, max_bytes: READ_FILE_MAX_BYTES } }));
  });

  it('a cut text says so in a note that does not invite a range read', () => {
    const answer = fileReadAnswer({ success: true, content: 'x', truncated: true });
    expect(answer.truncated).toBe(true);
    expect(answer.note).toMatch(/cut at 100000 characters; the rest of this file cannot be read with this tool/);
    expect(String(answer.note)).not.toMatch(/byte-range/);
  });

  it('a refusal is an error with the route\'s short message only', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'File not found or you do not have access to it.', error: 'File not accessible: stack at /srv/x.js' });
    await expect(call({ file_url: URL_OK })).rejects.toThrow('read_file_content: File not found or you do not have access to it.');
  });

  it('Emma\'s image and video refusals, which name tools outside agents do not have, are reworded', () => {
    expect(() => requireRead({ success: false, message: 'Use the describe_image tool', error: 'Image files must be analyzed with describe_image, not read_file_content' })).toThrow(/image or a video: only the text of documents/);
    expect(() => requireRead({ success: false, message: 'Use the describe_video tool', error: 'Video files must be analyzed with describe_video, not read_file_content' })).toThrow(/image or a video/);
    expect(() => requireRead(null)).toThrow(/gave no answer/);
  });

  it('a 4xx from the route passes through; a 5xx or no answer becomes a fixed text', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (429): Monthly token quota exceeded'));
    await expect(call({ file_url: URL_OK })).rejects.toThrow('API error (429): Monthly token quota exceeded');
    mockFetch.mockRejectedValueOnce(new Error('API error (500): ENOENT /srv/app/x'));
    await expect(call({ file_url: URL_OK })).rejects.toThrow(/^read_file_content: the file could not be read \(HTTP 500\)\. Try again later\. Nothing was changed\.$/);
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3001'));
    await expect(call({ file_url: URL_OK })).rejects.toThrow(/^read_file_content: the file service could not be reached/);
  });

  it('the answer is the caller\'s own file text: not rewritten by the public sanitizer', () => {
    expect(shouldSanitizePublicResponse('read_file_content', {}, { externalMcp: true })).toBe(false);
  });
});

describe('the guard', () => {
  const pending = () => {
    let release!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    return () => release({ success: true, content: 'x', truncated: false });
  };

  it('one read at a time per caller; another caller is not blocked; the slot frees when the read ends (even on failure)', async () => {
    const finish = pending();
    const first = call({ file_url: URL_OK }, 'user-1');
    await expect(call({ file_url: URL_OK }, 'user-1')).rejects.toThrow(/another file read of yours is still running/);
    mockFetch.mockResolvedValueOnce({ success: true, content: 'y', truncated: false });
    await expect(call({ file_url: URL_OK }, 'user-2')).resolves.toBeDefined();
    finish();
    await first;
    mockFetch.mockRejectedValueOnce(new Error('API error (500): boom'));
    await expect(call({ file_url: URL_OK }, 'user-1')).rejects.toThrow(/HTTP 500/);
    mockFetch.mockResolvedValueOnce({ success: true, content: 'z', truncated: false });
    await expect(call({ file_url: URL_OK }, 'user-1')).resolves.toBeDefined();
    expect(fileReadGuard.inFlight).toBe(0);
    expect(fileReadGuard.callers.size).toBe(0);
  });

  it(`at most ${FILE_READS_IN_FLIGHT} reads at once for the whole process`, async () => {
    const finishers = Array.from({ length: FILE_READS_IN_FLIGHT }, () => pending());
    const running = Array.from({ length: FILE_READS_IN_FLIGHT }, (_, i) => call({ file_url: URL_OK }, `user-${i}`));
    await expect(call({ file_url: URL_OK }, 'user-late')).rejects.toThrow(/file reading is busy/);
    finishers.forEach((finish) => finish());
    await Promise.all(running);
    expect(fileReadGuard.inFlight).toBe(0);
  });
});

describe('registration', () => {
  it('is a read-only tool that needs a user account', () => {
    const tool = mcpToolRegistry.getTool('read_file_content') as any;
    expect(tool.readOnly).toBe(true);
    expect(tool.requiresUserAccount).toBe(true);
    expect(MCP_TOOL_SIDE_EFFECTS.read_file_content).toBe('read');
    expect(tool.definition.inputSchema.required).toEqual(['file_url']);
    expect(tool.definition.description).not.toMatch(/describe_image|byte-range/);
  });
});
