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

  // ENG-1635/1644 (ask_user_question retirement) — REGRESSION, found live on
  // env1, not by any pre-existing test: ask_user_question's migrated execute()
  // and resolveCampaignObjectiveGate's Path 3 both still set
  // `type: 'ask_user_question'` (unchanged calling-convention tag) while ALSO
  // carrying `questionDeckPayload` — extractMinimalToolResult's OLD branching
  // checked `result.type === 'ask_user_question'` FIRST and returned a
  // fixed field set that did NOT include questionDeckPayload, silently
  // stripping it. Downstream, partitionApprovalHalts (agentModeService.ts)
  // classifies a halt as a question-deck ONLY via
  // `Array.isArray(r.questionDeckPayload)` — with it stripped, the halt fell
  // into `otherHalts` and the iteration-end seam bailed to the OLD plain-text
  // prompt instead of building a real deck-of-one card. This exact class of
  // bug already bit this feature twice before (metaWriteManifestDigest,
  // metaWriteDispatch — see the comments in extractMinimalToolResult) and
  // this suite still didn't catch it because every existing test here calls
  // the function directly with a result shaped like ONE OR THE OTHER
  // (questionDeckPayload set XOR type set) — never both, which is exactly the
  // real shape both migrated producers emit. These tests pin the fix: the
  // questionDeckPayload check must run BEFORE the type==='ask_user_question'
  // branch, regardless of what `type` a producer sets.
  describe('questionDeckPayload preservation (ENG-1635/1644)', () => {
    it('preserves questionDeckPayload on a halt that ALSO carries the legacy type:"ask_user_question" tag (ask_user_question tool)', () => {
      const result = {
        success: true,
        awaitingUserConfirmation: true,
        type: 'ask_user_question',
        questionDeckPayload: [{
          question: 'Which Meta campaign objective?',
          options: [{ id: 'leads', label: 'Leads', recommended: true }],
          kind: 'meta_objective',
          immutable: true,
        }],
        confirmationPrompt: 'Which Meta campaign objective?',
        summary: 'Which Meta campaign objective?',
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'ask_user_question');

      expect(minimalResult.awaitingUserConfirmation).toBe(true);
      expect(Array.isArray(minimalResult.questionDeckPayload)).toBe(true);
      expect(minimalResult.questionDeckPayload).toEqual(result.questionDeckPayload);
    });

    it('preserves questionDeckPayload on the objective gate\'s halt (call_meta_marketing_api, also tagged type:"ask_user_question")', () => {
      const result = {
        success: true,
        awaitingUserConfirmation: true,
        type: 'ask_user_question',
        sessionId: 'session-1',
        questionDeckPayload: [{
          question: 'Which Meta campaign objective should this campaign use? It cannot be changed after creation.',
          options: [
            { id: 'leads', label: 'Leads', recommended: true, payload: { objective: 'OUTCOME_LEADS' } },
            { id: 'traffic', label: 'Traffic' },
          ],
          allowEmmaDecide: true,
          kind: 'meta_objective:123|test|||NONE',
          immutable: true,
        }],
        confirmationPrompt: 'Which Meta campaign objective should this campaign use? It cannot be changed after creation.',
        summary: 'Which Meta campaign objective should this campaign use? It cannot be changed after creation.',
        message: 'The campaign objective is immutable and has not been confirmed by the user yet.',
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'call_meta_marketing_api');

      expect(Array.isArray(minimalResult.questionDeckPayload)).toBe(true);
      expect(minimalResult.questionDeckPayload).toHaveLength(1);
      expect(minimalResult.questionDeckPayload[0].kind).toBe('meta_objective:123|test|||NONE');
      expect(minimalResult.questionDeckPayload[0].immutable).toBe(true);
    });

    it('still preserves questionDeckPayload when the producer tags it type:"present_question_deck" (unchanged behavior)', () => {
      const result = {
        success: true,
        awaitingUserConfirmation: true,
        type: 'present_question_deck',
        questionDeckPayload: [{ question: 'What daily budget?', options: [{ id: '50', label: '$50/day', recommended: true }] }],
        confirmationPrompt: 'Review the following 1 question(s)...',
        summary: 'Review the following 1 question(s)...',
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'present_question_deck');

      expect(Array.isArray(minimalResult.questionDeckPayload)).toBe(true);
      expect(minimalResult.questionDeckPayload).toEqual(result.questionDeckPayload);
    });

    it('falls back to the true legacy shape (options/questionId, no questionDeckPayload) when a result genuinely has neither', () => {
      const result = {
        success: true,
        awaitingUserConfirmation: true,
        type: 'ask_user_question',
        questionId: 'q-1',
        question: 'Legacy card question?',
        options: [{ id: 'a', label: 'A' }],
        recommendedOptionId: 'a',
        allowEmmaDecide: true,
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'ask_user_question');

      expect(minimalResult.questionDeckPayload).toBeUndefined();
      expect(minimalResult.type).toBe('ask_user_question');
      expect(minimalResult.questionId).toBe('q-1');
      expect(minimalResult.options).toEqual(result.options);
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
        launchReadiness: { ready: true, reasons: [] },
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
        launchReadiness: { ready: true, reasons: [] },
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
        launchReadiness: { ready: true, reasons: [] },
      });
    });

    // ENG-1868: a failed smoke test must survive minimization — this is the exact ledger
    // evidence the truthful-reporting reconciler needs to append a launch-readiness caveat.
    it('surfaces launchReadiness.ready = false when the smoke test failed', () => {
      const result = {
        status: 'deployed',
        buildStatus: 'success',
        deployedUrl: 'https://example.agentwebforms.com/pilot',
        smokeTestResult: { ok: false, leadCaptured: false, checkedAt: '2026-09-11T00:00:00Z' },
      };
      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'get_deployment_status');
      expect(minimalResult.launchReadiness).toEqual({
        ready: false,
        reasons: ['Post-deploy smoke test failed'],
      });
    });

    it('surfaces launchReadiness.ready = false when tracking was not installed', () => {
      const result = {
        status: 'deployed',
        buildStatus: 'success',
        deployedUrl: 'https://example.agentwebforms.com/pilot',
        trackingInstalled: false,
      };
      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'get_deployment_status');
      expect(minimalResult.launchReadiness).toEqual({
        ready: false,
        reasons: ['No conversion tracking (GTM) installed'],
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

  // ENG-738: perform_deep_research previously fell through to the generic `{}`
  // fallback, which drops success/error — the exact fields the
  // open-research-request tracker needs to tell a real success from a
  // still-unresolved timeout result using only this minimized entry.
  describe('perform_deep_research result extraction (ENG-738)', () => {
    it('preserves success and the research URL on a completed result', () => {
      const result = {
        success: true,
        message: 'Deep research completed successfully. Generated 2200 words of content and saved to S3.',
        data: {
          research_url: 'https://s3.amazonaws.com/bucket/research.md',
          title: 'AI in Marketing',
          summary: 'Summary text',
          word_count: 2200,
          research_depth: 'detailed',
          topic: 'AI in marketing'
        }
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'perform_deep_research');

      expect(minimalResult).toEqual({
        success: true,
        research_url: 'https://s3.amazonaws.com/bucket/research.md',
        research_depth: 'detailed',
      });
    });

    it('preserves success:false and a truncated error on a timeout result', () => {
      const result = {
        success: false,
        message: 'Deep research failed',
        error: 'Deep research failed: Request timed out',
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'perform_deep_research');

      expect(minimalResult).toEqual({
        success: false,
        error: 'Deep research failed: Request timed out',
      });
    });

    it('preserves success:false on a plain unavailable-service failure', () => {
      const result = {
        success: false,
        message: 'Deep Research service is not available. Please check API key configuration.',
        error: 'Service unavailable'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'perform_deep_research');

      expect(minimalResult).toEqual({
        success: false,
        error: 'Service unavailable',
      });
    });

    it('truncates a very long error to avoid bloating stored history', () => {
      const longError = 'x'.repeat(500);
      const result = { success: false, error: longError };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'perform_deep_research');

      expect(minimalResult.error.length).toBeLessThanOrEqual(200);
      expect(longError.startsWith(minimalResult.error)).toBe(true);
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
