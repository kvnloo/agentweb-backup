/**
 * ENG-1133 — the resumable-import contract has to survive the DISPATCH boundary.
 *
 * `addLeadsToList` can return a rich ledger (`reconciliation`, `unimportedRows`,
 * `resumable: true`), but the agent only ever sees what `executePreparedTools`
 * forwards. That layer downgrades ANY result carrying `success: false` into a
 * structured tool error (`toolResultError`): the model is then handed the message
 * string alone — the row list is gone — the call is billed to `failedFunctions`,
 * the CRM refresh is skipped, and `appendRetryabilityGuidance` appends a verdict
 * telling the agent NOT to retry and to report the blocker to the user. That is
 * the exact whole-request hand-off the ticket exists to remove, so a unit test on
 * the tool's return value cannot prove the fix — it has to be asserted here.
 */

import { AgentModeService } from '../../services/agentModeService';
import { installStandardMockDeps, buildLLMResponse } from './characterization/harness';

jest.mock('openai');
jest.mock('../../services/settingsService');
jest.mock('../../services/db');
jest.mock('../../services/chatbotService');
jest.mock('../../utils/secretsManager');
jest.mock('../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));
jest.mock('../../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  uploadFileToS3WithPath: jest.fn().mockResolvedValue({ success: true, key: 'k' }),
  uploadScreenshotToS3: jest.fn().mockResolvedValue({ url: 'https://s3.example/shot.png' }),
  getS3ObjectAsString: jest.fn(),
}));
jest.mock('../../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn().mockResolvedValue(true),
  CRM_EDITOR_REQUIRED_MESSAGE: 'editor required',
}));

/** An import that wrote 2 of 3 rows: row 3 hit a DynamoDB write error. */
const PARTIAL_LEDGER = {
  successCount: 2, newCount: 2, mergedCount: 0, errorCount: 1,
  errors: ['Row 3: c@example.com - ProvisionedThroughputExceeded'],
  rowOutcomes: ['created', 'created', 'failed'],
};

/** An import that landed nothing — a genuine tool failure. */
const NOTHING_LANDED_LEDGER = {
  successCount: 0, newCount: 0, mergedCount: 0, errorCount: 2,
  errors: ['Row 1: a@example.com - ProvisionedThroughputExceeded'],
  rowOutcomes: ['failed', 'failed'],
};

const ROWS = [
  { email: 'a@example.com' },
  { email: 'b@example.com' },
  { email: 'c@example.com' },
];

describe('ENG-1133 — a partial lead import survives the dispatch boundary', () => {
  let service: AgentModeService;
  let socketEmit: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
    socketEmit = jest.fn();
  });

  /**
   * Build the tool result from the REAL `addLeadsToList` over a stubbed DB
   * ledger, then run it through the real dispatcher. Feeding a hand-written
   * literal here would pin only half the chain: it is precisely the `success`
   * flag `addLeadsToList` chooses that decides whether the dispatcher forwards
   * the ledger or destroys it.
   */
  async function runImport(dbLedger: any, rows = ROWS) {
    const mockDb = require('../../services/db');
    mockDb.crmDb = {
      getLeadListById: jest.fn().mockResolvedValue({ listId: 'L1', userId: 'test-user', name: 'Import' }),
      batchCreateLeads: jest.fn().mockResolvedValue(dbLedger),
    };
    const toolResult = await service.addLeadsToList('L1', rows, 'test-user');
    return { toolResult, ...(await dispatch(toolResult, rows)) };
  }

  /** Run one turn in which add_leads_to_list returns `toolResult`. */
  async function dispatch(toolResult: any, rows: any[]) {
    const callLLM = jest.spyOn(service as any, 'callLLM');
    callLLM.mockResolvedValueOnce(
      buildLLMResponse({
        tool_calls: [{
          id: 't1',
          name: 'add_leads_to_list',
          arguments: JSON.stringify({ list_id: 'L1', leads: rows }),
        }],
      }),
    );
    callLLM.mockResolvedValue(buildLLMResponse({ content: 'Import handled.' }));
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(toolResult);
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result = await service.generateMarketingResponse(
      'Import this CSV into list L1.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
      false,
      undefined,
      socketEmit,
    );
    const toolMessage = (result.responseMessages ?? []).find((m: any) => m.role === 'tool');
    return { result, toolMessage, call: result.toolCalls?.[0] };
  }

  it('hands the model the resume list instead of a tool error', async () => {
    const { toolMessage, call, toolResult } = await runImport(PARTIAL_LEDGER);

    // The incomplete import is reported as a completed CALL carrying an
    // incomplete OUTCOME — this flag is what the dispatcher keys off.
    expect(toolResult.success).toBe(true);
    expect(toolResult.complete).toBe(false);

    // Not downgraded: no `error` on the ledger entry, no error banner in the
    // message the model reads.
    expect(call.error).toBeUndefined();
    expect(toolMessage.content).not.toContain('Tool Error');

    // The rows still owed reach the model — the message tells it to resume from
    // `unimportedRows`, so `unimportedRows` has to actually be there.
    expect(toolMessage.content).toContain('unimportedRows');
    expect(toolMessage.content).toContain('c@example.com');
    expect(toolMessage.content).toContain('"resumable":true');

    // …and it is NOT told to stop and hand the retry back to the user.
    expect(toolMessage.content).not.toMatch(/do NOT retry/i);
    expect(toolMessage.content).not.toMatch(/report the blocker to the user/i);
  });

  it('does not bill an incomplete import to failedFunctions', async () => {
    const { chatbotDb } = require('../../services/chatbotService');
    await runImport(PARTIAL_LEDGER);

    expect(chatbotDb.incrementFailedFunctions).not.toHaveBeenCalled();
  });

  it('refreshes the CRM page for the rows that did land', async () => {
    await runImport(PARTIAL_LEDGER);

    expect(socketEmit).toHaveBeenCalledWith(
      'user:test-user',
      'crm-data-changed',
      expect.objectContaining({ listId: 'L1' }),
    );
  });

  it('persists the ledger so a LATER turn can resume it', async () => {
    // The turn that truncates cannot report; the resume happens on the next
    // turn, which reads the stored result. Reduced to `{}` there is nothing to
    // resume from — which is how the reported session ended in "retry".
    const { call } = await runImport(PARTIAL_LEDGER);

    expect(call.result).toMatchObject({
      complete: false,
      resumable: true,
      attempted: 3,
      unimportedRows: [{ row: 3, identifier: 'c@example.com', reason: 'failed' }],
    });
    expect(call.result.reconciliation).toMatchObject({ created: 2, failed: 1 });
  });

  it('still reports an import that landed nothing as a tool failure', async () => {
    const { toolMessage, call } = await runImport(NOTHING_LANDED_LEDGER, ROWS.slice(0, 2));

    expect(call.error).toBeDefined();
    expect(toolMessage.content).toContain('Tool Error');
    expect(socketEmit).not.toHaveBeenCalledWith(
      'user:test-user',
      'crm-data-changed',
      expect.anything(),
    );
  });
});
