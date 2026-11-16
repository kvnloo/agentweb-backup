/**
 * Opslane findings (2026-10-13), driven through the REAL generateMarketingResponse loop
 * (only callLLM and leaf executeTool are scripted):
 *
 * #4 In-turn [SYSTEM] nudges (consecutive-repeat anti-loop, sliding-window, step and
 *    time budget) were pushed as role 'user', so the model read them as the user's
 *    words ("stopped as requested"). ENG-763 moved the cross-turn loop-breaker to
 *    role 'system'; these must follow. The repeat nudge is added once, not every step.
 *
 * #5 After the step cap or a content-filter stop (or a plain empty final answer), the
 *    reply returned to the user was not the reply persisted in responseMessages.
 */

import { AgentModeService } from '../../../services/agentModeService';
import { ANTI_LOOP_STOP_MESSAGE } from '../../../services/agentMode/core/termination';
import { buildLLMResponse, installStandardMockDeps, runScenarioWithResult } from './harness';

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

const SAME_CALL = { name: 'you_search_web', arguments: '{"query":"acme leads"}' };
const lastAssistantText = (responseMessages: any[]) =>
  [...responseMessages].reverse().find((m: any) => m.role === 'assistant')?.content ?? null;

describe('Opslane #4 — in-turn [SYSTEM] nudges are system-role, added once', () => {
  let service: AgentModeService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  async function runAndCapture(turns: any[]) {
    const requests: any[][] = [];
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      requests.push((args[1] as any[]).map((m) => ({ ...m })));
      return buildLLMResponse(turns[Math.min(call++, turns.length - 1)]);
    });
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(JSON.stringify({ success: true, data: 'ok' }));
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);
    const result: any = await service.generateMarketingResponse(
      'Find leads for Acme.', [] as any, 'test-user', service.default_model, 'test-session',
    );
    return { requests, result };
  }

  it('never sends a [SYSTEM] nudge as role user after 4+ identical tool-call batches', async () => {
    const turns = [
      ...Array.from({ length: 6 }, (_, i) => ({ tool_calls: [{ id: `c${i}`, ...SAME_CALL }] })),
      { content: 'Here is what I found.' },
    ];
    const { requests } = await runAndCapture(turns);
    const all = requests.flat();
    // The nudge must actually have been injected (the 4th identical batch triggers it)...
    expect(all.some((m) => m.content === ANTI_LOOP_STOP_MESSAGE)).toBe(true);
    // ...and never as the user's own words.
    const userNudges = all.filter((m) => m.role === 'user' && typeof m.content === 'string' && /\[SYSTEM/.test(m.content));
    expect(userNudges).toEqual([]);
  });

  it('adds the consecutive-repeat nudge once per turn, not on every repeated step', async () => {
    const turns = [
      ...Array.from({ length: 7 }, (_, i) => ({ tool_calls: [{ id: `c${i}`, ...SAME_CALL }] })),
      { content: 'Done.' },
    ];
    const { requests } = await runAndCapture(turns);
    const finalRequest = requests[requests.length - 1];
    expect(finalRequest.filter((m) => m.content === ANTI_LOOP_STOP_MESSAGE)).toHaveLength(1);
  });

  it('does not persist the system nudges into the session transcript', async () => {
    const turns = [
      ...Array.from({ length: 5 }, (_, i) => ({ tool_calls: [{ id: `c${i}`, ...SAME_CALL }] })),
      { content: 'Summary.' },
    ];
    const { result } = await runAndCapture(turns);
    expect(result.responseMessages.some((m: any) => m.role === 'system')).toBe(false);
    expect(result.responseMessages.some((m: any) => m.content === ANTI_LOOP_STOP_MESSAGE)).toBe(false);
  });
});

describe('Opslane #5 — the persisted reply is the returned reply', () => {
  let service: AgentModeService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('step cap: the canned step-limit explanation is what gets persisted', async () => {
    // Varied args keep the run clear of the anti-loop detector; it runs to maxIterations.
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async () =>
      buildLLMResponse({ tool_calls: [{ id: `c${call}`, name: 'you_search_web', arguments: JSON.stringify({ query: `q${call++}` }) }] }));
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(JSON.stringify({ success: true }));
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);
    const result: any = await service.generateMarketingResponse(
      'Do the task.', [] as any, 'test-user', service.default_model, 'test-session',
    );
    expect(result.truncatedByStepBudget).toBe(true);
    expect(result.content).toMatch(/maximum number of processing steps/);
    expect(lastAssistantText(result.responseMessages)).toBe(result.content);
  });

  it('content filter: the canned safety message is what gets persisted', async () => {
    const { result } = await runScenarioWithResult(service, {
      transcript: [{ content: '', finish_reason: 'content_filter' }],
    });
    expect(result.content).toMatch(/content safety/i);
    expect(lastAssistantText(result.responseMessages)).toBe(result.content);
  });

  it('empty final answer with no tools: a short fallback is returned AND persisted, never ""', async () => {
    const { result } = await runScenarioWithResult(service, {
      transcript: [{ content: '' }, { content: '' }, { content: '' }],
    });
    expect(result.content.trim()).not.toBe('');
    expect(lastAssistantText(result.responseMessages)).toBe(result.content);
  });
});
