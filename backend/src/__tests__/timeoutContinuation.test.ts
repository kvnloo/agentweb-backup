import {
  countMediaGeneratedSince,
  buildTimeoutContinuationMessage,
} from '../utils/timeoutContinuation';

describe('countMediaGeneratedSince', () => {
  // Turn began at 06:47 (matches the real ENG-510 prod incident window).
  const turnStart = Date.parse('2026-07-24T06:47:00Z');
  const marker = (iso: string, url = 'https://s3/img.png') => ({
    metadata: { kind: 'image-generated', imageUrl: url, timestamp: iso },
  });

  it('returns 0 for non-array input', () => {
    expect(countMediaGeneratedSince(undefined, turnStart)).toBe(0);
    expect(countMediaGeneratedSince(null, turnStart)).toBe(0);
  });

  it('ignores markers persisted before the turn started (prior turns)', () => {
    expect(countMediaGeneratedSince([marker('2026-07-24T06:40:00Z')], turnStart)).toBe(0);
  });

  it('ignores non-image markers, URL-less markers, and malformed messages', () => {
    const msgs = [
      { metadata: { kind: 'image-generated', timestamp: '2026-07-24T06:54:00Z' } }, // no imageUrl
      { metadata: { kind: 'other', imageUrl: 'x', timestamp: '2026-07-24T06:54:00Z' } }, // wrong kind
      { metadata: null },
      {},
    ];
    expect(countMediaGeneratedSince(msgs, turnStart)).toBe(0);
  });

  it('counts markers at or after the turn start and prefers message.timestamp', () => {
    const msgs = [
      marker('2026-07-24T06:54:00Z', 'https://s3/v1.png'), // after → counted
      // message.timestamp present (preferred over metadata.timestamp)
      {
        timestamp: '2026-07-24T06:58:00Z',
        metadata: { kind: 'image-generated', imageUrl: 'https://s3/v2.png', timestamp: '2026-07-24T06:40:00Z' },
      },
      marker('2026-07-24T06:40:00Z', 'https://s3/old.png'), // before → excluded
    ];
    expect(countMediaGeneratedSince(msgs, turnStart)).toBe(2);
  });
});

describe('buildTimeoutContinuationMessage', () => {
  it('returns null when no media was delivered this turn', () => {
    expect(buildTimeoutContinuationMessage(0)).toBeNull();
    expect(buildTimeoutContinuationMessage(-1)).toBeNull();
    expect(buildTimeoutContinuationMessage(Number.NaN)).toBeNull();
  });

  it('uses the singular noun for exactly one image and invites "continue"', () => {
    const msg = buildTimeoutContinuationMessage(1)!;
    expect(msg).toContain('1 image ');
    expect(msg).not.toContain('1 images');
    expect(msg.toLowerCase()).toContain('continue');
  });

  it('uses the plural noun for multiple images', () => {
    expect(buildTimeoutContinuationMessage(3)).toContain('3 images');
  });
});
