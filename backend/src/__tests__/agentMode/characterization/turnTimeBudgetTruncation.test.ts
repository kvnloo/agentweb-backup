/**
 * ENG-907 — live-loop proof that the REAL `generateMarketingResponse` wraps up on
 * its own before the controller's whole-turn wall-clock cap kills it.
 *
 * Repro of the production failure: a broad multi-part research turn (10 posts +
 * 10 more posts + 5 accounts + an ordering) kept issuing discovery tool calls for
 * the full 10 minutes. The step budget (40 iterations) was never reached, so
 * nothing stopped the loop; `withGenerationTimeout` guillotined the run and the
 * user got a bare "please try again" after 34 messages and real spend — 100% of
 * the cost, 0% of the deliverable.
 *
 * The loop is driven with a controlled clock (each scripted LLM call advances
 * `Date.now`), so the whole scenario runs instantly and deterministically.
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

const CAP_MS = 600_000; // the production AGENT_MODE_GENERATION_TIMEOUT_MS default

describe('ENG-907 — real loop wraps up before the whole-turn wall-clock cap', () => {
  let service: AgentModeService;
  let nowMs: number;
  let realNow: () => number;
  const originalTimeout = process.env.AGENT_MODE_GENERATION_TIMEOUT_MS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_MODE_GENERATION_TIMEOUT_MS = String(CAP_MS);
    service = new AgentModeService();
    installStandardMockDeps();
    realNow = Date.now;
    nowMs = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    (Date.now as any).mockRestore?.();
    Date.now = realNow;
    if (originalTimeout === undefined) delete process.env.AGENT_MODE_GENERATION_TIMEOUT_MS;
    else process.env.AGENT_MODE_GENERATION_TIMEOUT_MS = originalTimeout;
  });

  /**
   * Drive the REAL loop. `makeTurn` receives the call index and whether the loop
   * offered tools on this call; every call burns `msPerCall` of the wall clock.
   *
   * "Offered" means the loop passed a tool list at all — the harness registry is
   * empty, so the list is `[]` on a normal turn and omitted entirely once the loop
   * switches to its tool-free synthesis turn.
   */
  async function runRealLoop(
    makeTurn: (call: number, toolsOffered: boolean) => any,
    msPerCall = 60_000,
    /**
     * The caller's whole-turn deadline stamp (ENG-907). The controller takes it right
     * before it starts `withGenerationTimeout`, i.e. BEFORE the session/message reads,
     * the title LLM call and the fork IPC hop — so by the time the loop runs it is
     * already in the past. Omitted here means "no cap enforced by the caller".
     */
    turnStartMs?: number,
  ) {
    let call = 0;
    const toolsOfferedPerCall: boolean[] = [];
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const options = args[2] || {};
      const toolsOffered = options.tools !== undefined && options.tools !== null;
      toolsOfferedPerCall.push(toolsOffered);
      nowMs += msPerCall;
      return buildLLMResponse(makeTurn(call++, toolsOffered));
    });
    jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
      const toolName: string = args[1];
      return JSON.stringify({ success: true, data: `mock:${toolName}` });
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const startedAt = nowMs;
    const result = (await service.generateMarketingResponse(
      'Find me the 10 best X posts about agentic wallets, 10 more to reply to, 5 accounts to monitor, and the order to reply in.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
      false, // mockMode
      undefined, // onProgress
      undefined, // socketEmit
      false, // isInteractiveShare
      undefined, // isCancelled
      undefined, // excludeTools
      undefined, // screenshotUrl
      false, // isDelegatedAccess
      false, // persistIncrementally
      turnStartMs,
    )) as any;
    return { result, elapsedMs: nowMs - startedAt, endedAtMs: nowMs, toolsOfferedPerCall };
  }

  it('stops discovery and delivers a partial answer instead of running past the hard cap', async () => {
    // The model never volunteers a text-only turn — exactly like the production
    // session, it keeps searching until something stops it. It only produces the
    // final answer when the loop takes the tools away.
    const { result, elapsedMs, toolsOfferedPerCall } = await runRealLoop((call, toolsOffered) =>
      toolsOffered
        ? {
            content: `Scanned batch ${call + 1} of X conversations.`,
            tool_calls: [
              { id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` },
            ],
          }
        : {
            content:
              'Partial results — 6 of the 10 best posts I found so far:\n1. …\n\nStill missing: the second list of 10, the 5 accounts, and the reply ordering.',
          },
    );

    // The run must end BEFORE the controller's hard cap — otherwise the whole
    // turn is discarded and the user sees "please try again" (the ENG-907 bug).
    expect(elapsedMs).toBeLessThanOrEqual(CAP_MS);
    // It ended because time ran out, not because it finished the job.
    expect(result.truncatedByTimeBudget).toBe(true);
    // And the user actually gets the work that was already done.
    expect(result.content).toMatch(/Partial results/);
    // The last LLM call was made with NO tools — that is what forces synthesis.
    expect(toolsOfferedPerCall[toolsOfferedPerCall.length - 1]).toBe(false);
    expect(toolsOfferedPerCall.filter((offered) => !offered)).toHaveLength(1);
  });

  it('warns the model to wrap up before it takes the tools away', async () => {
    let sawWrapUpNudge = false;
    let sawFinalNudge = false;
    await runRealLoop((call, toolsOffered) => {
      const messages = (service as any).callLLM.mock.calls[call]?.[1] || [];
      const text = messages
        .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
        .map((m: any) => m.content)
        .join('\n');
      if (/\[SYSTEM\][^\n]*time budget/i.test(text)) sawWrapUpNudge = true;
      if (/\[SYSTEM WARNING\][^\n]*time limit/i.test(text)) sawFinalNudge = true;
      return toolsOffered
        ? {
            content: `Scanned batch ${call + 1}.`,
            tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
          }
        : { content: 'Here is what I gathered before the time limit.' };
    });

    expect(sawWrapUpNudge).toBe(true);
    expect(sawFinalNudge).toBe(true);
  });

  it('falls back to a partial-delivery message when the synthesis turn returns nothing', async () => {
    const { result } = await runRealLoop((call, toolsOffered) =>
      toolsOffered
        ? {
            content: '',
            tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
          }
        : { content: '' },
    );

    expect(result.truncatedByTimeBudget).toBe(true);
    expect(result.content).toMatch(/time limit/i);
  });

  it("measures against the CALLER's deadline, not the moment the loop happened to start", async () => {
    // The turn the user waits on starts in the controller: it stamps `turnStartMs` and
    // immediately arms withGenerationTimeout, then spends real time on the session and
    // message reads, the title LLM call, the fork IPC hop and the memory backfill before
    // the loop below ever runs. Anchoring on a local Date.now() here would put the loop's
    // cap that much LATER than the deadline actually enforced — the setup latency would
    // come straight out of the synthesis reserve, and a slow enough setup would let the
    // controller guillotine the turn before the loop ever wrapped itself up.
    const keepSearching = (call: number, toolsOffered: boolean) =>
      toolsOffered
        ? {
            content: `Scanned batch ${call + 1}.`,
            tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
          }
        : { content: 'Partial results — here is what I gathered before the time limit.' };

    const SETUP_LATENCY_MS = 180_000; // 3 min burned before the loop starts

    const withoutStamp = await runRealLoop(keepSearching, 30_000);

    // Same run, but the caller's cap started SETUP_LATENCY_MS ago.
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
    const callerTurnStartMs = nowMs;
    nowMs += SETUP_LATENCY_MS;
    const withStamp = await runRealLoop(keepSearching, 30_000, callerTurnStartMs);

    // Both deliver a partial answer, but the stamped run stops sooner because it knows
    // it has 3 fewer minutes — and it finishes before the caller's REAL deadline.
    expect(withStamp.result.truncatedByTimeBudget).toBe(true);
    expect(withStamp.result.content).toMatch(/Partial results/);
    expect(withStamp.endedAtMs).toBeLessThanOrEqual(callerTurnStartMs + CAP_MS);
    expect(withStamp.toolsOfferedPerCall.length)
      .toBeLessThan(withoutStamp.toolsOfferedPerCall.length);
    // Without the stamp the loop would have run SETUP_LATENCY_MS past that deadline.
    expect(callerTurnStartMs + SETUP_LATENCY_MS + withoutStamp.elapsedMs)
      .toBeGreaterThan(callerTurnStartMs + CAP_MS);
  });

  it('does NOT fire on a fast run that finishes well inside the budget (no false positive)', async () => {
    const { result, elapsedMs, toolsOfferedPerCall } = await runRealLoop(
      (call) =>
        call === 0
          ? { tool_calls: [{ id: 'c0', name: 'twitter_outreach', arguments: '{"cursor":0}' }] }
          : { content: 'Here are the 10 best posts, 10 more, 5 accounts, and the reply order.' },
      5_000,
    );

    expect(result.truncatedByTimeBudget).toBeFalsy();
    expect(elapsedMs).toBeLessThan(CAP_MS / 2);
    // Tools were offered on every call — the loop never entered synthesis mode.
    expect(toolsOfferedPerCall.every((offered) => offered)).toBe(true);
    expect(result.content).toMatch(/10 best posts/);
  });
});
