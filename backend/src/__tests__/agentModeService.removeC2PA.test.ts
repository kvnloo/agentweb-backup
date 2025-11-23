// Unit tests for remove_c2pa_from_image function in agentModeService

import { AgentModeService } from '../services/agentModeService';
import * as imageGeneration from '../services/imageGeneration';
import * as s3Utils from '../utils/s3Utils';

// Mock dependencies
jest.mock('../services/imageGeneration');
jest.mock('../utils/s3Utils');
jest.mock('axios');

describe('AgentModeService - remove_c2pa_from_image function', () => {
  let agentModeService: AgentModeService;
  let mockImageService: any;
  let mockAxios: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock imageService
    mockImageService = {
      removeC2PAMetadata: jest.fn(),
      isAvailable: jest.fn().mockResolvedValue(true)
    };
    
    (imageGeneration.imageService as any).removeC2PAMetadata = mockImageService.removeC2PAMetadata;
    (imageGeneration.imageService as any).isAvailable = mockImageService.isAvailable;

    // Mock axios
    mockAxios = require('axios');
    (mockAxios.default.get as jest.Mock).mockResolvedValue({
      data: Buffer.from('image-data'),
      headers: { 'content-type': 'image/png' }
    });

    // Mock S3 upload
    (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({
      success: true,
      url: 'https://s3.amazonaws.com/bucket/cleaned-image.png'
    });

    // Create AgentModeService instance
    agentModeService = new AgentModeService();
  });

  describe('Image URL Handling', () => {
    it('should download image from HTTP URL and remove C2PA metadata', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'cleaned-image.png',
        'user123'
      );

      expect(mockAxios.default.get).toHaveBeenCalledWith(
        'https://example.com/image.png',
        expect.objectContaining({
          responseType: 'arraybuffer',
          timeout: 30000
        })
      );

      expect(mockImageService.removeC2PAMetadata).toHaveBeenCalledWith(originalBuffer);
      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        cleanedBuffer,
        'cleaned-image.png',
        'user123',
        'image/png'
      );

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://s3.amazonaws.com/bucket/cleaned-image.png');
      expect(result.filename).toBe('cleaned-image.png');
    });

    it('should handle data URL and remove C2PA metadata', async () => {
      const base64Data = Buffer.from('image-data').toString('base64');
      const dataUrl = `data:image/png;base64,${base64Data}`;
      const originalBuffer = Buffer.from('image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      const result = await (agentModeService as any).removeC2PAFromImage(
        dataUrl,
        'cleaned-image.png',
        'user123'
      );

      // Should not call axios for data URLs
      expect(mockAxios.default.get).not.toHaveBeenCalled();

      expect(mockImageService.removeC2PAMetadata).toHaveBeenCalled();
      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        cleanedBuffer,
        'cleaned-image.png',
        'user123',
        'image/png'
      );

      expect(result.success).toBe(true);
      expect(result.imageUrl).toBe('https://s3.amazonaws.com/bucket/cleaned-image.png');
    });

    it('should generate filename from URL when not provided', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/my-image.jpg',
        undefined,
        'user123'
      );

      // Should generate filename from URL
      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        cleanedBuffer,
        expect.stringMatching(/my-image_no_c2pa\.png$/),
        'user123',
        'image/png'
      );

      expect(result.success).toBe(true);
      expect(result.filename).toMatch(/my-image_no_c2pa\.png$/);
    });

    it('should handle S3 URLs', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://s3.amazonaws.com/bucket/original-image.png',
        'new-image.png',
        'user123'
      );

      expect(mockAxios.default.get).toHaveBeenCalledWith(
        'https://s3.amazonaws.com/bucket/original-image.png',
        expect.any(Object)
      );

      expect(result.success).toBe(true);
      expect(result.originalUrl).toBe('https://s3.amazonaws.com/bucket/original-image.png');
    });
  });

  describe('Filename Generation', () => {
    it('should preserve .png extension when filename already has .png', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'output.png',
        'user123'
      );

      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        cleanedBuffer,
        'output.png',
        'user123',
        'image/png'
      );

      expect(result.filename).toBe('output.png');
    });

    it('should convert filename to .png extension when different extension provided', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.jpg',
        'output.jpg',
        'user123'
      );

      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        cleanedBuffer,
        'output.png',
        'user123',
        'image/png'
      );

      expect(result.filename).toBe('output.png');
    });

    it('should generate timestamp-based filename when URL has no extension', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image',
        undefined,
        'user123'
      );

      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        cleanedBuffer,
        expect.stringMatching(/image_no_c2pa_\d+\.png$/),
        'user123',
        'image/png'
      );

      expect(result.filename).toMatch(/image_no_c2pa_\d+\.png$/);
    });
  });

  describe('Error Handling', () => {
    it('should return error when image URL is missing', async () => {
      const result = await (agentModeService as any).removeC2PAFromImage(
        '',
        'output.png',
        'user123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Image URL is required');
      expect(result.error).toBe('missing_image_url');
    });

    it('should return error when userId is missing', async () => {
      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'output.png',
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('User ID is required');
      expect(result.error).toBe('missing_user_id');
    });

    it('should handle download errors gracefully', async () => {
      (mockAxios.default.get as jest.Mock).mockRejectedValue(new Error('Network error'));

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'output.png',
        'user123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to remove C2PA metadata');
      expect(result.error).toContain('Network error');
    });

    it('should handle metadata removal errors gracefully', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockRejectedValue(new Error('Sharp processing error'));

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'output.png',
        'user123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to remove C2PA metadata');
    });

    it('should handle S3 upload errors gracefully', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);
      
      (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({
        success: false,
        error: 'S3 upload failed'
      });

      const result = await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'output.png',
        'user123'
      );

      expect(result.success).toBe(false);
      // The message will be uploadResult.error if provided, otherwise the default message
      expect(result.message).toBe('S3 upload failed');
      expect(result.error).toBe('S3 upload failed');
    });
  });

  describe('Integration with imageService', () => {
    it('should call imageService.removeC2PAMetadata with correct buffer', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'output.png',
        'user123'
      );

      expect(mockImageService.removeC2PAMetadata).toHaveBeenCalledTimes(1);
      expect(mockImageService.removeC2PAMetadata).toHaveBeenCalledWith(originalBuffer);
    });

    it('should use cleaned buffer from imageService for S3 upload', async () => {
      const originalBuffer = Buffer.from('original-image-data');
      const cleanedBuffer = Buffer.from('cleaned-image-data');
      
      (mockAxios.default.get as jest.Mock).mockResolvedValue({
        data: originalBuffer,
        headers: { 'content-type': 'image/png' }
      });
      
      mockImageService.removeC2PAMetadata.mockResolvedValue(cleanedBuffer);

      await (agentModeService as any).removeC2PAFromImage(
        'https://example.com/image.png',
        'output.png',
        'user123'
      );

      // Verify that the cleaned buffer (not original) was uploaded
      expect(s3Utils.uploadFileToS3).toHaveBeenCalledWith(
        cleanedBuffer,
        'output.png',
        'user123',
        'image/png'
      );
    });
  });
});

