/**
 * ENG-2840: readWithByteCap (utils/readWithByteCap.ts) and its use for Google Drive text reads (readGoogleDriveFileContent): a download
 * never holds more than its ceiling in memory, and a short or unreadable download is an error, never an empty file.
 */
import { Readable } from 'stream';
import { readWithByteCap } from '../utils/readWithByteCap';
import { readGoogleDriveFileContent, DRIVE_TEXT_READ_MAX_BYTES } from '../emma/impl/shared/googleDriveAccess';
import { normalizeStreamedDriveError, isDriveThrottle, driveErrorCode } from '../emma/impl/shared/googleDriveErrors';

function lazyStream(chunkBytes: number, chunks: number) {
  let produced = 0;
  const chunk = Buffer.alloc(chunkBytes, 0x61);
  const stream = new Readable({
    read() {
      produced++;
      this.push(produced <= chunks ? chunk : null);
    },
  });
  return { stream, produced: () => produced };
}

describe('readWithByteCap', () => {
  it('reads a stream under the cap in full', async () => {
    expect((await readWithByteCap(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 10))?.toString()).toBe('abcd');
  });

  it('stops a stream as soon as it passes the cap and answers null', async () => {
    const { stream, produced } = lazyStream(1024 * 1024, 10_000); // 10 GB if read to the end
    expect(await readWithByteCap(stream, 5 * 1024 * 1024)).toBeNull();
    expect(produced()).toBeLessThan(30);
    expect(stream.destroyed).toBe(true);
  });

  it('measures bytes that are already in memory', async () => {
    expect(await readWithByteCap(Buffer.alloc(11), 10)).toBeNull();
    expect((await readWithByteCap(Buffer.from('ok'), 10))?.toString()).toBe('ok');
    expect((await readWithByteCap(new Uint8Array([104, 105]), 10))?.toString()).toBe('hi');
  });

  it('refuses a body it cannot read instead of answering an empty file', async () => {
    await expect(readWithByteCap(undefined, 10)).rejects.toThrow('The download returned no readable body');
    await expect(readWithByteCap({ not: 'a stream' }, 10)).rejects.toThrow('The download returned no readable body');
  });

  it('rejects a stream that closes before it ends', async () => {
    const stream = new Readable({ read() { /* never ends */ } });
    const reading = readWithByteCap(stream, 10);
    stream.push(Buffer.from('par'));
    setImmediate(() => stream.destroy());
    await expect(reading).rejects.toThrow('The download ended before it was complete');
  });

  it('passes a stream error on', async () => {
    const stream = new Readable({ read() { this.destroy(new Error('socket reset')); } });
    await expect(readWithByteCap(stream, 10)).rejects.toThrow('socket reset');
  });
});

describe('readGoogleDriveFileContent: the text read has a byte ceiling', () => {
  it('stops a binary download over the ceiling and says the file is too large', async () => {
    const { stream, produced } = lazyStream(8 * 1024 * 1024, 1_000); // 8 GB if read to the end
    const drive = { files: { get: jest.fn().mockResolvedValue({ data: stream }), export: jest.fn() } };
    await expect(readGoogleDriveFileContent(drive, 'file-1', 'huge.mp4', 'video/mp4')).rejects.toThrow('"huge.mp4" is larger than 50 MB');
    expect(drive.files.get).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'file-1', alt: 'media' }), expect.objectContaining({ responseType: 'stream' }));
    // the request itself is aborted at the cap, not only its body stream
    expect((drive.files.get.mock.calls[0][1] as any).signal.aborted).toBe(true);
    expect(produced()).toBeLessThan(DRIVE_TEXT_READ_MAX_BYTES / (8 * 1024 * 1024) + 10);
  });

  it('stops an export over the ceiling too', async () => {
    const { stream } = lazyStream(8 * 1024 * 1024, 1_000);
    const drive = { files: { get: jest.fn(), export: jest.fn().mockResolvedValue({ data: stream }) } };
    await expect(readGoogleDriveFileContent(drive, 'doc-1', 'Plan', 'application/vnd.google-apps.document')).rejects.toThrow(/larger than 50 MB/);
    expect(drive.files.export).toHaveBeenCalledWith({ fileId: 'doc-1', mimeType: 'text/plain' }, expect.objectContaining({ responseType: 'stream' }));
  });

  it('reads a small exported document as text', async () => {
    const drive = { files: { get: jest.fn(), export: jest.fn().mockResolvedValue({ data: Readable.from([Buffer.from('Hello plan')]) }) } };
    await expect(readGoogleDriveFileContent(drive, 'doc-1', 'Plan', 'application/vnd.google-apps.document')).resolves.toBe('Hello plan');
  });
});

describe('readWithByteCap onExceeded', () => {
  it('is called once when the cap is passed, before the stream is destroyed', async () => {
    const { stream } = lazyStream(1024, 100);
    const onExceeded = jest.fn(() => expect(stream.destroyed).toBe(false));
    expect(await readWithByteCap(stream, 4 * 1024, onExceeded)).toBeNull();
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });
});

// ENG-2840 (W2-10 delta review): a streamed Drive request's error body arrives as text; it is parsed back into the usual error shape.
describe('normalizeStreamedDriveError', () => {
  const throttleBody = JSON.stringify({ error: { code: 403, message: 'User rate limit exceeded.', errors: [{ reason: 'userRateLimitExceeded' }] } });

  it('restores code, reasons and Google\'s message, so a throttle is seen as a throttle', () => {
    const err: any = Object.assign(new Error(throttleBody), { code: '403', response: { status: 403, data: throttleBody } });
    expect(isDriveThrottle(err)).toBe(false);
    const out = normalizeStreamedDriveError(err);
    expect(out).toBe(err);
    expect(isDriveThrottle(out)).toBe(true);
    expect(driveErrorCode(out)).toBe(403);
    expect(out.message).toBe('User rate limit exceeded.');
  });

  it('leaves any other error unchanged', () => {
    const plain: any = new Error('socket hang up');
    expect(normalizeStreamedDriveError(plain)).toBe(plain);
    const notJson: any = Object.assign(new Error('x'), { response: { data: '<html>502</html>' } });
    expect(normalizeStreamedDriveError(notJson).message).toBe('x');
  });

  it('is applied to a failed Drive text read', async () => {
    const err: any = Object.assign(new Error(throttleBody), { code: '403', response: { status: 403, data: throttleBody } });
    const drive = { files: { get: jest.fn().mockRejectedValue(err), export: jest.fn() } };
    await expect(readGoogleDriveFileContent(drive, 'f', 'a.pdf', 'application/pdf')).rejects.toMatchObject({ code: 403, message: 'User rate limit exceeded.' });
  });
});
