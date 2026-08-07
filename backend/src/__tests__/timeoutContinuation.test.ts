import {
  collectMediaGeneratedSince,
  buildTimeoutContinuationMessage,
  buildEmptyMediaTimeoutMessage,
  buildMediaBudgetDeferralMessage,
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

  it('skips null/undefined message entries and markers with no timestamp at all', () => {
    const msgs = [
      null,
      undefined,
      // valid image-generated marker but NO timestamp anywhere → Date.parse gets nothing
      // (rawTs falsy → NaN → not finite) so it is excluded rather than counted.
      { metadata: { kind: 'image-generated', imageUrl: 'https://s3/no-ts.png', imageFilename: 'x.png' } },
    ];
    expect(collectMediaGeneratedSince(msgs as any, turnStart)).toEqual([]);
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

describe('buildEmptyMediaTimeoutMessage (ENG-922)', () => {
  it('reports a four-image batch that timed out before any asset finished', () => {
    const msg = buildEmptyMediaTimeoutMessage([
      'generate_image',
      'generate_image',
      'generate_image',
      'generate_image',
    ]);

    expect(msg).toContain('before any images finished');
    expect(msg).toContain('4 images still remain');
    expect(msg).toContain('nothing from it to upload or use in a creative or ad');
  });

  it('uses singular remaining-work copy for one pending image', () => {
    const msg = buildEmptyMediaTimeoutMessage(['generate_image']);
    expect(msg).toContain('1 image still remains');
    expect(msg).not.toContain('1 images');
  });

  it('does not mislabel a non-media timeout as an image-generation failure', () => {
    expect(buildEmptyMediaTimeoutMessage(['search_web', 'create_blog_article'])).toBeNull();
    expect(buildEmptyMediaTimeoutMessage(undefined)).toBeNull();
  });

  it('covers video and voiceover timeouts, and falls back to neutral wording when mixed', () => {
    expect(buildEmptyMediaTimeoutMessage(['generate_video'])).toContain('1 video still remains');
    expect(buildEmptyMediaTimeoutMessage(['generate_voiceover', 'generate_voiceover']))
      .toContain('2 voiceovers still remain');
    expect(buildEmptyMediaTimeoutMessage(['generate_image', 'generate_video']))
      .toContain('2 assets still remain');
  });
});

describe('buildMediaBudgetDeferralMessage (ENG-922)', () => {
  const deferred = (name: string) => ({
    name,
    result: { deferred: true, reason: 'media_generation_time_budget' },
  });
  const doneImage = (filename: string) => ({
    name: 'generate_image',
    result: { imageUrl: `https://s3/${filename}`, filename },
  });

  it('delivers completed images inline and states the exact remaining count', () => {
    const msg = buildMediaBudgetDeferralMessage([
      doneImage('v1.png'),
      doneImage('v2.png'),
      doneImage('v3.png'),
      deferred('generate_image'),
    ]);

    expect(msg).toContain('I generated and saved 3 images so far');
    expect(msg).toContain('![v1.png](https://s3/v1.png)');
    expect(msg).toContain('1 image still remains');
  });

  it('still delivers completed images when the deferred call is a video, not an image', () => {
    // Regression: counting only generate_image returned null here, dropping the caller
    // into a canned string that lost the finished images entirely.
    const msg = buildMediaBudgetDeferralMessage([
      doneImage('v1.png'),
      deferred('generate_video'),
    ]);

    expect(msg).not.toBeNull();
    expect(msg).toContain('![v1.png](https://s3/v1.png)');
    expect(msg).toContain('1 video still remains');
  });

  it('does not claim the whole turn published nothing — only that it paused here', () => {
    // The loop can only guarantee that NOTHING FURTHER ran after this pause; an earlier
    // iteration in the same turn may already have published. The copy must not overclaim.
    const msg = buildMediaBudgetDeferralMessage([doneImage('v1.png'), deferred('generate_image')])!;

    expect(msg).toContain('I paused here rather than taking the incomplete set on to any further publishing step');
    expect(msg).not.toContain('was not published');
  });

  it('returns null when no media call was deferred for the time budget', () => {
    expect(buildMediaBudgetDeferralMessage([doneImage('v1.png')])).toBeNull();
    expect(buildMediaBudgetDeferralMessage([
      { name: 'call_meta_marketing_api', result: { deferred: true, reason: 'media_generation_time_budget' } },
    ])).toBeNull();
    expect(buildMediaBudgetDeferralMessage(undefined)).toBeNull();
  });
});
