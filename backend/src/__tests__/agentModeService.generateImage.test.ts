// Unit tests for generate_image function in agentModeService

import { AgentModeService } from '../services/agentModeService';
import * as autoHumanEvalService from '../services/autoHumanEvalService';
import * as imageGeneration from '../services/imageGeneration';
import { evaluateCreativeGates } from '../services/creativeGates';
import { resolveModelForUser } from '../services/modelRoles';
// ENG-2103 (F2 design-decision-list follow-up, Pattern A): generateImage's
// body now lives here; AgentModeService.prototype.generateImage is a thin
// delegating wrapper.
import * as mediaVideoImpl from '../emma/impl/mediaVideo';

// Mock dependencies
jest.mock('../services/imageGeneration');
// Workload-default resolution (org role, then the AW-Settings admin default) is
// covered in modelRoles.test.ts; here it is the seam generateImage calls.
jest.mock('../services/modelRoles');
// Prod's admin-configured image default (agent_mode_image_api_default_model).
const ADMIN_IMAGE_DEFAULT = 'gemini-3.1-flash-image-preview';
beforeEach(() => {
  jest.mocked(resolveModelForUser).mockResolvedValue(ADMIN_IMAGE_DEFAULT);
});
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addToolCostToSession: jest.fn().mockResolvedValue({}),
  }
}));
describe('AgentModeService - generate_image function', () => {
  let agentModeService: AgentModeService;
  let mockImageService: any;
  let enqueueAutoHumanEvalSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    enqueueAutoHumanEvalSpy = jest
      .spyOn(autoHumanEvalService, 'enqueueAutoHumanEval')
      .mockResolvedValue(null as any);
    
    // Mock imageService
    mockImageService = {
      generateImage: jest.fn(),
      isAvailable: jest.fn().mockResolvedValue(true)
    };
    
    (imageGeneration.imageService as any).isAvailable = mockImageService.isAvailable;
    (imageGeneration.imageService as any).generateImage = mockImageService.generateImage;

    // Create AgentModeService instance
    agentModeService = new AgentModeService();
  });

  afterEach(() => {
    enqueueAutoHumanEvalSpy?.mockRestore();
  });

  describe('Size Parameter Handling', () => {
    it('sends successful image generations to Matt for human eval without blocking the result', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024:1024',
        'medium',
        [],
        'user123',
        'session123',
        'gemini-3-pro-image-preview'
      , undefined, undefined, 'ad');

      expect(result.success).toBe(true);
      expect(enqueueAutoHumanEvalSpy).toHaveBeenCalledWith(expect.objectContaining({
        reviewType: 'creative_image',
        userId: 'user123',
        sessionId: 'session123',
        artifactUrl: 'https://example.com/image.png',
        originalRequest: 'Test prompt',
        outputSummary: expect.stringContaining('test.png'),
        sourceKey: expect.stringContaining('image:session123:test.png'),
        action: expect.objectContaining({
          type: 'agent_mode_image_revision',
          sessionId: 'session123',
          userId: 'user123',
          artifactUrl: 'https://example.com/image.png',
        }),
      }));
    });

    it('stores the generation-time creative gate result on the human-eval candidate (ENG-2139)', async () => {
      const gates = evaluateCreativeGates(
        { bytes: 2048, decoded: true, width: 1024, height: 1024, format: 'png', luminanceStdDev: 30 },
        { requestedSize: '9:16' },
      );
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/story.png',
        filename: 'story.png',
        gates,
      });
      const service = agentModeService as unknown as {
        generateImage(...args: unknown[]): Promise<{ success: boolean }>;
      };

      const result = await service.generateImage('Story ad', 'story.png', '9:16', 'medium', [], 'user123', 'session123', 'gemini-3-pro-image-preview', undefined, undefined, 'ad');

      expect(result).toMatchObject({ success: true });
      expect(enqueueAutoHumanEvalSpy).toHaveBeenCalledWith(expect.objectContaining({ creativeGates: gates }));
    });

    it('gives the rubric judge the generation request as the creative brief (ENG-2140)', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/demo-ad.png',
        filename: 'demo-ad.png',
      });
      const service = agentModeService as unknown as {
        generateImage(...args: unknown[]): Promise<{ success: boolean }>;
      };

      await service.generateImage('Demo ad for Acme, CTA Book a demo', 'demo-ad.png', '1080x1350', 'medium', [], 'user123', 'session123', 'gemini-3-pro-image-preview', undefined, undefined, 'ad');

      expect(enqueueAutoHumanEvalSpy).toHaveBeenCalledWith(expect.objectContaining({
        category: 'ad',
        creativeBrief: { generationRequest: 'Demo ad for Acme, CTA Book a demo' },
      }));
    });

    it('should pass size parameter as-is without modification', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024:1024', // Using : format
        'medium',
        [],
        'user123',
        'session123',
        'gemini_2.5_flash'
      , undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024:1024',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: 'gemini_2.5_flash'
      });

      expect(result.success).toBe(true);
    });

    it('should preserve x format for Runway Gemini ratios', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '832x1248', // Using x format
        'medium',
        [],
        'user123',
        'session123',
        'gemini_2.5_flash'
      , undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '832x1248',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: 'gemini_2.5_flash'
      });

      expect(result.success).toBe(true);
    });

    it('should handle auto size', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        'auto',
        'medium',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: 'auto',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: ADMIN_IMAGE_DEFAULT
      });

      expect(result.success).toBe(true);
    });

    it('should use default size when not provided', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        undefined, // No size provided
        'medium',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      // Should pass undefined, which will trigger default behavior in imageService
      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: undefined,
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: ADMIN_IMAGE_DEFAULT
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Placement parameter (ENG-2187)', () => {
    const call = (placement: string | undefined) =>
      (agentModeService as unknown as {
        generateImage: (...args: unknown[]) => Promise<{ success: boolean }>;
      }).generateImage(
        'Ad prompt', 'ad.png', '1:1', 'medium', [], 'user123', 'session123',
        'gemini-3-pro-image-preview', undefined, undefined, 'ad', undefined, placement,
      );

    it('passes a declared placement to the image service so the gates size against it', async () => {
      mockImageService.generateImage.mockResolvedValue({ success: true, imageUrl: 'https://example.com/a.png', filename: 'ad.png' });

      await call('meta_story_reel');

      expect(mockImageService.generateImage).toHaveBeenCalledWith(expect.objectContaining({ placement: 'meta_story_reel' }));
    });

    it('drops an unknown placement instead of passing it on', async () => {
      mockImageService.generateImage.mockResolvedValue({ success: true, imageUrl: 'https://example.com/a.png', filename: 'ad.png' });

      await call('tiktok_feed');

      expect(mockImageService.generateImage.mock.calls[0][0]).not.toHaveProperty('placement');
    });
  });

  describe('Model Parameter Handling', () => {
    it('should pass imageModel parameter to imageService', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123',
        'gen4_image'
      , undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: 'gen4_image'
      });

      expect(result.success).toBe(true);
    });

    it('should handle all supported models', async () => {
      const models = ['gpt-image-1', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gen4_image', 'gemini_2.5_flash'];
      
      for (const model of models) {
        mockImageService.generateImage.mockResolvedValue({
          success: true,
          imageUrl: 'https://example.com/image.png',
          filename: 'test.png'
        });

        const result = await (agentModeService as any).generateImage(
          'Test prompt',
          'test.png',
          'auto',
          'medium',
          [],
          'user123',
          'session123',
          model
        , undefined, undefined, 'ad');

        expect(mockImageService.generateImage).toHaveBeenCalledWith(
          expect.objectContaining({
            imageModel: model
          })
        );

        expect(result.success).toBe(true);
      }
    });

    it('should handle Gemini 3 Pro Image model with aspect ratio sizes', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const aspectRatios = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'];
      
      for (const ratio of aspectRatios) {
        const result = await (agentModeService as any).generateImage(
          'Test prompt',
          'test.png',
          ratio,
          'medium',
          [],
          'user123',
          'session123',
          'gemini-3-pro-image-preview'
        , undefined, undefined, 'ad');

        expect(mockImageService.generateImage).toHaveBeenCalledWith({
          prompt: 'Test prompt',
          filename: 'test.png',
          size: ratio,
          quality: 'medium',
          inputImages: [],
          logoImage: undefined,
          userId: 'user123',
          imageModel: 'gemini-3-pro-image-preview'
        });

        expect(result.success).toBe(true);
      }
    });
  });

  describe('Input Images Handling', () => {
    it('should pass input images array to imageService', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const inputImages = ['https://example.com/image1.jpg', 'https://example.com/image2.jpg'];

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium',
        inputImages,
        'user123',
        'session123',
        undefined, // imageModel
        undefined, // logoImage
        true       // confirm: bypass the image-edit confirmation gate
      , 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: inputImages,
        logoImage: undefined,
        userId: 'user123',
        imageModel: ADMIN_IMAGE_DEFAULT
      });

      expect(result.success).toBe(true);
    });

    it('should handle empty input images array', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: ADMIN_IMAGE_DEFAULT
      });

      expect(result.success).toBe(true);
    });

    it('should handle multiple input images for combined image generation', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/combined-image.png',
        filename: 'combined.png'
      });

      // Example: combining current image with logo
      const inputImages = [
        'https://example.com/current-image.jpg',
        'https://example.com/logo.png'
      ];

      const result = await (agentModeService as any).generateImage(
        'Add the logo to the top right corner of the image',
        'combined.png',
        '1024x1024',
        'medium',
        inputImages,
        'user123',
        'session123',
        'gemini-3-pro-image-preview',
        undefined, // logoImage
        true       // confirm: bypass the image-edit confirmation gate
      , 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Add the logo to the top right corner of the image',
        filename: 'combined.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: inputImages,
        logoImage: undefined,
        userId: 'user123',
        imageModel: 'gemini-3-pro-image-preview'
      });

      expect(result.success).toBe(true);
    });

    it('should handle multiple input images with different models', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/combined-image.png',
        filename: 'combined.png'
      });

      const inputImages = [
        'https://example.com/image1.jpg',
        'https://example.com/image2.jpg',
        'https://example.com/image3.jpg'
      ];

      const models = ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];
      
      for (const model of models) {
        const result = await (agentModeService as any).generateImage(
          'Combine these images into one',
          'combined.png',
          'auto',
          'medium',
          inputImages,
          'user123',
          'session123',
          model,
          undefined, // logoImage
          true       // confirm: bypass the image-edit confirmation gate
        , 'ad');

        expect(mockImageService.generateImage).toHaveBeenCalledWith(
          expect.objectContaining({
            inputImages: inputImages,
            imageModel: model
          })
        );

        expect(result.success).toBe(true);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle imageService unavailable', async () => {
      mockImageService.isAvailable.mockResolvedValue(false);

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(result.success).toBe(false);
      expect(result.message).toContain('not available');
    });

    it('should handle imageService generation failure', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: false,
        error: 'Generation failed'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Generation failed');
    });

    it('should retry fresh image generation timeouts with a fallback model only when no model was explicit', async () => {
      mockImageService.generateImage
        .mockResolvedValueOnce({
          success: false,
          error: 'Failed to generate image: Image generation with gemini-3-pro-image-preview timed out after 600 seconds'
        })
        .mockResolvedValueOnce({
          success: true,
          imageUrl: 'https://example.com/fallback-image.png',
          filename: 'fallback.png'
        });

      const result = await (agentModeService as any).generateImage(
        'A clean product launch graphic',
        'launch.png',
        '1024x1024',
        'high',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://example.com/fallback-image.png');
      expect(result.fallbackUsed).toBe(true);
      expect(result.imageModel).toBe('gpt-image-2');
      expect(result.quality).toBe('medium');
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(2);
      expect(mockImageService.generateImage).toHaveBeenNthCalledWith(2, {
        prompt: 'A clean product launch graphic',
        filename: 'launch.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: 'gpt-image-2'
      });
    });

    it('should not retry thrown transient image generation errors when the model was explicit', async () => {
      mockImageService.generateImage
        .mockRejectedValueOnce(new Error('gpt-image-2 API failed: 503 temporarily unavailable'));

      const result = await (agentModeService as any).generateImage(
        'A clean product launch graphic',
        'launch.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123',
        'gpt-image-2'
      , undefined, undefined, 'ad');

      expect(result.success).toBe(false);
      expect(result.error).toContain('503 temporarily unavailable');
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(1);
    });

    it('should retry thrown transient image generation errors when model selection was implicit', async () => {
      mockImageService.generateImage
        .mockRejectedValueOnce(new Error('gemini-3-pro-image-preview API failed: 503 temporarily unavailable'))
        .mockResolvedValueOnce({
          success: true,
          imageUrl: 'https://example.com/fallback-image.png',
          filename: 'fallback.png'
        });

      const result = await (agentModeService as any).generateImage(
        'A clean product launch graphic',
        'launch.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(result.success).toBe(true);
      expect(result.fallbackUsed).toBe(true);
      expect(result.imageModel).toBe('gpt-image-2');
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(2);
    });

    it('should not switch providers for confirmed image edits with source images', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: false,
        error: 'Failed to generate image: Image generation with gemini-3-pro-image-preview timed out after 600 seconds'
      });

      const result = await (agentModeService as any).generateImage(
        'Add this logo to the existing image',
        'edited.png',
        '1024x1024',
        'medium',
        ['https://example.com/source.png'],
        'user123',
        'session123',
        'gemini-3-pro-image-preview',
        undefined,
        true
      , 'ad');

      expect(result.success).toBe(false);
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(1);
    });

    it('should not retry non-retryable safety or policy failures', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: false,
        error: 'Safety policy blocked this image prompt'
      });

      const result = await (agentModeService as any).generateImage(
        'Unsafe prompt',
        'blocked.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123',
        'gemini-3-pro-image-preview'
      , undefined, undefined, 'ad');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Safety policy blocked this image prompt');
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(1);
    });

    it('should handle imageService exceptions', async () => {
      mockImageService.generateImage.mockRejectedValue(new Error('Service error'));

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Service error');
    });
  });

  describe('Quality Parameter Handling', () => {
    it('should pass quality parameter to imageService', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'high',
        [],
        'user123',
        'session123',
        'gpt-image-1'
      , undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024x1024',
        quality: 'high',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: 'gpt-image-1'
      });

      expect(result.success).toBe(true);
    });

    it('should pass quality parameter for Gemini 3 Pro', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '16:9',
        'low',
        [],
        'user123',
        'session123',
        'gemini-3-pro-image-preview'
      , undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '16:9',
        quality: 'low',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: 'gemini-3-pro-image-preview'
      });

      expect(result.success).toBe(true);
    });

    it('should use medium as default quality when quality is not specified in function call', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      // The function signature requires quality, but we can test that medium is the expected default
      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium', // Default quality
        [],
        'user123',
        'session123'
      , undefined, undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          quality: 'medium'
        })
      );

      expect(result.success).toBe(true);
    });

    it('should accept all valid quality values (low, medium, high)', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const validQualities = ['low', 'medium', 'high'];

      for (const quality of validQualities) {
        jest.clearAllMocks();

        const result = await (agentModeService as any).generateImage(
          'Test prompt',
          'test.png',
          '1024x1024',
          quality,
          [],
          'user123',
          'session123',
          'gpt-image-1'
        , undefined, undefined, 'ad');

        expect(mockImageService.generateImage).toHaveBeenCalledWith(
          expect.objectContaining({
            quality: quality
          })
        );

        expect(result.success).toBe(true);
      }
    });
  });

  describe('Logo Image Parameter Handling', () => {
    it('should pass logoImage parameter to imageService when provided', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image-with-logo.png',
        filename: 'branded.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Create a banner with the company logo',
        'branded.png',
        '16:9',
        'high',
        ['https://example.com/background.jpg'],
        'user123',
        'session123',
        'gemini-3-pro-image-preview',
        'https://example.com/logo.png',
        true // confirm: bypass the image-edit confirmation gate
      , 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Create a banner with the company logo',
        filename: 'branded.png',
        size: '16:9',
        quality: 'high',
        inputImages: ['https://example.com/background.jpg'],
        logoImage: 'https://example.com/logo.png',
        userId: 'user123',
        imageModel: 'gemini-3-pro-image-preview'
      });

      expect(result.success).toBe(true);
    });

    it('should pass logoImage as undefined when not provided', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Test prompt',
        'test.png',
        '1024x1024',
        'medium',
        [],
        'user123',
        'session123',
        'gemini-3-pro-image-preview'
        // logoImage not provided
      , undefined, undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          logoImage: undefined
        })
      );

      expect(result.success).toBe(true);
    });

    it('should pass logoImage with empty inputImages', async () => {
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/logo-image.png',
        filename: 'logo-banner.png'
      });

      const result = await (agentModeService as any).generateImage(
        'Generate a social media banner with this logo',
        'logo-banner.png',
        '16:9',
        'high',
        [], // no input images
        'user123',
        'session123',
        'gemini-3-pro-image-preview',
        'https://example.com/my-logo.png'
      , undefined, 'ad');

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Generate a social media banner with this logo',
        filename: 'logo-banner.png',
        size: '16:9',
        quality: 'high',
        inputImages: [],
        logoImage: 'https://example.com/my-logo.png',
        userId: 'user123',
        imageModel: 'gemini-3-pro-image-preview'
      });

      expect(result.success).toBe(true);
    });
  });

  describe('GA image-model migration (IMAGE_API_MODELS + pricing)', () => {
    it('IMAGE_API_MODELS lists the GA id and retains the preview id as an alias', () => {
      expect(AgentModeService.IMAGE_API_MODELS).toContain('gemini-3.1-flash-image');
      // preview retained so persisted settings/sessions still validate
      expect(AgentModeService.IMAGE_API_MODELS).toContain('gemini-3.1-flash-image-preview');
    });

    it('prices the GA id (and its preview alias) at 0.039 per image', () => {
      const cost = (agentModeService as any).estimateImageGenerationCost.bind(agentModeService);
      expect(cost('gemini-3.1-flash-image')).toBe(0.039);
      expect(cost('gemini-3.1-flash-image-preview')).toBe(0.039);
    });

    it('text-to-image fallback returns gpt-image-2 and never references the legacy preview id', () => {
      const fb = (agentModeService as any).getImageGenerationFallbackModel.bind(agentModeService);
      // No model specified + fresh text-to-image → fallback used (gpt-image-2).
      expect(fb(undefined, [], undefined)).toBe('gpt-image-2');
      // The legacy preview id must never be the fallback (regression guard for the 2249 swap).
      expect(fb(undefined, [], undefined)).not.toBe('gemini-3.1-flash-image-preview');
      // No fallback when the LLM explicitly picked a model, or when editing / compositing a logo.
      expect(fb('gemini-3.1-flash-image', [], undefined, true)).toBeUndefined();
      expect(fb(undefined, ['https://x/a.png'], undefined)).toBeUndefined();
      expect(fb(undefined, [], 'https://x/logo.png')).toBeUndefined();
    });
  });

  describe('Admin-default model fallback (ENG-510)', () => {
    it('getImageGenerationFallbackModel gates on the explicit-choice flag, not mere model presence', () => {
      const fb = (agentModeService as any).getImageGenerationFallbackModel.bind(agentModeService);
      // A concrete model that came from the admin default (implicit) must still fall back.
      expect(fb('gemini-3.1-flash-image-preview', [], undefined, false)).toBe('gpt-image-2');
      // The same concrete model, when the LLM explicitly chose it, is respected (no fallback).
      expect(fb('gemini-3.1-flash-image-preview', [], undefined, true)).toBeUndefined();
    });

    it('never falls back to the same model it just failed on', () => {
      const fb = (agentModeService as any).getImageGenerationFallbackModel.bind(agentModeService);
      // If the resolved default IS the first-choice fallback, pick a different alternate.
      const chosen = fb('gpt-image-2', [], undefined, false);
      expect(chosen).toBeDefined();
      expect(chosen).not.toBe('gpt-image-2');
    });

    it('falls back on a timeout when the model came from the admin default, not an explicit choice', async () => {
      mockImageService.generateImage
        .mockResolvedValueOnce({
          success: false,
          error: 'Failed to generate image: Image generation with gemini-3.1-flash-image timed out after 600 seconds'
        })
        .mockResolvedValueOnce({
          success: true,
          imageUrl: 'https://example.com/fallback-image.png',
          filename: 'ad.png'
        });

      const result = await (agentModeService as any).generateImage(
        'Three flat vector ad illustrations of a woman at the beach',
        'ad.png',
        '1024x1024',
        'high',
        [],
        'user123',
        'session123'
        // no explicit imageModel → the admin default is resolved internally
      , undefined, undefined, undefined, 'ad');

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://example.com/fallback-image.png');
      expect(result.fallbackUsed).toBe(true);
      expect(result.imageModel).toBe('gpt-image-2');
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(2);
      // Primary attempt uses the resolved admin default...
      expect(resolveModelForUser).toHaveBeenCalledWith('user123', 'image');
      expect(mockImageService.generateImage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        imageModel: ADMIN_IMAGE_DEFAULT
      }));
      // ...and the fallback fails over to a different provider.
      expect(mockImageService.generateImage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        imageModel: 'gpt-image-2'
      }));
    });

    it('resolves a missing image model to the image workload default for the caller (ENG-2183)', async () => {
      jest.mocked(resolveModelForUser).mockResolvedValueOnce('gpt-image-2');
      mockImageService.generateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      });

      const service = agentModeService as unknown as {
        generateImage(...args: unknown[]): Promise<{ success: boolean }>;
      };

      const result = await service.generateImage(
        'Test prompt', 'test.png', '1024x1024', 'medium', [], 'user456', 'session123',
        undefined, undefined, undefined, 'ad');

      expect(result.success).toBe(true);
      expect(resolveModelForUser).toHaveBeenCalledTimes(1);
      expect(resolveModelForUser).toHaveBeenCalledWith('user456', 'image');
      expect(mockImageService.generateImage).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user456',
        imageModel: 'gpt-image-2'
      }));
    });

    it('does not resolve the admin default or fall back when the LLM explicitly picked a model', async () => {
      mockImageService.generateImage.mockResolvedValueOnce({
        success: false,
        error: 'Failed to generate image: Image generation with gemini-3-pro-image-preview timed out after 600 seconds'
      });

      const result = await (agentModeService as any).generateImage(
        'A clean product launch graphic',
        'launch.png',
        '1024x1024',
        'high',
        [],
        'user123',
        'session123',
        'gemini-3-pro-image-preview' // explicit choice
      , undefined, undefined, 'ad');

      expect(result.success).toBe(false);
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(1);
      // An explicit model short-circuits the admin-default lookup entirely.
      expect(resolveModelForUser).not.toHaveBeenCalled();
    });
  });
});

describe('Category declaration at the enqueue boundary (ENG-343)', () => {
  let agentModeService: AgentModeService;
  let mockImageService: any;
  let enqueueSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    enqueueSpy = jest
      .spyOn(autoHumanEvalService, 'enqueueAutoHumanEval')
      .mockResolvedValue(null as any);
    mockImageService = {
      generateImage: jest.fn().mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test.png'
      }),
      isAvailable: jest.fn().mockResolvedValue(true)
    };
    (imageGeneration.imageService as any).isAvailable = mockImageService.isAvailable;
    (imageGeneration.imageService as any).generateImage = mockImageService.generateImage;
    agentModeService = new AgentModeService();
  });

  afterEach(() => {
    enqueueSpy?.mockRestore();
  });

  const call = (category?: any) =>
    (agentModeService as any).generateImage(
      'Test prompt', 'test.png', '1024x1024', 'medium', [],
      'user123', 'session123', undefined, undefined, undefined, category
    );

  it('fails visibly when category is missing: no generation, no eval candidate', async () => {
    const result = await call(undefined);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('category');
    expect(mockImageService.generateImage).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('fails visibly on an invalid category: no generation, no eval candidate', async () => {
    const result = await call('banner');
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('category');
    expect(mockImageService.generateImage).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('fails visibly on a non-string category: no generation, no eval candidate', async () => {
    const result = await call(42);
    expect(result.success).toBe(false);
    expect(mockImageService.generateImage).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("threads category 'ad' onto the enqueued eval candidate", async () => {
    const result = await call('ad');
    expect(result.success).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reviewType: 'creative_image', category: 'ad' })
    );
  });

  it("threads category 'organic_post' onto the enqueued eval candidate", async () => {
    const result = await call('organic_post');
    expect(result.success).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reviewType: 'creative_image', category: 'organic_post' })
    );
  });
});

// ENG-1027 (round 3): a fresh-eyes independent review flagged that no existing test
// exercised the real generateImage() → describeImage() wiring — only the pure
// dataFabricationGuard helper functions and a hand-built extractMinimalToolResult
// input were covered. That leaves the actual call site (argument order, the
// metricsVerified parameter threading through 13 positional args, and the
// Promise-race timeout behavior) unverified against a future refactor silently
// reordering generateImage's parameters. This exercises the real method with a
// mocked describeImage, the same way the suite above mocks imageService.
describe('Data-fabrication backstop wiring (ENG-1027)', () => {
  let agentModeService: AgentModeService;
  let mockImageService: any;
  let describeImageSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(autoHumanEvalService, 'enqueueAutoHumanEval').mockResolvedValue(null as any);

    mockImageService = {
      generateImage: jest.fn().mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/dashboard.png',
        filename: 'dashboard.png'
      }),
      isAvailable: jest.fn().mockResolvedValue(true)
    };
    (imageGeneration.imageService as any).isAvailable = mockImageService.isAvailable;
    (imageGeneration.imageService as any).generateImage = mockImageService.generateImage;

    agentModeService = new AgentModeService();
    // ENG-2103 (F2 design-decision-list follow-up, Pattern A): generateImage's
    // internal call to describeImage now lives inside emma/impl/mediaVideo.ts
    // (both moved together) and reaches it via a same-module self-import
    // (`self.describeImage(...)`), not `this.describeImage`/
    // `agentModeService.describeImage` — so the spy has to target the module
    // export, not the class instance, or it would silently stop being
    // observed (the cluster-10 sibling-function-spy failure mode).
    describeImageSpy = jest.spyOn(mediaVideoImpl, 'describeImage');
  });

  const DASHBOARD_PROMPT = 'A status tracker dashboard graphic with a metrics preview panel.';
  const PLAIN_PROMPT = 'A candid phone snapshot of a laptop on a kitchen table at night.';

  const call = (prompt: string, metricsVerified?: boolean) =>
    (agentModeService as any).generateImage(
      prompt, 'dashboard.png', '1024x1024', 'medium', [],
      'user123', 'session123', undefined, undefined, undefined, 'ad', metricsVerified
    );

  it('calls describeImage with the correct arguments when the prompt is dashboard-shaped', async () => {
    describeImageSpy.mockResolvedValue({ success: true, description: 'NUMBERS_FOUND: NONE' });

    await call(DASHBOARD_PROMPT);

    expect(describeImageSpy).toHaveBeenCalledWith(
      undefined,
      'https://example.com/dashboard.png',
      expect.stringContaining('NUMBERS_FOUND'),
      // ENG-1858: the check is metered to the generating user, not "system".
      { userId: 'user123', sessionId: 'session123', feature: 'describe_image' },
      // ENG-2103 (F2): generateImage forwards its own injected callLLM/getVisionModel
      // through to describeImage as a plain same-module call — not a second,
      // redundant injection point for the same underlying capability.
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('surfaces dataReliabilityWarning when the vision check reports fabricated numbers', async () => {
    describeImageSpy.mockResolvedValue({ success: true, description: 'NUMBERS_FOUND: 68%, $12,450' });

    const result = await call(DASHBOARD_PROMPT);

    expect(result.success).toBe(true);
    expect(result.dataReliabilityWarning).toEqual(expect.stringContaining('ENG-1027'));
  });

  it('does not surface a warning when the vision check reports no numbers', async () => {
    describeImageSpy.mockResolvedValue({ success: true, description: 'NUMBERS_FOUND: NONE' });

    const result = await call(DASHBOARD_PROMPT);

    expect(result.success).toBe(true);
    expect(result.dataReliabilityWarning).toBeUndefined();
  });

  it('does not call describeImage at all for a non-dashboard-shaped prompt', async () => {
    const result = await call(PLAIN_PROMPT);

    expect(result.success).toBe(true);
    expect(describeImageSpy).not.toHaveBeenCalled();
    expect(result.dataReliabilityWarning).toBeUndefined();
  });

  it('skips the check when metricsVerified is explicitly true, even on a dashboard-shaped prompt', async () => {
    const result = await call(DASHBOARD_PROMPT, true);

    expect(result.success).toBe(true);
    expect(describeImageSpy).not.toHaveBeenCalled();
    expect(result.dataReliabilityWarning).toBeUndefined();
  });

  it('degrades gracefully (no warning, generation still succeeds) when describeImage rejects/times out', async () => {
    describeImageSpy.mockRejectedValue(new Error('generate_image data-fabrication check timed out after 20000ms'));

    const result = await call(DASHBOARD_PROMPT);

    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://example.com/dashboard.png');
    expect(result.dataReliabilityWarning).toBeUndefined();
  });

  it('degrades gracefully when describeImage resolves but reports failure', async () => {
    describeImageSpy.mockResolvedValue({ success: false, message: 'No image URL provided' });

    const result = await call(DASHBOARD_PROMPT);

    expect(result.success).toBe(true);
    expect(result.dataReliabilityWarning).toBeUndefined();
  });

  // ENG-1535 AC3: the generate_image handler contract forwards the typed provider
  // errorClass so the gateway/agent can distinguish retryable from terminal failures.
  describe('typed errorClass contract (ENG-1535)', () => {
    const call = () =>
      (agentModeService as unknown as {
        generateImage: (...args: unknown[]) => Promise<Record<string, unknown>>;
      }).generateImage(
        'Ad prompt', 'ad.png', '1:1', 'medium', [], 'user123', 'session123',
        'gemini-3-pro-image-preview', undefined, undefined, 'ad', undefined, undefined,
      );

    it.each(['transient', 'rate_limited', 'policy', 'config'])('forwards errorClass=%s on failure', async (errorClass) => {
      mockImageService.generateImage.mockResolvedValue({ success: false, error: `boom ${errorClass}`, errorClass });
      const result = await call();
      expect(result).toMatchObject({ success: false, error: `boom ${errorClass}`, errorClass });
    });

    it('omits errorClass when the provider did not classify the failure', async () => {
      mockImageService.generateImage.mockResolvedValue({ success: false, error: 'unknown' });
      const result = await call();
      expect(result.success).toBe(false);
      expect(result).not.toHaveProperty('errorClass');
    });
  });
});
