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
        'gemini-omni-1.1-flash',
        undefined,
        undefined
      );

      expect(mockVideoService.generateVideo).toHaveBeenCalledWith({
        prompt: 'Test video prompt',
        filename: 'test.mp4',
        userId: 'user123',
        videoModel: 'gemini-omni-1.1-flash',
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
    // gemini-omni-1.1-flash estimate: $0.1014 per actual requested second,
    // used only when the service reports no actual cost.
    const generated = (extra: Record<string, any> = {}) => ({
      success: true, videoUrl: 'https://example.com/video.mp4', filename: 'test.mp4', ...extra,
    });

    it('charges the actual provider cost the service reports (Omni usage), not the estimate', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue(generated({ model: 'gemini-omni-1.1-flash', costUsd: 0.8123 }));

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'gemini-omni-1.1-flash', undefined, undefined, false, undefined, 8
      );

      expect(chatbotDb.addToolCostToSession).toHaveBeenCalledWith('session123', 0.8123, 'generateVideo');
    });

    it('estimates $0.1014 per requested second for Omni when no actual cost is reported', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue(generated({ model: 'gemini-omni-1.1-flash' }));

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'gemini-omni-1.1-flash', undefined, undefined, false, undefined, 8
      );
      await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'gemini-omni-1.1-flash', undefined, undefined, false, undefined, 24
      );

      const calls = chatbotDb.addToolCostToSession.mock.calls;
      expect(calls[0][1]).toBeCloseTo(8 * 0.1014, 5);  // 8s
      expect(calls[1][1]).toBeCloseTo(24 * 0.1014, 5); // 24s → clips 10/10/4, billed on 24s
    });

    it('prices a legacy Veo id as gemini-omni-1.1-flash (alias, not the retired $3.20 rate)', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue(generated());

      const result = await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'veo-3.1-fast-generate-preview', undefined, undefined, false, undefined, 8
      );

      expect(chatbotDb.addToolCostToSession.mock.calls[0][1]).toBeCloseTo(8 * 0.1014, 5);
      expect(result.model).toBe('gemini-omni-1.1-flash');
    });

    it('attributes cost to the model that actually produced the clip (Seedance→Omni fallback)', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue(generated({ model: 'gemini-omni-1.1-flash' }));

      const result = await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'seedance-2.0', undefined, undefined, false, undefined, 8
      );

      expect(chatbotDb.addToolCostToSession.mock.calls[0][1]).toBeCloseTo(8 * 0.1014, 5);
      expect(result.model).toBe('gemini-omni-1.1-flash');
    });

    it('defaults the session cost to Seedance ($1.55) when no model is given or reported', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue(generated());

      await (agentModeService as any).generateVideo('Test prompt', 'test.mp4', 'user123', 'session123');

      expect(chatbotDb.addToolCostToSession).toHaveBeenCalledWith('session123', 1.55, 'generateVideo');
    });

    it('should not track cost when video generation fails', async () => {
      const { chatbotDb } = require('../services/chatbotService');
      mockVideoService.generateVideo.mockResolvedValue({
        success: false,
        error: 'API error'
      });

      await (agentModeService as any).generateVideo(
        'Test prompt', 'test.mp4', 'user123', 'session123',
        'gemini-omni-1.1-flash', undefined, undefined,
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

