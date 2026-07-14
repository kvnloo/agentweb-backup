/**
 * ENG-244 — live-loop proof that the REAL `generateMarketingResponse` sets
 * `truncatedByStepBudget` when it genuinely exhausts its step budget.
 *
 * The completion-gate unit tests (agentModeController.completionGate*.test.ts)
 * prove the gate CONSUMES the flag; the run-level test mocks the worker and
 * INJECTS the flag. Neither exercises the one remaining link: does the real tool
 * loop actually SET the flag at `maxIterations`?
 *
 * This test closes that gap deterministically and with no infra — it drives the
 * real loop (real anti-loop detection, real termination decisions; only `callLLM`
 * and leaf `executeTool` are scripted) to its hard `maxIterations = 40` budget by
 * scripting an unbounded stream of tool-call turns, and asserts the returned
 * object carries `truncatedByStepBudget: true`. It also pins the two properties
 * the fix depends on:
 *   - the flag fires even when final `content` is the model's own NON-empty
 *     partial text (the common case the old text-only detector missed), and
 *   - the flag is ABSENT on a clean run that finishes within budget (no false
 *     positive → no spurious continuation on healthy scheduled runs).
 */

import { AgentModeService } from '../../../services/agentModeService';
import { buildLLMResponse, installStandardMockDeps } from './harness';

// Standard agentMode mock block (module-hoisted — must live in the test file).
jest.mock('openai');
jest.mock('../../../services/settingsService');
jest.mock('../../../services/db');
jest.mock('../../../services/chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

describe('ENG-244 — real loop sets truncatedByStepBudget at the step budget', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  // Wire the leaf mocks the real loop needs, then run the REAL method and return
  // its raw result (the shared `runScenario` snapshot drops the flag).
  async function runRealLoop(makeTurn: (call: number) => any) {
    let call = 0;
    jest
      .spyOn(service as any, 'callLLM')
      .mockImplementation(async () => buildLLMResponse(makeTurn(call++)));
    jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
      const toolName: string = args[1];
      return JSON.stringify({ success: true, data: `mock:${toolName}` });
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    return (await service.generateMarketingResponse(
      'Page through all session files from the past 24h, map userIds to emails, then produce a Daily User Activity Report.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
    )) as any;
  }

  it('sets truncatedByStepBudget:true when the loop exhausts maxIterations with NON-empty partial text', async () => {
    // Every turn emits a tool call (varied args → clean past the real anti-loop
    // detector) AND its own partial, non-report text. The loop can therefore
    // never terminate on a text-only turn; it runs to the budget with non-empty
    // `content`, so the canned apology never substitutes — exactly the case the
    // old text-only detector missed.
    const result = await runRealLoop((call) => ({
      content: `Gathered page ${call + 1}; still paging the S3 export.`,
      tool_calls: [
        { id: `c${call}`, name: 'read_tool_response', arguments: `{"char_offset":${call * 1000}}` },
      ],
    }));

    expect(result.truncatedByStepBudget).toBe(true);
    // Proves it truly ran the budget, not an early break.
    expect((service as any).callLLM.mock.calls.length).toBeGreaterThanOrEqual(40);
    // The final content is the model's own partial text, NOT the canned apology.
    expect(result.content).not.toMatch(/reached the maximum number of processing steps/i);
  });

  it('sets truncatedByStepBudget:true even when content is empty at the budget (canned-apology branch)', async () => {
    const result = await runRealLoop((call) => ({
      content: '',
      tool_calls: [
        { id: `c${call}`, name: 'read_tool_response', arguments: `{"char_offset":${call * 1000}}` },
      ],
    }));

    expect(result.truncatedByStepBudget).toBe(true);
    expect(result.content).toMatch(/reached the maximum number of processing steps/i);
  });

  it('does NOT set truncatedByStepBudget on a clean run that finishes within budget (no false positive)', async () => {
    // Turn 1 gathers, turn 2 emits the final report with no tool call → clean
    // termination well under the budget.
    const result = await runRealLoop((call) =>
      call === 0
        ? { tool_calls: [{ id: 'c0', name: 'read_tool_response', arguments: '{"char_offset":0}' }] }
        : { content: '<h2>Daily User Activity Report</h2><p>Consolidated report.</p>' },
    );

    expect(result.truncatedByStepBudget).toBeFalsy();
    expect((service as any).callLLM.mock.calls.length).toBeLessThan(40);
    expect(result.content).toMatch(/Daily User Activity Report/);
  });
});
