jest.mock('aws-sdk', () => {
  const getObjectMock = jest.fn();
  const S3 = jest.fn().mockImplementation(() => ({ getObject: getObjectMock }));
  return {
    __esModule: true,
    default: { S3 },
    S3,
    __getObjectMock: getObjectMock,
  } as any;
});

import { getS3ObjectAsBuffer } from '../s3Utils';

const { __getObjectMock: getObjectMock } = jest.requireMock('aws-sdk') as any;

function mockGetObjectResolves(value: any) {
  getObjectMock.mockReturnValue({ promise: jest.fn().mockResolvedValue(value) });
}

describe('getS3ObjectAsBuffer', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    getObjectMock.mockReset();
    process.env = { ...OLD_ENV, AWS_REGION: 'us-west-2', AWS_S3_BUCKET: 'agentweb-user-files' };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('returns the raw Buffer body and stored content type, using the given bucket/key', async () => {
    const bytes = Buffer.from('image-bytes');
    mockGetObjectResolves({ Body: bytes, ContentType: 'image/png' });

    const result = await getS3ObjectAsBuffer('users/u1/a.png', 'my-bucket');

    expect(getObjectMock).toHaveBeenCalledWith({ Bucket: 'my-bucket', Key: 'users/u1/a.png' });
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.toString()).toBe('image-bytes');
    expect(result.contentType).toBe('image/png');
  });

  it('defaults to the configured AWS_S3_BUCKET when no bucket is passed', async () => {
    mockGetObjectResolves({ Body: Buffer.from('x'), ContentType: 'image/webp' });

    await getS3ObjectAsBuffer('users/u1/a.webp');

    expect(getObjectMock).toHaveBeenCalledWith({
      Bucket: 'agentweb-user-files',
      Key: 'users/u1/a.webp',
    });
  });

  it('coerces a non-Buffer body (e.g. Uint8Array) into a Buffer', async () => {
    const arr = new Uint8Array([1, 2, 3, 4]);
    mockGetObjectResolves({ Body: arr, ContentType: 'image/gif' });

    const result = await getS3ObjectAsBuffer('k', 'b');

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(Array.from(result.buffer)).toEqual([1, 2, 3, 4]);
  });

  it('throws when the object body is missing rather than returning an empty buffer', async () => {
    mockGetObjectResolves({ Body: undefined, ContentType: 'image/png' });

    await expect(getS3ObjectAsBuffer('k', 'b')).rejects.toThrow(/empty body/i);
  });

  it('propagates S3 errors (e.g. AccessDenied on a private object)', async () => {
    getObjectMock.mockReturnValue({
      promise: jest.fn().mockRejectedValue(new Error('AccessDenied')),
    });

    await expect(getS3ObjectAsBuffer('k', 'b')).rejects.toThrow('AccessDenied');
  });
});
