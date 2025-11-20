// Unit tests for generate_image function in agentModeService

import { AgentModeService } from '../services/agentModeService';
import * as imageGeneration from '../services/imageGeneration';

// Mock dependencies
jest.mock('../services/imageGeneration');
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({})
  }
}));

describe('AgentModeService - generate_image function', () => {
  let agentModeService: AgentModeService;
  let mockImageService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
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

  describe('Size Parameter Handling', () => {
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
        userId: 'user123',
        imageModel: 'gen4_image'
      });

      expect(result.success).toBe(true);
    });

    it('should handle all supported models', async () => {
      const models = ['gpt-image-1', 'gemini-2.5-flash-image-preview', 'gemini-3-pro-image-preview', 'gen4_image', 'gemini_2.5_flash'];
      
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
        'session123'
      );

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        filename: 'test.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: inputImages,
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
        'gemini-3-pro-image-preview'
      );

      expect(mockImageService.generateImage).toHaveBeenCalledWith({
        prompt: 'Add the logo to the top right corner of the image',
        filename: 'combined.png',
        size: '1024x1024',
        quality: 'medium',
        inputImages: inputImages,
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

      const models = ['gemini-2.5-flash-image-preview', 'gemini-3-pro-image-preview'];
      
      for (const model of models) {
        const result = await (agentModeService as any).generateImage(
          'Combine these images into one',
          'combined.png',
          'auto',
          'medium',
          inputImages,
          'user123',
          'session123',
          model
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
});

