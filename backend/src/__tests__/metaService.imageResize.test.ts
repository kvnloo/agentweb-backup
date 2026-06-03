// Tests for MetaService.resizeImageForMeta — auto-downscaling oversized ad images
// so Meta's Marketing API doesn't reject them with a generic "Invalid parameter".

jest.mock('sharp', () => jest.fn());

import { MetaService } from '../services/metaService';

const sharp = require('sharp');

const MAX_BYTES = 8 * 1024 * 1024;
const fakeBuffer = (size: number) => Buffer.alloc(size, 0x42);

/**
 * Build a chainable sharp mock instance.
 * @param metadata  value resolved by .metadata()
 * @param outputs   buffers returned by successive .toBuffer() calls
 */
function makeSharpInstance(metadata: any, outputs: Buffer[]) {
  let call = 0;
  const instance: any = {
    resize: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    metadata: jest.fn().mockResolvedValue(metadata),
    toBuffer: jest.fn().mockImplementation(() => {
      const out = outputs[Math.min(call, outputs.length - 1)];
      call += 1;
      return Promise.resolve(out);
    }),
  };
  return instance;
}

describe('MetaService.resizeImageForMeta', () => {
  let service: MetaService;

  beforeEach(() => {
    service = MetaService.getInstance();
    jest.clearAllMocks();
  });

  it('returns the original buffer untouched when within dimension and byte limits', async () => {
    const buf = fakeBuffer(500 * 1024);
    const instance = makeSharpInstance({ width: 1080, height: 1080, format: 'png' }, [buf]);
    (sharp as jest.Mock).mockReturnValue(instance);

    const result = await service.resizeImageForMeta(buf, 'logo.png');

    expect(result.resized).toBe(false);
    expect(result.buffer).toBe(buf);
    expect(result.filename).toBe('logo.png');
    expect(instance.resize).not.toHaveBeenCalled();
  });

  it('downscales a 4096x4096 PNG with fit:inside, no enlargement (reported case)', async () => {
    const original = fakeBuffer(6 * 1024 * 1024);
    const resized = fakeBuffer(1.5 * 1024 * 1024);
    const instance = makeSharpInstance({ width: 4096, height: 4096, format: 'png' }, [resized]);
    (sharp as jest.Mock).mockReturnValue(instance);

    const result = await service.resizeImageForMeta(original, 'every-2D03-logo-tombstone.png');

    expect(result.resized).toBe(true);
    expect(result.buffer).toBe(resized);
    // PNG under the byte cap stays a PNG (preserves transparency for logos).
    expect(result.filename).toBe('every-2D03-logo-tombstone.png');
    expect(instance.resize).toHaveBeenCalledWith({
      width: 1936,
      height: 1936,
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(instance.png).toHaveBeenCalled();
    expect(instance.jpeg).not.toHaveBeenCalled();
  });

  it('falls back to JPEG (and .jpg filename) when a resized PNG is still over 8MB', async () => {
    const original = fakeBuffer(20 * 1024 * 1024);
    const heavyPng = fakeBuffer(MAX_BYTES + 1); // still too big as PNG
    const jpeg = fakeBuffer(2 * 1024 * 1024);
    const instance = makeSharpInstance({ width: 4096, height: 4096, format: 'png' }, [heavyPng, jpeg]);
    (sharp as jest.Mock).mockReturnValue(instance);

    const result = await service.resizeImageForMeta(original, 'big.png');

    expect(result.resized).toBe(true);
    expect(result.buffer).toBe(jpeg);
    expect(result.filename).toBe('big.jpg');
    expect(instance.jpeg).toHaveBeenCalled();
  });

  it('re-encodes a too-heavy image even when dimensions are within the limit', async () => {
    const original = fakeBuffer(MAX_BYTES + 1);
    const out = fakeBuffer(1 * 1024 * 1024);
    const instance = makeSharpInstance({ width: 1080, height: 1080, format: 'jpeg' }, [out]);
    (sharp as jest.Mock).mockReturnValue(instance);

    const result = await service.resizeImageForMeta(original, 'photo.jpg');

    expect(result.resized).toBe(true);
    expect(result.buffer).toBe(out);
    expect(instance.resize).toHaveBeenCalled();
  });

  it('drops JPEG quality progressively when the output stays over the byte cap', async () => {
    const original = fakeBuffer(30 * 1024 * 1024);
    // First three encodes stay too big, fourth fits.
    const tooBig = fakeBuffer(MAX_BYTES + 1);
    const ok = fakeBuffer(3 * 1024 * 1024);
    const instance = makeSharpInstance({ width: 5000, height: 4000, format: 'jpeg' }, [tooBig, tooBig, tooBig, ok]);
    (sharp as jest.Mock).mockReturnValue(instance);

    const result = await service.resizeImageForMeta(original, 'huge.jpg');

    expect(result.resized).toBe(true);
    expect(result.buffer).toBe(ok);
    // quality 90 -> 75 -> 60 -> 45 : four jpeg() encodes
    expect(instance.jpeg.mock.calls.map((c: any[]) => c[0])).toEqual([
      { quality: 90 },
      { quality: 75 },
      { quality: 60 },
      { quality: 45 },
    ]);
  });

  it('stops dropping JPEG quality once it bottoms out, even if still over the cap', async () => {
    const original = fakeBuffer(40 * 1024 * 1024);
    const tooBig = fakeBuffer(MAX_BYTES + 1); // never fits, forcing the quality floor
    const instance = makeSharpInstance({ width: 6000, height: 6000, format: 'jpeg' }, [tooBig]);
    (sharp as jest.Mock).mockReturnValue(instance);

    const result = await service.resizeImageForMeta(original, 'enormous.jpg');

    // Loop exits via the quality>40 guard (90 -> 75 -> 60 -> 45 -> 30), not because it fit.
    expect(result.resized).toBe(true);
    expect(result.buffer).toBe(tooBig);
    expect(instance.jpeg.mock.calls.map((c: any[]) => c[0].quality)).toEqual([90, 75, 60, 45, 30]);
  });

  it('handles a thrown non-error value without crashing', async () => {
    const buf = fakeBuffer(6 * 1024 * 1024);
    (sharp as jest.Mock).mockImplementation(() => {
      throw null; // exercises the error?.message optional-chain branch
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.resizeImageForMeta(buf, 'logo.png');

    expect(result.resized).toBe(false);
    expect(result.buffer).toBe(buf);
    consoleSpy.mockRestore();
  });

  it('returns the original buffer when sharp throws (never blocks the upload)', async () => {
    const buf = fakeBuffer(6 * 1024 * 1024);
    (sharp as jest.Mock).mockImplementation(() => {
      throw new Error('sharp unavailable');
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.resizeImageForMeta(buf, 'logo.png');

    expect(result.resized).toBe(false);
    expect(result.buffer).toBe(buf);
    expect(result.filename).toBe('logo.png');
    consoleSpy.mockRestore();
  });

  it('treats missing metadata dimensions as within limits unless too heavy', async () => {
    const buf = fakeBuffer(100 * 1024);
    const instance = makeSharpInstance({ format: 'png' }, [buf]); // no width/height
    (sharp as jest.Mock).mockReturnValue(instance);

    const result = await service.resizeImageForMeta(buf, 'unknown.png');

    expect(result.resized).toBe(false);
    expect(instance.resize).not.toHaveBeenCalled();
  });
});
