/**
 * ENG-1188 — live-loop proof that the REAL `generateMarketingResponse` never ships
 * one of its own injected system nudges back to the user as if it were an answer.
 *
 * The production failure this pins: a gemini-3.1-pro-preview work-plan session
 * generated and screenshot-verified the corrected ad assets, then closed with the
 * model echoing the injected synthesis nudge back verbatim — garbage shipped as the
 * "final answer" while the real, already-completed work went undelivered.
 *
 * Unlike `synthesisResidue.test.ts` (which calls the pure `isUnusableSynthesis`
 * function directly), this file drives the loop end to end: only `callLLM` and leaf
 * `executeTool` are scripted, everything else — termination decisions, the residue
 * guard, the empty-synthesis retry ladder, anti-loop detection, the wall-clock
 * budget — runs FOR REAL. It proves the wiring, not just the detector.
 *
 * Covers all four nudges the loop can inject and ask the model to answer again
 * after (SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE, and ENG-907's
 * wall-clock nudge) — an echo of any of them must never reach the user; the loop
 * must fall back to the truthful executed-actions ledger instead.
 */

import { AgentModeService } from '../../../services/agentModeService';
import { runScenarioWithResult, installStandardMockDeps } from './harness';
import { SYNTHESIS_NUDGE, CONTINUE_PROMPT, ANTI_LOOP_STOP_MESSAGE } from '../../../services/agentMode/core/termination';
import { buildTurnTimeBudgetNudge } from '../../../utils/turnTimeBudget';

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

describe('ENG-1188 — the real loop never delivers an echoed system nudge as an answer', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('recovers with the executed-action ledger when the terminating turn echoes SYNTHESIS_NUDGE', async () => {
    const echo = `${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE}`;
    const { result, snapshot } = await runScenarioWithResult(service, {
      transcript: [
        { tool_calls: [{ id: 'c1', name: 'search_tool', arguments: '{"query":"xCures ad assets"}' }] },
        { content: echo }, // terminating turn: blanked as residue, empty-synthesis retry fires
        { content: echo }, // retry echoes again: retries exhausted, ships the ledger
      ],
    });

    expect(snapshot.llmTurnsConsumed).toBe(3);
    expect(result.content).not.toContain('gathered all the necessary data');
    expect(result.content).toContain('search_tool');
    expect(result.content).toContain('succeeded');
  });

  it('recovers with the executed-action ledger when the terminating turn echoes CONTINUE_PROMPT', async () => {
    const echo = `${CONTINUE_PROMPT} ${CONTINUE_PROMPT}`;
    const { result, snapshot } = await runScenarioWithResult(service, {
      transcript: [
        { tool_calls: [{ id: 'c1', name: 'search_tool', arguments: '{"query":"xCures ad assets"}' }] },
        { content: 'partial draft of the writeup', finish_reason: 'length' }, // continuation nudge injected
        { content: echo }, // terminating turn: blanked as residue, empty-synthesis retry fires
        { content: echo }, // retry echoes again: retries exhausted, ships the ledger
      ],
    });

    expect(snapshot.llmTurnsConsumed).toBe(4);
    expect(result.content).not.toContain('exceeded the token limit');
    expect(result.content).toContain('search_tool');
    expect(result.content).toContain('succeeded');
  });

  it('recovers with the executed-action ledger when the terminating turn echoes the anti-loop STOP message', async () => {
    const echo = `${ANTI_LOOP_STOP_MESSAGE} ${ANTI_LOOP_STOP_MESSAGE}`;
    // MAX_CONSECUTIVE_REPEATS = 3: needs 4 identical-signature tool-call turns in a
    // row before the anti-loop warning is injected ahead of the 5th call.
    const repeatedCall = { tool_calls: [{ id: 'c', name: 'search_tool', arguments: '{"query":"same"}' }] };
    const { result, snapshot } = await runScenarioWithResult(service, {
      transcript: [
        repeatedCall,
        repeatedCall,
        repeatedCall,
        repeatedCall, // anti-loop STOP message injected ahead of the next call
        { content: echo }, // terminating turn: blanked as residue, empty-synthesis retry fires
        { content: echo }, // retry echoes again: retries exhausted, ships the ledger
      ],
    });

    expect(snapshot.llmTurnsConsumed).toBe(6);
    expect(result.content).not.toContain('STOP calling tools');
    expect(result.content).toContain('search_tool');
    expect(result.content).toContain('succeeded');
  });

  describe('ENG-907 wall-clock nudge', () => {
    const CAP_MS = 600_000;
    let nowMs: number;
    let realNow: () => number;
    const originalTimeout = process.env.AGENT_MODE_GENERATION_TIMEOUT_MS;

    beforeEach(() => {
      process.env.AGENT_MODE_GENERATION_TIMEOUT_MS = String(CAP_MS);
      nowMs = 1_700_000_000_000;
      realNow = Date.now;
      jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    });

    afterEach(() => {
      (Date.now as any).mockRestore?.();
      Date.now = realNow;
      if (originalTimeout === undefined) delete process.env.AGENT_MODE_GENERATION_TIMEOUT_MS;
      else process.env.AGENT_MODE_GENERATION_TIMEOUT_MS = originalTimeout;
    });

    it('recovers with the executed-action ledger when the forced synthesis turn echoes the time-budget nudge', async () => {
      // A drifting seconds count between the two copies, proving the pattern match
      // does not depend on both echoes reporting the same number.
      const echo =
        buildTurnTimeBudgetNudge({ phase: 'final_synthesis', elapsedMs: 0, remainingMs: 9_000, reserveMs: 0 }, 'final_synthesis') +
        ' ' +
        buildTurnTimeBudgetNudge({ phase: 'final_synthesis', elapsedMs: 0, remainingMs: 7_000, reserveMs: 0 }, 'final_synthesis');

      let call = 0;
      const executedTools: string[] = [];
      jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
        const messages = args[1] || [];
        const isFinalSynthesis = messages.some(
          (m: any) =>
            m?.role === 'user' &&
            typeof m.content === 'string' &&
            /\[SYSTEM WARNING\][^\n]*time limit/i.test(m.content),
        );
        nowMs += 250_000; // burn most of the 600s cap per call
        call++;
        return isFinalSynthesis
          ? { choices: [{ message: { role: 'assistant', content: echo, tool_calls: null }, finish_reason: 'stop' }], usage: {} }
          : {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{ id: `c${call}`, type: 'function', function: { name: 'search_tool', arguments: `{"page":${call}}` } }],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: {},
            };
      });
      jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
        const toolName: string = args[1];
        executedTools.push(toolName);
        return JSON.stringify({ success: true, data: `mock:${toolName}` });
      });
      jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

      const result = (await service.generateMarketingResponse(
        'Render the full ad set and deliver it.',
        [] as any,
        'test-user',
        service.default_model,
        'test-session',
        false,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        false,
        false,
        nowMs, // turnStartMs: caller stamped the deadline at the start
      )) as any;

      expect(result.truncatedByTimeBudget).toBe(true);
      expect(executedTools.length).toBeGreaterThan(0);
      expect(result.content).not.toContain('DISCARDED without running');
      expect(result.content).toContain('search_tool');
      expect(result.content).toContain('succeeded');
    });
  });
});
