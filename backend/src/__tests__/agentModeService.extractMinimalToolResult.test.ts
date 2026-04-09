// Unit tests for extractMinimalToolResult with update_html_file support

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService - extractMinimalToolResult', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
  });

  describe('update_html_file result extraction', () => {
    it('should extract s3_url and versioned_filename from update_html_file result', () => {
      const result = {
        success: true,
        s3_url: 'https://s3.amazonaws.com/bucket/report_v2.html',
        message: 'File updated successfully with 1 replacements',
        method: 'mixed_replacement',
        replacements: [{ index: 1, success: true }],
        versioned_filename: 'report_v2.html'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'update_html_file');

      expect(minimalResult).toEqual({
        success: true,
        message: 'File updated successfully with 1 replacements',
        s3_url: 'https://s3.amazonaws.com/bucket/report_v2.html',
        versioned_filename: 'report_v2.html'
      });
    });

    it('should extract s3_url and versioned_filename from MCP-wrapped update_html_file result', () => {
      const wrappedResult = {
        content: JSON.stringify({
          success: true,
          s3_url: 'https://s3.amazonaws.com/bucket/report_v2.html',
          message: 'File updated successfully with 1 replacements',
          method: 'mixed_replacement',
          replacements: [{ index: 1, success: true }],
          versioned_filename: 'report_v2.html'
        }),
        raw: {
          content: [
            {
              type: 'text',
              text: '{"success": true, "s3_url": "https://s3.amazonaws.com/bucket/report_v2.html", ...}'
            }
          ]
        }
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(wrappedResult, 'update_html_file');

      expect(minimalResult).toEqual({
        success: true,
        message: 'File updated successfully with 1 replacements',
        s3_url: 'https://s3.amazonaws.com/bucket/report_v2.html',
        versioned_filename: 'report_v2.html'
      });
    });

    it('should handle update_html_file result with missing optional fields', () => {
      const result = {
        success: true,
        s3_url: 'https://s3.amazonaws.com/bucket/report_v2.html',
        message: 'File updated successfully'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'update_html_file');

      expect(minimalResult).toEqual({
        success: true,
        message: 'File updated successfully',
        s3_url: 'https://s3.amazonaws.com/bucket/report_v2.html',
        versioned_filename: undefined
      });
    });

    it('should return empty object for other tool types', () => {
      const result = {
        success: true,
        someField: 'value'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'some_other_tool');

      expect(minimalResult).toEqual({});
    });
  });

  describe('generate_image result extraction', () => {
    it('should extract imageUrl and filename from generate_image result', () => {
      const result = {
        success: true,
        message: 'Image generated successfully',
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'generate_image');

      expect(minimalResult).toEqual({
        success: true,
        message: 'Image generated successfully',
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
    });

    it('should extract imageUrl and filename from MCP-wrapped generate_image result', () => {
      const wrappedResult = {
        content: JSON.stringify({
          success: true,
          message: 'Image generated successfully',
          imageUrl: 'https://example.com/image.png',
          filename: 'image.png'
        }),
        raw: {}
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(wrappedResult, 'generate_image');

      expect(minimalResult).toEqual({
        success: true,
        message: 'Image generated successfully',
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
    });
  });

  describe('generate_video result extraction', () => {
    it('should extract videoUrl and filename from MCP-wrapped generate_video result', () => {
      const wrappedResult = {
        content: JSON.stringify({
          success: true,
          message: 'Video generated successfully',
          videoUrl: 'https://example.com/video.mp4',
          filename: 'video.mp4'
        }),
        raw: {}
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(wrappedResult, 'generate_video');

      expect(minimalResult).toEqual({
        success: true,
        message: 'Video generated successfully',
        videoUrl: 'https://example.com/video.mp4',
        filename: 'video.mp4'
      });
    });
  });

  describe('save_file result extraction', () => {
    it('should extract file_url and file_name from save_file result', () => {
      const result = {
        success: true,
        message: 'File "report_v3.html" has been saved successfully.',
        file_url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user123/files/123/abc/report_v3.html',
        file_name: 'report_v3.html',
        file_size: 23070,
        formattedContent: '📁 **File Saved Successfully**\nFile: report_v3.html\nSize: 23070 bytes\nURL: https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user123/files/123/abc/report_v3.html'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'save_file');

      expect(minimalResult).toEqual({
        success: true,
        message: 'File "report_v3.html" has been saved successfully.',
        file_url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user123/files/123/abc/report_v3.html',
        file_name: 'report_v3.html',
      });
    });

    it('should extract file_url and file_name from MCP-wrapped save_file result', () => {
      const wrappedResult = {
        content: JSON.stringify({
          success: true,
          message: 'File "report_v3.html" has been saved successfully.',
          file_url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user123/files/123/abc/report_v3.html',
          file_name: 'report_v3.html',
          file_size: 23070
        }),
        raw: {}
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(wrappedResult, 'save_file');

      expect(minimalResult).toEqual({
        success: true,
        message: 'File "report_v3.html" has been saved successfully.',
        file_url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/user123/files/123/abc/report_v3.html',
        file_name: 'report_v3.html',
      });
    });

    it('should handle failed save_file result', () => {
      const result = {
        success: false,
        message: 'Failed to save file to S3. Please try again.',
        error: 'Upload error'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'save_file');

      expect(minimalResult).toEqual({
        success: false,
        message: 'Failed to save file to S3. Please try again.',
        file_url: undefined,
        file_name: undefined,
      });
    });
  });

  describe('report_product_issues result extraction', () => {
    it('should preserve success, message, and results on success', () => {
      const result = {
        success: true,
        message: 'All 1 issue(s) reported.',
        results: [{ title: 'Bug X', success: true, notionUrl: 'https://notion.so/123' }],
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'report_product_issues');

      expect(minimalResult).toEqual({
        success: true,
        message: 'All 1 issue(s) reported.',
        results: [{ title: 'Bug X', success: true, notionUrl: 'https://notion.so/123' }],
      });
    });

    it('should preserve success false and results on failure', () => {
      const result = {
        success: false,
        message: '0 of 1 issue(s) reported.',
        results: [{ title: 'Bug Y', success: false }],
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'report_product_issues');

      expect(minimalResult).toEqual({
        success: false,
        message: '0 of 1 issue(s) reported.',
        results: [{ title: 'Bug Y', success: false }],
      });
    });

    it('should default success to false when result has no success field', () => {
      const result = { message: 'Something happened' };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'report_product_issues');

      expect(minimalResult).toEqual({
        success: false,
        message: 'Something happened',
        results: undefined,
      });
    });
  });

  describe('task creation result extraction', () => {
    it('should extract taskId and executionId from MCP-wrapped create_task_from_template result', () => {
      const wrappedResult = {
        content: JSON.stringify({
          success: true,
          taskId: 'task-123',
          executionId: 'exec-456',
          status: 'pending',
          message: 'Task created successfully'
        }),
        raw: {}
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(wrappedResult, 'create_task_from_template');

      expect(minimalResult).toEqual({
        taskId: 'task-123',
        executionId: 'exec-456',
        status: 'pending',
        message: 'Task created successfully'
      });
    });
  });
});
