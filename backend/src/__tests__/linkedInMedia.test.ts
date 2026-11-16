import {
  assertImageDownload, classifyMedia, isVideoUrl, isVideoUrn, LinkedInUnsupportedMediaError,
  LINKEDIN_MAX_CONCURRENT_VIDEO_UPLOADS, withVideoUploadSlot,
} from '../services/linkedInMedia';

const isoBmff = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(12)]);

describe('ENG-3003 / ENG-3116 linkedInMedia', () => {
  it('isVideoUrl matches by extension, ignoring case and query string; isVideoUrn by prefix', () => {
    expect(isVideoUrl('https://cdn.example.com/a/Event.MP4?X-Amz-Signature=abc')).toBe(true);
    expect(isVideoUrl('https://cdn.example.com/a/photo.png')).toBe(false);
    expect(isVideoUrl('https://cdn.example.com/asset/9f3a')).toBe(false);
    expect(isVideoUrn('urn:li:video:C5505AQH')).toBe(true);
    expect(isVideoUrn('urn:li:image:C5505AQH')).toBe(false);
  });

  describe('classifyMedia', () => {
    it('classifies by content type: image, MP4 video, other video, other', () => {
      expect(classifyMedia('Image/JPEG; charset=binary', Buffer.from('x')).kind).toBe('image');
      expect(classifyMedia('video/mp4', Buffer.from('x')).kind).toBe('video');
      expect(classifyMedia('video/quicktime', Buffer.from('x')).kind).toBe('unsupported');
      expect(classifyMedia('video/webm', Buffer.from('x')).kind).toBe('unsupported');
      expect(classifyMedia('text/html; charset=utf-8', Buffer.from('<html>')).kind).toBe('unsupported');
    });

    it('sniffs generic content types: mp4 is video, mov/webm/avi unsupported, HEIC/AVIF/unknown stay images', () => {
      expect(classifyMedia('application/octet-stream', isoBmff('isom')).kind).toBe('video');
      expect(classifyMedia(undefined, isoBmff('mp42')).kind).toBe('video');
      expect(classifyMedia('application/octet-stream', isoBmff('qt  ')).kind).toBe('unsupported');
      expect(classifyMedia('application/octet-stream', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])).kind).toBe('unsupported');
      expect(classifyMedia('application/octet-stream', isoBmff('heic')).kind).toBe('image');
      expect(classifyMedia('application/octet-stream', isoBmff('avif')).kind).toBe('image');
      expect(classifyMedia('application/octet-stream', Buffer.from([0x89, 0x50, 0x4e, 0x47])).kind).toBe('image');
    });
  });

  describe('assertImageDownload (image-only path)', () => {
    it('accepts images and refuses videos and non-images with "nothing was posted"', () => {
      expect(() => assertImageDownload('image/png', Buffer.from('x'))).not.toThrow();
      expect(() => assertImageDownload('video/mp4', Buffer.from('x'))).toThrow(LinkedInUnsupportedMediaError);
      expect(() => assertImageDownload('text/html', Buffer.from('<html>'))).toThrow(/nothing was posted/i);
    });
  });

  describe('withVideoUploadSlot', () => {
    it('runs at most the allowed number at once and releases slots when a run throws', async () => {
      let running = 0;
      let peak = 0;
      const gates: Array<() => void> = [];
      const job = (fail = false) => withVideoUploadSlot(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>(resolve => gates.push(resolve));
        running--;
        if (fail) throw new Error('x');
      });
      const settledPromise = Promise.allSettled([job(), job(true), job(), job()]);
      await new Promise(r => setImmediate(r));
      expect(running).toBe(LINKEDIN_MAX_CONCURRENT_VIDEO_UPLOADS);
      while (gates.length || running) {
        gates.shift()?.();
        await new Promise(r => setImmediate(r));
      }
      const settled = await settledPromise;
      expect(settled.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
      expect(peak).toBe(LINKEDIN_MAX_CONCURRENT_VIDEO_UPLOADS);
      await expect(withVideoUploadSlot(async () => 'ok')).resolves.toBe('ok');
    });
  });
});
