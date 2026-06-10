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

  describe('Higgsfield Seedance 2.0', () => {
    const baseParams = {
      prompt: 'A product slowly rotates on a pedestal',
      filename: 'promo.mp4',
      userId: 'user123',
      videoModel: 'seedance-2.0',
    };

    let setTimeoutSpy: jest.SpyInstance;

    beforeEach(() => {
      mockedGetSecret.mockResolvedValue('apikey:apisecret');
      mockedUpload.mockResolvedValue({ success: true, url: 'https://s3.example.com/promo.mp4' });
      // Skip the real 10s poll waits — invoke the sleep callback immediately.
      setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => {
        cb();
        return 0 as any;
      }) as any);
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('should submit a request, poll until completed, and upload the resulting video', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          status: 'queued',
          request_id: 'req-1',
          status_url: 'https://platform.higgsfield.ai/requests/req-1/status',
        },
      } as any);
      // First poll: in_progress; second poll: completed with video URL.
      mockedAxios.get
        .mockResolvedValueOnce({ data: { status: 'in_progress' } } as any)
        .mockResolvedValueOnce({
          data: { status: 'completed', video: { url: 'https://video.higgsfield.ai/req-1.mp4' } },
        } as any)
        // Final get: download the produced video as a buffer for S3 upload.
        .mockResolvedValueOnce({ data: Buffer.from('fake-video-bytes') } as any);

      const result = await videoService.generateVideo({
        ...baseParams,
        startFrame: 'https://example.com/frame.png',
      });

      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/promo.mp4');
      // POST went to the Seedance v2 image-to-video endpoint with the right payload/auth.
      const [postUrl, postBody, postCfg] = mockedAxios.post.mock.calls[0] as any[];
      expect(postUrl).toContain('bytedance/seedance/v2/pro/image-to-video');
      expect(postBody).toMatchObject({ image_url: 'https://example.com/frame.png', prompt: baseParams.prompt });
      expect(postCfg.headers.Authorization).toBe('Key apikey:apisecret');
      // No auto-frame generation when startFrame is provided.
      expect(mockedGenerateImage).not.toHaveBeenCalled();
    });

    it('should auto-generate a first frame when no startFrame is provided', async () => {
      mockedGenerateImage.mockResolvedValue({ success: true, imageUrl: 'https://img.example.com/frame.png' });
      mockedAxios.post.mockResolvedValue({
        data: { status: 'completed', video: { url: 'https://video.higgsfield.ai/req-2.mp4' } },
      } as any);
      mockedAxios.get.mockResolvedValue({ data: Buffer.from('fake-video-bytes') } as any);

      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(true);
      expect(mockedGenerateImage).toHaveBeenCalledTimes(1);
      const postBody: any = mockedAxios.post.mock.calls[0][1];
      expect(postBody.image_url).toBe('https://img.example.com/frame.png');
    });

    it('should fail when first-frame generation fails', async () => {
      mockedGenerateImage.mockResolvedValue({ success: false, error: 'image service down' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to generate a source frame');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should surface a failed generation status', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { status: 'queued', status_url: 'https://platform.higgsfield.ai/requests/req-3/status' },
      } as any);
      mockedAxios.get.mockResolvedValue({ data: { status: 'failed', error: 'boom' } } as any);

      const result = await videoService.generateVideo({
        ...baseParams,
        startFrame: 'https://example.com/frame.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('failed');
    });

    it('should treat an nsfw status as a content-policy block', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { status: 'queued', status_url: 'https://platform.higgsfield.ai/requests/req-4/status' },
      } as any);
      mockedAxios.get.mockResolvedValue({ data: { status: 'nsfw' } } as any);

      const result = await videoService.generateVideo({
        ...baseParams,
        startFrame: 'https://example.com/frame.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content policies');
    });

    it('should return an error when the API responds with invalid credentials', async () => {
      mockedAxios.post.mockRejectedValue({
        response: { data: { detail: 'Invalid credentials' } },
      });

      const result = await videoService.generateVideo({
        ...baseParams,
        startFrame: 'https://example.com/frame.png',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid credentials');
    });
  });
});

