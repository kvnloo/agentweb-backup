/**
 * ENG-2840 (W2-7): the abortable S3 stream frees the request when a reader stops early (a size limit); the plain stream is unchanged.
 */
const mockAbort = jest.fn();
const mockCreateReadStream = jest.fn();
jest.mock('aws-sdk', () => {
  const S3 = jest.fn().mockImplementation(() => ({
    getObject: jest.fn(() => ({ createReadStream: mockCreateReadStream, abort: mockAbort })),
  }));
  return { __esModule: true, default: { S3 }, S3 };
});

import { PassThrough } from 'stream';
import { getS3ObjectStream, getS3ObjectStreamAbortable } from '../utils/s3Utils';

beforeEach(() => {
  mockAbort.mockReset();
  mockCreateReadStream.mockReset();
});

it('destroying the abortable stream aborts the S3 request and still destroys the stream', () => {
  const inner = new PassThrough();
  mockCreateReadStream.mockReturnValueOnce(inner);
  const stream = getS3ObjectStreamAbortable('users/u/files/a.txt');
  stream.destroy();
  expect(mockAbort).toHaveBeenCalledTimes(1);
  expect(inner.destroyed).toBe(true);
});

it('an abort that throws (request already finished) still destroys the stream', () => {
  const inner = new PassThrough();
  mockCreateReadStream.mockReturnValueOnce(inner);
  mockAbort.mockImplementationOnce(() => { throw new Error('already done'); });
  const stream = getS3ObjectStreamAbortable('users/u/files/a.txt');
  expect(() => stream.destroy()).not.toThrow();
  expect(inner.destroyed).toBe(true);
});

it('the plain stream is unchanged: destroying it does not abort', () => {
  const inner = new PassThrough();
  mockCreateReadStream.mockReturnValueOnce(inner);
  getS3ObjectStream('users/u/files/a.txt').destroy();
  expect(mockAbort).not.toHaveBeenCalled();
});
