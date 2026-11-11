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

  it('ENG-2778: forces a final synthesis on the last step instead of the canned apology', async () => {
    // Repro of session 3d6be53d: the model pages transcripts with empty text every
    // step. On the final step the loop must tell it to stop, discard any tool call
    // it still makes, and deliver its own summary of the gathered work.
    const executed: string[] = [];
    let call = 0;
    const synthesisCalls: number[] = [];
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const messages = args[1] || [];
      const isFinal = messages.some(
        (m: any) => m?.role === 'system' && typeof m.content === 'string' && /Step budget exhausted/.test(m.content),
      );
      const n = call++;
      if (isFinal) {
        synthesisCalls.push(n);
        return buildLLMResponse({
          content: 'Recap so far: 22 baseline prospects, 9 new since Oct 24. Still missing: reply rates.',
          tool_calls: [{ id: 'late', name: 'read_tool_response', arguments: '{"char_offset":999999}' }],
        });
      }
      return buildLLMResponse({
        content: '',
        tool_calls: [{ id: `c${n}`, name: 'read_tool_response', arguments: `{"char_offset":${n * 1000}}` }],
      });
    });
    jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
      executed.push(args[2]?.char_offset ?? JSON.stringify(args[2]));
      return JSON.stringify({ success: true, data: 'mock' });
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result = (await service.generateMarketingResponse(
      'Give me a client-facing recap of the campaign since Oct 24.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
    )) as any;

    expect(result.truncatedByStepBudget).toBe(true);
    expect(result.content).toMatch(/Recap so far/);
    expect(result.content).not.toMatch(/reached the maximum number of processing steps/i);
    // Exactly one forced synthesis call, and it was the last LLM call; maxIterations not raised.
    expect(synthesisCalls).toHaveLength(1);
    expect(synthesisCalls[0]).toBe(call - 1);
    expect(call).toBe(40);
    // The tool call made during the synthesis was discarded, not executed.
    expect(JSON.stringify(executed)).not.toContain('999999');
  });

  it('ENG-2778: an empty forced synthesis falls back to the step-limit message, not stale narration', async () => {
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const messages = args[1] || [];
      const isFinal = messages.some(
        (m: any) => m?.role === 'system' && typeof m.content === 'string' && /Step budget exhausted/.test(m.content),
      );
      const n = call++;
      if (isFinal) return buildLLMResponse({ content: '', tool_calls: [] });
      return buildLLMResponse({
        content: `Scanned batch ${n}.`,
        tool_calls: [{ id: `c${n}`, name: 'read_tool_response', arguments: `{"char_offset":${n * 1000}}` }],
      });
    });
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(JSON.stringify({ success: true, data: 'mock' }));
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result = (await service.generateMarketingResponse(
      'Give me a client-facing recap of the campaign since Oct 24.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
    )) as any;

    expect(result.truncatedByStepBudget).toBe(true);
    expect(result.content).not.toMatch(/^Scanned batch/);
    expect(result.content).toMatch(/reached the maximum number of processing steps/i);
  });

  it.each([
    ['the step-cap warning', () => require('../../../services/agentMode/core/termination').STEP_BUDGET_FINAL_SYNTHESIS_MESSAGE],
    ['an earlier anti-loop warning', () => require('../../../services/agentMode/core/termination').ANTI_LOOP_STOP_MESSAGE],
  ])('ENG-2778 (Opslane): a forced synthesis echoing %s ships the step-limit message, not the echo or a ledger', async (_label, getEcho) => {
    const echo: string = (getEcho as () => string)();
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const messages = args[1] || [];
      const isFinal = messages.some(
        (m: any) => m?.role === 'system' && typeof m.content === 'string' && /Step budget exhausted/.test(m.content),
      );
      const n = call++;
      if (isFinal) return buildLLMResponse({ content: echo, tool_calls: [] });
      return buildLLMResponse({
        content: '',
        tool_calls: [{ id: `c${n}`, name: 'read_tool_response', arguments: `{"char_offset":${n * 1000}}` }],
      });
    });
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(JSON.stringify({ success: true, data: 'mock' }));
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result = (await service.generateMarketingResponse(
      'Research the lead lists thoroughly and produce a full report.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
    )) as any;

    expect(result.truncatedByStepBudget).toBe(true);
    expect(result.content).not.toContain('[SYSTEM');
    expect(result.content).not.toMatch(/summary below is built directly from the actions/i);
    expect(result.content).toMatch(/reached the maximum number of processing steps/i);
  });

  it('ENG-2854: reports completed LP writes and resumable state without another loop', async () => {
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async () => buildLLMResponse({
      content: '',
      tool_calls: [{ id: `write-${call}`, name: 'coding_agent', arguments: JSON.stringify({
        page_id: 'lp-flatfee', task_description: `Edit section ${call++}`,
      }) }],
    }));
    jest.spyOn(service as any, 'executeTool').mockResolvedValue({ content: JSON.stringify({
      success: true, branch: 'draft/flatfee', previewUrl: 'https://preview.example/lp-flatfee',
    }) });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);
    const result = await service.generateMarketingResponse(
      'Edit my landing page sections, then verify the preview.', [], 'test-user', service.default_model, 'test-session',
    );
    expect(call).toBe(40);
    expect((service as any).executeTool.mock.calls).toHaveLength(39);
    expect(result.content).toContain('lp-flatfee');
    expect(result.content).toContain('draft/flatfee');
    expect(result.content).toContain('https://preview.example/lp-flatfee');
    expect(result.content).toMatch(/What changed/);
    expect(result.content).toMatch(/What remains/);
    expect(result.content).toMatch(/How to resume/);
    expect(result.content).toMatch(/Yugo.*engineering/i);
    expect(result.content).toMatch(/not.*automatically retr/i);
    expect(result.responseMessages.filter((m: any) => m.role === 'assistant').at(-1)?.content).toBe(result.content);
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

describe('ENG-2778 step-cap warning echo', () => {
  it('treats a verbatim echo of STEP_BUDGET_FINAL_SYNTHESIS_MESSAGE as unusable synthesis', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isUnusableSynthesis } = require('../../../services/agentMode/core/synthesisResidue');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { STEP_BUDGET_FINAL_SYNTHESIS_MESSAGE } = require('../../../services/agentMode/core/termination');
    expect(isUnusableSynthesis(STEP_BUDGET_FINAL_SYNTHESIS_MESSAGE)).toBe(true);
    expect(isUnusableSynthesis(`  ${STEP_BUDGET_FINAL_SYNTHESIS_MESSAGE}\n`)).toBe(true);
  });
});
