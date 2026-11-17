// ENG-3116: native LinkedIn video upload (Videos API) in LinkedInService.uploadMediaFromUrl.
import { Readable } from 'stream';

jest.mock('axios', () => {
  const create = jest.fn();
  return { __esModule: true, create, isAxiosError: jest.fn(), get: jest.fn(), put: jest.fn(), post: jest.fn(),
    default: { create, isAxiosError: jest.fn(), get: jest.fn(), put: jest.fn(), post: jest.fn() } };
});
jest.mock('puppeteer-core', () => ({ __esModule: true, default: { launch: jest.fn() } }));

import axios from 'axios';
import fs from 'fs';
import os from 'os';
import { LinkedInService } from '../services/linkedInService';
import { LinkedInUnsupportedMediaError, LINKEDIN_MAX_VIDEO_BYTES, LINKEDIN_VIDEO_PART_BYTES } from '../services/linkedInMedia';

const OWNER = 'urn:li:organization:123';
const VIDEO = 'urn:li:video:C5505AQH';
const PART = LINKEDIN_VIDEO_PART_BYTES;

const mp4Bytes = (size: number) => {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0, 0, 0, 0x18]).copy(b, 0);
  b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1');
  return b;
};
const download = (body: Buffer, headers: Record<string, string>) => ({ status: 200, data: Readable.from([body]), headers });

describe('LinkedInService.uploadMediaFromUrl', () => {
  let service: LinkedInService;
  let client: { get: jest.Mock; post: jest.Mock };
  const tempFiles = () => [...fs.readdirSync('/var/tmp'), ...fs.readdirSync(os.tmpdir())].filter(f => f.startsWith('li-media-'));

  beforeEach(() => {
    jest.clearAllMocks();
    client = { get: jest.fn(), post: jest.fn() };
    (axios.create as jest.Mock).mockReturnValue(client);
    service = new LinkedInService();
    service.videoProcessingPollMs = 1;
    service.videoProcessingTimeoutMs = 50;
  });

  function mockVideoApi(parts: number, status: string | string[] = 'AVAILABLE') {
    const instructions = Array.from({ length: parts }, (_, i) => ({
      firstByte: i * PART, lastByte: (i + 1) * PART - 1, uploadUrl: `https://www.linkedin.com/dms-uploads/${i}`,
    }));
    client.post.mockImplementation(async (url: string) =>
      url.includes('initializeUpload') ? { data: { value: { video: VIDEO, uploadToken: 'tok', uploadInstructions: instructions } } } : { data: {} });
    const statuses = ([] as string[]).concat(status);
    client.get.mockImplementation(async () => ({ data: { status: statuses.length > 1 ? statuses.shift() : statuses[0], processingFailureReason: 'BAD_CODEC' } }));
    let n = 0;
    (axios.put as jest.Mock).mockImplementation(async () => ({ headers: { etag: `"etag-${n++}"` } }));
  }

  it('uploads an extensionless video in 4 MB parts, finalizes with the ETags, waits until AVAILABLE, cleans up', async () => {
    const before = tempFiles().length;
    const size = PART + 1000; // two parts, the last one short
    (axios.get as jest.Mock).mockResolvedValue(download(mp4Bytes(size), { 'content-type': 'video/mp4', 'content-length': String(size) }));
    mockVideoApi(2, ['PROCESSING', 'AVAILABLE']);

    const urn = await service.uploadMediaFromUrl('token', OWNER, 'https://cdn.example.com/asset/9f3a');

    expect(urn).toBe(VIDEO);
    expect(client.post.mock.calls[0][0]).toBe('/rest/videos?action=initializeUpload');
    expect(client.post.mock.calls[0][1].initializeUploadRequest).toMatchObject({ owner: OWNER, fileSizeBytes: size });
    const puts = (axios.put as jest.Mock).mock.calls;
    expect(puts.map(c => (c[1] as Buffer).length)).toEqual([PART, 1000]);
    expect(client.post.mock.calls[1][0]).toBe('/rest/videos?action=finalizeUpload');
    expect(client.post.mock.calls[1][1].finalizeUploadRequest).toEqual({ video: VIDEO, uploadToken: 'tok', uploadedPartIds: ['etag-0', 'etag-1'] });
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(tempFiles().length).toBe(before);
  });

  it('refuses a non-MP4 video (e.g. QuickTime) before any LinkedIn call', async () => {
    const mov = mp4Bytes(2000);
    mov.write('qt  ', 8, 'latin1');
    (axios.get as jest.Mock).mockResolvedValue(download(mov, { 'content-type': 'video/quicktime' }));
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://cdn.example.com/a.mov')).rejects.toThrow(/only accepts MP4/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('refuses a declared size over the cap without downloading it', async () => {
    const data = Readable.from([Buffer.alloc(10)]);
    (axios.get as jest.Mock).mockResolvedValue({ status: 200, data, headers: { 'content-type': 'video/mp4', 'content-length': String(LINKEDIN_MAX_VIDEO_BYTES + 1) } });
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://cdn.example.com/big.mp4')).rejects.toBeInstanceOf(LinkedInUnsupportedMediaError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('aborts a stream that exceeds the cap with no content-length, leaving no temp file', async () => {
    const before = tempFiles().length;
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const endless = Readable.from((function* () { for (let i = 0; i < 25; i++) yield chunk; })());
    (axios.get as jest.Mock).mockResolvedValue({ status: 200, data: endless, headers: { 'content-type': 'video/mp4' } });
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://cdn.example.com/big.mp4')).rejects.toThrow(/larger than/);
    expect(client.post).not.toHaveBeenCalled();
    expect(tempFiles().length).toBe(before);
  });

  it('fails with "nothing was posted" when LinkedIn reports PROCESSING_FAILED, and when it never finishes', async () => {
    (axios.get as jest.Mock).mockImplementation(async () => download(mp4Bytes(2000), { 'content-type': 'video/mp4', 'content-length': '2000' }));
    mockVideoApi(1, 'PROCESSING_FAILED');
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://x/y.mp4')).rejects.toThrow(/could not process the video \(BAD_CODEC\)/);
    mockVideoApi(1, 'PROCESSING');
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://x/y.mp4')).rejects.toThrow(/still processing[\s\S]*Nothing was posted/);
  });

  it('errors when LinkedIn returns no ETag for a part', async () => {
    (axios.get as jest.Mock).mockResolvedValue(download(mp4Bytes(2000), { 'content-type': 'video/mp4', 'content-length': '2000' }));
    mockVideoApi(1);
    (axios.put as jest.Mock).mockResolvedValue({ headers: {} });
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://x/y.mp4')).rejects.toThrow(/ETag/);
  });

  it('refuses a non-2xx media download with a clear error instead of reading the error body', async () => {
    const body = Readable.from([Buffer.from('<html>Forbidden</html>')]);
    (axios.get as jest.Mock).mockResolvedValue({ status: 403, data: body, headers: { 'content-type': 'text/html' } });
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://x/expired')).rejects.toThrow(/HTTP 403/);
    expect(body.destroyed).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('refuses an empty download', async () => {
    (axios.get as jest.Mock).mockResolvedValue(download(Buffer.alloc(0), { 'content-type': 'image/png' }));
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://x/empty.png')).rejects.toThrow(/empty file/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('treats an MP4 whose first box is not ftyp, served as image/*, as a video', async () => {
    const mp4 = mp4Bytes(2000);
    mp4.write('free', 4, 'latin1');
    (axios.get as jest.Mock).mockResolvedValue(download(mp4, { 'content-type': 'image/jpeg', 'content-length': '2000' }));
    mockVideoApi(1);
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://x/asset')).resolves.toBe(VIDEO);
    expect(client.post.mock.calls[0][0]).toBe('/rest/videos?action=initializeUpload');
  });

  it('tags any failure after the bytes were classified as video, so the caller cannot mistake it for an image', async () => {
    (axios.get as jest.Mock).mockResolvedValue(download(mp4Bytes(2000), { 'content-type': 'application/octet-stream', 'content-length': '2000' }));
    mockVideoApi(1);
    client.post.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { isAxiosError: true, response: { status: 403, data: { message: 'no org permission' } } }));
    const err: any = await service.uploadMediaFromUrl('token', OWNER, 'https://x/asset').catch(e => e);
    expect(err.message).toMatch(/Permission Denied/);
    expect(err.isVideoUpload).toBe(true);
  });

  it('does not tag an image failure as a video failure', async () => {
    (axios.get as jest.Mock).mockResolvedValue(download(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]), { 'content-type': 'image/png' }));
    client.post.mockRejectedValue(new Error('boom'));
    const err: any = await service.uploadMediaFromUrl('token', OWNER, 'https://x/a').catch(e => e);
    expect(err.isVideoUpload).toBeUndefined();
  });

  it('still routes an image through the Images API and returns the image URN', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    (axios.get as jest.Mock).mockResolvedValue(download(png, { 'content-type': 'image/png', 'content-length': '7' }));
    client.post.mockResolvedValue({ data: { value: { uploadUrl: 'https://upload.linkedin.com/i', image: 'urn:li:image:9' } } });
    (axios.put as jest.Mock).mockResolvedValue({});
    await expect(service.uploadMediaFromUrl('token', OWNER, 'https://x/a.png')).resolves.toBe('urn:li:image:9');
    expect(client.post.mock.calls[0][0]).toBe('/rest/images?action=initializeUpload');
    expect((axios.put as jest.Mock).mock.calls[0][2].headers['Content-Type']).toBe('image/png');
  });
});
