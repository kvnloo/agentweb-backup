/**
 * ENG-2139: `ImageService.generateImage` runs the creative gates on the final bytes and
 * attaches the verdict to its result — advisory only, a failing gate never fails generation.
 */
import axios from 'axios';
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

interface RunwayProvider {
  generateWithRunwayML(params: { size?: string }, model: string): Promise<ProviderResult>;
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

  it('omits gates when the S3 upload fails and the unmeasured provider artifact is returned', async () => {
    stubProvider(await pngDataUrl(1080, 1350));
    jest.mocked(uploadFileToS3).mockResolvedValueOnce({ success: false, error: 'S3 unavailable' });

    const result = await new ImageService().generateImage({
      prompt: 'ad',
      filename: 'ad.png',
      userId: 'user-1',
      size: '1080x1350',
    });

    expect(result.success).toBe(true);
    expect(result.gates).toBeUndefined();
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

  it('checks dimensions and file size for a 1:1 agent-mode request against Meta feed square (ENG-2187)', async () => {
    stubProvider(await pngDataUrl(640, 640));

    const result = await new ImageService().generateImage({
      prompt: 'ad',
      filename: 'ad.png',
      userId: 'user-1',
      size: '1:1',
      imageModel: 'gemini-3-pro-image-preview',
      removeC2PA: false,
    });

    expect(result.gates).toMatchObject({ placement: 'meta_feed_square', placementSource: 'ratio', passed: true });
    const statuses = Object.fromEntries((result.gates?.checks ?? []).map((c) => [c.id, c.status]));
    expect(statuses).toMatchObject({ dimensions: 'pass', file_size: 'pass' });
  });

  it('holds the image against the placement the caller named (ENG-2187)', async () => {
    stubProvider(await pngDataUrl(640, 640));

    const result = await new ImageService().generateImage({
      prompt: 'ad',
      filename: 'ad.png',
      userId: 'user-1',
      size: '1:1',
      placement: 'google_square_marketing_image',
      removeC2PA: false,
    });

    expect(result.gates).toMatchObject({ placement: 'google_square_marketing_image', placementSource: 'requested' });
  });

  describe('remote-URL provider (Runway)', () => {
    const remoteUrl = 'https://runway.example.com/output/ad.png';

    function stubRunway(): void {
      jest
        .spyOn(ImageService.prototype as unknown as RunwayProvider, 'generateWithRunwayML')
        .mockResolvedValue({ success: true, imageUrl: remoteUrl, filename: 'ad.png' });
    }

    it('gates the downloaded image and still returns the remote URL (ENG-2187)', async () => {
      stubRunway();
      jest.mocked(uploadFileToS3).mockClear();
      const png = Buffer.from((await pngDataUrl(600, 750)).split(',')[1], 'base64');
      const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: png });

      const result = await new ImageService().generateImage({
        prompt: 'ad',
        filename: 'ad.png',
        userId: 'user-1',
        size: '1080x1350',
        imageModel: 'gen4_image',
      });

      expect(get).toHaveBeenCalledWith(remoteUrl, expect.objectContaining({ responseType: 'arraybuffer' }));
      // CodeRabbit #3137 (SSRF): the URL is provider-named, not ours — redirects must never be
      // followed to an address axios itself would otherwise silently fetch.
      expect(get).toHaveBeenCalledWith(remoteUrl, expect.objectContaining({ maxRedirects: 0 }));
      expect(result).toMatchObject({ success: true, imageUrl: remoteUrl });
      expect(result.gates).toMatchObject({ passed: true, placement: 'meta_feed_portrait', width: 600, height: 750 });
      expect(uploadFileToS3).not.toHaveBeenCalled();
    });

    it('refuses a redirect from the remote URL — recorded as not checked, never a hard error (ENG-2187, CodeRabbit #3137)', async () => {
      stubRunway();
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      // With maxRedirects: 0, axios's default validateStatus (2xx only) turns a 3xx response
      // into a thrown error — this is what a real redirect attempt looks like from the caller's
      // side; no request to the redirect target's Location is ever made.
      const redirectError = Object.assign(new Error('Request failed with status code 302'), {
        response: { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
      });
      jest.spyOn(axios, 'get').mockRejectedValue(redirectError);

      const result = await new ImageService().generateImage({
        prompt: 'ad',
        filename: 'ad.png',
        userId: 'user-1',
        size: '1080x1350',
        imageModel: 'gen4_image',
      });

      expect(result).toMatchObject({ success: true, imageUrl: remoteUrl });
      expect(result.gates?.notChecked).toContain('302');
      expect(result.gates?.checks.every((c) => c.status === 'skipped')).toBe(true);
    });

    it('records the image as not checked when the download fails (ENG-2187)', async () => {
      stubRunway();
      jest.spyOn(axios, 'get').mockRejectedValue(new Error('403 Forbidden'));
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await new ImageService().generateImage({
        prompt: 'ad',
        filename: 'ad.png',
        userId: 'user-1',
        size: '1344:768',
        imageModel: 'gen4_image',
      });

      expect(result).toMatchObject({ success: true, imageUrl: remoteUrl });
      expect(result.gates?.notChecked).toContain('403 Forbidden');
      expect(result.gates?.checks.every((c) => c.status === 'skipped')).toBe(true);
    });
  });
});
