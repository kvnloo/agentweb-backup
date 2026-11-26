/**
 * ENG-2840 (W2-8): getS3ObjectAsString with maxBytes reads at most that much (a ranged read) and refuses a larger object without
 * retrying; without maxBytes it reads the whole object exactly as before.
 */
const mockGetObject = jest.fn();
jest.mock('aws-sdk', () => {
  const S3 = jest.fn().mockImplementation(() => ({ getObject: (...a: any[]) => mockGetObject(...a) }));
  return { __esModule: true, default: { S3 }, S3 };
});

import { getS3ObjectAsString, S3ObjectTooLargeError } from '../utils/s3Utils';

const body = (text: string) => ({ promise: async () => ({ Body: Buffer.from(text, 'utf-8') }) });
beforeEach(() => mockGetObject.mockReset());

it('without maxBytes: no range, the whole object', async () => {
  mockGetObject.mockReturnValueOnce(body('a,b\n1,2'));
  await expect(getS3ObjectAsString('k', 'b')).resolves.toBe('a,b\n1,2');
  expect(mockGetObject).toHaveBeenCalledWith({ Bucket: 'b', Key: 'k' });
});

it('with maxBytes: asks for at most maxBytes + 1 bytes; an object of exactly the limit passes', async () => {
  mockGetObject.mockReturnValueOnce(body('12345'));
  await expect(getS3ObjectAsString('k', 'b', { maxBytes: 5 })).resolves.toBe('12345');
  expect(mockGetObject).toHaveBeenCalledWith({ Bucket: 'b', Key: 'k', Range: 'bytes=0-5' });
});

it('a larger object is refused with S3ObjectTooLargeError and not retried', async () => {
  mockGetObject.mockReturnValue(body('123456'));
  const err = await getS3ObjectAsString('k', 'b', { maxBytes: 5, sleep: async () => undefined }).catch((e) => e);
  expect(err).toBeInstanceOf(S3ObjectTooLargeError);
  expect(err.name).toBe('S3ObjectTooLargeError');
  expect(mockGetObject).toHaveBeenCalledTimes(1);
});

it('a transient error is still retried with a limit set', async () => {
  mockGetObject
    .mockReturnValueOnce({ promise: async () => { throw Object.assign(new Error('slow'), { code: 'SlowDown', statusCode: 503 }); } })
    .mockReturnValueOnce(body('ok'));
  await expect(getS3ObjectAsString('k', 'b', { maxBytes: 10, sleep: async () => undefined })).resolves.toBe('ok');
  expect(mockGetObject).toHaveBeenCalledTimes(2);
});
