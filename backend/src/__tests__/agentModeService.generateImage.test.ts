// Unit tests for generate_image function in agentModeService

import { AgentModeService } from '../services/agentModeService';
import * as autoHumanEvalService from '../services/autoHumanEvalService';
import * as imageGeneration from '../services/imageGeneration';

// Mock dependencies
jest.mock('../services/imageGeneration');
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
      );

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
      );

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
      );

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
      );

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: 'auto',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: undefined
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
      );

      // Should pass undefined, which will trigger default behavior in imageService
      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: undefined,
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: undefined
      });

      expect(result.success).toBe(true);
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
      );

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
        );

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
        );

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
      );

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: inputImages,
        logoImage: undefined,
        userId: 'user123',
        imageModel: undefined
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
      );

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: [],
        logoImage: undefined,
        userId: 'user123',
        imageModel: undefined
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
      );

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
        );

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
      );

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
      );

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
      );

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
      );

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
      );

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
      );

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
      );

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
      );

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
      );

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
      );

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
      );

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
        );

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
      );

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
      );

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
      );

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
      const defaultSpy = jest
        .spyOn(agentModeService as any, 'getImageApiDefaultModel')
        .mockResolvedValue('gemini-3.1-flash-image-preview');

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
      );

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://example.com/fallback-image.png');
      expect(result.fallbackUsed).toBe(true);
      expect(result.imageModel).toBe('gpt-image-2');
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(2);
      // Primary attempt uses the resolved admin default...
      expect(mockImageService.generateImage).toHaveBeenNthCalledWith(1, expect.objectContaining({
        imageModel: 'gemini-3.1-flash-image-preview'
      }));
      // ...and the fallback fails over to a different provider.
      expect(mockImageService.generateImage).toHaveBeenNthCalledWith(2, expect.objectContaining({
        imageModel: 'gpt-image-2'
      }));

      defaultSpy.mockRestore();
    });

    it('does not resolve the admin default or fall back when the LLM explicitly picked a model', async () => {
      const defaultSpy = jest
        .spyOn(agentModeService as any, 'getImageApiDefaultModel')
        .mockResolvedValue('gemini-3.1-flash-image-preview');

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
      );

      expect(result.success).toBe(false);
      expect(mockImageService.generateImage).toHaveBeenCalledTimes(1);
      // An explicit model short-circuits the admin-default lookup entirely.
      expect(defaultSpy).not.toHaveBeenCalled();

      defaultSpy.mockRestore();
    });
  });
});
