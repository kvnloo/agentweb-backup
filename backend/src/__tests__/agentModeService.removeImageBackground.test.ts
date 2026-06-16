// Unit tests for the remove_image_background orchestration in agentModeService.
// The pixel algorithm itself is covered by imageGeneration.backgroundRemoval.test.ts;
// here we mock imageService/S3/axios and verify the download → process → upload →
// contrast-check → response flow.

import { AgentModeService } from '../services/agentModeService';
import * as imageGeneration from '../services/imageGeneration';
import * as s3Utils from '../utils/s3Utils';

jest.mock('../services/imageGeneration');
jest.mock('../utils/s3Utils');
jest.mock('axios');

// sharp is only used by the optional contrast check (re-reading the transparent
// buffer's opaque pixels). Mock it to return a configurable foreground pixel so
// we can drive the contrast logic deterministically without a real PNG.
let mockSharpReadResult: { data: Buffer; info: { width: number; height: number; channels: number } } = {
  data: Buffer.from([255, 255, 255, 255]),
  info: { width: 1, height: 1, channels: 4 }
};
jest.mock('sharp', () =>
  jest.fn().mockImplementation(() => ({
    raw: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockImplementation(() => Promise.resolve(mockSharpReadResult))
  }))
);

describe('AgentModeService - removeImageBackground', () => {
  let agentModeService: AgentModeService;
  let mockAxios: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock the imageService.removeImageBackground used by the orchestration.
    (imageGeneration.imageService as any).removeImageBackground = jest.fn().mockResolvedValue({
      buffer: Buffer.from('transparent-png'),
      detectedBackground: { r: 255, g: 255, b: 255 },
      removedRatio: 0.6
    });

    // ImageService static helpers are used for the optional contrast check.
    // The real implementations are pure, so keep them (the auto-mock would
    // otherwise replace them with no-ops).
    const actual = jest.requireActual('../services/imageGeneration').ImageService;
    (imageGeneration as any).ImageService = actual;

    mockAxios = require('axios');
    (mockAxios.default.get as jest.Mock).mockResolvedValue({
      data: Buffer.from('original-image'),
      headers: { 'content-type': 'image/jpeg' }
    });

    (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({
      success: true,
      url: 'https://s3.amazonaws.com/bucket/logo_transparent.png'
    });

    agentModeService = new AgentModeService();
  });

  it('downloads, removes background, and uploads a transparent PNG', async () => {
    const result = await (agentModeService as any).removeImageBackground(
      'https://example.com/logo.jpg',
      'logo.png',
      'user123'
    );

    expect(mockAxios.default.get).toHaveBeenCalledWith(
      'https://example.com/logo.jpg',
      expect.objectContaining({ responseType: 'arraybuffer', timeout: 30000 })
    );
    expect((imageGeneration.imageService as any).removeImageBackground).toHaveBeenCalledTimes(1);
    expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from('transparent-png'),
      'logo.png',
      'user123',
      'image/png'
    );
    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://s3.amazonaws.com/bucket/logo_transparent.png');
    expect(result.detectedBackground).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('handles data URLs without calling axios', async () => {
    const base64 = Buffer.from('img').toString('base64');
    const result = await (agentModeService as any).removeImageBackground(
      `data:image/png;base64,${base64}`,
      'out.png',
      'user123'
    );
    expect(mockAxios.default.get).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('generates a *_transparent.png filename from the URL when none is provided', async () => {
    await (agentModeService as any).removeImageBackground(
      'https://example.com/brand-logo.jpg',
      undefined,
      'user123'
    );
    expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from('transparent-png'),
      expect.stringMatching(/brand-logo_transparent\.png$/),
      'user123',
      'image/png'
    );
  });

  it('appends .png to an extension-less filename without truncating it', async () => {
    // Regression: lastIndexOf('.') returns -1 for no-dot names; the old
    // `|| length` fallback was dead code and substring(0,-1) dropped a char,
    // collapsing "logo" → ".png".
    await (agentModeService as any).removeImageBackground(
      'https://example.com/logo.png',
      'logo',
      'user123'
    );
    expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from('transparent-png'),
      'logo.png',
      'user123',
      'image/png'
    );
  });

  it('forces a .png extension when a non-png filename is given', async () => {
    await (agentModeService as any).removeImageBackground(
      'https://example.com/logo.jpg',
      'output.jpg',
      'user123'
    );
    expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from('transparent-png'),
      'output.png',
      'user123',
      'image/png'
    );
  });

  it('returns an error when image URL is missing', async () => {
    const result = await (agentModeService as any).removeImageBackground('', 'out.png', 'user123');
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_image_url');
  });

  it('returns an error when userId is missing', async () => {
    const result = await (agentModeService as any).removeImageBackground(
      'https://example.com/logo.png',
      'out.png',
      undefined
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_user_id');
  });

  it('propagates S3 upload failures', async () => {
    (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({ success: false, error: 'S3 boom' });
    const result = await (agentModeService as any).removeImageBackground(
      'https://example.com/logo.png',
      'out.png',
      'user123'
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('S3 boom');
  });

  it('handles download errors gracefully', async () => {
    (mockAxios.default.get as jest.Mock).mockRejectedValue(new Error('Network error'));
    const result = await (agentModeService as any).removeImageBackground(
      'https://example.com/logo.png',
      'out.png',
      'user123'
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to remove background');
    expect(result.error).toContain('Network error');
  });

  describe('contrast check (surface_color)', () => {
    it('warns when a dark logo is placed on a dark surface', async () => {
      // Re-read of the transparent buffer yields a near-black foreground pixel.
      mockSharpReadResult = {
        data: Buffer.from([10, 10, 10, 255]),
        info: { width: 1, height: 1, channels: 4 }
      };
      const result = await (agentModeService as any).removeImageBackground(
        'https://example.com/logo.png',
        'out.png',
        'user123',
        { surfaceColor: '#1a1a2e' }
      );
      expect(result.success).toBe(true);
      expect(result.contrast).toBeDefined();
      expect(result.contrast.legible).toBe(false);
      expect(result.contrast.warning).toContain('Low contrast');
      expect(result.message).toContain('Low contrast');
    });

    it('passes contrast for a white logo on a dark surface', async () => {
      mockSharpReadResult = {
        data: Buffer.from([255, 255, 255, 255]),
        info: { width: 1, height: 1, channels: 4 }
      };
      const result = await (agentModeService as any).removeImageBackground(
        'https://example.com/logo.png',
        'out.png',
        'user123',
        { surfaceColor: '#1a1a2e' }
      );
      expect(result.success).toBe(true);
      expect(result.contrast.legible).toBe(true);
      expect(result.contrast.warning).toBeUndefined();
    });

    it('reports an unparseable surface_color without failing', async () => {
      const result = await (agentModeService as any).removeImageBackground(
        'https://example.com/logo.png',
        'out.png',
        'user123',
        { surfaceColor: 'periwinkle' }
      );
      expect(result.success).toBe(true);
      expect(result.contrast.warning).toContain('Could not parse');
    });
  });
});
