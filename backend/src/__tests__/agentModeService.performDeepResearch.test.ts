// Unit tests for perform_deep_research tool in agentModeService

import { AgentModeService } from '../services/agentModeService';

// Mock deep research service
jest.mock('../services/deepResearchService', () => ({
  deepResearchService: {
    isAvailable: jest.fn(),
    performDeepResearch: jest.fn()
  }
}));

// Mock S3 upload utility
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn()
}));

describe('AgentModeService - perform_deep_research tool', () => {
  let agentModeService: AgentModeService;
  let mockDeepResearchService: {
    isAvailable: jest.Mock;
    performDeepResearch: jest.Mock;
  };
  let mockUploadFileToS3: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
    
    const deepResearchModule = require('../services/deepResearchService');
    mockDeepResearchService = deepResearchModule.deepResearchService;

    const s3Module = require('../utils/s3Utils');
    mockUploadFileToS3 = s3Module.uploadFileToS3;
  });

  describe('performDeepResearchTool', () => {
    describe('Success Cases', () => {
      it('should return S3 URL and research metadata on success', async () => {
        const mockS3Url = 'https://s3.amazonaws.com/bucket/research-ai-agents-in-marketing-1234567890.md';
        
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# AI Agents in Marketing\n\n## Overview\n\nThis is research content about AI agents.\n\n## Key Findings\n\n- Finding one with important details\n- Finding two with more information\n\n## Conclusion\n\nAI agents are transforming marketing.',
          title: 'AI Agents in Marketing',
          researchSummary: 'Research about AI agents in marketing automation.'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: mockS3Url
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'AI agents in marketing',
          'Focus on automation benefits',
          'professional',
          'detailed',
          ['market trends', 'use cases'],
          'user-123'
        );

        expect(result.success).toBe(true);
        expect(result.data.research_url).toBe(mockS3Url);
        expect(result.data.title).toBe('AI Agents in Marketing');
        expect(result.data.summary).toBe('Research about AI agents in marketing automation.');
        expect(result.data.word_count).toBeGreaterThan(0);
        expect(result.data.research_depth).toBe('detailed');
        expect(result.data.topic).toBe('AI agents in marketing');
        expect(result.message).toContain('Deep research completed successfully');
        expect(result.message).toContain('saved to S3');
      });

      it('should calculate word count correctly', async () => {
        const markdownContent = 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10';
        
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent,
          title: 'Test',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        const result = await (agentModeService as any).performDeepResearchTool('Test topic');

        expect(result.success).toBe(true);
        expect(result.data.word_count).toBe(10);
      });

      it('should use default values for optional parameters', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Test Research\n\nContent here.',
          title: 'Test Research',
          researchSummary: 'Test summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
          // No other parameters provided
        );

        expect(result.success).toBe(true);
        expect(mockDeepResearchService.performDeepResearch).toHaveBeenCalledWith({
          topic: 'Test topic',
          prompt: undefined,
          tone: 'professional',
          depth: 'detailed',
          focus_areas: undefined
        });
      });

      it('should sanitize topic for filename', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        await (agentModeService as any).performDeepResearchTool(
          'AI & Machine Learning: A Guide!',
          undefined,
          'professional',
          'detailed',
          undefined,
          'user-123'
        );

        // Verify filename is sanitized (no special characters)
        expect(mockUploadFileToS3).toHaveBeenCalled();
        const callArgs = mockUploadFileToS3.mock.calls[0];
        const filename = callArgs[1];
        expect(filename).toMatch(/^research-[a-z0-9-]+-\d+\.md$/);
        expect(filename).not.toContain('&');
        expect(filename).not.toContain(':');
        expect(filename).not.toContain('!');
      });

      it('should truncate long topics in filename to 50 characters', async () => {
        const longTopic = 'This is a very long topic that exceeds fifty characters and should be truncated';
        
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        await (agentModeService as any).performDeepResearchTool(longTopic);

        const callArgs = mockUploadFileToS3.mock.calls[0];
        const filename = callArgs[1];
        // Filename format: research-{sanitizedTopic}-{timestamp}.md
        const sanitizedPart = filename.replace(/^research-/, '').replace(/-\d+\.md$/, '');
        expect(sanitizedPart.length).toBeLessThanOrEqual(50);
      });

      it('should use anonymous userId when not provided', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        await (agentModeService as any).performDeepResearchTool('Test topic');

        expect(mockUploadFileToS3).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(String),
          'anonymous',
          'text/markdown'
        );
      });
    });

    describe('Service Unavailable', () => {
      it('should return error when deep research service is unavailable', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(false);

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('not available');
        expect(result.error).toBe('Service unavailable');
        expect(mockDeepResearchService.performDeepResearch).not.toHaveBeenCalled();
      });
    });

    describe('Research Failure', () => {
      it('should return error when research fails', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: false,
          error: 'Deep research timed out'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Deep research timed out');
        expect(result.error).toBe('Deep research timed out');
      });

      it('should handle empty markdown content', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '',
          title: '',
          researchSummary: ''
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
      });

      it('should handle null markdown content', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: null,
          title: 'Title',
          researchSummary: 'Summary'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
      });

      it('should return error message from research service', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: false,
          error: 'Rate limit exceeded'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Rate limit exceeded');
        expect(result.error).toBe('Rate limit exceeded');
      });

      it('should provide default error message when none provided', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: false
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Deep research failed');
        expect(result.error).toBe('Unknown error');
      });
    });

    describe('S3 Upload Failure', () => {
      it('should return error when S3 upload fails', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: false,
          error: 'S3 bucket not accessible'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to upload research content to S3');
        expect(result.error).toBe('S3 upload failed');
      });

      it('should return error when S3 upload returns no URL', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: null
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to upload research content to S3');
        expect(result.error).toBe('S3 upload failed');
      });
    });

    describe('Exception Handling', () => {
      it('should handle exceptions from isAvailable gracefully', async () => {
        mockDeepResearchService.isAvailable.mockRejectedValue(new Error('Network error'));

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to perform deep research');
        expect(result.error).toBe('Network error');
      });

      it('should handle exceptions from performDeepResearch gracefully', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockRejectedValue(new Error('API timeout'));

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to perform deep research');
        expect(result.error).toBe('API timeout');
      });

      it('should handle exceptions from S3 upload gracefully', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockRejectedValue(new Error('S3 connection failed'));

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to perform deep research');
        expect(result.error).toBe('S3 connection failed');
      });
    });

    describe('Parameter Passing', () => {
      it('should pass all parameters to deep research service', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        await (agentModeService as any).performDeepResearchTool(
          'AI in healthcare',
          'Include case studies',
          'executive',
          'comprehensive',
          ['ROI', 'implementation']
        );

        expect(mockDeepResearchService.performDeepResearch).toHaveBeenCalledWith({
          topic: 'AI in healthcare',
          prompt: 'Include case studies',
          tone: 'executive',
          depth: 'comprehensive',
          focus_areas: ['ROI', 'implementation']
        });
      });

      it('should handle different depth values', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nShort content.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Quick overview',
          undefined,
          'casual',
          'overview'
        );

        expect(result.success).toBe(true);
        expect(result.data.research_depth).toBe('overview');
      });

      it('should pass correct content type to S3', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\nContent.',
          title: 'Research',
          researchSummary: 'Summary'
        });
        mockUploadFileToS3.mockResolvedValue({
          success: true,
          url: 'https://s3.amazonaws.com/bucket/test.md'
        });

        await (agentModeService as any).performDeepResearchTool(
          'Test topic',
          undefined,
          'professional',
          'detailed',
          undefined,
          'user-456'
        );

        expect(mockUploadFileToS3).toHaveBeenCalledWith(
          '# Research\n\nContent.',
          expect.stringContaining('research-'),
          'user-456',
          'text/markdown'
        );
      });
    });
  });

  describe('Tool Definition', () => {
    it('should include perform_deep_research in available tools', async () => {
      const tools = await (agentModeService as any).getAvailableTools();
      const deepResearchTool = tools.find(
        (t: any) => t.function?.name === 'perform_deep_research'
      );

      expect(deepResearchTool).toBeDefined();
      expect(deepResearchTool.function.description).toContain('whitepapers');
      expect(deepResearchTool.function.description).toContain('reports');
      expect(deepResearchTool.function.description).toContain('NOT for blog articles');
    });

    it('should have correct parameters in tool definition', async () => {
      const tools = await (agentModeService as any).getAvailableTools();
      const deepResearchTool = tools.find(
        (t: any) => t.function?.name === 'perform_deep_research'
      );

      const params = deepResearchTool.function.parameters.properties;

      expect(params.topic).toBeDefined();
      expect(params.prompt).toBeDefined();
      expect(params.tone).toBeDefined();
      expect(params.tone.enum).toContain('professional');
      expect(params.tone.enum).toContain('executive');
      expect(params.tone.enum).toContain('technical');
      expect(params.tone.enum).toContain('casual');
      expect(params.depth).toBeDefined();
      expect(params.depth.enum).toContain('overview');
      expect(params.depth.enum).toContain('detailed');
      expect(params.depth.enum).toContain('comprehensive');
      expect(params.focus_areas).toBeDefined();
      expect(params.focus_areas.type).toBe('array');
    });

    it('should require only topic parameter', async () => {
      const tools = await (agentModeService as any).getAvailableTools();
      const deepResearchTool = tools.find(
        (t: any) => t.function?.name === 'perform_deep_research'
      );

      expect(deepResearchTool.function.parameters.required).toEqual(['topic']);
    });

    it('should have depth description with page estimates', async () => {
      const tools = await (agentModeService as any).getAvailableTools();
      const deepResearchTool = tools.find(
        (t: any) => t.function?.name === 'perform_deep_research'
      );

      const depthDesc = deepResearchTool.function.parameters.properties.depth.description;
      expect(depthDesc).toContain('overview');
      expect(depthDesc).toContain('1-2 pages');
      expect(depthDesc).toContain('detailed');
      expect(depthDesc).toContain('3-5 pages');
      expect(depthDesc).toContain('comprehensive');
      expect(depthDesc).toContain('5-10 pages');
    });

    it('should mention S3 URL in response description', async () => {
      const tools = await (agentModeService as any).getAvailableTools();
      const deepResearchTool = tools.find(
        (t: any) => t.function?.name === 'perform_deep_research'
      );

      expect(deepResearchTool.function.description).toContain('S3');
      expect(deepResearchTool.function.description).toContain('research_url');
    });
  });
});
