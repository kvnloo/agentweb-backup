/**
 * GET /api/files/presign — download-disposition support (ENG-1188).
 *
 * Root cause: generated ad-creative assets (HTML banners, screenshots) had no
 * working download path. The chat UI only offered "View" (in-app preview) and
 * "Open in new tab" (no `download` attribute, and the underlying S3 object never
 * carries a Content-Disposition header), so a click just rendered the file inline
 * instead of saving it. The fix routes a real "Download" action through this
 * existing presign endpoint with an attachment disposition baked into the signed
 * URL itself, which S3 honors regardless of cross-origin `download`-attribute
 * quirks.
 */
import { Request, Response } from 'express';

jest.mock('../utils/s3Utils', () => ({
  extractS3KeyFromUrl: jest.fn(),
  generatePresignedUrl: jest.fn(),
}));
// ENG-2988: the handler now asks the storage access policy who may read the key. These tests are about the download disposition, so the
// caller owns the key (no lookups); the policy itself is covered by storageAccessPolicy.test.ts and filesController.access.test.ts.
jest.mock('../middleware/auth', () => ({
  isRealAdmin: jest.requireActual('../middleware/auth').isRealAdmin,
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: { getTaskById: jest.fn(), getTaskExecutionOwnerById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({
  ChatbotDB: jest.fn(),
  chatbotDb: { getChatSessionRecord: jest.fn() },
}));

import { generatePresignedUrl, extractS3KeyFromUrl } from '../utils/s3Utils';
import { getPresignedFileUrl } from '../controllers/filesController';

const OWN_KEY = 'users/u1/files/1/abc/banner.html';
const OWN_URL = `https://agentweb-user-files.s3.amazonaws.com/${OWN_KEY}`;
const asUser = (query: Record<string, string>) => ({ query, user: { userId: 'u1', isAdmin: false } }) as unknown as Request;

function mockRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function lastDisposition(): string | undefined {
  const call = (generatePresignedUrl as jest.Mock).mock.calls[0];
  return call?.[3];
}

describe('getPresignedFileUrl — download disposition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (extractS3KeyFromUrl as jest.Mock).mockReturnValue(OWN_KEY);
  });

  it('does NOT request a disposition when download is not requested (existing "view" behavior unchanged)', async () => {
    (generatePresignedUrl as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = asUser({ url: OWN_URL });
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    expect(lastDisposition()).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    // the key that was checked is the key that is signed
    expect((generatePresignedUrl as jest.Mock).mock.calls[0][0]).toBe(OWN_KEY);
  });

  it('requests an attachment disposition with the sanitized filename when download=true', async () => {
    (generatePresignedUrl as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = asUser({ url: OWN_URL, download: 'true', filename: 'xCures Master Banners V2.html' });
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    // Spaces are safe inside a quoted filename= string (RFC 6266) -- only
    // characters that could break the quoting or header syntax need stripping.
    expect(lastDisposition()).toBe('attachment; filename="xCures Master Banners V2.html"');
  });

  it('falls back to a generic filename when none is supplied for a download', async () => {
    (generatePresignedUrl as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = asUser({ url: OWN_URL, download: 'true' });
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    expect(lastDisposition()).toBe('attachment; filename="download"');
  });

  it('strips path separators, quotes, and other header-breaking characters from the filename', async () => {
    (generatePresignedUrl as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = asUser({ url: OWN_URL, download: 'true', filename: '../../etc/passwd" ; evil="1' });
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    const disposition = lastDisposition()!;
    const filenamePart = disposition.match(/^attachment; filename="(.*)"$/)![1];
    expect(filenamePart).not.toMatch(/["/\\]/);
  });

  it('strips HTTP control characters (CR, LF, NUL, DEL) from the filename', async () => {
    // CodeRabbit (PR #2430): RFC 9110 forbids CR/LF/NUL/other C0 controls and DEL
    // in a header field value. Left unstripped, S3 can reject the presigned
    // request (InvalidRequest) or a client can see a malformed/injected header.
    (generatePresignedUrl as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = asUser({ url: OWN_URL, download: 'true', filename: 'report\r\nX-Injected: yes\x00.txt\x7f' });
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    const disposition = lastDisposition()!;
    // eslint-disable-next-line no-control-regex
    expect(disposition).not.toMatch(/[\x00-\x1f\x7f]/);
    const filenamePart = disposition.match(/^attachment; filename="(.*)"$/)![1];
    expect(filenamePart).toBe('report__X-Injected_ yes_.txt_');
  });

  it('returns 400 when the URL does not reference the configured bucket, without ever presigning', async () => {
    (extractS3KeyFromUrl as jest.Mock).mockReturnValue(null);
    const req = asUser({ url: 'https://evil.example.com/steal.html', download: 'true' });
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(generatePresignedUrl).not.toHaveBeenCalled();
  });
});
