/**
 * Unit tests for MCP server publishing and content tools.
 * Tests that create_blog_article, publish_blog_article, and post_on_account tools
 * are registered correctly.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
    installSkills: jest.fn(),
    listSkills: jest.fn(),
    createBlogArticle: jest.fn(),
    publishBlogArticle: jest.fn(),
  },
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

describe('MCP Publishing & Content Tools', () => {
  describe('create_blog_article tool (internal)', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('create_blog_article');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('create_blog_article');
    });

    it('should be internal (hidden from external MCP clients)', () => {
      const externalNames = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
      expect(externalNames).not.toContain('create_blog_article');
    });

    it('should have title_draft and content_draft as required', () => {
      const tool = mcpToolRegistry.getTool('create_blog_article');
      const schema = tool?.definition.inputSchema;
      expect(schema?.required).toContain('title_draft');
      expect(schema?.required).toContain('content_draft');
    });
  });

  describe('publish_blog_article tool (internal)', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('publish_blog_article');
    });

    it('should be internal (hidden from external MCP clients)', () => {
      const externalNames = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
      expect(externalNames).not.toContain('publish_blog_article');
    });

    it('should have required parameters', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      const schema = tool?.definition.inputSchema;
      expect(schema?.required).toContain('title');
      expect(schema?.required).toContain('description');
      expect(schema?.required).toContain('hero_image_url');
      expect(schema?.required).toContain('blog_html_url');
    });
  });

  describe('post_on_account tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('post_on_account');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('post_on_account');
    });

    it('should have required parameters', () => {
      const tool = mcpToolRegistry.getTool('post_on_account');
      const schema = tool?.definition.inputSchema;
      expect(schema?.required).toContain('account_id');
      expect(schema?.required).toContain('content');
    });

    it('should have optional media_urls parameter', () => {
      const tool = mcpToolRegistry.getTool('post_on_account');
      const schema = tool?.definition.inputSchema;
      expect(schema?.properties?.media_urls).toBeDefined();
      expect(schema?.properties?.media_urls?.type).toBe('array');
    });
  });

  describe('list_connected_accounts tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('list_connected_accounts');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('list_connected_accounts');
    });
  });

  describe('Tool definitions (external)', () => {
    it('should include external publishing tools but not internal content tools', () => {
      const definitions = mcpToolRegistry.getToolDefinitions();
      const toolNames = definitions.map((d: any) => d.name);

      // External tools visible to MCP clients
      expect(toolNames).toContain('post_on_account');
      expect(toolNames).toContain('list_connected_accounts');

      // Internal tools hidden from MCP clients
      expect(toolNames).not.toContain('create_blog_article');
      expect(toolNames).not.toContain('publish_blog_article');
    });
  });
});
