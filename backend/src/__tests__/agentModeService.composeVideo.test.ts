// Unit tests for composeVideo function in agentModeService

import { AgentModeService } from '../services/agentModeService';
import * as remotionServiceModule from '../services/remotionService';

jest.mock('../services/remotionService', () => ({
  remotionService: {
    compose: jest.fn(),
  },
  RemotionComposeParams: {},
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addToolCostToSession: jest.fn().mockResolvedValue({}),
  }
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
  })),
}));

const mockRemotionService = (remotionServiceModule as any).remotionService;

describe('AgentModeService - composeVideo', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
  });

  const baseComposeParams = {
    brandName: 'TestBrand',
    primaryColor: '#123456',
    secondaryColor: '#abcdef',
  };

  describe('Invalid inputs', () => {
    it('should fail when clip_urls is empty', async () => {
      const result = await (agentModeService as any).composeVideo(
        [],
        'out.mp4',
        'user1',
        'session1',
        baseComposeParams
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_clip_urls');
    });

    it('should fail when clip_urls is null', async () => {
      const result = await (agentModeService as any).composeVideo(
        null,
        'out.mp4',
        'user1',
        'session1',
        baseComposeParams
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_clip_urls');
    });

    it('should return failure when remotionService.compose fails', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: false,
        error: 'Remotion render error',
      });

      const result = await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'out.mp4',
        'user1',
        'session1',
        baseComposeParams
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Remotion render error');
    });
  });

  describe('Successful composition', () => {
    it('should compose a single clip with brand overlays', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true,
        videoUrl: 'https://s3.example.com/final.mp4',
        filename: 'final.mp4',
      });

      const result = await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'final.mp4',
        'user1',
        'session1',
        baseComposeParams
      );

      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://s3.example.com/final.mp4');
      expect(mockRemotionService.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          clipUrl: 'https://s3.example.com/clip1.mp4',
          extraClipUrls: [],
          brandName: 'TestBrand',
          primaryColor: '#123456',
          secondaryColor: '#abcdef',
          filename: 'final.mp4',
          userId: 'user1',
        })
      );
    });

    it('should stitch multiple clips correctly (first clip → clipUrl, rest → extraClipUrls)', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true,
        videoUrl: 'https://s3.example.com/stitched.mp4',
        filename: 'stitched.mp4',
      });

      const clips = [
        'https://s3.example.com/clip1.mp4',
        'https://s3.example.com/clip2.mp4',
        'https://s3.example.com/clip3.mp4',
      ];

      await (agentModeService as any).composeVideo(
        clips,
        'stitched.mp4',
        'user1',
        'session1',
        baseComposeParams,
        8
      );

      expect(mockRemotionService.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          clipUrl: 'https://s3.example.com/clip1.mp4',
          extraClipUrls: [
            'https://s3.example.com/clip2.mp4',
            'https://s3.example.com/clip3.mp4',
          ],
          clipDurationSeconds: 8,
        })
      );
    });

    it('should default clipDurationSeconds to 8 when not provided', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true,
        videoUrl: 'https://s3.example.com/out.mp4',
        filename: 'out.mp4',
      });

      await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'out.mp4',
        'user1',
        'session1',
        baseComposeParams
        // no clipDurationSeconds
      );

      expect(mockRemotionService.compose).toHaveBeenCalledWith(
        expect.objectContaining({ clipDurationSeconds: 8 })
      );
    });

    it('should pass optional brand fields (tagline, logoUrl, ctaText, ctaUrl)', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true,
        videoUrl: 'https://s3.example.com/out.mp4',
        filename: 'out.mp4',
      });

      await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'out.mp4',
        'user1',
        'session1',
        {
          ...baseComposeParams,
          tagline: 'Our tagline',
          logoUrl: 'https://cdn.example.com/logo.png',
          ctaText: 'Start free trial',
          ctaUrl: 'example.com',
        }
      );

      expect(mockRemotionService.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          tagline: 'Our tagline',
          logoUrl: 'https://cdn.example.com/logo.png',
          ctaText: 'Start free trial',
          ctaUrl: 'example.com',
        })
      );
    });

    // Regression (ENG-123): the compose_video tool advertises audio_url/audio_volume
    // and remotionService.compose + the BrandedVideo composition both support an audio
    // track, but composeVideo used to enumerate brand fields and silently drop the
    // voiceover — so a spot composed via compose_video shipped SILENT.
    it('should forward voiceover audioUrl and audioVolume to remotionService.compose', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true,
        videoUrl: 'https://s3.example.com/out.mp4',
        filename: 'out.mp4',
      });

      await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'out.mp4',
        'user1',
        'session1',
        {
          ...baseComposeParams,
          audioUrl: 'https://s3.example.com/voiceover.mp3',
          audioVolume: 0.8,
        }
      );

      expect(mockRemotionService.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          audioUrl: 'https://s3.example.com/voiceover.mp3',
          audioVolume: 0.8,
        })
      );
    });

    // Boundary/regression (ENG-123): audioVolume === 0 is a falsy value. The pre-fix
    // code that enumerated brand fields and omitted the audio track entirely — or any
    // truthiness guard like `if (audioVolume)` — would drop it. Asserting the explicit
    // 0 is forwarded together with its audioUrl fails on the unfixed (audio-dropping)
    // code, so this is a real regression guard rather than a tautology.
    it('should forward audioUrl with a boundary audioVolume of 0 (not drop a falsy volume)', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true,
        videoUrl: 'https://s3.example.com/out.mp4',
        filename: 'out.mp4',
      });

      await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'out.mp4',
        'user1',
        'session1',
        {
          ...baseComposeParams,
          audioUrl: 'https://s3.example.com/voiceover.mp3',
          audioVolume: 0,
        }
      );

      const passed = mockRemotionService.compose.mock.calls[0][0];
      expect(passed.audioUrl).toBe('https://s3.example.com/voiceover.mp3');
      expect(passed.audioVolume).toBe(0);
    });
  });

  // ENG-123: detached-handoff passthrough. When a render can't finish in the run's
  // remaining budget, remotionService returns status:'processing' with the deterministic
  // URL. composeVideo must surface that as a usable success (URL + "still finalizing"
  // note) rather than treating the non-final result as a failure.
  describe('detached-handoff (status: processing)', () => {
    it('surfaces a processing render as success with the detached URL and message', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true,
        status: 'processing',
        videoUrl: 'https://s3.us-east-1.amazonaws.com/bucket/renders/r1/out.mp4',
        filename: 'out.mp4',
        message: 'The video is still finalizing and will be ready at this link in a minute or two — no need to regenerate it.',
      });

      const result = await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'out.mp4',
        'user1',
        'session1',
        { ...baseComposeParams, audioUrl: 'https://s3.example.com/vo.mp3' }
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('processing');
      expect(result.videoUrl).toBe('https://s3.us-east-1.amazonaws.com/bucket/renders/r1/out.mp4');
      expect(result.message).toMatch(/finalizing|ready at this link/i);
    });

    it('forwards renderDeadlineMs from composeParams to remotionService.compose', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true, status: 'complete', videoUrl: 'https://s3.example.com/final.mp4', filename: 'final.mp4',
      });
      const deadline = 1_700_000_000_000;

      await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'final.mp4',
        'user1',
        'session1',
        { ...baseComposeParams, audioUrl: 'https://s3.example.com/vo.mp3', renderDeadlineMs: deadline }
      );

      expect(mockRemotionService.compose).toHaveBeenCalledWith(
        expect.objectContaining({ renderDeadlineMs: deadline })
      );
    });
  });

  // ENG-123 regression tripwire: a spot must never silently ship without a voiceover.
  // composeVideo returns a soft `warning` when composed with no audioUrl — this catches
  // revision passes where the agent recomposes and forgets to re-attach the VO. It is a
  // nudge, not a hard failure (silent b-roll is still allowed to compose).
  describe('voiceover tripwire', () => {
    it('warns when a spot is composed with no audioUrl', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true, status: 'complete', videoUrl: 'https://s3.example.com/final.mp4', filename: 'final.mp4',
      });

      const result = await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4', 'https://s3.example.com/clip2.mp4'],
        'final.mp4',
        'user1',
        'session1',
        baseComposeParams // no audioUrl
      );

      expect(result.success).toBe(true);
      expect(typeof result.warning).toBe('string');
      expect(result.warning).toMatch(/voiceover|audio/i);
    });

    it('does NOT warn when an audioUrl is present', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true, status: 'complete', videoUrl: 'https://s3.example.com/final.mp4', filename: 'final.mp4',
      });

      const result = await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4'],
        'final.mp4',
        'user1',
        'session1',
        { ...baseComposeParams, audioUrl: 'https://s3.example.com/vo.mp3' }
      );

      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  // ENG-123 graceful UX: when the composition is clamped shorter than the requested
  // target (clips didn't cover the full length), remotionService returns a `warning`.
  // composeVideo must surface it to the user so they aren't silently handed a shorter
  // video than they asked for — and it must combine cleanly with the voiceover warning.
  describe('duration-clamp warning', () => {
    it('surfaces the composition duration warning to the user', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true, status: 'complete', videoUrl: 'https://s3.example.com/final.mp4', filename: 'final.mp4',
        warning: 'Requested 30s but the clip footage only totals 16s, so the video was trimmed to 16s.',
      });

      const result = await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4', 'https://s3.example.com/clip2.mp4'],
        'final.mp4', 'user1', 'session1',
        { ...baseComposeParams, audioUrl: 'https://s3.example.com/vo.mp3', targetDurationSeconds: 30 }
      );

      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/trimmed to 16s|only totals 16s/i);
    });

    it('combines the duration warning with the voiceover warning when both apply', async () => {
      mockRemotionService.compose.mockResolvedValue({
        success: true, status: 'complete', videoUrl: 'https://s3.example.com/final.mp4', filename: 'final.mp4',
        warning: 'Requested 30s but the clip footage only totals 16s, so the video was trimmed to 16s.',
      });

      const result = await (agentModeService as any).composeVideo(
        ['https://s3.example.com/clip1.mp4', 'https://s3.example.com/clip2.mp4'],
        'final.mp4', 'user1', 'session1',
        { ...baseComposeParams, targetDurationSeconds: 30 } // no audioUrl
      );

      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/trimmed to 16s/i);   // duration warning
      expect(result.warning).toMatch(/voiceover|audio/i);  // voiceover warning
    });
  });

  describe('Tool registration', () => {
    it('should have compose_video tool registered', () => {
      const tools = agentModeService.getAvailableTools();
      const tool = tools.find((t: any) => t.function?.name === 'compose_video');
      expect(tool).toBeDefined();
      expect(tool!.function.parameters.properties.clip_urls).toBeDefined();
      expect(tool!.function.parameters.properties.brand_name).toBeDefined();
      expect(tool!.function.parameters.properties.primary_color).toBeDefined();
      expect(tool!.function.parameters.properties.secondary_color).toBeDefined();
    });
  });
});
