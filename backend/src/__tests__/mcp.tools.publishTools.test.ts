/**
 * Unit tests for MCP server publishing tools (API-wrapping version)
 * Tests that publish_blog_post and post_on_account tools are registered correctly.
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
  agentModeService: { getUnassociatedToolNames: jest.fn().mockReturnValue([]) },
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

describe('MCP Publishing Tools (API-wrapping)', () => {
  describe('publish_blog_post tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_post');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('publish_blog_post');
    });

    it('should have article_url as a required parameter', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_post');
      const schema = tool?.definition.inputSchema;
      expect(schema?.required).toContain('article_url');
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

  describe('generate_blog_post tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('generate_blog_post');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('generate_blog_post');
    });

    it('should have title_draft and content_draft as required', () => {
      const tool = mcpToolRegistry.getTool('generate_blog_post');
      const schema = tool?.definition.inputSchema;
      expect(schema?.required).toContain('title_draft');
      expect(schema?.required).toContain('content_draft');
    });
  });

  describe('list_connected_accounts tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('list_connected_accounts');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('list_connected_accounts');
    });
  });

  describe('Tool definitions', () => {
    it('should include all publishing-related tools in definitions', () => {
      const definitions = mcpToolRegistry.getToolDefinitions();
      const toolNames = definitions.map((d: any) => d.name);

      expect(toolNames).toContain('publish_blog_post');
      expect(toolNames).toContain('post_on_account');
      expect(toolNames).toContain('generate_blog_post');
      expect(toolNames).toContain('list_connected_accounts');
    });
  });
});
