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
  presignS3Url: jest.fn(),
}));

import { presignS3Url, extractS3KeyFromUrl } from '../utils/s3Utils';
import { getPresignedFileUrl } from '../controllers/filesController';

function mockRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function lastDisposition(): string | undefined {
  const call = (presignS3Url as jest.Mock).mock.calls[0];
  return call?.[3];
}

describe('getPresignedFileUrl — download disposition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (extractS3KeyFromUrl as jest.Mock).mockReturnValue('users/u1/banner.html');
  });

  it('does NOT request a disposition when download is not requested (existing "view" behavior unchanged)', async () => {
    (presignS3Url as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = { query: { url: 'https://agentweb-user-files.s3.amazonaws.com/users/u1/banner.html' } } as unknown as Request;
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    expect(lastDisposition()).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('requests an attachment disposition with the sanitized filename when download=true', async () => {
    (presignS3Url as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = {
      query: {
        url: 'https://agentweb-user-files.s3.amazonaws.com/users/u1/banner.html',
        download: 'true',
        filename: 'xCures Master Banners V2.html',
      },
    } as unknown as Request;
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    // Spaces are safe inside a quoted filename= string (RFC 6266) -- only
    // characters that could break the quoting or header syntax need stripping.
    expect(lastDisposition()).toBe('attachment; filename="xCures Master Banners V2.html"');
  });

  it('falls back to a generic filename when none is supplied for a download', async () => {
    (presignS3Url as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = {
      query: {
        url: 'https://agentweb-user-files.s3.amazonaws.com/users/u1/banner.html',
        download: 'true',
      },
    } as unknown as Request;
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    expect(lastDisposition()).toBe('attachment; filename="download"');
  });

  it('strips path separators, quotes, and other header-breaking characters from the filename', async () => {
    (presignS3Url as jest.Mock).mockReturnValue('https://presigned.example.com/file.html');
    const req = {
      query: {
        url: 'https://agentweb-user-files.s3.amazonaws.com/users/u1/banner.html',
        download: 'true',
        filename: '../../etc/passwd" ; evil="1',
      },
    } as unknown as Request;
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    const disposition = lastDisposition()!;
    const filenamePart = disposition.match(/^attachment; filename="(.*)"$/)![1];
    expect(filenamePart).not.toMatch(/["/\\]/);
  });

  it('returns 400 when the URL does not reference the configured bucket, without ever presigning', async () => {
    (extractS3KeyFromUrl as jest.Mock).mockReturnValue(null);
    const req = { query: { url: 'https://evil.example.com/steal.html', download: 'true' } } as unknown as Request;
    const res = mockRes();

    await getPresignedFileUrl(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(presignS3Url).not.toHaveBeenCalled();
  });
});
