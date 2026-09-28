import { judgeImageSwap, readCreativeImage, selectSwapImageHash } from '../metaImageSwapCheck';

describe('metaImageSwapCheck (ENG-2169)', () => {
  describe('readCreativeImage', () => {
    it('reads a single image hash and picture', () => {
      expect(readCreativeImage({ link_data: { image_hash: 'h', picture: 'https://cdn/p.jpg' } }))
        .toEqual({ hash: 'h', url: 'https://cdn/p.jpg' });
    });

    it('reads a video thumbnail hash and url', () => {
      expect(readCreativeImage({ video_data: { image_hash: 'h', image_url: 'https://cdn/t.jpg' } }))
        .toEqual({ hash: 'h', url: 'https://cdn/t.jpg' });
    });

    it('returns an empty identity for a missing spec', () => {
      expect(readCreativeImage(undefined)).toEqual({ hash: undefined, url: undefined });
    });
  });

  describe('judgeImageSwap', () => {
    const urlOnly = { oldHash: 'old_hash', oldUrl: 'https://cdn/old.jpg', requestedUrl: 'https://cdn/new.jpg' };
    const hashGiven = { oldHash: 'old_hash', requestedHash: 'new_hash' };

    it('is unreadable when the read-back failed', () => {
      expect(judgeImageSwap(urlOnly, undefined)).toBe('unreadable');
    });

    it('confirms the requested hash and flags any other hash as stale', () => {
      expect(judgeImageSwap(hashGiven, { hash: 'new_hash' })).toBe('confirmed');
      expect(judgeImageSwap(hashGiven, { hash: 'old_hash' })).toBe('stale');
    });

    it('treats the old hash as stale and a fresh hash as confirmed on a URL-only swap', () => {
      expect(judgeImageSwap(urlOnly, { hash: 'old_hash' })).toBe('stale');
      expect(judgeImageSwap(urlOnly, { hash: 'fresh_hash' })).toBe('confirmed');
    });

    it('falls back to the image URL when the read-back carries no hash', () => {
      expect(judgeImageSwap(urlOnly, { url: 'https://cdn/new.jpg' })).toBe('confirmed');
      expect(judgeImageSwap(urlOnly, { url: 'https://cdn/old.jpg' })).toBe('stale');
    });

    it('treats the exact old URL as stale when a hash swap reads back no hash', () => {
      const hashWithOldUrl = { ...hashGiven, oldUrl: 'https://cdn/old.jpg' };
      expect(judgeImageSwap(hashWithOldUrl, { url: 'https://cdn/old.jpg' })).toBe('stale');
      // The hash still decides when it is present, whatever the URL says.
      expect(judgeImageSwap(hashWithOldUrl, { hash: 'new_hash', url: 'https://cdn/old.jpg' })).toBe('confirmed');
    });

    it('is unconfirmed when the read-back identifies no image', () => {
      expect(judgeImageSwap(urlOnly, {})).toBe('unconfirmed');
      expect(judgeImageSwap(urlOnly, { url: 'https://fbcdn/other.jpg' })).toBe('unconfirmed');
      expect(judgeImageSwap(hashGiven, { url: 'https://fbcdn/other.jpg' })).toBe('unconfirmed');
    });
  });

  describe('selectSwapImageHash', () => {
    it('uses the requested hash when given', () => {
      expect(selectSwapImageHash('new_hash', 'https://cdn/new.jpg', 'old_hash')).toBe('new_hash');
    });

    it('drops the current hash when only a new image URL is requested', () => {
      expect(selectSwapImageHash(undefined, 'https://cdn/new.jpg', 'old_hash')).toBeUndefined();
    });

    it('keeps the current hash when no new image is requested', () => {
      expect(selectSwapImageHash(undefined, undefined, 'old_hash')).toBe('old_hash');
    });
  });
});
