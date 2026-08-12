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
   * Drive the REAL loop. `makeTurn` receives the call index and whether this call is
   * the forced final synthesis; every call burns `msPerCall` of the wall clock.
   *
   * The synthesis turn is detected the way production detects it — by the
   * `[SYSTEM WARNING] ... time limit` nudge in the outgoing messages — NOT by the
   * tool list. The loop deliberately keeps sending tools on that turn (dropping them
   * would make Bedrock reject a history containing toolUse/toolResult blocks) and
   * discards whatever the model calls instead.
   */
  async function runRealLoop(
    makeTurn: (call: number, isFinalSynthesis: boolean) => any,
    msPerCall = 60_000,
    /**
     * The caller's whole-turn deadline stamp (ENG-907). The controller takes it right
     * before it starts `withGenerationTimeout`, i.e. BEFORE the session/message reads,
     * the title LLM call and the fork IPC hop — so by the time the loop runs it is
     * already in the past.
     *
     * It is also the ONLY signal that a deadline exists at all: only the two capped
     * endpoints stamp it. Pass `null` to model an UNCAPPED caller (a scheduled run,
     * Slack, GTM) — the budget must then stay completely out of the way. Defaults to
     * "stamped at the moment the loop starts", the capped-caller case.
     */
    turnStartMs: number | null | undefined = undefined,
  ) {
    let call = 0;
    const toolsOfferedPerCall: boolean[] = [];
    const finalSynthesisPerCall: boolean[] = [];
    const executedTools: string[] = [];
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const messages = args[1] || [];
      const options = args[2] || {};
      toolsOfferedPerCall.push(options.tools !== undefined && options.tools !== null);
      const isFinalSynthesis = messages.some(
        (m: any) =>
          m?.role === 'user' &&
          typeof m.content === 'string' &&
          /\[SYSTEM WARNING\][^\n]*time limit/i.test(m.content),
      );
      finalSynthesisPerCall.push(isFinalSynthesis);
      nowMs += msPerCall;
      return buildLLMResponse(makeTurn(call++, isFinalSynthesis));
    });
    jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
      const toolName: string = args[1];
      executedTools.push(toolName);
      return JSON.stringify({ success: true, data: `mock:${toolName}` });
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const startedAt = nowMs;
    // `undefined` here means "the test did not choose" → behave like a capped caller and
    // stamp now. `null` means "the caller genuinely has no deadline" → pass nothing.
    const effectiveTurnStartMs = turnStartMs === undefined ? nowMs : (turnStartMs ?? undefined);
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
      effectiveTurnStartMs,
    )) as any;
    return {
      result,
      elapsedMs: nowMs - startedAt,
      endedAtMs: nowMs,
      toolsOfferedPerCall,
      finalSynthesisPerCall,
      executedTools,
    };
  }

  it('stops discovery and delivers a partial answer instead of running past the hard cap', async () => {
    // The model never volunteers a text-only turn — exactly like the production
    // session, it keeps searching until something stops it. It only produces the
    // final answer when the loop stops honouring its tool calls.
    const { result, elapsedMs, toolsOfferedPerCall, finalSynthesisPerCall } = await runRealLoop(
      (call, isFinalSynthesis) =>
        isFinalSynthesis
          ? {
              content:
                'Partial results — 6 of the 10 best posts I found so far:\n1. …\n\nStill missing: the second list of 10, the 5 accounts, and the reply ordering.',
            }
          : {
              content: `Scanned batch ${call + 1} of X conversations.`,
              tool_calls: [
                { id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` },
              ],
            },
    );

    // The run must end BEFORE the controller's hard cap — otherwise the whole
    // turn is discarded and the user sees "please try again" (the ENG-907 bug).
    expect(elapsedMs).toBeLessThanOrEqual(CAP_MS);
    // It ended because time ran out, not because it finished the job.
    expect(result.truncatedByTimeBudget).toBe(true);
    // And the user actually gets the work that was already done.
    expect(result.content).toMatch(/Partial results/);
    // Exactly one forced synthesis turn, and it is the last thing the loop did.
    expect(finalSynthesisPerCall.filter(Boolean)).toHaveLength(1);
    expect(finalSynthesisPerCall[finalSynthesisPerCall.length - 1]).toBe(true);
    // Tools stayed on the wire for EVERY call, including that one: a Converse request
    // replaying toolUse/toolResult history with no toolConfig is rejected outright, so
    // withholding them here would turn the partial delivery into a hard error.
    expect(toolsOfferedPerCall.every((offered) => offered)).toBe(true);
  });

  it('discards tool calls made during the forced synthesis instead of running them', async () => {
    // The model ignores the nudge and tries to keep searching. The loop must not honour
    // it — the whole point of the phase is that no new work can start. The turn ends with
    // whatever text came back alongside the (dropped) call.
    const { result, executedTools, finalSynthesisPerCall } = await runRealLoop(
      (call, isFinalSynthesis) =>
        isFinalSynthesis
          ? {
              content: 'Partial results — here is what I gathered before the time limit.',
              tool_calls: [
                { id: 'late', name: 'twitter_outreach', arguments: '{"cursor":999}' },
              ],
            }
          : {
              content: `Scanned batch ${call + 1}.`,
              tool_calls: [
                { id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` },
              ],
            },
    );

    expect(finalSynthesisPerCall.filter(Boolean)).toHaveLength(1);
    expect(result.truncatedByTimeBudget).toBe(true);
    expect(result.content).toMatch(/Partial results/);
    // The late call never ran: exactly one tool executed per PRE-synthesis turn, and
    // none for the synthesis turn itself.
    expect(executedTools).toHaveLength(finalSynthesisPerCall.filter((f) => !f).length);
  });

  it('warns the model to wrap up before it stops honouring tool calls', async () => {
    let sawWrapUpNudge = false;
    let sawFinalNudge = false;
    await runRealLoop((call, isFinalSynthesis) => {
      const messages = (service as any).callLLM.mock.calls[call]?.[1] || [];
      const text = messages
        .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
        .map((m: any) => m.content)
        .join('\n');
      if (/\[SYSTEM\][^\n]*time budget/i.test(text)) sawWrapUpNudge = true;
      if (/\[SYSTEM WARNING\][^\n]*time limit/i.test(text)) sawFinalNudge = true;
      return isFinalSynthesis
        ? { content: 'Here is what I gathered before the time limit.' }
        : {
            content: `Scanned batch ${call + 1}.`,
            tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
          };
    });

    expect(sawWrapUpNudge).toBe(true);
    expect(sawFinalNudge).toBe(true);
  });

  it('falls back to a partial-delivery message when the synthesis turn returns nothing', async () => {
    const { result, elapsedMs, finalSynthesisPerCall } = await runRealLoop((call, isFinalSynthesis) =>
      isFinalSynthesis
        ? { content: '' }
        : {
            content: '',
            tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
          },
    );

    expect(result.truncatedByTimeBudget).toBe(true);
    expect(result.content).toMatch(/time limit/i);
    // The empty-synthesis retry ladder must NOT fire here. Every millisecond left is
    // inside the reserve held back for this one call, so a retry would spend it and
    // could let the controller's cap fire mid-call — discarding the whole turn, which
    // is the ENG-907 failure itself. One synthesis attempt, then deliver.
    expect(finalSynthesisPerCall.filter(Boolean)).toHaveLength(1);
    expect(elapsedMs).toBeLessThanOrEqual(CAP_MS);
  });

  it('delivers a token-truncated synthesis as-is instead of spending the reserve on a continuation', async () => {
    // Same hazard from the other continuation ladder: a synthesis that stops on
    // max_tokens normally gets a "keep going" round trip. Inside the reserve there is no
    // room for one, and the clipped text is a real partial answer — ship it.
    const { result, elapsedMs, finalSynthesisPerCall } = await runRealLoop(
      (call, isFinalSynthesis) =>
        isFinalSynthesis
          ? {
              content: 'Partial results — 6 of the 10 best posts:\n1. @wallet_dev on agentic',
              finish_reason: 'length',
            }
          : {
              content: `Scanned batch ${call + 1}.`,
              tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
            },
    );

    expect(result.truncatedByTimeBudget).toBe(true);
    expect(result.content).toMatch(/Partial results/);
    expect(finalSynthesisPerCall.filter(Boolean)).toHaveLength(1);
    expect(elapsedMs).toBeLessThanOrEqual(CAP_MS);
  });

  it('does not start an unaffordable backup-model retry when the synthesis call fails', async () => {
    // The transient-error handler normally retries the whole call on a backup model. On the
    // forced-synthesis turn the only time left is the reserve for that single call, so a
    // retry runs past the controller's cap — and the cap discards everything, which is the
    // ENG-907 failure itself. The turn must end with what it has instead.
    let call = 0;
    const modelsCalled: string[] = [];
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const model = args[0];
      const messages = args[1] || [];
      const isFinalSynthesis = messages.some(
        (m: any) =>
          m?.role === 'user' &&
          typeof m.content === 'string' &&
          /\[SYSTEM WARNING\][^\n]*time limit/i.test(m.content),
      );
      modelsCalled.push(model);
      nowMs += 60_000;
      if (isFinalSynthesis) {
        // A transient failure — the only kind the backup retry would have handled —
        // raised after the call burned the rest of the reserve.
        throw new Error('Too many requests, please try again later');
      }
      return buildLLMResponse({
        content: `Scanned batch ${++call}.`,
        tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
      });
    });
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(
      JSON.stringify({ success: true, data: 'mock' }),
    );
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const startedAt = nowMs;
    const result = (await service.generateMarketingResponse(
      'Find me the 10 best X posts about agentic wallets, 10 more to reply to, 5 accounts to monitor, and the order to reply in.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
      false, undefined, undefined, false, undefined, undefined, undefined, false, false,
      nowMs,
    )) as any;

    // It did NOT throw the turn away, and it did NOT cross the caller's deadline.
    expect(nowMs - startedAt).toBeLessThanOrEqual(CAP_MS);
    expect(result.truncatedByTimeBudget).toBe(true);
    expect(result.content).toMatch(/time limit/i);
    // Only one model was ever used — no backup retry was started.
    expect(new Set(modelsCalled).size).toBe(1);
  });

  it('sizes the retry against a FULL call, not the attempt that failed fast', async () => {
    // A primary that fails fast — an immediate 429, a dropped socket — burns almost no
    // clock. Judging affordability by that attempt alone would wave through a backup call
    // that is far slower than the time left, and it would cross the cap and discard the
    // partial answer anyway. The retry costs a full call, so it is measured against the
    // slowest full call this run actually made.
    const SLOW_CALL_MS = 150_000;
    let call = 0;
    const modelsCalled: string[] = [];
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const messages = args[1] || [];
      const isFinalSynthesis = messages.some(
        (m: any) =>
          m?.role === 'user' &&
          typeof m.content === 'string' &&
          /\[SYSTEM WARNING\][^\n]*time limit/i.test(m.content),
      );
      modelsCalled.push(args[0]);
      if (isFinalSynthesis) {
        nowMs += 1_000; // fails almost immediately
        throw new Error('Too many requests, please try again later');
      }
      nowMs += SLOW_CALL_MS;
      return buildLLMResponse({
        content: `Scanned batch ${++call}.`,
        tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
      });
    });
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(
      JSON.stringify({ success: true, data: 'mock' }),
    );
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const startedAt = nowMs;
    const result = (await service.generateMarketingResponse(
      'Find me the 10 best X posts about agentic wallets, 10 more to reply to, 5 accounts to monitor, and the order to reply in.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
      false, undefined, undefined, false, undefined, undefined, undefined, false, false,
      nowMs,
    )) as any;

    // There was more clock left than the 1s failure took, but nowhere near enough for
    // another 150s call — so no backup was started and the turn stayed inside the cap.
    expect(new Set(modelsCalled).size).toBe(1);
    expect(nowMs - startedAt).toBeLessThanOrEqual(CAP_MS);
    expect(result.truncatedByTimeBudget).toBe(true);
    expect(result.content).toMatch(/time limit/i);
  });

  it('lets a NON-transient synthesis failure propagate instead of reporting a timeout', async () => {
    // The affordability guard above must not become a catch-all. A context-limit,
    // content-policy or malformed-request failure has no retry to skip, and dressing one
    // up as "I hit the time limit — reply continue" would invite the user straight back
    // into the same error. Those keep their existing classification path.
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async (...args: any[]) => {
      const messages = args[1] || [];
      const isFinalSynthesis = messages.some(
        (m: any) =>
          m?.role === 'user' &&
          typeof m.content === 'string' &&
          /\[SYSTEM WARNING\][^\n]*time limit/i.test(m.content),
      );
      nowMs += 60_000;
      if (isFinalSynthesis) {
        throw new Error('This model\'s maximum context length is 200000 tokens');
      }
      return buildLLMResponse({
        content: `Scanned batch ${++call}.`,
        tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
      });
    });
    jest.spyOn(service as any, 'executeTool').mockResolvedValue(
      JSON.stringify({ success: true, data: 'mock' }),
    );
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    // It raises instead of returning, so the error reaches the controller's existing
    // classification path (isContextLimitError et al. read `originalMessage`) rather than
    // coming back as a successful time-budget truncation whose "continue" invitation would
    // just re-run the same failing call.
    const rejection = await service
      .generateMarketingResponse(
        'Find me the 10 best X posts about agentic wallets, 10 more to reply to, 5 accounts to monitor, and the order to reply in.',
        [] as any,
        'test-user',
        service.default_model,
        'test-session',
        false, undefined, undefined, false, undefined, undefined, undefined, false, false,
        nowMs,
      )
      .then(
        (value: any) => ({ resolved: value }),
        (error: any) => ({ error }),
      );

    expect((rejection as any).resolved).toBeUndefined();
    expect((rejection as any).error.originalMessage).toMatch(/context length/i);
    expect((rejection as any).error.message).not.toMatch(/time limit/i);
  });

  it('still honours the max-tokens continuation when the time budget is NOT spent', async () => {
    // The suppression above is scoped to the forced-synthesis phase only. A fast run that
    // hits max_tokens must keep its ordinary continuation, or this fix would silently
    // truncate every long answer in the product.
    const { result, elapsedMs, finalSynthesisPerCall } = await runRealLoop(
      (call) =>
        call === 0
          ? { content: 'Here are the 10 best posts: 1. …', finish_reason: 'length' }
          : { content: ' …and the reply order.' },
      5_000,
    );

    expect(result.truncatedByTimeBudget).toBeFalsy();
    expect(finalSynthesisPerCall.some(Boolean)).toBe(false);
    expect(elapsedMs).toBeLessThan(CAP_MS / 2);
    // Two calls happened: the truncated one and its continuation.
    expect(finalSynthesisPerCall).toHaveLength(2);
    expect(result.content).toMatch(/reply order/);
  });

  it("measures against the CALLER's deadline, not the moment the loop happened to start", async () => {
    // The turn the user waits on starts in the controller: it stamps `turnStartMs` and
    // immediately arms withGenerationTimeout, then spends real time on the session and
    // message reads, the title LLM call, the fork IPC hop and the memory backfill before
    // the loop below ever runs. Anchoring on a local Date.now() here would put the loop's
    // cap that much LATER than the deadline actually enforced — the setup latency would
    // come straight out of the synthesis reserve, and a slow enough setup would let the
    // controller guillotine the turn before the loop ever wrapped itself up.
    const keepSearching = (call: number, isFinalSynthesis: boolean) =>
      isFinalSynthesis
        ? { content: 'Partial results — here is what I gathered before the time limit.' }
        : {
            content: `Scanned batch ${call + 1}.`,
            tool_calls: [{ id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` }],
          };

    const SETUP_LATENCY_MS = 180_000; // 3 min burned before the loop starts

    // Stamped at the moment the loop starts (no setup latency).
    const promptStamp = await runRealLoop(keepSearching, 30_000);

    // Same run, but the caller's cap started SETUP_LATENCY_MS ago.
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
    const callerTurnStartMs = nowMs;
    nowMs += SETUP_LATENCY_MS;
    const lateStamp = await runRealLoop(keepSearching, 30_000, callerTurnStartMs);

    // Both deliver a partial answer, but the late-stamped run stops sooner because it
    // knows it has 3 fewer minutes — and it finishes before the caller's REAL deadline.
    expect(lateStamp.result.truncatedByTimeBudget).toBe(true);
    expect(lateStamp.result.content).toMatch(/Partial results/);
    expect(lateStamp.endedAtMs).toBeLessThanOrEqual(callerTurnStartMs + CAP_MS);
    expect(lateStamp.finalSynthesisPerCall.length)
      .toBeLessThan(promptStamp.finalSynthesisPerCall.length);
  });

  it('stays out of the way entirely when the caller enforces NO deadline', async () => {
    // Regression guard for the uncapped call paths. `withGenerationTimeout` wraps only
    // the interactive and ishare endpoints; scheduled runs, Slack, GTM, admin replay and
    // email all call this loop with no wall-clock cap at all. Deriving a cap from
    // AGENT_MODE_GENERATION_TIMEOUT_MS regardless would invent a ceiling production does
    // not have.
    //
    // The concrete casualty is session bd733cb4 — the 5/5/5 "LinkedIn Engagement Queue"
    // scheduled run that ENG-907's own report holds up as the pattern to copy. Its first
    // turn ran 683s (14:00:04 → 14:11:27) and only wrote its knowledge-base queue, the
    // actual deliverable, at ~630s. A 600s-derived budget would have forced synthesis at
    // ~520s and thrown that away, converting a top-scoring run into a truncated partial.
    const TURN_MS = 683_000;
    const CALLS = 12;
    const { result, elapsedMs, finalSynthesisPerCall, executedTools } = await runRealLoop(
      (call) =>
        call < CALLS - 1
          ? {
              content: `Scanned batch ${call + 1}.`,
              tool_calls: [
                { id: `c${call}`, name: 'twitter_outreach', arguments: `{"cursor":${call}}` },
              ],
            }
          : { content: 'Queue prepared: 10 items written to the knowledge base.' },
      Math.floor(TURN_MS / CALLS),
      null, // uncapped caller — a scheduled run
    );

    // It ran well past the 600s cap, exactly as it does in production today...
    expect(elapsedMs).toBeGreaterThan(CAP_MS);
    // ...and was never truncated, nudged, or flagged for continuation.
    expect(result.truncatedByTimeBudget).toBeFalsy();
    expect(finalSynthesisPerCall.some(Boolean)).toBe(false);
    // Every tool call ran — including the late ones that carry the deliverable.
    expect(executedTools).toHaveLength(CALLS - 1);
    expect(result.content).toMatch(/Queue prepared/);
  });

  it('does NOT fire on a fast run that finishes well inside the budget (no false positive)', async () => {
    const { result, elapsedMs, finalSynthesisPerCall } = await runRealLoop(
      (call) =>
        call === 0
          ? { tool_calls: [{ id: 'c0', name: 'twitter_outreach', arguments: '{"cursor":0}' }] }
          : { content: 'Here are the 10 best posts, 10 more, 5 accounts, and the reply order.' },
      5_000,
    );

    expect(result.truncatedByTimeBudget).toBeFalsy();
    expect(elapsedMs).toBeLessThan(CAP_MS / 2);
    // The loop never entered synthesis mode — no nudge was ever injected.
    expect(finalSynthesisPerCall.some(Boolean)).toBe(false);
    expect(result.content).toMatch(/10 best posts/);
  });
});
