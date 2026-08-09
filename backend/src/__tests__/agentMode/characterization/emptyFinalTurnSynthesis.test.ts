/**
 * ENG-946 — live-loop proof that a scheduled run cannot end on a turn that said
 * nothing just because an earlier turn narrated something.
 *
 * Prod signature (scheduled "X Reply Guy" / "Reply Ideas" runs): the model narrates
 * one line alongside its tool calls ("I'll scan his roster…"), the run falls back
 * mid-flight from Bedrock Claude to native Gemini on a transient error, and the
 * follow-up turn comes back with either NO text at all or nothing but the
 * `[Previously called ...]` placeholder that the cross-provider history degradation
 * emits. Both are non-answers, but the loop's `content` accumulator is
 * replace-on-nonempty, so it still held the stale narration — the empty-synthesis
 * nudge never fired and the run shipped the narration as if it were the report.
 *
 * Only `callLLM` / leaf `executeTool` are scripted; the real loop drives the real
 * termination ladder.
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

const NARRATION = "I'll scan his roster and check what he's already engaged with today.";
const REPORT = 'Top reply targets today:\n1. @chamath — bottoms-up CAC thread\n2. @gregisenberg — distribution thread';
const DEGRADED_ECHO =
  '[Previously called twitter_outreach({"action":"search_tweets","query":"from:chamath","max_results":30})]';

describe('ENG-946 — the terminating turn, not the accumulator, decides whether the run answered', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  async function runScriptedLoop(turns: any[]) {
    const seen: any[] = [];
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      seen.push(args[1]);
      return buildLLMResponse(turns[Math.min(call++, turns.length - 1)]);
    });
    jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
      const toolName: string = args[1];
      return JSON.stringify({ success: true, data: `mock:${toolName}` });
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result = (await service.generateMarketingResponse(
      "You are Harsha's X reply guy. Surface and rank today's best reply targets.",
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
    )) as any;
    return { result, messagesPerCall: seen, llmCalls: call };
  }

  it('nudges for a synthesis when the FINAL turn is empty, instead of shipping the stale narration', async () => {
    const { result, messagesPerCall, llmCalls } = await runScriptedLoop([
      // 1: narration + tool call — this is the text that used to survive as "the answer"
      {
        content: NARRATION,
        tool_calls: [{ id: 'c1', name: 'you_search_web', arguments: '{"query":"harshmoney123 mentions"}' }],
      },
      // 2: the terminating turn comes back with nothing
      { content: '' },
      // 3: after the nudge the model produces the real report
      { content: REPORT },
    ]);

    expect(llmCalls).toBe(3);
    expect(result.content).toBe(REPORT);
    expect(result.content).not.toBe(NARRATION);

    // The nudge really was injected before the third call.
    const lastRequest = messagesPerCall[2] as any[];
    expect(
      lastRequest.some(
        (m: any) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('synthesize the information'),
      ),
    ).toBe(true);
  });

  it('treats a turn that is only the degraded cross-provider history placeholder as no answer', async () => {
    const { result } = await runScriptedLoop([
      {
        content: NARRATION,
        tool_calls: [{ id: 'c1', name: 'you_search_web', arguments: '{"query":"harshmoney123 mentions"}' }],
      },
      // The parroted `[Previously called ...]` placeholder — non-empty, but not an answer.
      { content: DEGRADED_ECHO },
      { content: REPORT },
    ]);

    expect(result.content).toBe(REPORT);
    expect(result.content).not.toContain('Previously called');
  });

  it('keeps the nudge bounded — a second empty turn ends the run rather than looping', async () => {
    const { result, llmCalls } = await runScriptedLoop([
      {
        content: NARRATION,
        tool_calls: [{ id: 'c1', name: 'you_search_web', arguments: '{"query":"harshmoney123 mentions"}' }],
      },
      { content: '' },
      { content: '' },
    ]);

    // One nudge only (MAX_EMPTY_SYNTHESIS_RETRIES = 1), then terminate.
    expect(llmCalls).toBe(3);
    expect(result.content).toBe(NARRATION);
  });

  it('does not disturb a healthy run that answers on its final turn', async () => {
    const { result, llmCalls } = await runScriptedLoop([
      {
        content: NARRATION,
        tool_calls: [{ id: 'c1', name: 'you_search_web', arguments: '{"query":"harshmoney123 mentions"}' }],
      },
      { content: REPORT },
    ]);

    expect(llmCalls).toBe(2);
    expect(result.content).toBe(REPORT);
  });
});
