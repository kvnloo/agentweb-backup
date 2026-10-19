import {
  validateScheduledPostRequest,
  SCHEDULED_POST_CONTENT_LIMITS,
} from '../validateScheduledPostRequest';

const NOW = new Date('2026-10-16T12:00:00Z');
const clock = () => NOW;
const IMG = 'https://cdn.example.com/a.png';

function codes(input: unknown): string[] {
  const r = validateScheduledPostRequest(input, clock);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe('validateScheduledPostRequest (ENG-2507)', () => {
  it.each([
    ['x', { content: 'hello' }],
    ['linkedin', { content: 'hello', mediaUrls: [IMG] }],
    ['instagram', { content: 'hello', mediaUrls: [IMG] }],
  ])('accepts a valid %s request', (platform, extra) => {
    const r = validateScheduledPostRequest({ platform, publishAt: '2026-10-17T09:30:00-07:00', ...extra }, clock);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.platform).toBe(platform);
      expect(r.value.publishAt.toISOString()).toBe('2026-10-17T16:30:00.000Z');
    }
  });

  it('rejects non-object input without throwing', () => {
    expect(codes(null)).toEqual(['INVALID_REQUEST']);
    expect(codes([])).toEqual(['INVALID_REQUEST']);
  });

  it('rejects unsupported platforms', () => {
    expect(codes({ platform: 'youtube', publishAt: '2026-10-17T00:00:00Z', content: 'x' })).toEqual(['PLATFORM_UNSUPPORTED']);
  });

  it('rejects missing, unparseable, and timezone-less publishAt', () => {
    expect(codes({ platform: 'x', content: 'a' })).toEqual(['PUBLISH_AT_INVALID']);
    expect(codes({ platform: 'x', content: 'a', publishAt: 'tomorrow' })).toEqual(['PUBLISH_AT_INVALID']);
    expect(codes({ platform: 'x', content: 'a', publishAt: '2026-13-45T00:00:00Z' })).toEqual(['PUBLISH_AT_INVALID']);
    expect(codes({ platform: 'x', content: 'a', publishAt: '2026-10-17T09:00:00' })).toEqual(['PUBLISH_AT_MISSING_TIMEZONE']);
  });

  it('rejects past/now and beyond-horizon publishAt', () => {
    expect(codes({ platform: 'x', content: 'a', publishAt: '2026-10-16T12:00:00Z' })).toEqual(['PUBLISH_AT_NOT_FUTURE']);
    expect(codes({ platform: 'x', content: 'a', publishAt: '2026-10-15T12:00:00Z' })).toEqual(['PUBLISH_AT_NOT_FUTURE']);
    expect(codes({ platform: 'x', content: 'a', publishAt: '2027-01-15T12:00:00Z' })).toEqual(['PUBLISH_AT_BEYOND_HORIZON']);
    expect(codes({ platform: 'x', content: 'a', publishAt: '2027-01-14T12:00:00Z' })).toEqual([]);
  });

  it('rejects empty and over-limit content per platform', () => {
    const at = '2026-10-17T00:00:00Z';
    expect(codes({ platform: 'x', publishAt: at, content: '   ' })).toEqual(['CONTENT_EMPTY']);
    for (const [platform, limit] of Object.entries(SCHEDULED_POST_CONTENT_LIMITS)) {
      const mediaUrls = [IMG];
      expect(codes({ platform, publishAt: at, mediaUrls, content: 'a'.repeat(limit) })).toEqual([]);
      expect(codes({ platform, publishAt: at, mediaUrls, content: 'a'.repeat(limit + 1) })).toEqual(['CONTENT_TOO_LONG']);
    }
  });

  it('rejects malformed media and text-only Instagram', () => {
    const base = { platform: 'x', publishAt: '2026-10-17T00:00:00Z', content: 'a' };
    expect(codes({ ...base, mediaUrls: 'https://a.b/c.png' })).toEqual(['MEDIA_INVALID']);
    expect(codes({ ...base, mediaUrls: ['ftp://a.b/c.png'] })).toEqual(['MEDIA_INVALID']);
    expect(codes({ ...base, platform: 'instagram' })).toEqual(['MEDIA_REQUIRED']);
  });

  it('reports every failing field at once', () => {
    expect(codes({ platform: 'nope', publishAt: 'x', content: '' })).toEqual([
      'PLATFORM_UNSUPPORTED', 'PUBLISH_AT_INVALID', 'CONTENT_EMPTY',
    ]);
  });
});
