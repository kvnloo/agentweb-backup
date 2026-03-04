// Tests for publish_blog_article status surfacing on HTML reports

import { AgentModeService } from '../services/agentModeService';

describe('publish_blog_article publish status', () => {
  describe('extractMinimalToolResult', () => {
    let agentModeService: AgentModeService;

    beforeEach(() => {
      agentModeService = new AgentModeService();
    });

    it('should preserve success, message, and data fields from publish_blog_article result', () => {
      const result = {
        success: true,
        message: 'Blog article published successfully to Webflow as published',
        data: {
          title: 'My Article',
          status: 'published',
          cmsType: 'Webflow',
          cmsResponse: { id: 'abc123', fieldData: { name: 'My Article', slug: 'my-article' } }
        }
      };

      const minimal = (agentModeService as any).extractMinimalToolResult(result, 'publish_blog_article');

      expect(minimal).toEqual({
        success: true,
        message: 'Blog article published successfully to Webflow as published',
        data: {
          title: 'My Article',
          status: 'published',
          cmsType: 'Webflow',
        }
      });
      // cmsResponse should be stripped out
      expect(minimal.data.cmsResponse).toBeUndefined();
    });

    it('should preserve error field when publish fails', () => {
      const result = {
        success: false,
        message: 'Categories required for published articles',
        error: 'Categories required for published articles'
      };

      const minimal = (agentModeService as any).extractMinimalToolResult(result, 'publish_blog_article');

      expect(minimal).toEqual({
        success: false,
        message: 'Categories required for published articles',
        error: 'Categories required for published articles'
      });
      expect(minimal.data).toBeUndefined();
    });

    it('should handle draft status in data', () => {
      const result = {
        success: true,
        message: 'Blog article published successfully to Webflow as draft',
        data: {
          title: 'Draft Article',
          status: 'draft',
          cmsType: 'Webflow',
          cmsResponse: { id: 'def456' }
        }
      };

      const minimal = (agentModeService as any).extractMinimalToolResult(result, 'publish_blog_article');

      expect(minimal.data.status).toBe('draft');
      expect(minimal.data.title).toBe('Draft Article');
      expect(minimal.data.cmsType).toBe('Webflow');
    });

    it('should handle MCP-wrapped result (content as JSON string)', () => {
      const wrappedResult = {
        content: JSON.stringify({
          success: true,
          message: 'Published successfully',
          data: {
            title: 'Wrapped Article',
            status: 'published',
            cmsType: 'Webflow',
            cmsResponse: { id: 'xyz789' }
          }
        }),
        raw: {}
      };

      const minimal = (agentModeService as any).extractMinimalToolResult(wrappedResult, 'publish_blog_article');

      expect(minimal.success).toBe(true);
      expect(minimal.data.status).toBe('published');
      expect(minimal.data.cmsResponse).toBeUndefined();
    });

    it('should not affect other tools (still returns empty object)', () => {
      const result = {
        success: true,
        data: { status: 'published' }
      };

      const minimal = (agentModeService as any).extractMinimalToolResult(result, 'some_other_tool');
      expect(minimal).toEqual({});
    });
  });

  describe('html-reports publish status annotation', () => {
    // Replicate the publish status annotation logic from tasks.ts

    const annotatePublishStatus = (messages: any[], resultFiles: any[]) => {
      messages.forEach((message: any) => {
        if (message.metadata?.toolCalls) {
          message.metadata.toolCalls.forEach((toolCall: any) => {
            if (toolCall.name === 'publish_blog_article') {
              const blogHtmlUrl = toolCall.arguments?.blog_html_url;
              if (!blogHtmlUrl) return;

              const publishStatus = toolCall.result?.data?.status
                || toolCall.arguments?.status
                || 'draft';

              const isSuccess = toolCall.result?.success !== undefined
                ? toolCall.result.success
                : !toolCall.error;

              if (!isSuccess) return;

              const matchingFile = resultFiles.find((file: any) => file.url === blogHtmlUrl);
              if (matchingFile) {
                matchingFile.publishStatus = publishStatus;
              }
            }
          });
        }
      });
    };

    it('should annotate file with published status from result.data.status (new format)', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/report.html', filename: 'report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'publish_blog_article',
            arguments: {
              blog_html_url: 'https://bucket.s3.amazonaws.com/files/report.html',
              status: 'published'
            },
            result: {
              success: true,
              message: 'Published',
              data: { status: 'published', title: 'Test', cmsType: 'Webflow' }
            }
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBe('published');
    });

    it('should annotate file with draft status from arguments.status (old format, result is {})', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/report.html', filename: 'report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'publish_blog_article',
            arguments: {
              blog_html_url: 'https://bucket.s3.amazonaws.com/files/report.html',
              status: 'draft'
            },
            result: {}
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBe('draft');
    });

    it('should default to draft when no status available', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/report.html', filename: 'report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'publish_blog_article',
            arguments: {
              blog_html_url: 'https://bucket.s3.amazonaws.com/files/report.html'
            },
            result: {}
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBe('draft');
    });

    it('should not annotate when tool call failed (result.success is false)', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/report.html', filename: 'report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'publish_blog_article',
            arguments: {
              blog_html_url: 'https://bucket.s3.amazonaws.com/files/report.html',
              status: 'published'
            },
            result: {
              success: false,
              message: 'Categories required',
              error: 'Categories required for published articles'
            }
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBeUndefined();
    });

    it('should not annotate when tool call has error (old error format)', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/report.html', filename: 'report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'publish_blog_article',
            arguments: {
              blog_html_url: 'https://bucket.s3.amazonaws.com/files/report.html',
              status: 'published'
            },
            error: 'Some error occurred'
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBeUndefined();
    });

    it('should not annotate when blog_html_url is missing from arguments', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/report.html', filename: 'report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'publish_blog_article',
            arguments: { status: 'published' },
            result: { success: true, data: { status: 'published' } }
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBeUndefined();
    });

    it('should not annotate files from other tool calls', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/report.html', filename: 'report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'create_blog_article',
            arguments: {
              blog_html_url: 'https://bucket.s3.amazonaws.com/files/report.html'
            },
            result: { success: true }
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBeUndefined();
    });

    it('should skip files that do not match the blog_html_url', () => {
      const resultFiles: any[] = [
        { url: 'https://bucket.s3.amazonaws.com/files/other-report.html', filename: 'other-report.html' }
      ];

      const messages = [{
        role: 'assistant',
        metadata: {
          toolCalls: [{
            name: 'publish_blog_article',
            arguments: {
              blog_html_url: 'https://bucket.s3.amazonaws.com/files/report.html',
              status: 'published'
            },
            result: { success: true, data: { status: 'published' } }
          }]
        }
      }];

      annotatePublishStatus(messages, resultFiles);

      expect(resultFiles[0].publishStatus).toBeUndefined();
    });
  });
});
