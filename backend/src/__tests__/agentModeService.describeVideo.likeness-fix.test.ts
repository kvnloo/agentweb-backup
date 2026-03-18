// Unit tests for describeVideo image rejection (Fix D)

import { AgentModeService } from '../services/agentModeService';
import axios from 'axios';
import { Readable } from 'stream';

// Mock dependencies
jest.mock('axios');
jest.mock('../utils/secretsManager');
jest.mock('@google/genai');

describe('AgentModeService - describeVideo Fix D', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  describe('Fix D: Reject image files gracefully', () => {
    it('should reject image files by extension (.jpg)', async () => {
      const result = await agentModeService.describeVideo('https://example.com/file.jpg');

      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain('.jpg');
      expect(result.message).toContain('describe_image');
    });

    it('should reject image files by extension (.png)', async () => {
      const result = await agentModeService.describeVideo('https://example.com/file.png');

      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain('.png');
      expect(result.message).toContain('describe_image');
    });

    it('should reject image files by extension (.gif)', async () => {
      const result = await agentModeService.describeVideo('https://example.com/file.gif');

      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain('.gif');
      expect(result.message).toContain('describe_image');
    });

    it('should reject image files by extension (.webp)', async () => {
      const result = await agentModeService.describeVideo('https://example.com/file.webp');

      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain('.webp');
      expect(result.message).toContain('describe_image');
    });

    it('should reject image files by Content-Type header (image/jpeg)', async () => {
      // Mock the secrets manager to return an API key
      const secretsManager = require('../utils/secretsManager');
      (secretsManager.getSecret as jest.Mock).mockResolvedValue('test-api-key');

      // Mock axios to return an image Content-Type
      const mockStream = new Readable();
      mockStream.push('fake-video-data');
      mockStream.push(null);

      (axios.get as jest.Mock).mockResolvedValue({
        data: mockStream,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '1024'
        }
      });

      const result = await agentModeService.describeVideo('https://example.com/file.mp4');

      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain('image/jpeg');
      expect(result.message).toContain('describe_image');
    });

    it('should reject image files by Content-Type header (image/png)', async () => {
      // Mock the secrets manager to return an API key
      const secretsManager = require('../utils/secretsManager');
      (secretsManager.getSecret as jest.Mock).mockResolvedValue('test-api-key');

      // Mock axios to return an image Content-Type
      const mockStream = new Readable();
      mockStream.push('fake-video-data');
      mockStream.push(null);

      (axios.get as jest.Mock).mockResolvedValue({
        data: mockStream,
        headers: {
          'content-type': 'image/png',
          'content-length': '2048'
        }
      });

      const result = await agentModeService.describeVideo('https://example.com/video.mp4');

      expect(result.success).toBe(false);
      expect(result.message).toContain('appears to be an image');
      expect(result.message).toContain('image/png');
      expect(result.message).toContain('describe_image');
    });

    it('should allow video files with .mp4 extension and no Content-Type header', async () => {
      // Mock the secrets manager to return an API key
      const secretsManager = require('../utils/secretsManager');
      (secretsManager.getSecret as jest.Mock).mockResolvedValue('test-api-key');

      // Mock axios to return no Content-Type (or empty string)
      const mockStream = new Readable();
      mockStream.push('fake-video-data');
      mockStream.push(null);

      (axios.get as jest.Mock).mockResolvedValue({
        data: mockStream,
        headers: {
          'content-type': '',
          'content-length': '10240'
        }
      });

      // This test will fail during processing, but should pass the validation
      const result = await agentModeService.describeVideo('https://example.com/video.mp4');

      // Should not reject with "appears to be an image" error
      if (!result.success) {
        expect(result.message).not.toContain('appears to be an image');
        expect(result.message).not.toContain('describe_image');
      }
    });

    it('should allow video files with video/mp4 Content-Type', async () => {
      // Mock the secrets manager to return an API key
      const secretsManager = require('../utils/secretsManager');
      (secretsManager.getSecret as jest.Mock).mockResolvedValue('test-api-key');

      // Mock axios to return a video Content-Type
      const mockStream = new Readable();
      mockStream.push('fake-video-data');
      mockStream.push(null);

      (axios.get as jest.Mock).mockResolvedValue({
        data: mockStream,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '10240'
        }
      });

      const result = await agentModeService.describeVideo('https://example.com/video.mp4');

      // Should not reject with "appears to be an image" error
      if (!result.success) {
        expect(result.message).not.toContain('appears to be an image');
        expect(result.message).not.toContain('describe_image');
      }
    });

    it('should handle malformed URLs gracefully', async () => {
      const result = await agentModeService.describeVideo('not-a-valid-url');

      // Should fail but not crash
      expect(result.success).toBe(false);
      // Error message should be informative
      expect(result.message || result.error).toBeTruthy();
    });

    it('should reject empty video URL', async () => {
      const result = await agentModeService.describeVideo('');

      expect(result.success).toBe(false);
      expect(result.message).toContain('No video URL provided');
    });
  });
});
