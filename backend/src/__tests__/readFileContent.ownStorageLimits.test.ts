/**
 * ENG-2840 (W2-7): readFileContent's two optional caller fields for the MCP tool read_file_content.
 *  - ownStorageOnly: a URL that is not an object of AgentWeb's own bucket is refused (OWN_STORAGE_ONLY_MESSAGE) before ANY network fetch;
 *    a bucket URL under another user's prefix is still refused with the ownership message.
 *  - maxBytes: the stored size is checked before the stream is opened; with no stored size the stream stops at the limit.
 *  - without either field (Emma's path) nothing changes: external URLs are fetched, no metadata call before the stream.
 * Mocking follows readFileContent.test.ts (s3Utils, axios, ssrfGuard), but the impl is imported directly.
 */
jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({ chat: { postMessage: jest.fn() } })),
}));

jest.mock('axios', () => {
  const mockAxios = {
    get: jest.fn(),
    post: jest.fn(),
    create: jest.fn().mockReturnThis(),
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
    defaults: { headers: { common: {} } },
  };
  return { __esModule: true, default: mockAxios, ...mockAxios };
});

jest.mock('../utils/s3Utils', () => {
  // One double for both stream helpers: with maxBytes the reader opens the abortable one (its own test: s3Utils.abortableStream.test.ts).
  const stream = jest.fn();
  return {
    extractS3KeyFromUrl: jest.fn((url: string) => {
      if (url.includes('agentweb-user-files.s3')) return new URL(url).pathname.replace(/^\/+/, '');
      return null;
    }),
    getS3ObjectStream: stream,
    getS3ObjectStreamAbortable: stream,
    getS3ObjectMetadata: jest.fn(),
  };
});

jest.mock('../utils/ssrfGuard', () => {
  const actual = jest.requireActual('../utils/ssrfGuard');
  return {
    ...actual,
    resolvePinnedPublicAddress: jest.fn(async (rawUrl: string) => ({ hostname: new URL(rawUrl).hostname, address: '93.184.216.34', family: 4 })),
  };
});

jest.mock('pdf-parse', () => jest.fn());

import axios from 'axios';
import { extractS3KeyFromUrl, getS3ObjectStream, getS3ObjectMetadata } from '../utils/s3Utils';
import { resolvePinnedPublicAddress } from '../utils/ssrfGuard';
import { readFileContent, OWN_STORAGE_ONLY_MESSAGE } from '../emma/impl/misc';

const mockGet = axios.get as jest.Mock;
const mockStream = getS3ObjectStream as jest.Mock;
const mockMeta = getS3ObjectMetadata as jest.Mock;
const mockResolve = resolvePinnedPublicAddress as jest.Mock;
const mockExtract = extractS3KeyFromUrl as jest.Mock;

const BUCKET = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/';
const OWN_KEY = 'users/user-a/files/1700000000/tok/notes.txt';
const OWN_URL = `${BUCKET}${OWN_KEY}`;
const OWN = { userId: 'user-a', ownStorageOnly: true } as const;

/** A stream of the given chunks that records how many it handed out and whether destroy() was called. */
function chunkStream(chunks: Buffer[]) {
  const state = { pulled: 0, destroy: jest.fn() };
  const gen: any = (async function* () {
    for (const c of chunks) {
      state.pulled++;
      yield c;
    }
  })();
  gen.destroy = state.destroy;
  return { stream: gen, state };
}

beforeEach(() => {
  mockGet.mockReset();
  mockStream.mockReset();
  mockMeta.mockReset();
  mockResolve.mockClear();
  mockExtract.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const expectNothingFetched = () => {
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockStream).not.toHaveBeenCalled();
  expect(mockMeta).not.toHaveBeenCalled();
};

describe('ownStorageOnly', () => {
  it.each([
    ['a public web page', 'https://example.com/page.html'],
    ['a public text file', 'https://example.com/notes.txt'],
    ['a cloud metadata address', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['a loopback address', 'http://127.0.0.1:3000/admin'],
    ['another S3 bucket', 'https://other-bucket.s3.amazonaws.com/doc.pdf'],
    ['a Google Drive link', 'https://drive.google.com/file/d/123'],
    ['a look-alike host', 'https://agentweb-user-files.example.com/users/user-a/x.txt'],
  ])('refuses %s with OWN_STORAGE_ONLY_MESSAGE before any fetch', async (_label, url) => {
    const result = await readFileContent(url, OWN);
    expect(result.success).toBe(false);
    expect(result.message).toBe(OWN_STORAGE_ONLY_MESSAGE);
    expectNothingFetched();
  });

  it('refuses a bucket URL under another user\'s prefix with the ownership message, touching no S3 call', async () => {
    const result = await readFileContent(`${BUCKET}users/user-b/files/1/t/secret.txt`, OWN);
    expect(result.success).toBe(false);
    expect(result.message).toBe('File not found or you do not have access to it.');
    expect(JSON.stringify(result)).not.toContain('user-b');
    expectNothingFetched();
  });

  it('reads the caller\'s own bucket file', async () => {
    mockStream.mockReturnValueOnce(chunkStream([Buffer.from('own text')]).stream);
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain' });
    const result = await readFileContent(OWN_URL, OWN);
    expect(result.success).toBe(true);
    expect(result.content).toBe('own text');
    expect(mockStream).toHaveBeenCalledWith(OWN_KEY);
    expect(mockGet).not.toHaveBeenCalled();
  });

  // Any URL that is not an object of AgentWeb's own bucket gets the own-storage refusal first, an image or video URL elsewhere included.
  it('refuses an external IMAGE url with OWN_STORAGE_ONLY_MESSAGE, not the describe_image message', async () => {
    const result = await readFileContent('https://evil.example/picture.png', OWN);
    expect(result.message).toBe(OWN_STORAGE_ONLY_MESSAGE);
  });

  it('an external image or video url is refused without any fetch', async () => {
    for (const url of ['https://evil.example/picture.png', 'https://evil.example/clip.mp4']) {
      const result = await readFileContent(url, OWN);
      expect(result.success).toBe(false);
    }
    expectNothingFetched();
  });
});

describe('maxBytes', () => {
  const LIMIT = 10;

  it('a stored size over the limit is refused before the stream is opened', async () => {
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain', ContentLength: LIMIT + 1 });
    const result = await readFileContent(OWN_URL, { ...OWN, maxBytes: LIMIT });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/larger than .* MB/);
    expect(mockMeta).toHaveBeenCalledWith(OWN_KEY);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('the MB figure in the refusal is the limit in MB', async () => {
    mockMeta.mockResolvedValueOnce({ ContentLength: 11 * 1024 * 1024 });
    const result = await readFileContent(OWN_URL, { ...OWN, maxBytes: 10 * 1024 * 1024 });
    expect(result.message).toContain('larger than 10 MB');
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('a stored size exactly at the limit reads normally, with one metadata call made BEFORE the stream', async () => {
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain', ContentLength: LIMIT });
    mockStream.mockReturnValueOnce(chunkStream([Buffer.from('0123456789')]).stream);
    const result = await readFileContent(OWN_URL, { ...OWN, maxBytes: LIMIT });
    expect(result.success).toBe(true);
    expect(result.content).toBe('0123456789');
    expect(result.file_size).toBe(LIMIT);
    expect(mockMeta).toHaveBeenCalledTimes(1);
    expect(mockMeta.mock.invocationCallOrder[0]).toBeLessThan(mockStream.mock.invocationCallOrder[0]);
  });

  it('when the metadata read fails the stream is read, and stops and refuses as soon as the bytes pass the limit', async () => {
    mockMeta.mockRejectedValueOnce(new Error('HeadObject denied'));
    const { stream, state } = chunkStream([Buffer.from('012345'), Buffer.from('6789X'), Buffer.from('never-read')]);
    mockStream.mockReturnValueOnce(stream);
    const result = await readFileContent(OWN_URL, { ...OWN, maxBytes: LIMIT });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/larger than .* MB/);
    expect(state.destroy).toHaveBeenCalled();
    expect(state.pulled).toBe(2);
    expect(result.content).toBeUndefined();
  });

  it('when the metadata has no size the stream is still capped', async () => {
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain' });
    const { stream, state } = chunkStream([Buffer.from('01234567890')]);
    mockStream.mockReturnValueOnce(stream);
    const result = await readFileContent(OWN_URL, { ...OWN, maxBytes: LIMIT });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/larger than/);
    expect(state.destroy).toHaveBeenCalled();
  });

  it('with no stored size, a file whose bytes total exactly the limit reads normally', async () => {
    mockMeta.mockResolvedValueOnce({});
    const { stream, state } = chunkStream([Buffer.from('01234'), Buffer.from('56789')]);
    mockStream.mockReturnValueOnce(stream);
    const result = await readFileContent(OWN_URL, { ...OWN, maxBytes: LIMIT });
    expect(result.success).toBe(true);
    expect(result.content).toBe('0123456789');
    expect(state.destroy).not.toHaveBeenCalled();
  });

  it('a file under the limit reads normally', async () => {
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain', ContentLength: 3 });
    mockStream.mockReturnValueOnce(chunkStream([Buffer.from('abc')]).stream);
    const result = await readFileContent(OWN_URL, { ...OWN, maxBytes: LIMIT });
    expect(result.success).toBe(true);
    expect(result.content).toBe('abc');
  });

  it('maxBytes is checked on the ownership-refused path only after ownership: a foreign key is refused with no metadata call', async () => {
    const result = await readFileContent(`${BUCKET}users/user-b/files/big.txt`, { ...OWN, maxBytes: LIMIT });
    expect(result.message).toBe('File not found or you do not have access to it.');
    expect(mockMeta).not.toHaveBeenCalled();
    expect(mockStream).not.toHaveBeenCalled();
  });
});

describe('without the new fields (Emma\'s path) nothing changes', () => {
  it('an external URL is still fetched through the SSRF-safe GET', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/plain' }, data: Buffer.from('public body') });
    const result = await readFileContent('https://example.com/notes.txt', { userId: 'user-a' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('public body');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it('ownStorageOnly: false behaves as unset (the external URL is fetched)', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/plain' }, data: Buffer.from('ok') });
    const result = await readFileContent('https://example.com/notes.txt', { userId: 'user-a', ownStorageOnly: false });
    expect(result.success).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('an own bucket file: no metadata call before the stream (the content type is read after it)', async () => {
    mockStream.mockReturnValueOnce(chunkStream([Buffer.from('S3 file content')]).stream);
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain', ContentLength: 999_999_999 });
    const result = await readFileContent(OWN_URL, { userId: 'user-a' });
    expect(result.success).toBe(true);
    expect(result.content).toBe('S3 file content');
    expect(mockMeta).toHaveBeenCalledTimes(1);
    expect(mockStream.mock.invocationCallOrder[0]).toBeLessThan(mockMeta.mock.invocationCallOrder[0]);
  });

  it('a large own file is not capped when maxBytes is unset', async () => {
    const big = Buffer.alloc(64 * 1024, 'a');
    const { stream, state } = chunkStream([big, big, big]);
    mockStream.mockReturnValueOnce(stream);
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain' });
    const result = await readFileContent(OWN_URL, { userId: 'user-a' });
    expect(result.success).toBe(true);
    expect(result.file_size).toBe(3 * 64 * 1024);
    expect(state.destroy).not.toHaveBeenCalled();
  });
});

describe('the truncation message (Emma\'s, unchanged; the MCP tool writes its own note)', () => {
  it('a cut read keeps Emma\'s message and reports truncated', async () => {
    mockStream.mockReturnValueOnce(chunkStream([Buffer.alloc(100_050, 'x')]).stream);
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain' });
    const result = await readFileContent(OWN_URL, { userId: 'user-a' });
    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.content_length).toBe(100_000);
    expect(result.message).toMatch(/content was truncated/);
  });

  it('an untruncated read says nothing about truncation', async () => {
    mockStream.mockReturnValueOnce(chunkStream([Buffer.from('short')]).stream);
    mockMeta.mockResolvedValueOnce({ ContentType: 'text/plain' });
    const result = await readFileContent(OWN_URL, { userId: 'user-a' });
    expect(result.truncated).toBe(false);
    expect(result.message).not.toMatch(/truncated/);
  });
});
