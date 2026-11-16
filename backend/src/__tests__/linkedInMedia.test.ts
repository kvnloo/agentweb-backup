import { assertImageDownload, isVideoUrl, LinkedInUnsupportedMediaError } from '../services/linkedInMedia';

const isoBmff = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(12)]);

describe('ENG-3003 linkedInMedia', () => {
  describe('isVideoUrl', () => {
    it('matches by extension, ignoring case and query string', () => {
      expect(isVideoUrl('https://cdn.example.com/a/Event.MP4?X-Amz-Signature=abc')).toBe(true);
      expect(isVideoUrl('https://cdn.example.com/a/photo.png')).toBe(false);
      expect(isVideoUrl('https://cdn.example.com/asset/9f3a')).toBe(false);
    });
  });

  describe('assertImageDownload', () => {
    it('accepts image content types, including parameters and case', () => {
      expect(() => assertImageDownload('image/png', Buffer.from('x'))).not.toThrow();
      expect(() => assertImageDownload('Image/JPEG; charset=binary', Buffer.from('x'))).not.toThrow();
    });

    it('refuses video content types and non-image types', () => {
      expect(() => assertImageDownload('video/mp4', Buffer.from('x'))).toThrow(LinkedInUnsupportedMediaError);
      expect(() => assertImageDownload('video/mp4', Buffer.from('x'))).toThrow(/nothing was posted/i);
      expect(() => assertImageDownload('text/html; charset=utf-8', Buffer.from('<html>'))).toThrow(/did not return an image/);
    });

    it('sniffs generic content types: refuses an mp4, allows a HEIC image and unknown bytes', () => {
      expect(() => assertImageDownload('application/octet-stream', isoBmff('isom'))).toThrow(LinkedInUnsupportedMediaError);
      expect(() => assertImageDownload(undefined, isoBmff('mp42'))).toThrow(LinkedInUnsupportedMediaError);
      expect(() => assertImageDownload('application/octet-stream', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]))).toThrow(LinkedInUnsupportedMediaError);
      expect(() => assertImageDownload('application/octet-stream', isoBmff('heic'))).not.toThrow();
      expect(() => assertImageDownload('application/octet-stream', isoBmff('avif'))).not.toThrow();
      expect(() => assertImageDownload('application/octet-stream', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).not.toThrow();
    });
  });
});
