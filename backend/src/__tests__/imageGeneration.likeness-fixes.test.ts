// Unit tests for image likeness issue fixes
// Tests for Fix B (model validation), Fix C (timeout), and Fix D (video/image rejection)

import { ImageService } from '../services/imageGeneration';
import * as secretsManager from '../utils/secretsManager';
import * as s3Utils from '../utils/s3Utils';

// Mock dependencies
jest.mock('../utils/secretsManager');
jest.mock('../utils/s3Utils');
jest.mock('openai');
jest.mock('axios');
jest.mock('@google/generative-ai');
jest.mock('@runwayml/sdk');
jest.mock('@google/genai');

describe('ImageService - Likeness Fixes', () => {
  let imageService: ImageService;

  beforeEach(() => {
    jest.clearAllMocks();
    imageService = new ImageService();
  });

  describe('Fix B: imageModel parameter validation', () => {
    it('should reject invalid imageModel parameter', async () => {
      const result = await imageService.generateImage({
        prompt: 'Test prompt',
        filename: 'test.png',
        userId: 'user123',
        imageModel: 'invalid-model-name'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid imageModel');
      expect(result.error).toContain('invalid-model-name');
      expect(result.error).toContain('Must be one of:');
    });

    it('should accept valid imageModel: gpt-image-1', async () => {
      // ENG-410: the Azure image secret is JSON {apiKey, endpoint}; the raw-key format is rejected.
      const mockApiKey = JSON.stringify({ apiKey: 'test-api-key', endpoint: 'https://agentweb-imagegen-prod.services.ai.azure.com' });
      (secretsManager.getSecret as jest.Mock).mockResolvedValue(mockApiKey);

      const mockOpenAI = require('openai');
      mockOpenAI.default = jest.fn().mockImplementation(() => ({
        images: {
          generate: jest.fn().mockResolvedValue({
            data: [{ b64_json: 'base64data' }]
          })
        }
      }));

      const result = await imageService.generateImage({
        prompt: 'Test prompt',
        filename: 'test.png',
        userId: 'user123',
        imageModel: 'gpt-image-1'
      });

      // Should not fail with validation error
      if (!result.success) {
        expect(result.error).not.toContain('Invalid imageModel');
      }
    });

    it('should accept valid imageModel: gemini-3-pro-image-preview', async () => {
      // ENG-410: the Azure image secret is JSON {apiKey, endpoint}; the raw-key format is rejected.
      const mockApiKey = JSON.stringify({ apiKey: 'test-api-key', endpoint: 'https://agentweb-imagegen-prod.services.ai.azure.com' });
      (secretsManager.getSecret as jest.Mock).mockResolvedValue(mockApiKey);

      const result = await imageService.generateImage({
        prompt: 'Test prompt',
        filename: 'test.png',
        userId: 'user123',
        imageModel: 'gemini-3-pro-image-preview'
      });

      // Should not fail with validation error
      if (!result.success) {
        expect(result.error).not.toContain('Invalid imageModel');
      }
    });

    it('should accept valid imageModel: gen4_image', async () => {
      // ENG-410: the Azure image secret is JSON {apiKey, endpoint}; the raw-key format is rejected.
      const mockApiKey = JSON.stringify({ apiKey: 'test-api-key', endpoint: 'https://agentweb-imagegen-prod.services.ai.azure.com' });
      (secretsManager.getSecret as jest.Mock).mockResolvedValue(mockApiKey);

      const result = await imageService.generateImage({
        prompt: 'Test prompt',
        filename: 'test.png',
        userId: 'user123',
        imageModel: 'gen4_image'
      });

      // Should not fail with validation error
      if (!result.success) {
        expect(result.error).not.toContain('Invalid imageModel');
      }
    });

    it('should default to gemini-3-pro-image-preview when no model specified', async () => {
      // ENG-410: the Azure image secret is JSON {apiKey, endpoint}; the raw-key format is rejected.
      const mockApiKey = JSON.stringify({ apiKey: 'test-api-key', endpoint: 'https://agentweb-imagegen-prod.services.ai.azure.com' });
      (secretsManager.getSecret as jest.Mock).mockResolvedValue(mockApiKey);

      const result = await imageService.generateImage({
        prompt: 'Test prompt',
        filename: 'test.png',
        userId: 'user123'
        // No imageModel specified
      });

      // Should not fail with validation error (defaults to valid model)
      if (!result.success) {
        expect(result.error).not.toContain('Invalid imageModel');
      }
    });
  });

  describe('Fix C: Generation timeout', () => {
    it('should timeout if generation takes longer than 10 minutes', async () => {
      // Note: This test verifies timeout mechanism exists but uses short timeout for testing
      // Create a new instance with shorter timeout for testing
      const testImageService = new ImageService();
      // Access private property for testing - we'll override it
      (testImageService as any).IMAGE_GENERATION_TIMEOUT_MS = 1000; // 1 second for testing

      // ENG-410: the Azure image secret is JSON {apiKey, endpoint}; the raw-key format is rejected.
      const mockApiKey = JSON.stringify({ apiKey: 'test-api-key', endpoint: 'https://agentweb-imagegen-prod.services.ai.azure.com' });
      (secretsManager.getSecret as jest.Mock).mockResolvedValue(mockApiKey);

      // Mock axios for form-data POST (used by Azure AI)
      const mockAxios = require('axios');
      mockAxios.post = jest.fn().mockImplementation(() =>
        new Promise((resolve) => {
          // Never resolve - simulates a hanging API call
          setTimeout(() => resolve({ data: { result: { b64_json: 'base64data' } } }), 10000);
        })
      );

      const startTime = Date.now();
      const result = await testImageService.generateImage({
        prompt: 'Test prompt',
        filename: 'test.png',
        userId: 'user123',
        imageModel: 'gpt-image-1'
      });
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should fail due to timeout
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');

      // Should timeout within reasonable time (1 second + overhead)
      expect(duration).toBeLessThan(2000); // 1 sec + 1 sec overhead
    }, 5000); // Set Jest timeout to 5 seconds

    it('should complete successfully if generation finishes within timeout', async () => {
      // ENG-410: the Azure image secret is JSON {apiKey, endpoint}; the raw-key format is rejected.
      const mockApiKey = JSON.stringify({ apiKey: 'test-api-key', endpoint: 'https://agentweb-imagegen-prod.services.ai.azure.com' });
      (secretsManager.getSecret as jest.Mock).mockResolvedValue(mockApiKey);
      (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({
        success: true,
        url: 's3://bucket/test.png'
      });

      // Mock axios for form-data POST (used by Azure AI) - fast completion
      const mockAxios = require('axios');
      mockAxios.post = jest.fn().mockResolvedValue({
        data: { result: { b64_json: Buffer.from('test-image-data').toString('base64') } }
      });

      const result = await imageService.generateImage({
        prompt: 'Test prompt',
        filename: 'test.png',
        userId: 'user123',
        imageModel: 'gpt-image-1'
      });

      // Should not timeout - either succeeds or fails for different reason
      if (!result.success && result.error) {
        expect(result.error).not.toContain('timed out');
      }
    }, 10000);
  });
});
