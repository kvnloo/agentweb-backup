/**
 * Deploy-image regression guard for ENG-370.
 *
 * describe_image relies on sharp to decode uploaded logos that arrive in formats
 * the vision APIs cannot read natively — notably SVG (needs librsvg) and
 * HEIC/AVIF (needs libheif). The npm-prebuilt sharp binary bundles both, so this
 * works today. But that is a property of the INSTALLED binary, not of our code:
 * a sharp version bump, a musl/Alpine base image, a `--no-optional` install, or a
 * system libvips without these codecs would silently drop them, and such logos
 * would quietly fall to the describe_image fast-fail instead of being analyzed.
 *
 * These assertions run in CI on the same linux/x64 arch the backend deploys to,
 * so a codec-losing change fails the test suite before it can ship rather than
 * regressing ENG-370 in production. If this ever fails, restore a sharp build
 * with librsvg + libheif (or add an explicit rasterizer fallback) before deploy.
 */

// Real sharp — we are asserting the actual installed binary's capabilities.
const sharp = require('sharp');

describe('sharp installed-binary codec guard (ENG-370)', () => {
  it('can decode SVG input (librsvg present)', () => {
    expect(sharp.format.svg?.input?.buffer).toBe(true);
  });

  it('can decode HEIC/AVIF input (libheif present)', () => {
    expect(sharp.format.heif?.input?.buffer).toBe(true);
  });

  it('can decode the vision-native formats it may re-encode from/to', () => {
    for (const fmt of ['jpeg', 'png', 'gif', 'webp'] as const) {
      expect(sharp.format[fmt]?.input?.buffer).toBe(true);
    }
  });

  it('actually rasterizes an SVG to PNG (end-to-end, not just a capability flag)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="orange"/></svg>'
    );
    const meta = await sharp(svg).metadata();
    expect(meta.format).toBe('svg');
    const png = await sharp(svg).png().toBuffer();
    // PNG magic number — proves a real raster image came out.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
