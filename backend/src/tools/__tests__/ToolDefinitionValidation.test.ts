/**
 * Tool Definition Validation Tests
 * 
 * Validates that all tool definitions are correctly configured
 * and catch configuration errors at test time.
 */

import { 
  allToolDefinitions, 
  validateAllTools,
  DERIVED_TOOL_CATEGORIES,
  DERIVED_CATEGORY_KEYWORDS,
  DERIVED_HANDLER_CONFIGS
} from '../definitions';

describe('Tool Definition Validation', () => {
  describe('All Tools', () => {
    it('should have no validation errors', () => {
      const { valid, errors } = validateAllTools();
      
      if (!valid) {
        console.error('Tool validation errors:', errors);
      }
      
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it('should have unique tool names', () => {
      const names = allToolDefinitions.map(t => t.name);
      const uniqueNames = new Set(names);
      
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have valid categories', () => {
      // Use the single source of truth for category names
      const { TOOL_CATEGORY_NAMES } = require('../types/ToolDefinition');
      
      for (const tool of allToolDefinitions) {
        expect(TOOL_CATEGORY_NAMES).toContain(tool.category);
      }
    });

    it('should have descriptions for all tools', () => {
      for (const tool of allToolDefinitions) {
        expect(tool.schema.description).toBeDefined();
        expect(tool.schema.description.length).toBeGreaterThan(10);
      }
    });

    it('should have valid parameter schemas', () => {
      for (const tool of allToolDefinitions) {
        expect(tool.schema.parameters).toBeDefined();
        expect(tool.schema.parameters.type).toBe('object');
        
        // Required params should be in properties
        const required = tool.schema.parameters.required || [];
        const properties = Object.keys(tool.schema.parameters.properties || {});
        
        for (const req of required) {
          expect(properties).toContain(req);
        }
      }
    });
  });

  describe('Handler Configs', () => {
    it('should have handler config or specialHandler flag', () => {
      for (const tool of allToolDefinitions) {
        if (tool.handler) {
          // Either has methodName or is special handler
          if (!tool.handler.specialHandler) {
            expect(tool.handler.methodName).toBeDefined();
          }
        }
      }
    });

    it('should derive handler configs without errors', () => {
      expect(DERIVED_HANDLER_CONFIGS).toBeDefined();
      expect(Array.isArray(DERIVED_HANDLER_CONFIGS)).toBe(true);
    });

    it('should have argOrder for all derived configs', () => {
      for (const config of DERIVED_HANDLER_CONFIGS) {
        expect(config.name).toBeDefined();
        expect(config.methodName).toBeDefined();
        expect(config.argOrder).toBeDefined();
        expect(Array.isArray(config.argOrder)).toBe(true);
      }
    });
  });

  describe('Derived Data', () => {
    it('should derive tool categories from definitions', () => {
      expect(DERIVED_TOOL_CATEGORIES).toBeDefined();
      
      // Should have all categories
      const categories = Object.keys(DERIVED_TOOL_CATEGORIES);
      expect(categories.length).toBeGreaterThan(0);
      
      // Each category should have tools
      for (const [category, tools] of Object.entries(DERIVED_TOOL_CATEGORIES)) {
        expect(Array.isArray(tools)).toBe(true);
      }
    });

    it('should derive category keywords from definitions', () => {
      expect(DERIVED_CATEGORY_KEYWORDS).toBeDefined();
      
      // Should have keywords for categories
      const categories = Object.keys(DERIVED_CATEGORY_KEYWORDS);
      expect(categories.length).toBeGreaterThan(0);
      
      // Each category should have some keywords
      for (const [category, keywords] of Object.entries(DERIVED_CATEGORY_KEYWORDS)) {
        expect(Array.isArray(keywords)).toBe(true);
      }
    });

    it('should match tool count between definitions and categories', () => {
      // Count tools in definitions
      const toolCount = allToolDefinitions.length;
      
      // Count tools in derived categories
      let categoryToolCount = 0;
      for (const tools of Object.values(DERIVED_TOOL_CATEGORIES)) {
        categoryToolCount += tools.length;
      }
      
      expect(categoryToolCount).toBe(toolCount);
    });
  });

  describe('Intent Keywords', () => {
    it('should have keywords for content-heavy categories', () => {
      const contentCategories = ['content', 'research', 'crm', 'analytics'];
      
      for (const category of contentCategories) {
        const keywords = DERIVED_CATEGORY_KEYWORDS[category];
        expect(keywords).toBeDefined();
        expect(keywords.length).toBeGreaterThan(0);
      }
    });

    it('should have tools with intentKeywords defined', () => {
      const toolsWithKeywords = allToolDefinitions.filter(t => t.intentKeywords && t.intentKeywords.length > 0);
      
      // At least 50% of tools should have keywords
      expect(toolsWithKeywords.length).toBeGreaterThan(allToolDefinitions.length * 0.5);
    });
  });

  describe('Deprecated Tools', () => {
    it('should have deprecatedMessage for deprecated tools', () => {
      const deprecatedTools = allToolDefinitions.filter(t => t.deprecated);
      
      for (const tool of deprecatedTools) {
        expect(tool.deprecatedMessage).toBeDefined();
        expect(tool.deprecatedMessage!.length).toBeGreaterThan(5);
      }
    });
  });

  describe('Version Tracking', () => {
    it('should have valid semver versions', () => {
      const semverRegex = /^\d+\.\d+\.\d+$/;
      
      for (const tool of allToolDefinitions) {
        expect(tool.version).toMatch(semverRegex);
      }
    });
  });
});

describe('Category Consistency', () => {
  it('should have matching tool counts across different data structures', () => {
    // Get counts from different sources
    const definitionCount = allToolDefinitions.length;
    
    let categoryCount = 0;
    for (const tools of Object.values(DERIVED_TOOL_CATEGORIES)) {
      categoryCount += tools.length;
    }
    
    expect(categoryCount).toBe(definitionCount);
  });
});
