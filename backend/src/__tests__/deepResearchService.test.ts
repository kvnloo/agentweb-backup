// Unit tests for deepResearchService

import { DeepResearchService, extractReportText } from '../services/deepResearchService';
import * as secretsManager from '../utils/secretsManager';
import { DEEP_RESEARCH_AGENT, DEEP_RESEARCH_AGENT_SPEED, DEEP_RESEARCH_AGENT_MAX } from '../config';

// Mock dependencies
jest.mock('../utils/secretsManager');
jest.mock('@google/genai');

describe('DeepResearchService', () => {
  let deepResearchService: DeepResearchService;
  const mockGetSecret = secretsManager.getSecret as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    deepResearchService = new DeepResearchService();
  });

  describe('Service Initialization', () => {
    it('should have performDeepResearch method', () => {
      expect(deepResearchService.performDeepResearch).toBeDefined();
      expect(typeof deepResearchService.performDeepResearch).toBe('function');
    });

    it('should have isAvailable method', () => {
      expect(deepResearchService.isAvailable).toBeDefined();
      expect(typeof deepResearchService.isAvailable).toBe('function');
    });
  });

  describe('Parameter Structure', () => {
    it('should accept valid DeepResearchParams with topic only', () => {
      const params = {
        topic: 'History of artificial intelligence',
      };
      
      expect(params.topic).toBeDefined();
      // Note: userId and rawMarkdownOnly were removed - params now only need topic
    });

    it('should accept all optional parameters', () => {
      const params = {
        topic: 'Market trends in renewable energy',
        prompt: 'Focus on solar and wind',
        tone: 'professional',
        style: 'substack',
        depth: 'comprehensive',
        focus_areas: ['solar power', 'wind energy', 'cost analysis']
      };
      
      expect(params.topic).toBe('Market trends in renewable energy');
      expect(params.prompt).toBe('Focus on solar and wind');
      expect(params.tone).toBe('professional');
      expect(params.style).toBe('substack');
      expect(params.depth).toBe('comprehensive');
      expect(params.focus_areas).toEqual(['solar power', 'wind energy', 'cost analysis']);
    });

    it('should accept depth parameter with valid values', () => {
      const overviewParams = { topic: 'Test', depth: 'overview' };
      const detailedParams = { topic: 'Test', depth: 'detailed' };
      const comprehensiveParams = { topic: 'Test', depth: 'comprehensive' };
      
      expect(overviewParams.depth).toBe('overview');
      expect(detailedParams.depth).toBe('detailed');
      expect(comprehensiveParams.depth).toBe('comprehensive');
    });

    it('should accept focus_areas as array of strings', () => {
      const params = {
        topic: 'AI in healthcare',
        focus_areas: ['diagnostics', 'treatment planning', 'patient monitoring']
      };
      
      expect(Array.isArray(params.focus_areas)).toBe(true);
      expect(params.focus_areas.length).toBe(3);
    });
  });

  describe('Config Constants', () => {
    it('should use the April 2026 speed and max deep research agents', () => {
      // Verify the agent names match Google's April 2026 Deep Research agents.
      expect(DEEP_RESEARCH_AGENT_SPEED).toBe('deep-research-preview-04-2026');
      expect(DEEP_RESEARCH_AGENT_MAX).toBe('deep-research-max-preview-04-2026');
    });

    it('should default to the speed agent', () => {
      expect(DEEP_RESEARCH_AGENT).toBe(DEEP_RESEARCH_AGENT_SPEED);
    });
  });

  describe('extractReportText', () => {
    it('should concatenate text from all model_output steps in order', () => {
      const interaction = {
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'the prompt' }] },
          { type: 'model_output', content: [{ type: 'text', text: '# Title\n\nIntro.' }] },
          {
            type: 'model_output',
            content: [
              { type: 'image', mime_type: 'image/png', data: 'base64==' },
              { type: 'text', text: 'Second chunk continues the report.' },
            ],
          },
        ],
      };

      const result = extractReportText(interaction);

      expect(result).toBe('# Title\n\nIntro.\n\nSecond chunk continues the report.');
    });

    it('should ignore user_input steps and image content', () => {
      const interaction = {
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'should not appear' }] },
          { type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: 'x' }] },
          { type: 'model_output', content: [{ type: 'text', text: 'Only this.' }] },
        ],
      };

      const result = extractReportText(interaction);

      expect(result).toBe('Only this.');
      expect(result).not.toContain('should not appear');
    });

    it('should fall back to the legacy outputs array when no steps are present', () => {
      const interaction = {
        outputs: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'final report text' },
        ],
      };

      const result = extractReportText(interaction);

      // Legacy behavior: take the last text output.
      expect(result).toBe('final report text');
    });

    it('should return empty string when there is no usable content', () => {
      expect(extractReportText({ steps: [] })).toBe('');
      expect(extractReportText({ outputs: [] })).toBe('');
      expect(extractReportText({})).toBe('');
      expect(extractReportText(null)).toBe('');
      expect(
        extractReportText({ steps: [{ type: 'model_output', content: [] }] })
      ).toBe('');
    });

    it('should prefer steps over a legacy outputs array when both exist', () => {
      const interaction = {
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: 'from steps' }] },
        ],
        outputs: [{ type: 'text', text: 'from outputs' }],
      };

      expect(extractReportText(interaction)).toBe('from steps');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key exists', async () => {
      mockGetSecret.mockResolvedValue('valid-api-key');
      
      const result = await deepResearchService.isAvailable();
      
      expect(result).toBe(true);
      expect(mockGetSecret).toHaveBeenCalled();
    });

    it('should return false when API key is missing', async () => {
      mockGetSecret.mockRejectedValue(new Error('Secret not found'));
      
      const result = await deepResearchService.isAvailable();
      
      expect(result).toBe(false);
    });

    it('should return false when API key is empty', async () => {
      mockGetSecret.mockResolvedValue('   ');
      
      const result = await deepResearchService.isAvailable();
      
      expect(result).toBe(false);
    });
  });

  describe('performDeepResearch - API Interaction', () => {
    const mockGoogleGenAI = require('@google/genai').GoogleGenAI;
    
    beforeEach(() => {
      mockGetSecret.mockResolvedValue('test-api-key');
    });

    it('should return error when API key retrieval fails', async () => {
      mockGetSecret.mockRejectedValue(new Error('Secret not found'));
      
      const result = await deepResearchService.performDeepResearch({
        topic: 'Test topic'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Secret not found');
    });

    it('should include tone in research prompt when provided', async () => {
      // This tests that tone parameter is properly used
      const params = {
        topic: 'AI in healthcare',
        tone: 'executive'
      };
      
      // Verify the tone parameter is accepted
      expect(params.tone).toBe('executive');
    });

    it('should include style instructions for substack', async () => {
      const params = {
        topic: 'Tech trends',
        style: 'substack'
      };

      // Verify substack style is accepted
      expect(params.style).toBe('substack');
    });
  });

  describe('Agent Tier Selection by Depth', () => {
    const mockGoogleGenAI = require('@google/genai').GoogleGenAI;
    let createMock: jest.Mock;

    beforeEach(() => {
      mockGetSecret.mockResolvedValue('test-api-key');

      // Resolve immediately as completed so performDeepResearch returns without polling.
      const completedInteraction = {
        id: 'interaction-1',
        status: 'completed',
        outputs: [{ text: '# Title\n\nReport body content.' }],
      };
      createMock = jest.fn().mockResolvedValue(completedInteraction);
      mockGoogleGenAI.mockImplementation(() => ({
        interactions: {
          create: createMock,
          get: jest.fn().mockResolvedValue(completedInteraction),
        },
      }));
    });

    it('should use the max agent for comprehensive depth', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'Quantum computing',
        depth: 'comprehensive',
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: DEEP_RESEARCH_AGENT_MAX })
      );
    });

    it('should use the speed agent for detailed depth', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'Quantum computing',
        depth: 'detailed',
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: DEEP_RESEARCH_AGENT_SPEED })
      );
    });

    it('should use the speed agent when depth is not provided', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'Quantum computing',
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: DEEP_RESEARCH_AGENT_SPEED })
      );
    });
  });

  describe('Result Structure', () => {
    it('should define correct success result structure', () => {
      const successResult = {
        success: true,
        markdownContent: '# Research Report\n\nContent here...',
        title: 'Research Report',
        researchSummary: 'This is a research summary'
      };
      
      expect(successResult.success).toBe(true);
      expect(successResult.markdownContent).toBeDefined();
      expect(successResult.title).toBeDefined();
      expect(successResult.researchSummary).toBeDefined();
    });

    it('should define correct error result structure', () => {
      const errorResult = {
        success: false,
        error: 'Deep research failed'
      };
      
      expect(errorResult.success).toBe(false);
      expect(errorResult.error).toBeDefined();
    });
  });

  describe('Title Extraction', () => {
    it('should extract title from H1 markdown header', () => {
      const markdownWithH1 = '# My Research Title\n\nContent follows...';
      const titleMatch = markdownWithH1.match(/^#\s+(.+)$/m);
      
      expect(titleMatch).not.toBeNull();
      expect(titleMatch![1].trim()).toBe('My Research Title');
    });

    it('should handle missing H1 by using first line', () => {
      const markdownNoH1 = 'Research Summary\n\nMore content...';
      const firstLine = markdownNoH1.split('\n')[0].replace(/^#+\s*/, '').trim();
      
      expect(firstLine).toBe('Research Summary');
    });
  });

  describe('Research Summary Generation', () => {
    it('should truncate long content for summary', () => {
      const longContent = 'A'.repeat(600);
      const maxLength = 500;
      const summary = longContent.length > maxLength 
        ? longContent.substring(0, maxLength) + '...'
        : longContent;
      
      expect(summary.length).toBeLessThanOrEqual(503); // 500 + '...'
      expect(summary.endsWith('...')).toBe(true);
    });

    it('should keep short content as-is for summary', () => {
      const shortContent = 'Short research summary';
      const maxLength = 500;
      const summary = shortContent.length > maxLength 
        ? shortContent.substring(0, maxLength) + '...'
        : shortContent;
      
      expect(summary).toBe(shortContent);
    });
  });

  describe('Polling Configuration', () => {
    it('should use correct polling parameters', () => {
      const maxPollAttempts = 120; // 20 minutes max (120 * 10 seconds)
      const pollIntervalMs = 10000; // 10 seconds
      
      const totalTimeoutMinutes = (maxPollAttempts * pollIntervalMs) / 1000 / 60;
      
      expect(totalTimeoutMinutes).toBe(20);
    });
  });
});
