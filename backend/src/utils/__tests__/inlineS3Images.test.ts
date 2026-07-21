import {
  inlineS3ImagesAsDataUris,
  createDefaultS3ImageFetcher,
  S3ImageFetcher,
} from '../inlineS3Images';

// Keep extractS3KeyFromUrl real (pure, no network); mock only the byte fetch.
jest.mock('../s3Utils', () => {
  const actual = jest.requireActual('../s3Utils');
  return { ...actual, getS3ObjectAsBuffer: jest.fn() };
});
const { getS3ObjectAsBuffer } = jest.requireMock('../s3Utils') as {
  getS3ObjectAsBuffer: jest.Mock;
};

const PNG_BYTES = Buffer.from('fake-png-bytes');
const PNG_B64 = PNG_BYTES.toString('base64');

describe('inlineS3ImagesAsDataUris (pure transform)', () => {
  it('rewrites a recognised <img src> into a base64 data URI', async () => {
    const fetcher: S3ImageFetcher = jest
      .fn()
      .mockResolvedValue({ buffer: PNG_BYTES, contentType: 'image/png' });
    const html = `<html><body><img src="https://bucket.s3.amazonaws.com/a.png"></body></html>`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.inlined).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.html).toContain(`src="data:image/png;base64,${PNG_B64}"`);
    expect(result.html).not.toContain('https://bucket.s3.amazonaws.com/a.png');
  });

  it('leaves a non-recognised image (fetcher returns null) untouched', async () => {
    const fetcher: S3ImageFetcher = jest.fn().mockResolvedValue(null);
    const html = `<img src="https://cdn.example.com/logo.png" alt="logo">`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.inlined).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.html).toBe(html);
  });

  it('never passes an existing data: URI to the fetcher and leaves it unchanged', async () => {
    const fetcher: S3ImageFetcher = jest.fn().mockResolvedValue(null);
    const html = `<img src="data:image/gif;base64,R0lGOD= ">`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.html).toBe(html);
    expect(result.inlined).toBe(0);
  });

  it('de-duplicates fetches when the same image appears multiple times', async () => {
    const fetcher: S3ImageFetcher = jest
      .fn()
      .mockResolvedValue({ buffer: PNG_BYTES, contentType: 'image/png' });
    const url = 'https://bucket.s3.amazonaws.com/dup.png';
    const html = `<img src="${url}"><hr><img src="${url}">`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.inlined).toBe(1);
    // Both occurrences are rewritten.
    const occurrences = result.html.split(`data:image/png;base64,${PNG_B64}`).length - 1;
    expect(occurrences).toBe(2);
  });

  it('counts a recognised-but-failed fetch and keeps the original src, while still inlining others', async () => {
    const badUrl = 'https://bucket.s3.amazonaws.com/broken.png';
    const goodUrl = 'https://bucket.s3.amazonaws.com/good.png';
    const fetcher: S3ImageFetcher = jest.fn(async (url: string) => {
      if (url === badUrl) throw new Error('AccessDenied');
      return { buffer: PNG_BYTES, contentType: 'image/png' };
    });
    const html = `<img src="${badUrl}"><img src="${goodUrl}">`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.inlined).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.html).toContain(`src="${badUrl}"`); // untouched
    expect(result.html).toContain(`src="data:image/png;base64,${PNG_B64}"`); // inlined
  });

  it('handles single-quoted src attributes', async () => {
    const fetcher: S3ImageFetcher = jest
      .fn()
      .mockResolvedValue({ buffer: PNG_BYTES, contentType: 'image/webp' });
    const html = `<img src='https://bucket.s3.amazonaws.com/a.webp' />`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.inlined).toBe(1);
    expect(result.html).toContain(`src='data:image/webp;base64,${PNG_B64}'`);
  });

  it('preserves other attributes on the <img> tag', async () => {
    const fetcher: S3ImageFetcher = jest
      .fn()
      .mockResolvedValue({ buffer: PNG_BYTES, contentType: 'image/png' });
    const html = `<img class="hero" alt="Chart" width="600" src="https://bucket.s3.amazonaws.com/a.png" style="border:0">`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.html).toContain('class="hero"');
    expect(result.html).toContain('alt="Chart"');
    expect(result.html).toContain('width="600"');
    expect(result.html).toContain('style="border:0"');
    expect(result.html).toContain(`src="data:image/png;base64,${PNG_B64}"`);
  });

  it('falls back to application/octet-stream when contentType is empty', async () => {
    const fetcher: S3ImageFetcher = jest
      .fn()
      .mockResolvedValue({ buffer: PNG_BYTES, contentType: '' });
    const html = `<img src="https://bucket.s3.amazonaws.com/a.bin">`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(result.html).toContain(`data:application/octet-stream;base64,${PNG_B64}`);
  });

  it('returns unchanged HTML with no fetcher calls when there are no <img> tags', async () => {
    const fetcher: S3ImageFetcher = jest.fn();
    const html = `<html><body><p>No images here</p></body></html>`;

    const result = await inlineS3ImagesAsDataUris(html, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.html).toBe(html);
    expect(result.inlined).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('handles empty / non-string input safely', async () => {
    const fetcher: S3ImageFetcher = jest.fn();
    expect(await inlineS3ImagesAsDataUris('', fetcher)).toEqual({ html: '', inlined: 0, failed: 0 });
    expect(await inlineS3ImagesAsDataUris(undefined as any, fetcher)).toEqual({
      html: '',
      inlined: 0,
      failed: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('createDefaultS3ImageFetcher', () => {
  beforeEach(() => {
    getS3ObjectAsBuffer.mockReset();
  });

  it('returns null for a URL that is not in our bucket(s)', async () => {
    const fetcher = createDefaultS3ImageFetcher(['agentweb-user-files']);
    const result = await fetcher('https://someone-else.s3.amazonaws.com/x.png');

    expect(result).toBeNull();
    expect(getS3ObjectAsBuffer).not.toHaveBeenCalled();
  });

  it('fetches bytes for a virtual-hosted bucket URL and passes the extracted key', async () => {
    getS3ObjectAsBuffer.mockResolvedValue({ buffer: PNG_BYTES, contentType: 'image/png' });
    const fetcher = createDefaultS3ImageFetcher(['agentweb-user-files']);
    const url = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/u1/files/1/img.png';

    const result = await fetcher(url);

    expect(getS3ObjectAsBuffer).toHaveBeenCalledWith('users/u1/files/1/img.png', 'agentweb-user-files');
    expect(result).toEqual({ buffer: PNG_BYTES, contentType: 'image/png' });
  });

  it('infers the MIME from the extension when the stored content type is not image/*', async () => {
    getS3ObjectAsBuffer.mockResolvedValue({ buffer: PNG_BYTES, contentType: 'binary/octet-stream' });
    const fetcher = createDefaultS3ImageFetcher(['agentweb-user-files']);
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/logo.webp';

    const result = await fetcher(url);

    expect(result?.contentType).toBe('image/webp');
  });

  it('defaults to the AWS_S3_BUCKET env bucket when none is passed', async () => {
    const prev = process.env.AWS_S3_BUCKET;
    process.env.AWS_S3_BUCKET = 'agentweb-user-files';
    try {
      getS3ObjectAsBuffer.mockResolvedValue({ buffer: PNG_BYTES, contentType: 'image/jpeg' });
      const fetcher = createDefaultS3ImageFetcher();
      const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/a.jpg';

      const result = await fetcher(url);

      expect(result?.contentType).toBe('image/jpeg');
      expect(getS3ObjectAsBuffer).toHaveBeenCalledWith('users/u1/a.jpg', 'agentweb-user-files');
    } finally {
      process.env.AWS_S3_BUCKET = prev;
    }
  });

  it('propagates a fetch error so the caller can count it as a failure', async () => {
    getS3ObjectAsBuffer.mockRejectedValue(new Error('NoSuchKey'));
    const fetcher = createDefaultS3ImageFetcher(['agentweb-user-files']);
    const url = 'https://agentweb-user-files.s3.amazonaws.com/users/u1/missing.png';

    await expect(fetcher(url)).rejects.toThrow('NoSuchKey');
  });
});
