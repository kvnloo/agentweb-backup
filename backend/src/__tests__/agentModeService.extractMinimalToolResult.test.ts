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
  });
});
