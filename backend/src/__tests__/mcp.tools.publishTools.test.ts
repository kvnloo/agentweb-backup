/**
 * Unit tests for MCP server publishing tools
 * Tests that publish_blog_article and post_on_connected_account have correct parameters
 */

import { mcpToolRegistry } from '../mcp/server/registry';

// Import the tools to ensure they're registered
import '../mcp/server/tools';

describe('MCP Publishing Tools', () => {
  describe('publish_blog_article tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('publish_blog_article');
    });

    it('should have all required parameters including status, author, and categories', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      expect(tool).toBeDefined();

      const schema = tool?.definition.inputSchema;
      expect(schema).toBeDefined();
      expect(schema?.properties).toBeDefined();

      // Check required parameters
      expect(schema?.required).toContain('title');
      expect(schema?.required).toContain('description');
      expect(schema?.required).toContain('hero_image_url');
      expect(schema?.required).toContain('blog_html_url');

      // Check optional parameters
      expect(schema?.properties?.status).toBeDefined();
      expect(schema?.properties?.author).toBeDefined();
      expect(schema?.properties?.categories).toBeDefined();
    });

    it('should have status parameter with draft and published enum values', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      const statusParam = tool?.definition.inputSchema?.properties?.status;

      expect(statusParam).toBeDefined();
      expect(statusParam?.enum).toEqual(['draft', 'published']);
      expect(statusParam?.default).toBe('draft');
    });

    it('should have categories parameter as array of strings', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      const categoriesParam = tool?.definition.inputSchema?.properties?.categories;

      expect(categoriesParam).toBeDefined();
      expect(categoriesParam?.type).toBe('array');
      expect(categoriesParam?.items?.type).toBe('string');
      expect(categoriesParam?.default).toEqual([]);
    });

    it('should have author parameter as string', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      const authorParam = tool?.definition.inputSchema?.properties?.author;

      expect(authorParam).toBeDefined();
      expect(authorParam?.type).toBe('string');
    });

    it('should have description that mentions user review and approval', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      const description = tool?.definition.description;

      expect(description).toBeDefined();
      expect(description).toContain('CRITICAL');
      expect(description?.toLowerCase()).toContain('review');
      expect(description?.toLowerCase()).toContain('approval');
    });

    it('should have description that mentions categories are required for published status', () => {
      const tool = mcpToolRegistry.getTool('publish_blog_article');
      const description = tool?.definition.description;

      expect(description).toBeDefined();
      expect(description).toContain('IMPORTANT');
      expect(description?.toLowerCase()).toContain('published');
      expect(description?.toLowerCase()).toContain('category');
    });
  });

  describe('post_on_connected_account tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('post_on_connected_account');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('post_on_connected_account');
    });

    it('should have required parameters', () => {
      const tool = mcpToolRegistry.getTool('post_on_connected_account');
      const schema = tool?.definition.inputSchema;

      expect(schema?.required).toContain('account_id');
      expect(schema?.required).toContain('content');
    });

    it('should have optional media_urls parameter', () => {
      const tool = mcpToolRegistry.getTool('post_on_connected_account');
      const schema = tool?.definition.inputSchema;

      expect(schema?.properties?.media_urls).toBeDefined();
      expect(schema?.properties?.media_urls?.type).toBe('array');
    });

    it('should have description that mentions user review and approval', () => {
      const tool = mcpToolRegistry.getTool('post_on_connected_account');
      const description = tool?.definition.description;

      expect(description).toBeDefined();
      expect(description).toContain('CRITICAL');
      expect(description?.toLowerCase()).toContain('review');
      expect(description?.toLowerCase()).toContain('approval');
    });

    it('should have content description that warns against markdown for LinkedIn', () => {
      const tool = mcpToolRegistry.getTool('post_on_connected_account');
      const contentDesc = tool?.definition.inputSchema?.properties?.content?.description;

      expect(contentDesc).toBeDefined();
      expect(contentDesc).toContain('CRITICAL FOR LINKEDIN');
      expect(contentDesc).toContain('does NOT render markdown');
      expect(contentDesc).toContain('**bold**');
      expect(contentDesc).toContain('unicode bullets');
    });
  });

  describe('create_social_media_posts tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('create_social_media_posts');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('create_social_media_posts');
    });

    it('should have content description that warns against markdown for LinkedIn', () => {
      const tool = mcpToolRegistry.getTool('create_social_media_posts');
      const contentDesc = tool?.definition.inputSchema?.properties?.posts?.items?.properties?.content?.description;

      expect(contentDesc).toBeDefined();
      expect(contentDesc).toContain('CRITICAL FOR LINKEDIN');
      expect(contentDesc).toContain('does NOT support markdown');
      expect(contentDesc).toContain('**bold**');
      expect(contentDesc).toContain('unicode bullets');
      expect(contentDesc).toContain('LinkedIn-native plain text');
    });
  });

  describe('list_cms_categories tool', () => {
    it('should be registered in the tool registry', () => {
      const tool = mcpToolRegistry.getTool('list_cms_categories');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('list_cms_categories');
    });

    it('should have no required parameters', () => {
      const tool = mcpToolRegistry.getTool('list_cms_categories');
      const schema = tool?.definition.inputSchema;

      expect(schema).toBeDefined();
      // Should have no required params or an empty required array
      expect(!schema?.required || schema?.required.length === 0).toBe(true);
    });

    it('should have description mentioning CMS categories', () => {
      const tool = mcpToolRegistry.getTool('list_cms_categories');
      const description = tool?.definition.description;

      expect(description).toBeDefined();
      expect(description?.toLowerCase()).toContain('categor');
      expect(description?.toLowerCase()).toContain('cms');
    });
  });

  describe('Tool execution', () => {
    it('should be able to get tool definitions for all publishing tools', () => {
      const definitions = mcpToolRegistry.getToolDefinitions();

      const publishBlogTool = definitions.find(
        (def: any) => def.name === 'publish_blog_article'
      );
      const postOnAccountTool = definitions.find(
        (def: any) => def.name === 'post_on_connected_account'
      );
      const listCmsCategoriesTool = definitions.find(
        (def: any) => def.name === 'list_cms_categories'
      );

      expect(publishBlogTool).toBeDefined();
      expect(postOnAccountTool).toBeDefined();
      expect(listCmsCategoriesTool).toBeDefined();
    });
  });
});
