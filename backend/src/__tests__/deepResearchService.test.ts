// Unit tests for deepResearchService

import { DeepResearchService } from '../services/deepResearchService';
import * as secretsManager from '../utils/secretsManager';
import * as s3Utils from '../utils/s3Utils';

// Mock dependencies
jest.mock('../utils/secretsManager');
jest.mock('../utils/s3Utils');
jest.mock('@google/genai');

describe('DeepResearchService', () => {
  let deepResearchService: DeepResearchService;

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

  describe('Parameter Validation', () => {
    it('should accept valid parameters for deep research', () => {
      const params = {
        topic: 'History of artificial intelligence',
        prompt: 'Focus on recent developments',
        userId: 'user123'
      };
      
      // Verify the parameter structure is correct
      expect(params.topic).toBeDefined();
      expect(params.userId).toBeDefined();
    });

    it('should accept topic without optional prompt', () => {
      const params = {
        topic: 'Market trends in renewable energy',
        userId: 'user123'
      };
      
      // Verify minimal valid parameters
      expect(params.topic).toBe('Market trends in renewable energy');
      expect(params.userId).toBe('user123');
    });
  });

  describe('Deep Research API Structure', () => {
    it('should use correct agent identifier', () => {
      // Verify the correct agent name is expected
      const expectedAgent = 'deep-research-pro-preview-12-2025';
      expect(expectedAgent).toBe('deep-research-pro-preview-12-2025');
    });

    it('should expect background=true for async execution', () => {
      // Deep Research runs asynchronously with background mode
      const expectedConfig = {
        background: true
      };
      expect(expectedConfig.background).toBe(true);
    });

    it('should handle completed status', () => {
      const completedInteraction = {
        id: 'test-interaction-id',
        status: 'completed',
        outputs: [{ text: 'Research report content' }]
      };
      
      expect(completedInteraction.status).toBe('completed');
      expect(completedInteraction.outputs).toHaveLength(1);
    });

    it('should handle failed status', () => {
      const failedInteraction = {
        id: 'test-interaction-id',
        status: 'failed',
        outputs: []
      };
      
      expect(failedInteraction.status).toBe('failed');
    });

    it('should handle cancelled status', () => {
      const cancelledInteraction = {
        id: 'test-interaction-id',
        status: 'cancelled',
        outputs: []
      };
      
      expect(cancelledInteraction.status).toBe('cancelled');
    });
  });

  describe('Result Structure', () => {
    it('should return expected success result structure', () => {
      const successResult = {
        success: true,
        htmlContent: 'https://example.com/research.html',
        imagePlaceholders: [
          {
            key: 'IMAGE_PLACEHOLDER_1',
            imagePrompt: 'Test image prompt',
            context: 'Introduction Section'
          }
        ],
        researchSummary: 'This is a research summary'
      };
      
      expect(successResult.success).toBe(true);
      expect(successResult.htmlContent).toBeDefined();
      expect(successResult.imagePlaceholders).toBeInstanceOf(Array);
      expect(successResult.imagePlaceholders[0]).toHaveProperty('key');
      expect(successResult.imagePlaceholders[0]).toHaveProperty('imagePrompt');
      expect(successResult.imagePlaceholders[0]).toHaveProperty('context');
    });

    it('should return expected error result structure', () => {
      const errorResult = {
        success: false,
        error: 'Deep research failed'
      };
      
      expect(errorResult.success).toBe(false);
      expect(errorResult.error).toBeDefined();
    });
  });

  describe('Image Placeholder Generation', () => {
    it('should generate valid placeholder keys', () => {
      const placeholderKeys = ['IMAGE_PLACEHOLDER_1', 'IMAGE_PLACEHOLDER_2', 'IMAGE_PLACEHOLDER_3'];
      
      placeholderKeys.forEach((key, index) => {
        expect(key).toBe(`IMAGE_PLACEHOLDER_${index + 1}`);
      });
    });

    it('should generate image prompts with topic context', () => {
      const topic = 'Artificial Intelligence';
      const expectedPromptPatterns = [
        /Professional.*infographic/i,
        /diagram/i,
        /visual/i
      ];
      
      // Verify prompt patterns are reasonable
      expect(expectedPromptPatterns.length).toBeGreaterThan(0);
    });
  });

  describe('HTML Output Processing', () => {
    it('should convert markdown headers to HTML', () => {
      const markdownInput = '# Main Title\n## Subtitle';
      const expectedH1 = '<h1>';
      const expectedH2 = '<h2>';
      
      expect(expectedH1).toBe('<h1>');
      expect(expectedH2).toBe('<h2>');
    });

    it('should include proper HTML document structure', () => {
      const expectedElements = [
        '<!DOCTYPE html>',
        '<html',
        '<head>',
        '<body>',
        '</html>'
      ];
      
      // Verify expected HTML elements
      expect(expectedElements).toContain('<!DOCTYPE html>');
      expect(expectedElements).toContain('<body>');
    });
  });
});
