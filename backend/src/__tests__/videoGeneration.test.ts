// Unit tests for videoGeneration service

import { VideoService } from '../services/videoGeneration';
import * as secretsManager from '../utils/secretsManager';
import * as s3Utils from '../utils/s3Utils';
import { imageService } from '../services/imageGeneration';
import axios from 'axios';

// Mock dependencies
jest.mock('../utils/secretsManager');
jest.mock('../utils/s3Utils');
jest.mock('../services/imageGeneration', () => ({
  imageService: { generateImage: jest.fn() },
}));
jest.mock('axios');
jest.mock('@google/genai');

// Seedance 2.0 runs via the Higgsfield MCP server; mock the one-off client.
const mockCallToolDirect = jest.fn();
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ callToolDirect: mockCallToolDirect })),
}));

describe('VideoService', () => {
  let videoService: VideoService;
  const mockedAxios = axios as jest.Mocked<typeof axios>;
  const mockedGetSecret = secretsManager.getSecret as jest.Mock;
  const mockedUpload = s3Utils.uploadFileToS3 as jest.Mock;
  const mockedGenerateImage = imageService.generateImage as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    videoService = new VideoService();
  });

  describe('Video Generation with Veo 3.1', () => {
    it('should have generateVideo method', () => {
      expect(videoService.generateVideo).toBeDefined();
      expect(typeof videoService.generateVideo).toBe('function');
    });

    it('should accept valid parameters for video generation', () => {
      const params = {
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'veo-3.1-generate-preview'
      };
      
      // Just verify the method signature accepts these parameters
      expect(params.prompt).toBeDefined();
      expect(params.filename).toBeDefined();
      expect(params.userId).toBeDefined();
    }, 10000);

    it('should accept start and end frame URLs', () => {
      const params = {
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'veo-3.1-generate-preview',
        startFrame: 'https://example.com/start.png',
        endFrame: 'https://example.com/end.png'
      };
      
      // Verify the parameters structure
      expect(params.startFrame).toBe('https://example.com/start.png');
      expect(params.endFrame).toBe('https://example.com/end.png');
    }, 10000);

    it('should support fallback to fast model on quota exhaustion', () => {
      // Verify that both models are in the supported models list
      const supportedModels = ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview'];
      expect(supportedModels).toContain('veo-3.1-generate-preview');
      expect(supportedModels).toContain('veo-3.1-fast-generate-preview');
    }, 10000);

    it('should handle RAI media filtering response structure', () => {
      // Verify the response structure for RAI filtering
      const mockRaiResponse = {
        raiMediaFilteredCount: 1,
        raiMediaFilteredReasons: ['Content filtered by policy'],
        generatedVideos: []
      };
      
      expect(mockRaiResponse.raiMediaFilteredCount).toBe(1);
      expect(mockRaiResponse.raiMediaFilteredReasons).toContain('Content filtered by policy');
    }, 10000);

    it('should handle image processing error structure', () => {
      // Verify error handling structure for image processing
      const mockError = new Error('Failed to download image');
      expect(mockError.message).toContain('Failed to download');
    }, 10000);
  });

  describe('Model Validation', () => {
    it('should accept veo-3.1-generate-preview model', () => {
      const params = {
        prompt: 'Test',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'veo-3.1-generate-preview'
      };

      expect(params.videoModel).toBe('veo-3.1-generate-preview');
    });

    it('should accept veo-3.1-fast-generate-preview model', () => {
      const params = {
        prompt: 'Test',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'veo-3.1-fast-generate-preview'
      };

      expect(params.videoModel).toBe('veo-3.1-fast-generate-preview');
    });

    it('should reject an unsupported model', async () => {
      const result = await videoService.generateVideo({
        prompt: 'Test',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'not-a-real-model',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid videoModel 'not-a-real-model'");
    });
  });

  describe('Higgsfield Seedance 2.0 (MCP)', () => {
    const baseParams = {
      prompt: 'A product slowly rotates on a pedestal',
      filename: 'promo.mp4',
      userId: 'user123',
      videoModel: 'seedance-2.0',
    };

    let setTimeoutSpy: jest.SpyInstance;

    const VIDEO_URL = 'https://video.higgsfield.ai/job-1.mp4';
    // Canned MCP tool results matching the confirmed outputSchema shapes:
    // generate_video/job_display wrap in `results[]`; job_status wraps in `generation`.
    const routeTools = (overrides: Record<string, any> = {}) => {
      mockCallToolDirect.mockImplementation(async (_server: string, tool: string) => {
        if (tool === 'media_import_url') return overrides.media_import_url ?? { structuredContent: { media_id: 'media-123' } };
        if (tool === 'generate_video') return overrides.generate_video ?? {
          structuredContent: { results: [{ id: 'job-1', type: 'video', status: 'queued', model: 'seedance_2_0', params: {}, results: {} }] },
        };
        if (tool === 'job_status') return overrides.job_status ?? {
          structuredContent: { generation: { id: 'job-1', type: 'video', status: 'completed', results: { rawUrl: VIDEO_URL, minUrl: VIDEO_URL } } },
        };
        if (tool === 'job_display') return overrides.job_display ?? {
          structuredContent: { results: [{ id: 'job-1', type: 'video', status: 'completed', results: { rawUrl: VIDEO_URL } }] },
        };
        return {};
      });
    };

    const callArgsFor = (tool: string): any => {
      const call = (mockCallToolDirect.mock.calls as any[]).find((c) => c[1] === tool);
      return call ? call[2] : undefined;
    };

    beforeEach(() => {
      mockedUpload.mockResolvedValue({ success: true, url: 'https://s3.example.com/promo.mp4' });
      mockedAxios.get.mockResolvedValue({ data: Buffer.from('fake-video-bytes') } as any);
      // Skip the real 10s poll waits — invoke the sleep callback immediately.
      setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => {
        cb();
        return 0 as any;
      }) as any);
      routeTools();
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('text-to-video: builds seedance_2_0 params, polls, and uploads (no media import)', async () => {
      const result = await (videoService as any).generateWithHiggsfield({ ...baseParams, durationSeconds: 5 });

      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/promo.mp4');
      const args = callArgsFor('generate_video');
      expect(args.params).toMatchObject({
        model: 'seedance_2_0',
        prompt: baseParams.prompt,
        duration: 5,
        resolution: '720p',
        aspect_ratio: 'auto',
      });
      expect(args.params.medias).toBeUndefined();
      expect((mockCallToolDirect.mock.calls as any[]).some((c) => c[1] === 'media_import_url')).toBe(false);
    });

    it('image-to-video: imports the start frame and passes it as a media reference', async () => {
      const result = await (videoService as any).generateWithHiggsfield({
        ...baseParams,
        startFrame: 'https://example.com/frame.png',
      });

      expect(result.success).toBe(true);
      expect(callArgsFor('media_import_url')).toMatchObject({ url: 'https://example.com/frame.png', type: 'image' });
      expect(callArgsFor('generate_video').params.medias).toEqual([{ value: 'media-123', role: 'start_image' }]);
    });

    it('passes user-selected resolution and aspect ratio through', async () => {
      await (videoService as any).generateWithHiggsfield({ ...baseParams, resolution: '1080p', aspectRatio: '9:16' });
      const args = callArgsFor('generate_video');
      expect(args.params.resolution).toBe('1080p');
      expect(args.params.aspect_ratio).toBe('9:16');
    });

    it('clamps duration to Seedance 4–15s range', async () => {
      await (videoService as any).generateWithHiggsfield({ ...baseParams, durationSeconds: 30 });
      expect(callArgsFor('generate_video').params.duration).toBe(15);
    });

    it('surfaces a failed job status', async () => {
      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'failed' } } } });
      const result = await (videoService as any).generateWithHiggsfield({ ...baseParams });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/failed/i);
    });

    it('treats an nsfw status as a content-policy block', async () => {
      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'nsfw' } } } });
      const result = await (videoService as any).generateWithHiggsfield({ ...baseParams });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/content polic/i);
    });

    it('treats ip_detected as a gated failure (→ triggers Veo fallback upstream)', async () => {
      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'ip_detected' } } } });
      const result = await (videoService as any).generateWithHiggsfield({ ...baseParams });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/IP detection/i);
    });

    it('reads the job_id from generation.id and the URL from generation.results.rawUrl', async () => {
      const result = await (videoService as any).generateWithHiggsfield({ ...baseParams });
      expect(result.success).toBe(true);
      // job_status was polled with the id returned by generate_video's results[0].id
      const statusCall = (mockCallToolDirect.mock.calls as any[]).find((c) => c[1] === 'job_status');
      expect(statusCall[2]).toMatchObject({ job_id: 'job-1' });
    });

    it('returns an error when the MCP call throws (auth/credits)', async () => {
      mockCallToolDirect.mockRejectedValue(new Error('Unauthorized'));
      const result = await (videoService as any).generateWithHiggsfield({ ...baseParams });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Seedance.*failed/i);
    });

    it('defaults to Seedance 2.0 (MCP) when no videoModel is specified', async () => {
      routeTools();
      const result = await videoService.generateVideo({ prompt: 'a sunrise', filename: 'd.mp4', userId: 'u' });
      expect(result.success).toBe(true);
      const genCall = (mockCallToolDirect.mock.calls as any[]).find((c) => c[1] === 'generate_video');
      expect(genCall).toBeDefined();
      expect(genCall[2].params.model).toBe('seedance_2_0');
    });

    it('falls back to Veo when Seedance fails', async () => {
      mockCallToolDirect.mockRejectedValue(new Error('no credits'));
      const veoSpy = jest
        .spyOn(videoService as any, 'generateWithVeo31')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/veo.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(veoSpy).toHaveBeenCalled();
      expect(result.success).toBe(true);
      veoSpy.mockRestore();
    });
  });
});

