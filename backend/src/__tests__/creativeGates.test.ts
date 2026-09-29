/**
 * ENG-2139 (ENG-2128 T7): creative deterministic gates and the placement spec table.
 *
 * Fixtures are rendered with sharp in-process (no binary files in git): a textured "clean"
 * image, a wrong-aspect render, a flat blank render, a fully transparent render and bytes that
 * are not an image. Oversize is exercised through the measurement, since a real 30 MB fixture
 * would only slow the suite down for the same comparison.
 */
import sharp from 'sharp';
import {
  BLANK_RENDER_MAX_STDDEV,
  CREATIVE_GATES_GRADER_ID,
  evaluateCreativeGates,
  measureImage,
  notCheckedGateResult,
  parseCreativeGateResult,
  runCreativeGates,
  type CreativeGateCheckId,
  type CreativeGateResult,
} from '../services/creativeGates';
import {
  PLACEMENT_SPECS,
  metaPlacementForAspect,
  placementForSize,
  resolveGeminiAspectRatio,
} from '../services/creativePlacementSpecs';

/** Deterministic textured PNG — stands in for a real ad (edges, varied luminance). */
async function texturedPng(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const band = Math.floor(y / 40) % 2 === 0 ? 40 : 210;
      raw[i] = band;
      raw[i + 1] = (x * 255) / width;
      raw[i + 2] = (y * 255) / height;
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

async function solidPng(width: number, height: number, background: sharp.Color): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

function status(result: CreativeGateResult, id: CreativeGateCheckId): string | undefined {
  return result.checks.find((c) => c.id === id)?.status;
}

describe('placement spec table', () => {
  it('has story/reel at 9:16 1080x1920 and the 4:5 feed portrait at 1080x1350', () => {
    expect(PLACEMENT_SPECS.meta_story_reel).toMatchObject({ width: 1080, height: 1920 });
    expect(PLACEMENT_SPECS.meta_feed_portrait).toMatchObject({ width: 1080, height: 1350 });
    expect(placementForSize('1080x1350')?.id).toBe('meta_feed_portrait');
    expect(placementForSize('1080x1920')?.id).toBe('meta_story_reel');
    expect(placementForSize('1080x1080')?.id).toBe('meta_feed_square');
    expect(placementForSize('1200x628')?.id).toBe('google_marketing_image');
    expect(placementForSize('1024x1024')).toBeUndefined();
    expect(placementForSize('4:5')).toBeUndefined();
  });
});

describe('metaPlacementForAspect (ENG-2187)', () => {
  it('maps the Meta ratios to their placement and nothing else', () => {
    expect(metaPlacementForAspect(1)?.id).toBe('meta_feed_square');
    expect(metaPlacementForAspect(4 / 5)?.id).toBe('meta_feed_portrait');
    expect(metaPlacementForAspect(9 / 16)?.id).toBe('meta_story_reel');
    expect(metaPlacementForAspect(1200 / 628)).toBeUndefined();
    expect(metaPlacementForAspect(3 / 4)).toBeUndefined();
    expect(metaPlacementForAspect(16 / 9)).toBeUndefined();
    expect(metaPlacementForAspect(null)).toBeUndefined();
  });
});

describe('resolveGeminiAspectRatio', () => {
  it('keeps the size → Gemini aspect mapping imageGeneration has always used', () => {
    const expected: Record<string, string> = {
      auto: '1:1',
      '1:1': '1:1',
      '9:16': '9:16',
      '4:5': '4:5',
      '1024x1024': '1:1',
      '1080x1920': '9:16',
      '1080x1350': '4:5',
      '1536x1024': '3:2',
      '1024x1536': '2:3',
      '1920x1080': '16:9',
      '2560x1080': '21:9',
      '1200x628': '16:9',
      '7:3': '1:1',
      'large': '1:1',
    };
    for (const [size, ratio] of Object.entries(expected)) {
      expect({ size, ratio: resolveGeminiAspectRatio(size).aspectRatio }).toEqual({ size, ratio });
    }
    expect(resolveGeminiAspectRatio(undefined).aspectRatio).toBe('1:1');
  });

  it('reports the silent substitutions and nothing else', () => {
    expect(resolveGeminiAspectRatio('7:3').fallback).toBe('unsupported_ratio');
    expect(resolveGeminiAspectRatio('large').fallback).toBe('unparseable_size');
    expect(resolveGeminiAspectRatio('1200x628').fallback).toBe('nearest_ratio');
    for (const size of [undefined, 'auto', '4:5', '1080x1350', '1080x1920', '1024x1024']) {
      expect({ size, fallback: resolveGeminiAspectRatio(size).fallback }).toEqual({ size, fallback: undefined });
    }
  });
});

describe('runCreativeGates', () => {
  it('passes a clean render at the requested placement', async () => {
    const result = await runCreativeGates(await texturedPng(1080, 1350), {
      requestedSize: '1080x1350',
      aspectResolution: resolveGeminiAspectRatio('1080x1350'),
    });

    expect(result).toMatchObject({
      graderId: CREATIVE_GATES_GRADER_ID,
      advisory: true,
      passed: true,
      placement: 'meta_feed_portrait',
      width: 1080,
      height: 1350,
      format: 'png',
    });
    expect(result.checks.map((c) => [c.id, c.status])).toEqual([
      ['decode', 'pass'],
      ['blank_render', 'pass'],
      ['aspect_ratio', 'pass'],
      ['dimensions', 'pass'],
      ['file_size', 'pass'],
      ['aspect_fallback', 'pass'],
    ]);
    expect(result.fitsPlacements).toEqual(['meta_feed_portrait']);
  });

  it('fails the aspect check when a 4:5 portrait came back square (the silent 1:1 fallback)', async () => {
    const result = await runCreativeGates(await texturedPng(1024, 1024), { requestedSize: '1080x1350' });

    expect(result.passed).toBe(false);
    expect(status(result, 'aspect_ratio')).toBe('fail');
    expect(result.checks.find((c) => c.id === 'aspect_ratio')?.reason).toContain('1024x1024');
    expect(status(result, 'decode')).toBe('pass');
    expect(result.fitsPlacements).toEqual(['meta_feed_square', 'google_square_marketing_image']);
  });

  it('holds a bare ratio request against the matching Meta placement (ENG-2187)', async () => {
    const result = await runCreativeGates(await texturedPng(1200, 900), { requestedSize: '9:16' });

    expect(result).toMatchObject({ placement: 'meta_story_reel', placementSource: 'ratio' });
    expect(status(result, 'aspect_ratio')).toBe('fail');
    expect(status(result, 'dimensions')).toBe('pass');
    expect(status(result, 'file_size')).toBe('pass');
  });

  it('reports dimensions and file_size for the 1:1 agent-mode request, not skipped (ENG-2187)', async () => {
    const ok = await runCreativeGates(await texturedPng(1024, 1024), { requestedSize: '1:1' });
    const small = await runCreativeGates(await texturedPng(512, 512), { requestedSize: '1024x1024' });

    expect(ok).toMatchObject({ placement: 'meta_feed_square', placementSource: 'ratio', passed: true });
    expect(status(ok, 'dimensions')).toBe('pass');
    expect(status(ok, 'file_size')).toBe('pass');
    expect(small.placement).toBe('meta_feed_square');
    expect(status(small, 'dimensions')).toBe('fail');
    expect(small.checks.find((c) => c.id === 'dimensions')?.reason).toContain('600x600');
  });

  it('still skips the size checks, with the ratio as the reason, when no Meta placement uses it', async () => {
    const result = await runCreativeGates(await texturedPng(1600, 900), { requestedSize: '16:9' });

    expect(result.placement).toBeUndefined();
    expect(status(result, 'aspect_ratio')).toBe('pass');
    expect(result.checks.find((c) => c.id === 'dimensions')).toMatchObject({
      status: 'skipped',
      reason: 'no Meta placement uses the requested ratio "16:9"',
    });
    expect(status(result, 'file_size')).toBe('skipped');
  });

  it('flags a provider-side aspect substitution even before looking at the pixels', async () => {
    const result = await runCreativeGates(await texturedPng(1200, 675), {
      requestedSize: '1200x628',
      aspectResolution: resolveGeminiAspectRatio('1200x628'),
    });

    expect(status(result, 'aspect_fallback')).toBe('fail');
    expect(result.checks.find((c) => c.id === 'aspect_fallback')?.reason).toContain('16:9');
    expect(status(result, 'aspect_ratio')).toBe('fail');
  });

  it('fails a blank (flat white) render as broken', async () => {
    const result = await runCreativeGates(await solidPng(1080, 1080, '#ffffff'), { requestedSize: '1080x1080' });

    expect(result.passed).toBe(false);
    expect(status(result, 'blank_render')).toBe('fail');
    expect(status(result, 'aspect_ratio')).toBe('pass');
  });

  it('fails a fully transparent render as broken', async () => {
    const result = await runCreativeGates(await solidPng(1080, 1080, { r: 0, g: 0, b: 0, alpha: 0 }));

    expect(status(result, 'blank_render')).toBe('fail');
  });

  it('fails bytes that do not decode, and skips the checks that need pixels', async () => {
    const png = await texturedPng(200, 200);
    const result = await runCreativeGates(png.subarray(0, 60), { requestedSize: '1080x1080' });

    expect(result.passed).toBe(false);
    expect(status(result, 'decode')).toBe('fail');
    expect(status(result, 'blank_render')).toBe('skipped');
    expect(status(result, 'aspect_ratio')).toBe('skipped');
    expect(status(result, 'dimensions')).toBe('skipped');
    expect(result.fitsPlacements).toEqual([]);
    expect(result.width).toBeUndefined();
  });

  it('fails the minimum-size check for an undersized placement render', async () => {
    const result = await runCreativeGates(await texturedPng(400, 500), { requestedSize: '1080x1350' });

    expect(status(result, 'aspect_ratio')).toBe('pass');
    expect(status(result, 'dimensions')).toBe('fail');
  });
});

describe('placement resolution order (ENG-2187)', () => {
  const measured = { bytes: 1000, decoded: true, width: 1200, height: 1200, format: 'png', luminanceStdDev: 50 };

  it('prefers the named placement, then an exact placement size, then the ratio', () => {
    expect(evaluateCreativeGates(measured, { requestedSize: '1:1', placement: 'google_square_marketing_image' }))
      .toMatchObject({ placement: 'google_square_marketing_image', placementSource: 'requested' });
    expect(evaluateCreativeGates(measured, { requestedSize: '1200x1200' }))
      .toMatchObject({ placement: 'google_square_marketing_image', placementSource: 'size' });
    expect(evaluateCreativeGates(measured, { requestedSize: '1:1' }))
      .toMatchObject({ placement: 'meta_feed_square', placementSource: 'ratio' });
  });
});

describe('notCheckedGateResult (ENG-2187)', () => {
  it('records every check as skipped with the reason instead of omitting the result', () => {
    const result = notCheckedGateResult({ requestedSize: '1:1' }, 'download failed');

    expect(result).toMatchObject({ notChecked: 'download failed', placement: 'meta_feed_square', passed: true, bytes: 0 });
    expect(result.checks.map((c) => c.id)).toEqual([
      'decode', 'blank_render', 'aspect_ratio', 'dimensions', 'file_size', 'aspect_fallback',
    ]);
    expect(result.checks.every((c) => c.status === 'skipped' && c.reason === 'download failed')).toBe(true);
  });
});

describe('parseCreativeGateResult (ENG-2187)', () => {
  it('round-trips a real result and rejects anything from another grader', () => {
    const real = evaluateCreativeGates(
      { bytes: 1000, decoded: true, width: 1080, height: 1350, format: 'png', luminanceStdDev: 50 },
      { requestedSize: '4:5' },
    );

    expect(parseCreativeGateResult(JSON.parse(JSON.stringify(real)))).toEqual(real);
    expect(parseCreativeGateResult({ ...real, graderId: 'other' })).toBeUndefined();
    expect(parseCreativeGateResult({ ...real, passed: 'yes' })).toBeUndefined();
    expect(parseCreativeGateResult('gates')).toBeUndefined();
  });
});

describe('evaluateCreativeGates', () => {
  it('fails an oversized file against the placement limit', async () => {
    const measured = await measureImage(await texturedPng(1200, 628));
    const google = PLACEMENT_SPECS.google_marketing_image;

    const atLimit = evaluateCreativeGates({ ...measured, bytes: google.maxBytes }, { requestedSize: '1200x628' });
    const over = evaluateCreativeGates({ ...measured, bytes: google.maxBytes + 1 }, { requestedSize: '1200x628' });

    expect(status(atLimit, 'file_size')).toBe('pass');
    expect(status(over, 'file_size')).toBe('fail');
    expect(over.passed).toBe(false);
    expect(over.fitsPlacements).not.toContain('google_marketing_image');
  });

  it('uses the blank-render threshold as a strict bound', () => {
    const base = { bytes: 1000, decoded: true, width: 1080, height: 1080, format: 'png' };
    expect(status(evaluateCreativeGates({ ...base, luminanceStdDev: BLANK_RENDER_MAX_STDDEV - 0.01 }), 'blank_render')).toBe('fail');
    expect(status(evaluateCreativeGates({ ...base, luminanceStdDev: BLANK_RENDER_MAX_STDDEV }), 'blank_render')).toBe('pass');
  });

  it('skips aspect and placement checks for an "auto" request', () => {
    const result = evaluateCreativeGates(
      { bytes: 1000, decoded: true, width: 1024, height: 1536, format: 'png', luminanceStdDev: 50 },
      { requestedSize: 'auto', aspectResolution: resolveGeminiAspectRatio('auto') },
    );

    expect(result.passed).toBe(true);
    expect(status(result, 'aspect_ratio')).toBe('skipped');
    expect(status(result, 'aspect_fallback')).toBe('pass');
  });
});

describe('evaluateCreativeGates blank_render skip reasons', () => {
  it('distinguishes an unmeasured luminance from a failed decode', () => {
    const unmeasured = evaluateCreativeGates({ bytes: 1000, decoded: true, width: 1080, height: 1080 });
    expect(unmeasured.checks.find((c) => c.id === 'blank_render'))
      .toEqual({ id: 'blank_render', status: 'skipped', reason: 'luminance could not be measured' });
    const undecoded = evaluateCreativeGates({ bytes: 1000, decoded: false });
    expect(undecoded.checks.find((c) => c.id === 'blank_render'))
      .toEqual({ id: 'blank_render', status: 'skipped', reason: 'image did not decode' });
  });
});
