// Unit tests for generate_video function in agentModeService

import { AgentModeService } from '../services/agentModeService';
import * as videoGeneration from '../services/videoGeneration';

// Mock dependencies
jest.mock('../services/videoGeneration');
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

describe('AgentModeService - generate_video function', () => {
  let agentModeService: AgentModeService;
  let mockVideoService: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Mock videoService
    mockVideoService = {
      generateVideo: jest.fn(),
      isAvailable: jest.fn().mockResolvedValue(true)
    };
    
    // Mock the videoService module export
    (videoGeneration as any).videoService = mockVideoService;

    // Create AgentModeService instance
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
  });

  describe('Basic Video Generation', () => {
    it('should call videoService.generateVideo with correct parameters', async () => {
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test.mp4'
      });

      const result = await (agentModeService as any).generateVideo(
        'Test video prompt',
        'test.mp4',
        'user123',
        'session123',
        undefined, // videoModel
        undefined, // startFrame
        undefined // endFrame
      );

      expect(mockVideoService.generateVideo).toHaveBeenCalledWith({
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: undefined,
        startFrame: undefined,
        endFrame: undefined
      });

      expect(result.success).toBe(true);
      expect(result.videoUrl).toBe('https://example.com/video.mp4');
    });

    it('should handle videoModel parameter', async () => {
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test.mp4'
      });

      const result = await (agentModeService as any).generateVideo(
        'Test video prompt',
        'test.mp4',
        'user123',
        'session123',
        'veo-3.1-generate-preview',
        undefined,
        undefined
      );

      expect(mockVideoService.generateVideo).toHaveBeenCalledWith({
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'veo-3.1-generate-preview',
        startFrame: undefined,
        endFrame: undefined
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Start and End Frame Handling', () => {
    it('should pass startFrame URL to videoService', async () => {
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test.mp4'
      });

      const result = await (agentModeService as any).generateVideo(
        'Test video prompt',
        'test.mp4',
        'user123',
        'session123',
        undefined,
        'https://example.com/start.png',
        undefined
      );

      expect(mockVideoService.generateVideo).toHaveBeenCalledWith({
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: undefined,
        startFrame: 'https://example.com/start.png',
        endFrame: undefined
      });

      expect(result.success).toBe(true);
    });

    it('should pass endFrame URL to videoService', async () => {
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test.mp4'
      });

      const result = await (agentModeService as any).generateVideo(
        'Test video prompt',
        'test.mp4',
        'user123',
        'session123',
        undefined,
        undefined,
        'https://example.com/end.png'
      );

      expect(mockVideoService.generateVideo).toHaveBeenCalledWith({
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: undefined,
        startFrame: undefined,
        endFrame: 'https://example.com/end.png'
      });

      expect(result.success).toBe(true);
    });

    it('should pass both startFrame and endFrame URLs', async () => {
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test.mp4'
      });

      const result = await (agentModeService as any).generateVideo(
        'Test video prompt',
        'test.mp4',
        'user123',
        'session123',
        undefined,
        'https://example.com/start.png',
        'https://example.com/end.png'
      );

      expect(mockVideoService.generateVideo).toHaveBeenCalledWith({
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: undefined,
        startFrame: 'https://example.com/start.png',
        endFrame: 'https://example.com/end.png'
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle video generation failures', async () => {
      mockVideoService.generateVideo.mockResolvedValue({
        success: false,
        error: 'Video generation failed'
      });

      const result = await (agentModeService as any).generateVideo(
        'Test video prompt',
        'test.mp4',
        'user123',
        'session123',
        undefined,
        undefined,
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Video generation failed');
    });

    it('should handle videoService errors', async () => {
      mockVideoService.generateVideo.mockRejectedValue(new Error('Service error'));

      const result = await (agentModeService as any).generateVideo(
        'Test video prompt',
        'test.mp4',
        'user123',
        'session123',
        undefined,
        undefined,
        undefined
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Service error');
    });
  });

  describe('Cost Tracking', () => {
    it('should charge $2.80 for an 8s veo-3.1-generate-preview video (single clip)', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test.mp4'
      });

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'veo-3.1-generate-preview', undefined, undefined,
        false, undefined, 8
      );

      expect(chatbotDb.addToolCostToSession).toHaveBeenCalledWith('session123', 2.80, 'generateVideo');
    });

    it('should charge $5.60 for a 16s video (2 clips × $2.80)', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test_16s.mp4'
      });

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test_16s.mp4', 'user123', 'session123',
        'veo-3.1-generate-preview', undefined, undefined,
        false, undefined, 16
      );

      expect(chatbotDb.addToolCostToSession).toHaveBeenCalledWith('session123', 5.60, 'generateVideo');
    });

    it('should charge $8.40 for a 24s video (3 clips × $2.80)', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test_24s.mp4'
      });

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test_24s.mp4', 'user123', 'session123',
        'veo-3.1-generate-preview', undefined, undefined,
        false, undefined, 24
      );

      const call = chatbotDb.addToolCostToSession.mock.calls[0];
      expect(call[0]).toBe('session123');
      expect(call[1]).toBeCloseTo(8.40, 5);
      expect(call[2]).toBe('generateVideo');
    });

    it('should charge $2.80 when durationSeconds is undefined (defaults to single clip)', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test.mp4'
      });

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'veo-3.1-generate-preview'
      );

      expect(chatbotDb.addToolCostToSession).toHaveBeenCalledWith('session123', 2.80, 'generateVideo');
    });

    it('should charge $2.80 for a 16s fast video (2 clips × $1.40)', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue({
        success: true,
        videoUrl: 'https://example.com/video.mp4',
        filename: 'test_fast.mp4'
      });

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test_fast.mp4', 'user123', 'session123',
        'veo-3.1-fast-generate-preview', undefined, undefined,
        false, undefined, 16
      );

      expect(chatbotDb.addToolCostToSession).toHaveBeenCalledWith('session123', 2.80, 'generateVideo');
    });

    it('should not track cost when video generation fails', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue({
        success: false,
        error: 'API error'
      });

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'veo-3.1-generate-preview', undefined, undefined,
        false, undefined, 16
      );

      expect(chatbotDb.addToolCostToSession).not.toHaveBeenCalled();
    });
  });

  describe('Tool Definition', () => {
    it('should have generate_video tool registered', () => {
      const tools = agentModeService.getAvailableTools();
      const generateVideoTool = tools.find((tool: any) => tool.function?.name === 'generate_video');
      
      expect(generateVideoTool).toBeDefined();
      if (!generateVideoTool) {
        throw new Error('generate_video tool not found');
      }
      
      expect(generateVideoTool.function.name).toBe('generate_video');
      expect(generateVideoTool.function.parameters.properties.prompt).toBeDefined();
      expect(generateVideoTool.function.parameters.properties.filename).toBeDefined();
      expect(generateVideoTool.function.parameters.properties.startFrame).toBeDefined();
      expect(generateVideoTool.function.parameters.properties.endFrame).toBeDefined();
    });
  });
});

