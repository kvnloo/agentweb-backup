/**
 * ENG-2193 (ENG-2128 B): OCR text-ratio/legibility, spelling, brand-colour, logo-presence and
 * policy-keyword checks.
 *
 * Style matches creativeGates.test.ts: fixtures rendered with sharp in-process (no binary
 * files in git), pure `evaluate*` functions exhaustively tested against hand-built
 * measurements, and the IO-performing `measure*` functions exercised either for real (spelling,
 * palette, logo match — all fully offline, no network) or against a mocked `tesseract.js` (OCR
 * needs a real network fetch for language data, which would make this suite flaky/slow).
 */
import sharp from 'sharp';
import type { CreativeGateCheck } from '../services/creativeGates';
import {
  buildBrandProfile,
  evaluateBrandColourCheck,
  evaluateLogoPresenceCheck,
  evaluateOcrChecks,
  evaluatePolicyKeywordCheck,
  evaluateSpellingCheck,
  measureLogoMatch,
  measureOcr,
  measurePalette,
  measureSpelling,
  runCreativeContentChecks,
  type OcrMeasurement,
  type PaletteMeasurement,
  type SpellingMeasurement,
} from '../services/creativeContentChecks';

function checkFor(checks: CreativeGateCheck[], id: CreativeGateCheck['id']): CreativeGateCheck | undefined {
  return checks.find((c) => c.id === id);
}

async function solidPng(width: number, height: number, background: sharp.Color): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

// -------------------------------------------------------------------------------------------
// OCR
// -------------------------------------------------------------------------------------------

describe('evaluateOcrChecks (pure)', () => {
  it('skips both checks when OCR could not run', () => {
    const checks = evaluateOcrChecks(undefined);
    expect(checks).toEqual([
      { id: 'ocr_text_ratio', status: 'skipped', reason: 'OCR could not run on this image' },
      { id: 'ocr_legibility', status: 'skipped', reason: 'OCR could not run on this image' },
    ]);
  });

  it('skips both checks when no text was detected', () => {
    const m: OcrMeasurement = { text: '   ', confidence: 0, textAreaRatio: 0 };
    const checks = evaluateOcrChecks(m);
    expect(checks.every((c) => c.status === 'skipped')).toBe(true);
  });

  it('passes both checks for normal text coverage and high confidence', () => {
    const m: OcrMeasurement = { text: 'Shop the sale', confidence: 92, textAreaRatio: 0.1 };
    const checks = evaluateOcrChecks(m);
    expect(checks).toEqual([
      { id: 'ocr_text_ratio', status: 'pass' },
      { id: 'ocr_legibility', status: 'pass' },
    ]);
  });

  it('fails text_ratio when text covers over half the image', () => {
    const m: OcrMeasurement = { text: 'Wall of text', confidence: 90, textAreaRatio: 0.7 };
    const checks = evaluateOcrChecks(m);
    expect(checkFor(checks, 'ocr_text_ratio')).toMatchObject({ status: 'fail' });
    expect(checkFor(checks, 'ocr_text_ratio')?.reason).toContain('70%');
    expect(checkFor(checks, 'ocr_legibility')).toMatchObject({ status: 'pass' });
  });

  it('fails legibility when OCR confidence is low', () => {
    const m: OcrMeasurement = { text: 'blurry text', confidence: 30, textAreaRatio: 0.1 };
    const checks = evaluateOcrChecks(m);
    expect(checkFor(checks, 'ocr_legibility')).toMatchObject({ status: 'fail' });
    expect(checkFor(checks, 'ocr_legibility')?.reason).toContain('30');
  });
});

describe('measureOcr (IO wrapper, tesseract.js mocked)', () => {
  it('never calls tesseract when width/height are missing', async () => {
    const buffer = Buffer.from('not-an-image');
    const result = await measureOcr(buffer, undefined, undefined);
    expect(result).toBeUndefined();
  });

  it('maps word bounding boxes to a text-area ratio and passes through confidence', async () => {
    jest.resetModules();
    const recognize = jest.fn().mockResolvedValue({
      data: {
        text: 'HI',
        confidence: 88,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    words: [
                      { bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }, // 100 px^2
                      { bbox: { x0: 10, y0: 0, x1: 20, y1: 10 } }, // 100 px^2
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const terminate = jest.fn().mockResolvedValue(undefined);
    const createWorker = jest.fn().mockResolvedValue({ recognize, terminate });
    jest.doMock('tesseract.js', () => ({ createWorker }));

    const { measureOcr: measureOcrMocked } = await import('../services/creativeContentChecks');
    const result = await measureOcrMocked(Buffer.from('fake-png-bytes'), 100, 20); // 2000 px^2 total
    expect(createWorker).toHaveBeenCalledWith('eng');
    expect(result).toEqual({ text: 'HI', confidence: 88, textAreaRatio: 0.1 }); // 200/2000
    expect(terminate).toHaveBeenCalled();
    jest.dontMock('tesseract.js');
    jest.resetModules();
  });

  it('returns undefined (never throws) when the worker fails to init', async () => {
    jest.resetModules();
    const createWorker = jest.fn().mockRejectedValue(new Error('no network'));
    jest.doMock('tesseract.js', () => ({ createWorker }));

    const { measureOcr: measureOcrMocked } = await import('../services/creativeContentChecks');
    const result = await measureOcrMocked(Buffer.from('fake-png-bytes'), 100, 100);
    expect(result).toBeUndefined();
    jest.dontMock('tesseract.js');
    jest.resetModules();
  });
});

// -------------------------------------------------------------------------------------------
// Spelling — real nspell + dictionary-en, fully offline
// -------------------------------------------------------------------------------------------

describe('measureSpelling + evaluateSpellingCheck (real dictionary)', () => {
  it('returns undefined for empty text (check reads as skipped)', async () => {
    const measurement = await measureSpelling('', []);
    expect(measurement).toBeUndefined();
    expect(evaluateSpellingCheck(measurement)).toEqual({
      id: 'spelling',
      status: 'skipped',
      reason: 'no text available to spell-check',
    });
  });

  it('passes clean, correctly-spelled ad copy', async () => {
    const measurement = await measureSpelling('Shop the biggest sale of the year today', []);
    expect(evaluateSpellingCheck(measurement)).toEqual({ id: 'spelling', status: 'pass' });
  });

  it('flags a genuinely misspelled word', async () => {
    // "recieve" is a classic misspelling of "receive" — a real dictionary lookup, not a stub.
    const measurement = await measureSpelling('Recieve your discount today', []);
    const check = evaluateSpellingCheck(measurement);
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('Recieve');
  });

  it('allow-lists brand vocabulary instead of flagging it as misspelled', async () => {
    const withoutAllowList = evaluateSpellingCheck(await measureSpelling('Try Zorbnax today', []));
    expect(withoutAllowList.status).toBe('fail');

    const withAllowList = evaluateSpellingCheck(
      await measureSpelling('Try Zorbnax today', ['zorbnax']),
    );
    expect(withAllowList).toEqual({ id: 'spelling', status: 'pass' });
  });

  it('treats a not-in-dictionary word as skipped when it is the only word (all filtered)', () => {
    const m: SpellingMeasurement = { misspelled: [], checkedWordCount: 0 };
    expect(evaluateSpellingCheck(m)).toEqual({
      id: 'spelling',
      status: 'skipped',
      reason: 'no dictionary-checkable words found',
    });
  });
});

// -------------------------------------------------------------------------------------------
// Brand colour
// -------------------------------------------------------------------------------------------

describe('evaluateBrandColourCheck (pure)', () => {
  it('skips when the brand has no colours on file', () => {
    const m: PaletteMeasurement = { dominant: [{ r: 255, g: 0, b: 0 }] };
    expect(evaluateBrandColourCheck(m, [])).toEqual({
      id: 'brand_colour',
      status: 'skipped',
      reason: 'no brand colours on file',
    });
  });

  it('skips when the palette could not be measured', () => {
    expect(evaluateBrandColourCheck(undefined, ['#ff0000'])).toMatchObject({
      id: 'brand_colour',
      status: 'skipped',
    });
  });

  it('passes when a dominant colour is close to the brand palette', () => {
    const m: PaletteMeasurement = { dominant: [{ r: 250, g: 5, b: 5 }] };
    expect(evaluateBrandColourCheck(m, ['#ff0000'])).toEqual({ id: 'brand_colour', status: 'pass' });
  });

  it('fails when no dominant colour is close to the brand palette', () => {
    const m: PaletteMeasurement = { dominant: [{ r: 10, g: 200, b: 10 }] }; // green
    const check = evaluateBrandColourCheck(m, ['#0000ff']); // brand is blue
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('closest distance');
  });
});

describe('measurePalette (real sharp)', () => {
  it('finds a solid fill colour as the dominant colour', async () => {
    const buffer = await solidPng(40, 40, { r: 200, g: 20, b: 20, alpha: 1 });
    const measurement = await measurePalette(buffer);
    expect(measurement?.dominant.length).toBeGreaterThan(0);
    // Quantized to 16-value buckets — 200/20/20 should round down to 192/16/16.
    expect(measurement?.dominant[0]).toMatchObject({ r: 192, g: 16, b: 16 });
  });

  it('returns undefined for undecodable bytes', async () => {
    const measurement = await measurePalette(Buffer.from('not an image'));
    expect(measurement).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------
// Logo presence
// -------------------------------------------------------------------------------------------

describe('evaluateLogoPresenceCheck (pure)', () => {
  it('skips when there is no logo on file', () => {
    expect(evaluateLogoPresenceCheck(undefined, false)).toEqual({
      id: 'logo_presence',
      status: 'skipped',
      reason: 'no persisted brand logo on file',
    });
  });

  it('skips when the match could not run', () => {
    expect(evaluateLogoPresenceCheck(undefined, true)).toMatchObject({
      id: 'logo_presence',
      status: 'skipped',
    });
  });

  it('passes above the score threshold', () => {
    expect(evaluateLogoPresenceCheck({ bestScore: 0.9 }, true)).toEqual({
      id: 'logo_presence',
      status: 'pass',
      reason: 'best match score 0.90',
    });
  });

  it('fails below the score threshold', () => {
    const check = evaluateLogoPresenceCheck({ bestScore: 0.1 }, true);
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('0.10');
  });
});

describe('measureLogoMatch (real sharp fixtures)', () => {
  /** A smooth, non-periodic 48x48 pattern — resized cleanly under nearest-neighbour and
   *  distinguishable from a flat/degenerate template (zero variance would auto-fail). */
  async function gradientBlock(size: number): Promise<Buffer> {
    const channels = 3;
    const raw = Buffer.alloc(size * size * channels);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * channels;
        const v = Math.floor(((x + y) / (2 * size)) * 255);
        raw[i] = v;
        raw[i + 1] = 255 - v;
        raw[i + 2] = (x * y) % 256;
      }
    }
    return sharp(raw, { raw: { width: size, height: size, channels } }).png().toBuffer();
  }

  it('scores a real match much higher than an unrelated image', async () => {
    const logo = await gradientBlock(48);
    // Paste the exact same 48x48 logo onto a plain background — the scale=1 template
    // candidate (48px) then matches this region near-exactly.
    const creativeWithLogo = await sharp({
      create: { width: 240, height: 240, channels: 4, background: { r: 235, g: 235, b: 235, alpha: 1 } },
    })
      .composite([{ input: logo, left: 96, top: 96 }])
      .png()
      .toBuffer();

    const unrelatedCreative = await solidPng(240, 240, { r: 235, g: 235, b: 235, alpha: 1 });

    const matchResult = await measureLogoMatch(creativeWithLogo, logo);
    const noMatchResult = await measureLogoMatch(unrelatedCreative, logo);

    expect(matchResult?.bestScore).toBeGreaterThanOrEqual(0.9);
    // A flat creative has zero variance everywhere -> every correlation is the -1 sentinel.
    expect(noMatchResult?.bestScore).toBeLessThan(0.55);
    expect(matchResult!.bestScore).toBeGreaterThan(noMatchResult!.bestScore);

    // And the evaluate layer turns that into pass/fail exactly as expected (red->green proof
    // for the whole measure+evaluate pipeline, not just the pure function in isolation).
    expect(evaluateLogoPresenceCheck(matchResult, true).status).toBe('pass');
    expect(evaluateLogoPresenceCheck(noMatchResult, true).status).toBe('fail');
  });

  it('returns undefined for a degenerate (too-small) logo', async () => {
    const tinyLogo = await solidPng(2, 2, { r: 0, g: 0, b: 0, alpha: 1 });
    const creative = await solidPng(240, 240, { r: 235, g: 235, b: 235, alpha: 1 });
    const result = await measureLogoMatch(creative, tinyLogo);
    expect(result).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------
// Policy keywords
// -------------------------------------------------------------------------------------------

describe('evaluatePolicyKeywordCheck (pure)', () => {
  it('skips when there is no text', () => {
    expect(evaluatePolicyKeywordCheck(undefined)).toEqual({
      id: 'policy_keywords',
      status: 'skipped',
      reason: 'no text available to check',
    });
    expect(evaluatePolicyKeywordCheck('   ').status).toBe('skipped');
  });

  it('passes ordinary ad copy', () => {
    expect(evaluatePolicyKeywordCheck('Shop our new summer collection today')).toEqual({
      id: 'policy_keywords',
      status: 'pass',
    });
  });

  it('flags a health-claims phrase', () => {
    const check = evaluatePolicyKeywordCheck('Our miracle cure guaranteed results overnight');
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('health claims');
  });

  it('flags a before/after phrase', () => {
    expect(evaluatePolicyKeywordCheck('See the amazing before and after').reason).toContain(
      'before/after imagery claims',
    );
  });

  it('flags a financial-claims phrase', () => {
    expect(evaluatePolicyKeywordCheck('Guaranteed returns, no risk investment').reason).toContain(
      'financial claims',
    );
  });

  it('lists every matched category when more than one applies', () => {
    const check = evaluatePolicyKeywordCheck('Guaranteed weight loss AND guaranteed returns');
    expect(check.status).toBe('fail');
    expect(check.reason).toContain('health claims');
    expect(check.reason).toContain('financial claims');
  });
});

// -------------------------------------------------------------------------------------------
// buildBrandProfile
// -------------------------------------------------------------------------------------------

describe('buildBrandProfile', () => {
  it('returns empty profile for undefined brand data', () => {
    expect(buildBrandProfile(undefined)).toEqual({ colours: [], vocabulary: [] });
  });

  it('collects colours and a lower-cased, deduped vocabulary', () => {
    const profile = buildBrandProfile({
      brandName: 'Acme Rockets',
      tagline: 'To the Moon',
      primaryColor: '#112233',
      primaryColorEnd: '#445566',
      secondaryColor: '#778899',
      keyMessages: ['Fast delivery', 'Acme cares'],
      brandValues: ['Speed'],
      founders: [{ name: 'Wile E Coyote' }],
    });
    expect(profile.colours).toEqual(['#112233', '#445566', '#778899']);
    expect(profile.vocabulary).toEqual(
      expect.arrayContaining(['acme', 'rockets', 'moon', 'fast', 'delivery', 'cares', 'speed', 'wile', 'coyote']),
    );
    // "acme" appears twice across brandName and keyMessages — deduped.
    expect(profile.vocabulary.filter((w) => w === 'acme')).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------
// Orchestrator
// -------------------------------------------------------------------------------------------

describe('runCreativeContentChecks', () => {
  it('returns all six checks in a stable order, and honours the brand allow-list', async () => {
    const buffer = await solidPng(40, 40, { r: 200, g: 20, b: 20, alpha: 1 });
    const checks = await runCreativeContentChecks({
      buffer,
      // No width/height -> measureOcr short-circuits without touching tesseract.js, keeping
      // this test hermetic and fast while still exercising the other four checks together.
      adCopyText: 'Recieve our miracle cure today from Acme',
      brand: { colours: ['#ff0000'], vocabulary: ['acme'] },
    });

    expect(checks.map((c) => c.id)).toEqual([
      'ocr_text_ratio',
      'ocr_legibility',
      'spelling',
      'brand_colour',
      'logo_presence',
      'policy_keywords',
    ]);
    expect(checkFor(checks, 'ocr_text_ratio')?.status).toBe('skipped');
    expect(checkFor(checks, 'spelling')?.status).toBe('fail');
    expect(checkFor(checks, 'spelling')?.reason).toContain('Recieve');
    expect(checkFor(checks, 'spelling')?.reason).not.toContain('acme'); // allow-listed
    expect(checkFor(checks, 'brand_colour')?.status).toBe('pass');
    expect(checkFor(checks, 'logo_presence')).toEqual({
      id: 'logo_presence',
      status: 'skipped',
      reason: 'no persisted brand logo on file',
    });
    expect(checkFor(checks, 'policy_keywords')?.status).toBe('fail');
    expect(checkFor(checks, 'policy_keywords')?.reason).toContain('health claims');
  });
});
