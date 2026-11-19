/**
 * perform_data_analysis downloads each plain http(s) entry of `file_urls` itself, from a URL the caller (or an outside agent steering the
 * model) chose, and sends the body to a model. That download must go through the guarded fetch (utils/callerUrlFetch.ts): public addresses
 * only, redirects checked again, and the body capped at what is left of the total size budget (axios has no cap by default).
 *
 * Blocked URLs here are judged by the REAL wrapper and the real SSRF guard; every one of them is a literal address, a reserved name or a
 * non-http scheme, so no test reaches DNS or the network. Everything else is mocked and every fixture is synthetic.
 */
import axios from 'axios';
import { getSecret } from '../utils/secretsManager';
import { getS3ObjectAsString } from '../utils/s3Utils';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { toolResultError } from '../utils/toolResultError';
import * as callerUrlFetch from '../utils/callerUrlFetch';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: true, url: 'https://example.com/u.png' }),
  getS3ObjectAsString: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn() }));
// Who may read which S3 key is a boundary here (covered with the real policy in performDataAnalysis.storageAccess.test.ts).
jest.mock('../services/storageAccessPolicy', () => ({
  ...jest.requireActual('../services/storageAccessPolicy'),
  decideStorageAccess: jest.fn().mockResolvedValue({ allow: true }),
}));

import { performDataAnalysis, __resetDataAnalysisConsistencyCacheForTests } from '../emma/impl/searchResearch';

const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const secret = getSecret as jest.Mock;
const readS3 = getS3ObjectAsString as jest.Mock;

const geminiOk = () => post.mockResolvedValue({
  data: { candidates: [{ content: { parts: [{ text: 'Analysis complete.' }, { codeExecutionResult: { output: 'ok' } }] } }] },
});
const bytes = (n: number) => ({ buffer: Buffer.alloc(n, 'a'), contentType: 'text/csv', finalUrl: 'x' });

describe('perform_data_analysis: plain URLs in file_urls', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DATA_ANALYSIS_FILE_SIZE;
    secret.mockResolvedValue('test-key');
    geminiOk();
    __resetDataAnalysisConsistencyCacheForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchSpy = jest.spyOn(callerUrlFetch, 'fetchCallerUrlBuffer');
  });
  afterEach(() => {
    delete process.env.DATA_ANALYSIS_FILE_SIZE;
    jest.restoreAllMocks();
  });

  describe('a URL the guard refuses (the REAL wrapper and guard decide)', () => {
    it.each([
      ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
      ['the backend itself on loopback', 'http://127.0.0.1:3001/internal/tool-bridge/run1/mcp'],
      ['localhost', 'http://localhost/admin'],
      ['a private 10/8 address', 'http://10.0.0.5/data.csv'],
      ['a private 192.168/16 address', 'https://192.168.1.1/data.csv'],
      ['a decimal-encoded loopback', 'http://2130706433/data.csv'],
      ['a file: URL', 'file:///etc/passwd'],
      ['an ftp: URL', 'ftp://example.com/data.csv'],
    ])('%s: one generic answer, nothing fetched, nothing sent to the model', async (_label, fileUrl) => {
      const r = await performDataAnalysis([fileUrl], 'summarise', 'user-1');
      expect(r.success).toBe(false);
      expect(r.errorClass).toBe('invalid_args'); // a bad argument, not a tool or config fault
      expect(r.message).toContain(callerUrlFetch.CALLER_URL_BLOCKED_MESSAGE);
      expect(r.message).toContain(fileUrl); // the caller's own input is echoed so the model knows which entry it was
      expect(r).not.toHaveProperty('error'); // no echo of the guard's reason
      // (checked without the caller's own URL, which may itself contain words like "internal")
      expect(JSON.stringify(r).split(fileUrl).join('')).not.toMatch(/private|internal|resolve|loopback|metadata|DNS/i);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });

    // A model's typo (a bare file name, a path) is not a refused address: it is told so plainly, and it is not logged as a blocked URL.
    it.each([
      ['a plain file name', 'sales.csv'],
      ['an absolute local path', '/tmp/sales.csv'],
      ['a relative path', './data/sales.csv'],
      ['an empty-looking name', 'my sales data'],
    ])('%s is "not a URL": a clear answer, a bad argument, nothing fetched, no blocked-URL log', async (_label, entry) => {
      const r = await performDataAnalysis([entry], 'summarise', 'user-1');
      expect(r.success).toBe(false);
      expect(r.errorClass).toBe('invalid_args');
      expect(r.message).toContain(`file_urls entry "${entry}" is not a URL`);
      expect(r.message).not.toContain(callerUrlFetch.CALLER_URL_BLOCKED_MESSAGE);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      const lines = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain('caller_url_blocked');
    });

    it('is classified as a bad argument by telemetry, never as a config fault', async () => {
      const r = await performDataAnalysis(['http://169.254.169.254/'], 'summarise', 'user-1');
      expect(classifyToolErrorClass(toolResultError(r))).toBe('invalid_args');
    });

    it('refuses the whole call when one entry in the list is refused, and sends nothing to the model', async () => {
      fetchSpy.mockResolvedValueOnce(bytes(10)); // the first entry is a normal public file
      const r = await performDataAnalysis(['https://example.com/a.csv', 'http://169.254.169.254/x'], 'summarise', 'user-1');
      expect(r.success).toBe(false);
      expect(r.message).toContain(callerUrlFetch.CALLER_URL_BLOCKED_MESSAGE);
      expect(post).not.toHaveBeenCalled();
    });

    it('logs the caller and the host only', async () => {
      await performDataAnalysis(['http://169.254.169.254/latest/meta-data/?token=SECRET123'], 'summarise', 'user-9');
      const lines = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes('caller_url_blocked'))!;
      expect(JSON.parse(line)).toEqual({ event: 'caller_url_blocked', tool: 'perform_data_analysis', userId: 'user-9', host: '169.254.169.254' });
      expect(lines.join('\n')).not.toMatch(/SECRET123|meta-data/);
    });
  });

  describe('the size budget', () => {
    it('hands the guarded fetch the whole budget for the first file and what is left for the next', async () => {
      process.env.DATA_ANALYSIS_FILE_SIZE = '100';
      fetchSpy.mockResolvedValueOnce(bytes(60)).mockResolvedValueOnce(bytes(30));
      const r = await performDataAnalysis(['https://example.com/a.csv', 'https://example.com/b.csv'], 'summarise', 'user-1');
      expect(r.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/a.csv');
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ tool: 'perform_data_analysis', userId: 'user-1', maxBytes: 100, timeoutMs: 30000 });
      expect(fetchSpy.mock.calls[1][1]).toMatchObject({ maxBytes: 40 });
    });

    it('a body over the cap is the same "too big" answer as before, a bad argument, and nothing is sent to the model', async () => {
      process.env.DATA_ANALYSIS_FILE_SIZE = '100';
      fetchSpy.mockRejectedValueOnce(new callerUrlFetch.CallerUrlTooLargeError(100));
      const r = await performDataAnalysis(['https://example.com/huge.csv'], 'summarise', 'user-1');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/exceeds the 100 bytes limit/);
      expect(r.errorClass).toBe('invalid_args');
      expect(post).not.toHaveBeenCalled();
    });

    // `parseInt('abc')` is NaN, and a NaN limit compares false with everything: the cap would silently switch off.
    it.each([['abc'], [''], ['-5'], ['NaN']])('a non-numeric or negative size setting (%p) falls back to 50 MB, never to "no cap"', async (setting) => {
      process.env.DATA_ANALYSIS_FILE_SIZE = setting;
      fetchSpy.mockResolvedValueOnce(bytes(5));
      await performDataAnalysis(['https://example.com/a.csv'], 'summarise', 'user-1');
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ maxBytes: 52428800 });
    });

    it('what an earlier s3:// file used is taken off the budget for a later URL: the exact remainder is accepted', async () => {
      process.env.DATA_ANALYSIS_FILE_SIZE = '100';
      readS3.mockResolvedValueOnce('a'.repeat(60));
      fetchSpy.mockResolvedValueOnce(bytes(40));
      const r = await performDataAnalysis(['s3://agentweb-user-files/users/user-1/files/1/abc/a.csv', 'https://example.com/b.csv'], 'summarise', 'user-1');
      expect(r.success).toBe(true);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ maxBytes: 40 });
    });

    it('with nothing left in the budget the fetch is given a cap of zero, never a negative or unlimited one', async () => {
      process.env.DATA_ANALYSIS_FILE_SIZE = '100';
      readS3.mockResolvedValueOnce('a'.repeat(100));
      fetchSpy.mockRejectedValueOnce(new callerUrlFetch.CallerUrlTooLargeError(0));
      const r = await performDataAnalysis(['s3://agentweb-user-files/users/user-1/files/1/abc/a.csv', 'https://example.com/b.csv'], 'summarise', 'user-1');
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ maxBytes: 0 });
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/exceeds the 100 bytes limit/);
    });

    it('a file that fits is analysed as before', async () => {
      fetchSpy.mockResolvedValueOnce(bytes(20));
      const r = await performDataAnalysis(['https://example.com/a.csv'], 'summarise', 'user-1');
      expect(r.success).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('failures that are not about the guard keep their old handling', () => {
    it('a dead link (404) is still a bad argument that names the URL', async () => {
      fetchSpy.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
      const r = await performDataAnalysis(['https://example.com/gone.csv'], 'summarise', 'user-1');
      expect(r.success).toBe(false);
      expect(r.errorClass).toBe('invalid_args');
      expect(r.message).toContain('https://example.com/gone.csv');
      expect(r.message).toMatch(/HTTP 404/);
    });

    // The guarded fetch gives a download ONE total deadline. A host too slow to send the file in time is a bad argument for this tool,
    // not an account or config fault (it would otherwise cluster as "not found" and read as a config problem in telemetry).
    it.each([
      ['an aborted request (the total deadline)', Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })],
      ['a socket timeout', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })],
      ['redirects that took too long', new Error('Timed out following redirects after 30000ms')],
    ])('%s: a clear "too slow or too large" answer, classified as a timeout', async (_label, error) => {
      fetchSpy.mockRejectedValueOnce(error);
      const r = await performDataAnalysis(['https://example.com/slow.csv'], 'summarise', 'user-1');
      expect(r.success).toBe(false);
      expect(r.errorClass).toBe('timeout');
      expect(r.message).toContain('https://example.com/slow.csv');
      expect(r.message).toMatch(/did not finish within the 30-second download limit/);
      expect(console.error).toHaveBeenCalled(); // a timeout is still logged
      expect(classifyToolErrorClass(toolResultError(r))).toBe('timeout');
      expect(post).not.toHaveBeenCalled();
    });

    it('a network error is still reported as a failed download of that URL', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND example.com'));
      const r = await performDataAnalysis(['https://example.com/x.csv'], 'summarise', 'user-1');
      expect(r.success).toBe(false);
      expect(r.message).toContain('https://example.com/x.csv');
    });
  });

  it('entries that are not URLs for the guarded fetch are untouched: no plain URL, no fetch', async () => {
    const r = await performDataAnalysis([], 'compute the mean of 1, 2, 3', 'user-1');
    expect(r.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
