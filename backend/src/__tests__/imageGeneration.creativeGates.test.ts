/**
 * ENG-2139: `ImageService.generateImage` runs the creative gates on the final bytes and
 * attaches the verdict to its result — advisory only, a failing gate never fails generation.
 */
import sharp from 'sharp';
import { ImageService } from '../services/imageGeneration';
import { uploadFileToS3 } from '../utils/s3Utils';

jest.mock('../utils/s3Utils');
jest.mock('../utils/secretsManager');
jest.mock('../services/usageRecorderService', () => ({ recordUsage: jest.fn(), meterUserUsage: jest.fn() }));

interface ProviderResult {
  success: boolean;
  imageUrl?: string;
  filename?: string;
}

interface GeminiProvider {
  generateWithGoogleGemini3Pro(params: { size?: string }): Promise<ProviderResult>;
}

async function pngDataUrl(width: number, height: number, flat = false): Promise<string> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  // A diagonal gradient survives the gates' 64x64 thumbnail; a flat fill reads as blank.
  for (let i = 0; i < raw.length; i++) {
    const pixel = Math.floor(i / channels);
    raw[i] = flat ? 255 : Math.floor((((pixel % width) / width + Math.floor(pixel / width) / height) * 255) / 2);
  }
  const png = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function stubProvider(imageUrl: string): jest.SpyInstance {
  return jest
    .spyOn(ImageService.prototype as unknown as GeminiProvider, 'generateWithGoogleGemini3Pro')
    .mockResolvedValue({ success: true, imageUrl, filename: 'ad.png' });
}

describe('ImageService.generateImage creative gates (ENG-2139)', () => {
  beforeEach(() => {
    jest.mocked(uploadFileToS3).mockResolvedValue({ success: true, url: 'https://files.example.com/ad.png' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('attaches a passing gate result for a render that matches the requested placement', async () => {
    stubProvider(await pngDataUrl(1080, 1350));

    const result = await new ImageService().generateImage({
      prompt: 'ad',
      filename: 'ad.png',
      userId: 'user-1',
      size: '1080x1350',
      removeC2PA: false,
    });

    expect(result).toMatchObject({ success: true, imageUrl: 'https://files.example.com/ad.png' });
    expect(result.gates).toMatchObject({ passed: true, advisory: true, placement: 'meta_feed_portrait', width: 1080, height: 1350 });
  });

  it('still succeeds, with failing advisory gates, when the render is the wrong shape and blank', async () => {
    stubProvider(await pngDataUrl(1024, 1024, true));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new ImageService().generateImage({
      prompt: 'ad',
      filename: 'ad.png',
      userId: 'user-1',
      size: '1080x1920',
      removeC2PA: false,
    });

    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://files.example.com/ad.png');
    expect(result.gates?.passed).toBe(false);
    const failed = result.gates?.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    expect(failed).toEqual(['blank_render', 'aspect_ratio']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[creative-gates]'), expect.stringContaining('aspect_ratio'));
  });

  it('flags a size the Gemini 3 path would silently send as 1:1', async () => {
    stubProvider(await pngDataUrl(1024, 1024));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await new ImageService().generateImage({
      prompt: 'ad',
      filename: 'ad.png',
      userId: 'user-1',
      size: '7:3',
      imageModel: 'gemini-3.1-flash-image',
      removeC2PA: false,
    });

    expect(result.success).toBe(true);
    expect(result.gates?.checks.find((c) => c.id === 'aspect_fallback')).toMatchObject({
      status: 'fail',
      reason: expect.stringContaining('unsupported_ratio'),
    });
  });
});
