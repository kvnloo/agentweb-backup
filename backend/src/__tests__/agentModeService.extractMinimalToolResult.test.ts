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

  describe('landing-page deployment result extraction (ENG-736)', () => {
    it('preserves buildStatus + deployedUrl from a get_deployment_status result', () => {
      const result = {
        status: 'deployed',
        buildStatus: 'success',
        deployedUrl: 'https://example.agentwebforms.com/pilot',
      };
      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'get_deployment_status');
      expect(minimalResult).toEqual({
        status: 'deployed',
        buildStatus: 'success',
        deployedUrl: 'https://example.agentwebforms.com/pilot',
      });
    });

    it('preserves status + deployedUrl + name + ids from a generate_landing_page record', () => {
      const result = {
        id: 'page-123',
        status: 'deployed',
        deployedUrl: 'https://example.agentwebforms.com/pilot',
        name: 'Cold Outreach',
        leadListId: 'list-9',
        slug: 'pilot',
        prompt: 'a very long prompt that must be dropped',
      };
      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'generate_landing_page');
      expect(minimalResult).toEqual({
        id: 'page-123',
        status: 'deployed',
        deployedUrl: 'https://example.agentwebforms.com/pilot',
        name: 'Cold Outreach',
        leadListId: 'list-9',
      });
    });

    it('parses an MCP-wrapped (content string) landing result', () => {
      const wrapped = {
        content: JSON.stringify({
          buildStatus: 'success',
          previewUrl: 'https://preview.example.com',
        }),
      };
      const minimalResult = (agentModeService as any).extractMinimalToolResult(wrapped, 'get_landing_page_preview_url');
      expect(minimalResult).toEqual({
        buildStatus: 'success',
        previewUrl: 'https://preview.example.com',
      });
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

    // ENG-1027: this minimizer whitelists fields per tool — everything unnamed is
    // dropped (ENG-736/ENG-1526 already hit this trap for other tools). Without this
    // case, the post-generation data-fabrication warning would silently vanish before
    // reaching Emma, exactly like the un-relayed approval tokens did.
    it('preserves dataReliabilityWarning from a generate_image result', () => {
      const result = {
        success: true,
        message: 'Image generated successfully',
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png',
        dataReliabilityWarning: 'DATA RELIABILITY CHECK: this image appears to contain specific numbers...'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'generate_image');

      expect(minimalResult.dataReliabilityWarning).toBe(result.dataReliabilityWarning);
    });

    it('omits dataReliabilityWarning when the check did not fire', () => {
      const result = {
        success: true,
        message: 'Image generated successfully',
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'generate_image');

      expect(minimalResult.dataReliabilityWarning).toBeUndefined();
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

  // ENG-1472: the workplan_recommendation result MUST survive minimization —
  // it is the only thing that lets the customer portal render the recommendation
  // card again after a reload (the ledger entry is all it has at that point).
  describe('recommend_predefined_work_plan result extraction', () => {
    const successResult = {
      success: true,
      type: 'workplan_recommendation',
      version: 1,
      recommendationId: 'abc123',
      plan: {
        id: 'plan-onboard',
        title: 'Client Onboarding',
        summary: 'Get a new client set up',
        steps: [{ position: 1, label: 'Analyze website' }],
      },
      reason: 'The user wants to onboard a new client.',
      formattedContent: 'Recommended work plan "Client Onboarding" — because reasons',
    };

    it('preserves the full structured payload for a successful proposal (reload survives)', () => {
      const minimalResult = (agentModeService as any).extractMinimalToolResult(successResult, 'recommend_predefined_work_plan');

      expect(minimalResult).toEqual({
        success: true,
        type: 'workplan_recommendation',
        version: 1,
        recommendationId: 'abc123',
        plan: successResult.plan,
        reason: 'The user wants to onboard a new client.',
      });
      // formattedContent (model-visible only) is dropped from the persisted ledger entry.
      expect(minimalResult.formattedContent).toBeUndefined();
    });

    it('preserves the source marker when present (completion-recommendation extension)', () => {
      const minimalResult = (agentModeService as any).extractMinimalToolResult(
        { ...successResult, source: 'completion_next' },
        'recommend_predefined_work_plan',
      );
      expect(minimalResult.source).toBe('completion_next');
    });

    it('minimizes a rejected/failed proposal to success:false + message only (boundary/malformed case)', () => {
      const minimalResult = (agentModeService as any).extractMinimalToolResult(
        { success: false, message: 'Work plan template "plan-x" is not available.' },
        'recommend_predefined_work_plan',
      );
      expect(minimalResult).toEqual({ success: false, message: 'Work plan template "plan-x" is not available.' });
      expect(minimalResult.type).toBeUndefined();
    });

    it('never treats a wrong-type/unversioned payload as a valid recommendation', () => {
      const minimalResult = (agentModeService as any).extractMinimalToolResult(
        { success: true, type: 'workplan_recommendation', version: 2, plan: { id: 'x' } },
        'recommend_predefined_work_plan',
      );
      expect(minimalResult).toEqual({ success: true, message: undefined });
      expect(minimalResult.plan).toBeUndefined();
    });
  });

  // ENG-1720: the de-dupe outcome must survive the minimizer, or the requirement
  // verdict cannot tell a skipped send from a delivered one. linkedin_outreach has
  // no general branch, so anything not named here becomes the `{}` default — and a
  // `{}` result reads as SUCCESS to toolCallSucceeded (no error, no success:false).
  // That is how a run which contacted nobody stored passed:true / { actual: 2 }.
  describe('linkedin_outreach de-duplicated send (ENG-1720)', () => {
    it('preserves alreadyInvited so a skipped send is not scored as a delivery', () => {
      const result = {
        success: true,
        alreadyInvited: true,
        message: 'A LinkedIn connection invitation is already pending for this profile. Skipped to avoid a duplicate — no invite quota was used.',
        data: { alreadyInvited: true, sentAt: '2026-09-09T13:32:45.644Z' },
      };
      const minimal = (agentModeService as any).extractMinimalToolResult(result, 'linkedin_outreach');
      expect(minimal.alreadyInvited).toBe(true);
      expect(minimal.success).toBe(true);
    });

    it('a real delivery is NOT marked alreadyInvited', () => {
      const result = { success: true, data: { invitationId: '7503444979126583297' } };
      const minimal = (agentModeService as any).extractMinimalToolResult(result, 'linkedin_outreach');
      expect(minimal?.alreadyInvited).toBeFalsy();
    });
  });

});