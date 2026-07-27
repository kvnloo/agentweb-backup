import {
  collectMediaGeneratedSince,
  buildTimeoutContinuationMessage,
} from '../utils/timeoutContinuation';

describe('collectMediaGeneratedSince', () => {
  // Turn began at 06:47 (matches the real ENG-510 prod incident window).
  const turnStart = Date.parse('2026-07-24T06:47:00Z');
  const marker = (iso: string, url = 'https://s3/img.png', filename = 'img.png') => ({
    metadata: { kind: 'image-generated', imageUrl: url, imageFilename: filename, timestamp: iso },
  });

  it('returns [] for non-array input', () => {
    expect(collectMediaGeneratedSince(undefined, turnStart)).toEqual([]);
    expect(collectMediaGeneratedSince(null, turnStart)).toEqual([]);
  });

  it('ignores markers persisted before the turn started (prior turns)', () => {
    expect(collectMediaGeneratedSince([marker('2026-07-24T06:40:00Z')], turnStart)).toEqual([]);
  });

  it('ignores non-image markers, URL-less markers, and malformed messages', () => {
    const msgs = [
      { metadata: { kind: 'image-generated', timestamp: '2026-07-24T06:54:00Z' } }, // no imageUrl
      { metadata: { kind: 'other', imageUrl: 'x', timestamp: '2026-07-24T06:54:00Z' } }, // wrong kind
      { metadata: null },
      {},
    ];
    expect(collectMediaGeneratedSince(msgs, turnStart)).toEqual([]);
  });

  it('collects markers at/after turn start, prefers message.timestamp, and URL-dedupes', () => {
    const msgs = [
      marker('2026-07-24T06:54:00Z', 'https://s3/v1.png', 'v1.png'), // after → kept
      // message.timestamp present (preferred over metadata.timestamp)
      {
        timestamp: '2026-07-24T06:58:00Z',
        metadata: { kind: 'image-generated', imageUrl: 'https://s3/v2.png', imageFilename: 'v2.png', timestamp: '2026-07-24T06:40:00Z' },
      },
      marker('2026-07-24T06:59:00Z', 'https://s3/v1.png', 'v1-dup.png'), // dup URL → dropped
      marker('2026-07-24T06:40:00Z', 'https://s3/old.png'), // before → excluded
    ];
    expect(collectMediaGeneratedSince(msgs, turnStart)).toEqual([
      { imageUrl: 'https://s3/v1.png', filename: 'v1.png' },
      { imageUrl: 'https://s3/v2.png', filename: 'v2.png' },
    ]);
  });

  it('falls back to a default filename when the marker omits one', () => {
    const msgs = [{ metadata: { kind: 'image-generated', imageUrl: 'https://s3/x.png', timestamp: '2026-07-24T06:54:00Z' } }];
    expect(collectMediaGeneratedSince(msgs, turnStart)).toEqual([
      { imageUrl: 'https://s3/x.png', filename: 'generated-image.png' },
    ]);
  });
});

describe('buildTimeoutContinuationMessage', () => {
  it('returns null when no media was delivered this turn', () => {
    expect(buildTimeoutContinuationMessage([])).toBeNull();
    expect(buildTimeoutContinuationMessage(undefined)).toBeNull();
    expect(buildTimeoutContinuationMessage(null)).toBeNull();
  });

  it('embeds a single image inline (markdown) and invites "continue"', () => {
    const msg = buildTimeoutContinuationMessage([{ imageUrl: 'https://s3/v1.png', filename: 'v1.png' }])!;
    expect(msg).toContain('1 image ');
    expect(msg).not.toContain('1 images');
    expect(msg).toContain('here it is');
    expect(msg).toContain('![v1.png](https://s3/v1.png)'); // renders inline → user actually gets it
    expect(msg.toLowerCase()).toContain('continue');
  });

  it('embeds every completed image so partial work is delivered even if the rest fail', () => {
    const msg = buildTimeoutContinuationMessage([
      { imageUrl: 'https://s3/v1.png', filename: 'v1.png' },
      { imageUrl: 'https://s3/v2.png', filename: 'v2.png' },
    ])!;
    expect(msg).toContain('2 images');
    expect(msg).toContain('here they are');
    expect(msg).toContain('![v1.png](https://s3/v1.png)');
    expect(msg).toContain('![v2.png](https://s3/v2.png)');
  });
});
