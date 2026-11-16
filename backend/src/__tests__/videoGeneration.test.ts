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

  describe('gemini-omni-1.1-flash via the Gemini Interactions API', () => {
    const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
    const VIDEO_B64 = Buffer.from('fake-mp4-bytes').toString('base64');
    const completed = (usage: any = undefined) => ({
      data: {
        id: 'int-1',
        status: 'completed',
        ...(usage ? { usage } : {}),
        steps: [
          { type: 'thought', content: [{ type: 'text', text: 'planning' }] },
          { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: VIDEO_B64 }] },
        ],
      },
    });
    const baseParams = { prompt: 'A cat surfing', filename: 'cat.mp4', userId: 'user123', videoModel: 'gemini-omni-1.1-flash' };
    let setTimeoutSpy: jest.SpyInstance;

    beforeEach(() => {
      mockedGetSecret.mockResolvedValue('fake-key');
      mockedUpload.mockResolvedValue({ success: true, url: 'https://s3.example.com/cat.mp4' });
      mockedAxios.post.mockResolvedValue(completed() as any);
      setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => { cb(); return 0 as any; }) as any);
    });
    afterEach(() => setTimeoutSpy.mockRestore());

    it('text-to-video: POSTs to /v1beta/interactions with model, prompt string and video response_format', async () => {
      const result = await videoService.generateVideo({ ...baseParams, aspectRatio: '9:16', resolution: '1080p' });

      expect(result.success).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, body, config] = mockedAxios.post.mock.calls[0] as any[];
      expect(url).toBe(INTERACTIONS_URL);
      expect(config.params).toEqual({ key: 'fake-key' });
      expect(body).toEqual({
        model: 'gemini-omni-1.1-flash',
        input: 'A cat surfing',
        // No duration requested → the 8s default is sent as Omni's string form.
        response_format: { type: 'video', aspect_ratio: '9:16', resolution: '1080p', duration: '8s' },
      });
    });

    it('sends response_format.duration as a "<n>s" string, rounded and clamped to 3–10s', async () => {
      const sent = async (durationSeconds: number) => {
        mockedAxios.post.mockClear();
        await videoService.generateVideo({ ...baseParams, durationSeconds });
        return (mockedAxios.post.mock.calls[0] as any[])[1].response_format.duration;
      };
      expect(await sent(5)).toBe('5s');
      expect(await sent(6.6)).toBe('7s');
      expect(await sent(10)).toBe('10s');
      expect(await sent(1)).toBe('3s');
      // Never the integer form (the API rejects {"duration":5} with 400).
      expect(typeof (await sent(5))).toBe('string');
    });

    it('decodes the base64 video from steps[].content[] and uploads the bytes to S3', async () => {
      const result = await videoService.generateVideo({ ...baseParams });

      expect(result).toMatchObject({ success: true, videoUrl: 'https://s3.example.com/cat.mp4', model: 'gemini-omni-1.1-flash' });
      const [buffer, filename, userId, mime] = mockedUpload.mock.calls[0];
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.toString()).toBe('fake-mp4-bytes');
      expect([filename, userId, mime]).toEqual(['cat.mp4', 'user123', 'video/mp4']);
    });

    it('defaults to 720p, omits aspect_ratio for auto, and maps Seedance ratios to 16:9/9:16', async () => {
      await videoService.generateVideo({ ...baseParams, resolution: '480p' });
      expect((mockedAxios.post.mock.calls[0] as any[])[1].response_format).toEqual({ type: 'video', resolution: '720p', duration: '8s' });

      await videoService.generateVideo({ ...baseParams, aspectRatio: '21:9' });
      expect((mockedAxios.post.mock.calls[1] as any[])[1].response_format.aspect_ratio).toBe('16:9');
    });

    it('image-to-video and first/last-frame interpolation send image parts (first, then last) before the text', async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: Buffer.from('first'), headers: { 'content-type': 'image/jpeg' } } as any)
        .mockResolvedValueOnce({ data: Buffer.from('last'), headers: { 'content-type': 'image/png' } } as any);

      await videoService.generateVideo({
        ...baseParams, startFrame: 'https://example.com/first.jpg', endFrame: 'https://example.com/last.png',
      });

      const body = (mockedAxios.post.mock.calls[0] as any[])[1];
      expect(body.input).toEqual([
        { type: 'image', data: Buffer.from('first').toString('base64'), mime_type: 'image/jpeg' },
        { type: 'image', data: Buffer.from('last').toString('base64'), mime_type: 'image/png' },
        { type: 'text', text: 'A cat surfing' },
      ]);
    });

    it('accepts every retired Veo id as an alias for gemini-omni-1.1-flash', async () => {
      for (const legacy of ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3-generate-preview', 'veo-3.0-generate-preview']) {
        mockedAxios.post.mockClear();
        const result = await videoService.generateVideo({ ...baseParams, videoModel: legacy });
        expect(result.success).toBe(true);
        expect(result.model).toBe('gemini-omni-1.1-flash');
        expect((mockedAxios.post.mock.calls[0] as any[])[1].model).toBe('gemini-omni-1.1-flash');
      }
    });

    it('bills the actual usage (video tokens at $17.50/M, text $9/M, input $1.50/M) exactly once', async () => {
      mockedAxios.post.mockResolvedValue(completed({
        total_input_tokens: 1000,
        total_output_tokens: 58_920,
        output_tokens_by_modality: [{ modality: 'video', tokens: 57_920 }, { modality: 'text', tokens: 1000 }],
      }) as any);

      const result = await videoService.generateVideo({ ...baseParams });

      const expected = (1000 * 1.5 + 1000 * 9 + 57_920 * 17.5) / 1e6;
      expect(result.costUsd).toBeCloseTo(expected, 10);
      expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
      expect(mockMeterUserUsage).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gemini-omni-1.1-flash', provider: 'google', feature: 'video_generation',
        inputTokens: 0, outputTokens: 0, generationCount: 1,
      }));
      expect(mockMeterUserUsage.mock.calls[0][0].costUsdOverride).toBeCloseTo(expected, 10);
    });

    it('falls back to the $0.1014/s estimate on the actual requested seconds when no usage is reported', async () => {
      const result = await videoService.generateVideo({ ...baseParams, durationSeconds: 8 });
      expect(result.costUsd).toBeCloseTo(8 * 0.1014, 10);
      expect(mockMeterUserUsage.mock.calls[0][0].costUsdOverride).toBeCloseTo(8 * 0.1014, 10);
    });

    it('fails clearly on a quota error (HTTP 429) with no fallback model and no charge', async () => {
      mockedAxios.post.mockRejectedValue({ response: { status: 429, data: { error: { message: 'Resource exhausted' } } }, message: 'Request failed' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/quota exhausted for gemini-omni-1\.1-flash/);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockMeterUserUsage).not.toHaveBeenCalled();
    });

    it('surfaces the API error message for other HTTP failures', async () => {
      mockedAxios.post.mockRejectedValue({ response: { status: 400, data: { error: { message: 'bad request field' } } }, message: 'Request failed' });
      const result = await videoService.generateVideo({ ...baseParams });
      expect(result.success).toBe(false);
      expect(result.error).toContain('bad request field');
    });

    it('fails when the interaction completes without a video part', async () => {
      mockedAxios.post.mockResolvedValue({ data: { status: 'completed', steps: [{ content: [{ type: 'text', text: 'refused' }] }] } } as any);
      const result = await videoService.generateVideo({ ...baseParams });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no video was returned/);
      expect(mockedUpload).not.toHaveBeenCalled();
    });

    it('splits >10s requests into <=10s clips, each requested at its exact length, and stitches them', async () => {
      const mockedCompose = remotionService.compose as jest.Mock;
      mockedCompose.mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/stitched.mp4', filename: 'cat.mp4' });
      mockedUpload.mockImplementation(async (_b: any, filename: string) => ({ success: true, url: `https://s3.example.com/${filename}` }));

      const result = await videoService.generateVideo({ ...baseParams, durationSeconds: 14 });

      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      const durations = (mockedAxios.post.mock.calls as any[]).map((c) => c[1].response_format.duration).sort();
      expect(durations).toEqual(['10s', '4s']);
      const arg = mockedCompose.mock.calls[0][0];
      expect(arg.clipUrl).toBe('https://s3.example.com/cat_clip1.mp4');
      expect(arg.extraClipUrls).toEqual(['https://s3.example.com/cat_clip2.mp4']);
      expect(arg.clipDurationsSeconds).toEqual([10, 4]);
      expect(arg.maxClipSeconds).toBe(10);
      expect(result.videoUrl).toBe('https://s3.example.com/stitched.mp4');
      expect(mockMeterUserUsage.mock.calls[0][0].costUsdOverride).toBeCloseTo(14 * 0.1014, 10);
      expect(mockMeterUserUsage.mock.calls[0][0].generationCount).toBe(2);
    });

    it('a remainder under 3s borrows from the previous clip so clips sum to the request (21s → 10/8/3)', async () => {
      const mockedCompose = remotionService.compose as jest.Mock;
      mockedCompose.mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/stitched.mp4', filename: 'cat.mp4' });
      mockedUpload.mockImplementation(async (_b: any, filename: string) => ({ success: true, url: `https://s3.example.com/${filename}` }));

      await videoService.generateVideo({ ...baseParams, durationSeconds: 21 });

      const byFile = Object.fromEntries((mockedUpload.mock.calls as any[]).map((c, i) =>
        [c[1], (mockedAxios.post.mock.calls[i] as any[])[1].response_format.duration]));
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
      expect(Object.values(byFile).sort()).toEqual(['10s', '3s', '8s']);
      expect(mockedCompose.mock.calls[0][0].clipDurationsSeconds).toEqual([10, 8, 3]);
      expect(mockMeterUserUsage.mock.calls[0][0].costUsdOverride).toBeCloseTo(21 * 0.1014, 10);
    });
  });

  describe('Model Validation', () => {
    it('should reject an unsupported model', async () => {
      const result = await videoService.generateVideo({
        prompt: 'Test',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'not-a-real-model',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid videoModel 'not-a-real-model'");
      expect(result.error).toContain('gemini-omni-1.1-flash, seedance-2.0');
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

    it('treats ip_detected as a gated failure (→ triggers Omni fallback upstream)', async () => {
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
    // the paid clip and trigger a full Omni regen — retry the download/upload instead.
    it('retries a transient S3 upload failure instead of falling back to Omni (no double spend)', async () => {
      routeTools();
      mockedUpload
        .mockResolvedValueOnce({ success: false, error: 'transient S3 error' })
        .mockResolvedValueOnce({ success: true, url: 'https://s3.example.com/retried.mp4' });
      const omniSpy = jest.spyOn(videoService as any, 'generateWithOmni');

      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/retried.mp4');
      expect(mockedUpload).toHaveBeenCalledTimes(2); // first failed, retry succeeded
      expect(omniSpy).not.toHaveBeenCalled();          // paid Seedance clip reused, not regenerated
      omniSpy.mockRestore();
    });

    it('falls back to Omni only after the upload retries are exhausted', async () => {
      routeTools();
      mockedUpload.mockResolvedValue({ success: false, error: 'S3 down' });
      const omniSpy = jest.spyOn(videoService as any, 'generateWithOmni')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/omni.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(mockedUpload.mock.calls.length).toBeGreaterThanOrEqual(3); // retried before giving up
      expect(omniSpy).toHaveBeenCalledTimes(1);
      expect(result.videoUrl).toBe('https://s3.example.com/omni.mp4');
      omniSpy.mockRestore();
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

    it('meters exactly once (as Omni) on the Seedance→Omni fallback — no double record', async () => {
      mockCallTool.mockRejectedValue(new Error('no credits'));
      const omniSpy = jest
        .spyOn(videoService as any, 'generateWithOmni')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/omni.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(result.success).toBe(true);
      // The failed Seedance attempt returns into the Omni recursion BEFORE its own meter,
      // so only the terminal (successful) Omni model is charged — exactly once.
      expect(mockMeterUserUsage).toHaveBeenCalledTimes(1);
      expect(mockMeterUserUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-omni-1.1-flash',
          feature: 'video_generation',
          costUsdOverride: expect.closeTo(8 * 0.1014, 10), // default 8s at $0.1014/s
        })
      );
      expect(result.model).toBe('gemini-omni-1.1-flash');
      omniSpy.mockRestore();
    });

    it('does not charge when generation fails (invalid model)', async () => {
      const result = await videoService.generateVideo({ ...baseParams, videoModel: 'not-a-real-model' });
      expect(result.success).toBe(false);
      expect(mockMeterUserUsage).not.toHaveBeenCalled();
    });

    it('falls back to Omni when Seedance THROWS (auth/credits/stream error)', async () => {
      mockCallTool.mockRejectedValue(new Error('no credits'));
      const omniSpy = jest
        .spyOn(videoService as any, 'generateWithOmni')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/omni.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(omniSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/omni.mp4');
      omniSpy.mockRestore();
    });

    it('falls back to Omni when Seedance returns a non-throw failure (job failed)', async () => {
      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'failed' } } } });
      const omniSpy = jest
        .spyOn(videoService as any, 'generateWithOmni')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/omni.mp4', filename: 'promo.mp4' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(omniSpy).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/omni.mp4');
      omniSpy.mockRestore();
    });

    it('falls back to Omni on nsfw and ip_detected failures', async () => {
      const omniSpy = jest
        .spyOn(videoService as any, 'generateWithOmni')
        .mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/omni.mp4', filename: 'promo.mp4' });

      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'nsfw' } } } });
      expect((await videoService.generateVideo({ ...baseParams })).success).toBe(true);

      routeTools({ job_status: { structuredContent: { generation: { id: 'job-1', status: 'ip_detected' } } } });
      expect((await videoService.generateVideo({ ...baseParams })).success).toBe(true);

      expect(omniSpy).toHaveBeenCalledTimes(2);
      omniSpy.mockRestore();
    });

    it('returns a clean failure (no loop, Omni tried once) when BOTH Seedance and Omni fail', async () => {
      mockCallTool.mockRejectedValue(new Error('no credits'));
      const omniSpy = jest
        .spyOn(videoService as any, 'generateWithOmni')
        .mockResolvedValue({ success: false, error: 'omni down' });

      const result = await videoService.generateVideo({ ...baseParams });

      expect(omniSpy).toHaveBeenCalledTimes(1); // Omni tried exactly once — no re-entry into Seedance
      expect(result.success).toBe(false);
      omniSpy.mockRestore();
    });
  });

  // H1: a branded Seedance video >10s is ONE real clip of the full length. The compose
  // call must place it at its true duration, not the Omni per-10s-clip split — otherwise
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

    it('composes the single full-length Seedance clip at its true duration (not the Omni [10,4] split)', async () => {
      const result = await videoService.generateVideo({
        prompt: 'x', filename: 'promo.mp4', userId: 'u', videoModel: 'seedance-2.0',
        durationSeconds: 14,
        compose: true,
        composeParams: { brandName: 'Acme', primaryColor: '#111111', secondaryColor: '#222222' },
      });

      expect(mockedCompose).toHaveBeenCalledTimes(1);
      const arg = mockedCompose.mock.calls[0][0];
      // ONE clip, no Omni-style extras, full 14s playback — NOT [10,4]
      expect(arg.clipUrl).toBe('https://s3.example.com/raw.mp4'); // Seedance clip after S3 upload
      expect(arg.extraClipUrls ?? []).toEqual([]);
      expect(arg.clipDurationsSeconds).toEqual([14]);
      // Seedance clips can be up to 15s, so the 10s Omni clamp must not apply here.
      expect(arg.maxClipSeconds).toBe(15);
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/branded.mp4');
    });
  });

  // Option B: a multi-clip Omni result (>10s) must be stitched even with no brand overlay,
  // or the video is silently truncated to the first clip.
  describe('multi-clip Omni stitching (option B)', () => {
    const mockedCompose = remotionService.compose as jest.Mock;

    beforeEach(() => {
      jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => { cb(); return 0 as any; }) as any);
      mockedUpload.mockResolvedValue({ success: true, url: 'https://s3.example.com/raw.mp4' });
      mockedAxios.get.mockResolvedValue({ data: Buffer.from('x') } as any);
      // Seedance fails immediately so we exercise the Omni fallback.
      mockCallTool.mockImplementation(async (tool: string) => {
        if (tool === 'generate_video') return { structuredContent: { results: [{ id: 'job-1', status: 'failed' }] } };
        if (tool === 'job_status') return { structuredContent: { generation: { id: 'job-1', status: 'failed' } } };
        return {};
      });
    });

    afterEach(() => jest.restoreAllMocks());

    it('stitches a >10s Omni fallback even when compose is not requested (no truncation to 10s)', async () => {
      // Each Omni clip "succeeds"
      jest.spyOn(VideoService.prototype as any, 'generateWithOmni').mockImplementation(async (p: any) => ({
        success: true, videoUrl: `https://s3.example.com/${p.filename}`, filename: p.filename,
      }));
      mockedCompose.mockResolvedValue({ success: true, videoUrl: 'https://s3.example.com/stitched.mp4', filename: 'shoe.mp4' });

      const result = await videoService.generateVideo({
        prompt: 'x', filename: 'shoe.mp4', userId: 'u', videoModel: 'seedance-2.0',
        durationSeconds: 14, // → 2 Omni clips
        compose: false,      // no branding
      });

      // Remotion was used to concatenate the 2 clips...
      expect(mockedCompose).toHaveBeenCalledTimes(1);
      const arg = mockedCompose.mock.calls[0][0];
      expect(arg.extraClipUrls.length).toBe(1); // clip1 + 1 extra = 2 clips
      expect(arg.brandName).toBe('');           // plain concat, no overlay
      // ...and the stitched video is returned, not the first clip.
      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/stitched.mp4');
    });
  });

  // Option C: the whole video op (Seedance attempt + Omni fallback) is bounded by a
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
      // Seedance gives up immediately with the budget message (→ Omni fallback upstream).
      mockCallTool.mockImplementation(async (tool: string) => {
        if (tool === 'generate_video') return { structuredContent: { results: [{ id: 'job-1', status: 'queued', results: {} }] } };
        if (tool === 'job_status') return { structuredContent: { generation: { id: 'job-1', status: 'queued', results: {} } } };
        return {};
      });

      const result = await (videoService as any).generateWithHiggsfield({
        prompt: 'x', filename: 'p.mp4', userId: 'u', videoModel: 'seedance-2.0',
        deadlineMs: Date.now(), // no budget left after the Omni reserve
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/budget/i);
    });

    it('carries the SAME whole-op deadline into the Omni fallback (does not reset it)', async () => {
      let hfDeadline: number | undefined;
      let omniDeadline: number | undefined;
      const hfSpy = jest.spyOn(videoService as any, 'generateWithHiggsfield')
        .mockImplementation(async (p: any) => { hfDeadline = p.deadlineMs; return { success: false, error: 'seedance down' }; });
      const omniSpy = jest.spyOn(videoService as any, 'generateWithOmni')
        .mockImplementation(async (p: any) => { omniDeadline = p.deadlineMs; return { success: true, videoUrl: 'https://s3.example.com/omni.mp4', filename: 'p.mp4' }; });

      await videoService.generateVideo({ prompt: 'x', filename: 'p.mp4', userId: 'u', videoModel: 'seedance-2.0' });

      expect(typeof hfDeadline).toBe('number');
      expect(omniDeadline).toBe(hfDeadline); // one deadline, propagated through the fallback
      hfSpy.mockRestore();
      omniSpy.mockRestore();
    });

    it('Omni returns a time-budget error (without calling the API) when the deadline has already passed', async () => {
      mockedGetSecret.mockResolvedValue('fake-key');

      const result = await (videoService as any).generateWithOmni({
        prompt: 'x', filename: 'p.mp4', userId: 'u', deadlineMs: Date.now() - 1, // already past
      });

      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/time budget/i);
    });
  });
});

