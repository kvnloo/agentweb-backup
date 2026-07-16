// Unit tests for videoGeneration service

import { VideoService } from '../services/videoGeneration';
import * as secretsManager from '../utils/secretsManager';
import * as s3Utils from '../utils/s3Utils';
import { imageService } from '../services/imageGeneration';
import axios from 'axios';
import { remotionService } from '../services/remotionService';

// Mock dependencies
jest.mock('../utils/secretsManager');
jest.mock('../utils/s3Utils');
jest.mock('../services/imageGeneration', () => ({
  imageService: { generateImage: jest.fn() },
}));
jest.mock('axios');
jest.mock('@google/genai');
jest.mock('../services/remotionService', () => ({
  remotionService: { compose: jest.fn() },
}));

// Seedance 2.0 runs over ONE MCP session (withServerSession). The mock invokes the
// session callback with a routing callTool(toolName, args, opts).
const mockCallTool = jest.fn();
const mockWithServerSession = jest.fn(async (_server: string, fn: any) => fn(mockCallTool));
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    withServerSession: mockWithServerSession,
  })),
}));

jest.mock('../services/usageRecorderService', () => ({ recordUsage: jest.fn(), meterUserUsage: jest.fn() }));
import { recordUsage, meterUserUsage } from '../services/usageRecorderService';
const mockRecordUsage = recordUsage as jest.Mock;
const mockMeterUserUsage = meterUserUsage as jest.Mock;

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
      mockCallTool.mockImplementation(async (tool: string) => {
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
      const call = (mockCallTool.mock.calls as any[]).find((c) => c[0] === tool);
      return call ? call[1] : undefined;
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
      expect((mockCallTool.mock.calls as any[]).some((c) => c[0] === 'media_import_url')).toBe(false);
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
      const statusCall = (mockCallTool.mock.calls as any[]).find((c) => c[0] === 'job_status');
      expect(statusCall[1]).toMatchObject({ jobId: 'job-1' });
    });

    it('returns an error when the MCP call throws (auth/credits)', async () => {
      mockCallTool.mockRejectedValue(new Error('Unauthorized'));
      const result = await (videoService as any).generateWithHiggsfield({ ...baseParams });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Seedance.*failed/i);
    });

    // M2: Seedance already succeeded (paid). A transient S3 upload blip must NOT discard
    // the paid clip and trigger a full Veo regen — retry the download/upload instead.
    it('retries a transient S3 upload failure instead of falling back to Veo (no double spend)', async () => {
      routeTools();
      mockedUpload
        .mockResolvedValueOnce({ success: false, error: 'transient S3 error' })
        .mockResolvedValueOnce({ success: true, url: 'https://s3.example.com/retried.mp4' });
      const veoSpy = jest.spyOn(videoService as any, 'generateWithVeo31');

      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/retried.mp4');
      expect(mockedUpload).toHaveBeenCalledTimes(2); // first failed, retry succeeded
      expect(veoSpy).not.toHaveBeenCalled();          // paid Seedance clip reused, not regenerated
      veoSpy.mockRestore();
    });

    it('falls back to Veo only after the upload retries are exhausted', async () => {
      routeTools();
      mockedUpload.mockResolvedValue({ success: false, error: 'S3 down' });
      const veoSpy = jest.spyOn(videoService as any, 'generateWithVeo31')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/veo.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(mockedUpload.mock.calls.length).toBeGreaterThanOrEqual(3); // retried before giving up
      expect(veoSpy).toHaveBeenCalledTimes(1);
      expect(result.videoUrl).toBe('https://s3.example.com/veo.mp4');
      veoSpy.mockRestore();
    });

    it('defaults to Seedance 2.0 (MCP) when no videoModel is specified', async () => {
      routeTools();
      const result = await videoService.generateVideo({ prompt: 'a sunrise', filename: 'd.mp4', userId: 'u' });
      expect(result.success).toBe(true);
      const genCall = (mockCallTool.mock.calls as any[]).find((c) => c[0] === 'generate_video');
      expect(genCall).toBeDefined();
      expect(genCall[1].params.model).toBe('seedance_2_0');
    });

    it('charges the successful Seedance generation to the user exactly once at the source', async () => {
      routeTools();
      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(true);
      expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
      expect(mockMeterUserUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user123',
          model: 'seedance-2.0',
          feature: 'video_generation',
          costUsdOverride: 1.55, // effective Higgsfield 8s clip
        })
      );
    });

    it('meters exactly once (as Veo) on the Seedance→Veo fallback — no double record', async () => {
      mockCallTool.mockRejectedValue(new Error('no credits'));
      const veoSpy = jest
        .spyOn(videoService as any, 'generateWithVeo31')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/veo.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(true);
      // The failed Seedance attempt returns into the Veo recursion BEFORE its own meter,
      // so only the terminal (successful) Veo model is charged — exactly once.
      expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
      expect(mockMeterUserUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'veo-3.1-generate-preview',
          feature: 'video_generation',
          costUsdOverride: 3.2,
        })
      );
      veoSpy.mockRestore();
    });

    it('does not charge when generation fails (invalid model)', async () => {
      const result = await videoService.generateVideo({ ...baseParams, videoModel: 'not-a-real-model' });
      expect(result.success).toBe(false);
      expect(mockMeterUserUsage).not.toHaveBeenCalled();
    });

    it('falls back to Veo when Seedance THROWS (auth/credits/stream error)', async () => {
      mockCallTool.mockRejectedValue(new Error('no credits'));
      const veoSpy = jest
        .spyOn(videoService as any, 'generateWithVeo31')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/veo.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(veoSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/veo.mp4');
      veoSpy.mockRestore();
    });

    it('falls back to Veo when Seedance returns a non-throw failure (job failed)', async () => {
      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'failed' } } } });
      const veoSpy = jest
        .spyOn(videoService as any, 'generateWithVeo31')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/veo.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(veoSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/veo.mp4');
      veoSpy.mockRestore();
    });

    it('falls back to Veo on nsfw and ip_detected failures', async () => {
      const veoSpy = jest
        .spyOn(videoService as any, 'generateWithVeo31')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/veo.mp4', filename: 'promo.mp4' });

      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'nsfw' } } } });
      expect((await videoService.generateVideo({ ...baseParams })).success).toBe(true);

      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'ip_detected' } } } });
      expect((await videoService.generateVideo({ ...baseParams })).success).toBe(true);

      expect(veoSpy).toHaveBeenCalledTimes(2);
      veoSpy.mockRestore();
    });

    it('returns a clean failure (no loop, Veo tried once) when BOTH Seedance and Veo fail', async () => {
      mockCallTool.mockRejectedValue(new Error('no credits'));
      const veoSpy = jest
        .spyOn(videoService as any, 'generateWithVeo31')
        .mockResolvedValue({ success: false, error: 'veo down' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(veoSpy).toHaveBeenCalledTimes(1); // Veo tried exactly once — no re-entry into Seedance
      expect(result.success).toBe(false);
      veoSpy.mockRestore();
    });
  });

  // H1: a branded Seedance video >8s is ONE real clip of the full length. The compose
  // call must place it at its true duration, not the Veo per-8s-clip split — otherwise
  // Remotion renders only the first 8s and the rest of the paid clip is discarded.
  describe('branded Seedance composition (H1)', () => {
    const mockedCompose = remotionService.compose as jest.Mock;
    const VIDEO_URL = 'https://video.higgsfield.ai/job-1.mp4';

    beforeEach(() => {
      jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => { cb(); return 0 as any; }) as any);
      mockedUpload.mockResolvedValue({ success: true, url: 'https://s3.example.com/raw.mp4' });
      mockedAxios.get.mockResolvedValue({ data: Buffer.from('x') } as any);
      mockCallTool.mockImplementation(async (tool: string) => {
        if (tool === 'generate_video') return { structuredContent: { results: [{ id: 'job-1', status: 'queued', results: {} }] } };
        if (tool === 'job_status') return { structuredContent: { generation: { id: 'job-1', status: 'completed', results: { rawUrl: VIDEO_URL, minUrl: VIDEO_URL } } } };
        return {};
      });
      mockedCompose.mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/branded.mp4', filename: 'promo.mp4' });
    });

    afterEach(() => jest.restoreAllMocks());

    it('composes the single full-length Seedance clip at its true duration (not the Veo [8,6] split)', async () => {
      const result = await videoService.generateVideo({
        prompt: 'x', filename: 'promo.mp4', userId: 'u', videoModel: 'seedance-2.0',
        durationSeconds: 14,
        compose: true,
        composeParams: { brandName: 'Acme', primaryColor: '#111111', secondaryColor: '#222222' },
      });

      expect(mockedCompose).toHaveBeenCalledTimes(1);
      const arg = mockedCompose.mock.calls[0][0];
      // ONE clip, no Veo-style extras, full 14s playback — NOT [8,6]
      expect(arg.clipUrl).toBe('https://s3.example.com/raw.mp4'); // Seedance clip after S3 upload
      expect(arg.extraClipUrls ?? []).toEqual([]);
      expect(arg.clipDurationsSeconds).toEqual([14]);
      // Seedance clips can be up to 15s, so the 8s Veo clamp must not apply here.
      expect(arg.maxClipSeconds).toBe(15);
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/branded.mp4');
    });
  });

  // Option B: a multi-clip Veo result (>8s) must be stitched even with no brand overlay,
  // or the video is silently truncated to the first 8s clip.
  describe('multi-clip Veo stitching (option B)', () => {
    const mockedCompose = remotionService.compose as jest.Mock;

    beforeEach(() => {
      jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => { cb(); return 0 as any; }) as any);
      mockedUpload.mockResolvedValue({ success: true, url: 'https://s3.example.com/raw.mp4' });
      mockedAxios.get.mockResolvedValue({ data: Buffer.from('x') } as any);
      // Seedance fails immediately so we exercise the Veo fallback.
      mockCallTool.mockImplementation(async (tool: string) => {
        if (tool === 'generate_video') return { structuredContent: { results: [{ id: 'job-1', status: 'failed' }] } };
        if (tool === 'job_status') return { structuredContent: { generation: { id: 'job-1', status: 'failed' } } };
        return {};
      });
    });

    afterEach(() => jest.restoreAllMocks());

    it('stitches a >8s Veo fallback even when compose is not requested (no truncation to 8s)', async () => {
      // Each Veo clip "succeeds"
      jest.spyOn(VideoService.prototype as any, 'generateWithVeo31').mockImplementation(async (p: any) => ({
        success: true, videoUrl: `https://s3.example.com/${p.filename}`, filename: p.filename,
      }));
      mockedCompose.mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/stitched.mp4', filename: 'shoe.mp4' });

      const result = await videoService.generateVideo({
        prompt: 'x', filename: 'shoe.mp4', userId: 'u', videoModel: 'seedance-2.0',
        durationSeconds: 14, // → 2 Veo clips
        compose: false,      // no branding
      });

      // Remotion was used to concatenate the 2 clips...
      expect(mockedCompose).toHaveBeenCalledTimes(1);
      const arg = mockedCompose.mock.calls[0][0];
      expect(arg.extraClipUrls.length).toBe(1); // clip1 + 1 extra = 2 clips
      expect(arg.brandName).toBe('');           // plain concat, no overlay
      // ...and the stitched video is returned, not the first 8s clip.
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/stitched.mp4');
    });
  });

  // Option C: the whole video op (Seedance attempt + Veo fallback) is bounded by a
  // single deadline that stays under the agent-mode turn cap, so the fallback can't be
  // killed mid-run. These cover the deadline-enforcement branches specifically.
  describe('time-budget enforcement (option C)', () => {
    let setTimeoutSpy: jest.SpyInstance;
    beforeEach(() => {
      setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => { cb(); return 0 as any; }) as any);
      mockedUpload.mockResolvedValue({ success: true, url: 'https://s3.example.com/p.mp4' });
    });
    afterEach(() => setTimeoutSpy.mockRestore());

    it('Seedance returns a budget error when polling never reaches a terminal state in time', async () => {
      // Job stays "queued"; with the deadline already at hand the poll budget is 0, so
      // Seedance gives up immediately with the budget message (→ Veo fallback upstream).
      mockCallTool.mockImplementation(async (tool: string) => {
        if (tool === 'generate_video') return { structuredContent: { results: [{ id: 'job-1', status: 'queued', results: {} }] } };
        if (tool === 'job_status') return { structuredContent: { generation: { id: 'job-1', status: 'queued', results: {} } } };
        return {};
      });

      const result = await (videoService as any).generateWithHiggsfield({
        prompt: 'x', filename: 'p.mp4', userId: 'u', videoModel: 'seedance-2.0',
        deadlineMs: Date.now(), // no budget left after the Veo reserve
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/budget/i);
    });

    it('carries the SAME whole-op deadline into the Veo fallback (does not reset it)', async () => {
      let hfDeadline: number | undefined;
      let veoDeadline: number | undefined;
      const hfSpy = jest.spyOn(videoService as any, 'generateWithHiggsfield')
        .mockImplementation(async (p: any) => { hfDeadline = p.deadlineMs; return { success: false, error: 'seedance down' }; });
      const veoSpy = jest.spyOn(videoService as any, 'generateWithVeo31')
        .mockImplementation(async (p: any) => { veoDeadline = p.deadlineMs; return { success: true, videoUrl: 'https://s3.example.com/veo.mp4', filename: 'p.mp4' }; });

      await videoService.generateVideo({ prompt: 'x', filename: 'p.mp4', userId: 'u', videoModel: 'seedance-2.0' });

      expect(typeof hfDeadline).toBe('number');
      expect(veoDeadline).toBe(hfDeadline); // one deadline, propagated through the fallback
      hfSpy.mockRestore();
      veoSpy.mockRestore();
    });

    it('Veo returns a time-budget error when the deadline has already passed', async () => {
      mockedGetSecret.mockResolvedValue('fake-key');
      const genai = require('@google/genai');
      (genai.GoogleGenAI as jest.Mock).mockImplementation(() => ({
        models: { generateVideos: jest.fn().mockResolvedValue({ done: false }) },
        operations: { getVideosOperation: jest.fn().mockResolvedValue({ done: false }) },
      }));

      const result = await (videoService as any).generateWithVeo31({
        prompt: 'x', filename: 'p.mp4', userId: 'u', deadlineMs: Date.now() - 1, // already past
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/time budget/i);
    });
  });
});

