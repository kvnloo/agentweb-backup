// Functional tests for the real background-removal algorithm and the WCAG
// contrast/color helpers in ImageService. These use the REAL sharp library
// (no mock) so they actually prove a genuine transparent alpha channel is
// produced and the foreground artwork is preserved byte-for-byte.

import { ImageService } from '../services/imageGeneration';
import sharp from 'sharp';

describe('ImageService.removeImageBackground (real sharp)', () => {
  const imageService = new ImageService();

  /**
   * Build a width x height RGBA raw buffer painted with `bg`, then run the
   * provided painter to draw foreground pixels, and encode to a PNG buffer.
   */
  async function makePng(
    width: number,
    height: number,
    bg: { r: number; g: number; b: number },
    paint?: (x: number, y: number) => { r: number; g: number; b: number } | null
  ): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const fg = paint ? paint(x, y) : null;
        const c = fg ?? bg;
        raw[i] = c.r;
        raw[i + 1] = c.g;
        raw[i + 2] = c.b;
        raw[i + 3] = 255;
      }
    }
    return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }

  async function readRGBA(buffer: Buffer) {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  }

  it('produces a real alpha channel and makes the solid background transparent', async () => {
    // White background with a red square in the center.
    const png = await makePng(20, 20, { r: 255, g: 255, b: 255 }, (x, y) =>
      x >= 6 && x < 14 && y >= 6 && y < 14 ? { r: 255, g: 0, b: 0 } : null
    );

    const { buffer, detectedBackground, removedRatio } = await imageService.removeImageBackground(png);

    expect(detectedBackground).toEqual({ r: 255, g: 255, b: 255 });
    expect(removedRatio).toBeGreaterThan(0.5); // most of the 20x20 is background

    const { data, width, channels } = await readRGBA(buffer);

    // A corner pixel (background) must be fully transparent.
    expect(data[(0 * width + 0) * channels + 3]).toBe(0);

    // A center pixel (red square) must remain fully opaque and red.
    const ci = (10 * width + 10) * channels;
    expect(data[ci]).toBe(255);
    expect(data[ci + 1]).toBe(0);
    expect(data[ci + 2]).toBe(0);
    expect(data[ci + 3]).toBe(255);
  });

  it('preserves an enclosed background-colored region inside the foreground (does not flood interior)', async () => {
    // A red frame (ring) on white: the center is white but enclosed by red, so
    // it is NOT connected to the border and must stay opaque.
    const png = await makePng(20, 20, { r: 255, g: 255, b: 255 }, (x, y) => {
      const inRing = x >= 4 && x < 16 && y >= 4 && y < 16;
      const inHole = x >= 8 && x < 12 && y >= 8 && y < 12;
      if (inRing && !inHole) return { r: 200, g: 0, b: 0 };
      return null; // white elsewhere (outside ring AND the hole)
    });

    const { buffer } = await imageService.removeImageBackground(png);
    const { data, width, channels } = await readRGBA(buffer);

    // Outer corner: transparent.
    expect(data[(0 * width + 0) * channels + 3]).toBe(0);
    // Enclosed white hole at center: must remain opaque (not reached by fill).
    expect(data[(10 * width + 10) * channels + 3]).toBe(255);
  });

  it('respects a low tolerance (does not remove a distinct foreground color)', async () => {
    const png = await makePng(10, 10, { r: 0, g: 0, b: 0 }, (x, y) =>
      x >= 3 && x < 7 && y >= 3 && y < 7 ? { r: 255, g: 255, b: 255 } : null
    );
    const { removedRatio } = await imageService.removeImageBackground(png, { tolerance: 10 });
    // 100 px total, 16 px white foreground → 84 background removed.
    expect(Math.round(removedRatio * 100)).toBe(84);
  });

  it('detects the background color via corner median (robust to one odd corner)', async () => {
    // Three corners blue, one corner red → median should be blue.
    const png = await makePng(10, 10, { r: 0, g: 0, b: 255 }, (x, y) =>
      x === 0 && y === 0 ? { r: 255, g: 0, b: 0 } : null
    );
    const { detectedBackground } = await imageService.removeImageBackground(png);
    expect(detectedBackground).toEqual({ r: 0, g: 0, b: 255 });
  });
});

describe('ImageService color/contrast helpers', () => {
  it('parses 6-digit, 3-digit, and #-prefixed hex colors', () => {
    expect(ImageService.parseHexColor('#1a1a2e')).toEqual({ r: 26, g: 26, b: 46 });
    expect(ImageService.parseHexColor('1a1a2e')).toEqual({ r: 26, g: 26, b: 46 });
    expect(ImageService.parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('returns null for invalid hex colors', () => {
    expect(ImageService.parseHexColor('not-a-color')).toBeNull();
    expect(ImageService.parseHexColor('#12')).toBeNull();
    expect(ImageService.parseHexColor('')).toBeNull();
    expect(ImageService.parseHexColor(undefined as any)).toBeNull();
  });

  it('computes WCAG contrast: white on black is 21:1', () => {
    const ratio = ImageService.contrastRatio({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 });
    expect(Math.round(ratio)).toBe(21);
  });

  it('flags a dark wordmark on a dark surface as low contrast (< 3:1)', () => {
    // Near-black logo on dark navy #1a1a2e — the postmortem failure case.
    const ratio = ImageService.contrastRatio({ r: 10, g: 10, b: 10 }, { r: 26, g: 26, b: 46 });
    expect(ratio).toBeLessThan(3);
  });

  it('white logo on dark navy passes the 3:1 minimum', () => {
    const ratio = ImageService.contrastRatio({ r: 255, g: 255, b: 255 }, { r: 26, g: 26, b: 46 });
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it('averageOpaqueColor ignores transparent pixels', () => {
    // 2 pixels: one opaque red, one transparent green → average is red.
    const buf = Buffer.from([255, 0, 0, 255, 0, 255, 0, 0]);
    expect(ImageService.averageOpaqueColor(buf, 4)).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('averageOpaqueColor returns null when every pixel is transparent', () => {
    const buf = Buffer.from([255, 0, 0, 0, 0, 255, 0, 0]);
    expect(ImageService.averageOpaqueColor(buf, 4)).toBeNull();
  });
});
