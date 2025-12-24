// Unit tests for perform_deep_research tool in agentModeService

import { AgentModeService } from '../services/agentModeService';

// Mock deep research service
jest.mock('../services/deepResearchService', () => ({
  deepResearchService: {
    isAvailable: jest.fn(),
    performDeepResearch: jest.fn()
  }
}));

describe('AgentModeService - perform_deep_research tool', () => {
  let agentModeService: AgentModeService;
  let mockDeepResearchService: {
    isAvailable: jest.Mock;
    performDeepResearch: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    
    const deepResearchModule = require('../services/deepResearchService');
    mockDeepResearchService = deepResearchModule.deepResearchService;
  });

  describe('performDeepResearchTool', () => {
    describe('Success Cases', () => {
      it('should return structured research data on success', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# AI Agents in Marketing\n\n## Overview\n\nThis is research content about AI agents.\n\n## Key Findings\n\n- Finding one with important details\n- Finding two with more information\n\n## Conclusion\n\nAI agents are transforming marketing.',
          title: 'AI Agents in Marketing',
          researchSummary: 'Research about AI agents in marketing automation.'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'AI agents in marketing',
          'Focus on automation benefits',
          'professional',
          'detailed',
          ['market trends', 'use cases']
        );

        expect(result.success).toBe(true);
        expect(result.data.markdown_content).toContain('# AI Agents in Marketing');
        expect(result.data.title).toBe('AI Agents in Marketing');
        expect(result.data.summary).toBeDefined();
        expect(result.data.word_count).toBeGreaterThan(0);
        expect(result.data.research_depth).toBe('detailed');
        expect(result.data.topic).toBe('AI agents in marketing');
      });

      it('should extract key findings from headers', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Main Title\n\n## First Finding\n\nContent.\n\n## Second Finding\n\nMore content.\n\n### Sub Finding\n\nDetails.',
          title: 'Main Title',
          researchSummary: 'Summary text'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(true);
        expect(result.data.key_findings).toContain('First Finding');
        expect(result.data.key_findings).toContain('Second Finding');
        expect(result.data.key_findings).toContain('Sub Finding');
      });

      it('should extract key findings from bullet points', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Research\n\n- This is a long bullet point that should be included in findings\n- Another detailed finding with enough characters\n- Short\n* Asterisk bullet with sufficient length for inclusion',
          title: 'Research',
          researchSummary: 'Summary'
        });

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(true);
        expect(result.data.key_findings.length).toBeLessThanOrEqual(5);
      });

      it('should use default values for optional parameters', async () => {
        mockDeepResearchService.isAvailable.mockResolvedValue(true);
        mockDeepResearchService.performDeepResearch.mockResolvedValue({
          success: true,
          markdownContent: '# Test Research\n\nContent here.',
          title: 'Test Research',
          researchSummary: 'Test summary'
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
    });

    describe('Exception Handling', () => {
      it('should handle exceptions gracefully', async () => {
        mockDeepResearchService.isAvailable.mockRejectedValue(new Error('Network error'));

        const result = await (agentModeService as any).performDeepResearchTool(
          'Test topic'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to perform deep research');
        expect(result.error).toBe('Network error');
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

        const result = await (agentModeService as any).performDeepResearchTool(
          'Quick overview',
          undefined,
          'casual',
          'overview'
        );

        expect(result.success).toBe(true);
        expect(result.data.research_depth).toBe('overview');
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
  });
});
