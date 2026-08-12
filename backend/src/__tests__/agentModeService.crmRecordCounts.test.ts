// ENG-1054 (reopened): the two places a CRM batch import loses its record count.
//
// 1. `extractMinimalToolResult` trimmed `add_leads_to_list` to `{}` via the default
//    branch, so the tool ledger the truthful-reporting reconcilers read held no
//    evidence of how many leads were written. A closing message stating the wrong
//    number therefore had nothing to be checked against. Same shape of carve-out as
//    ENG-736 (landing deployment) and ENG-518 (enrichment counts): keep the small
//    scalars, drop the big arrays.
//
// 2. The diagnosis agent — which writes the terminal message on the platform-timeout
//    path — is handed the session's `calledFunctions` histogram as "Succeeded
//    operations" with no statement of what its numbers count. For a 75-lead import
//    run as three batches that map reads `{"add_leads_to_list":3}`, and the agent
//    told the user it had "successfully added the 3 leads".

import { AgentModeService } from '../services/agentModeService';

describe('ENG-1054 CRM record counts', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
  });

  describe('extractMinimalToolResult — add_leads_to_list', () => {
    const extract = (result: any, tool = 'add_leads_to_list') =>
      (agentModeService as any).extractMinimalToolResult(result, tool);

    it('preserves the scalar record counts', () => {
      const minimal = extract({
        success: true,
        message: 'Successfully processed: 24 new lead(s) created, 1 lead(s) merged.',
        successCount: 25,
        newCount: 24,
        mergedCount: 1,
        errorCount: 0,
        anonymizedSkipped: 0,
        errors: undefined,
      });

      expect(minimal.successCount).toBe(25);
      expect(minimal.newCount).toBe(24);
      expect(minimal.mergedCount).toBe(1);
      expect(minimal.errorCount).toBe(0);
      expect(minimal.success).toBe(true);
    });

    it('drops the unbounded per-row errors array', () => {
      const minimal = extract({
        success: true,
        successCount: 2,
        errorCount: 2,
        errors: [
          { row: 3, message: 'invalid email' },
          { row: 9, message: 'invalid email' },
        ],
      });

      expect(minimal.errors).toBeUndefined();
      expect(minimal.errorCount).toBe(2);
      expect(minimal.successCount).toBe(2);
    });

    it('carries a failed import through as an explicit failure, not as silence', () => {
      const minimal = extract({
        success: false,
        message: 'Lead list not found',
        error: 'The specified lead list does not exist',
      });

      expect(minimal.success).toBe(false);
      expect(minimal.successCount).toBeUndefined();
    });

    it('preserves the created list identity for create_lead_list', () => {
      const minimal = extract(
        {
          success: true,
          message: 'Lead list "Q3 Founders" created successfully',
          list: { listId: 'list-123', name: 'Q3 Founders', leadCount: 0 },
        },
        'create_lead_list',
      );

      expect(minimal.success).toBe(true);
      expect(minimal.listId).toBe('list-123');
      expect(minimal.name).toBe('Q3 Founders');
    });

    it('still minimizes unrelated tools to an empty object', () => {
      expect(extract({ huge: 'payload', results: [1, 2, 3] }, 'search_leads')).toEqual({});
    });
  });

  describe('diagnosis agent prompt', () => {
    // The succeeded-operations map is a histogram of tool CALLS. Presented without
    // that label it reads as a count of the things the tool acts on — which is how a
    // 3-batch, 75-lead import became "the 3 leads".
    const buildPrompt = async (context: any) => {
      const captured: any[] = [];
      (agentModeService as any).callLLM = async (_model: string, messages: any[]) => {
        captured.push(...messages);
        return { choices: [{ message: { content: 'ok' } }] };
      };
      await agentModeService.generateDiagnosticMessage(context);
      return captured.map((m) => m.content).join('\n\n');
    };

    const CONTEXT = {
      errorType: 'timeout',
      errorMessage: 'Generation exceeded the time budget',
      userMessage: 'Import the prospects from this sheet into a new CRM list',
      workPlanSummary: null,
      failedFunctions: null,
      succeededFunctions: { add_leads_to_list: 3, create_lead_list: 1, get_lead_lists: 1 },
    };

    it('labels the succeeded-operations numbers as call counts', async () => {
      const prompt = await buildPrompt(CONTEXT);
      expect(prompt).toMatch(/number of (?:times|calls)|times the tool ran|tool CALLS/i);
      expect(prompt).toMatch(/not\b[^\n]*\b(?:records?|rows?|leads?|items?)/i);
    });

    it('forbids restating a call count as a record count', async () => {
      const prompt = await buildPrompt(CONTEXT);
      // The agent must be told to name WHAT succeeded without quoting the number.
      expect(prompt).toMatch(/do not\b[^\n]*\bnumber/i);
    });

    it('still tells the agent the operations completed', async () => {
      const prompt = await buildPrompt(CONTEXT);
      expect(prompt).toContain('add_leads_to_list');
      expect(prompt).toMatch(/COMPLETED/);
    });
  });
});
