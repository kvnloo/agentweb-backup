/**
 * ENG-1858 — auxiliary LLM calls must be attributed (and charged) to the real user.
 *
 * Production booked ~27% of LLM calls to userId "system" because callers of
 * `callLLM` omitted `options.usageContext`: `recordUsage` falls back to "system"
 * and `meterUserUsage` skips the per-user cap charge when no userId is present.
 *
 * The fix has two halves, and these tests pin both:
 *   1. Call sites pass a plain `{ userId, sessionId, feature }` — no awaited
 *      lookup in front of the LLM call, so attribution can never delay or break it.
 *   2. `callLLM`'s metering step fills in the ENG-1217 billing subject (an org
 *      member bills to the org root) when the caller supplied a user but not who
 *      pays: fire-and-forget, fail-open, cached for a burst. A context that already
 *      carries `billingUserId` (the agent loop) is metered exactly as before.
 * Platform-funded work stays userless but is named `platform:*`.
 */

jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  resolveBillingUserId: jest.fn(),
}));

let mockAsyncWrite: () => Promise<void> = () => Promise.resolve();
jest.mock('../services/usageRecorderService', () => {
  const meterUserUsage = jest.fn();
  return {
    ...jest.requireActual('../services/usageRecorderService'),
    meterUserUsage,
    // The deferred path awaits the writes (PR #2926). Record the call on the
    // same mock so every assertion reads one call log, and let a test hold the
    // write open.
    meterUserUsageAsync: jest.fn((ctx: unknown) => {
      meterUserUsage(ctx);
      return mockAsyncWrite();
    }),
  };
});

import { AgentModeService, agentModeService } from '../services/agentModeService';
import { resolveBillingUserId } from '../services/tokenUsageService';
import { meterUserUsage } from '../services/usageRecorderService';
import { meteringFeature } from '../services/llmUsageAttributionService';
import { scheduledTurnDefersToUser } from '../controllers/agentModeController';
import { processEnrichmentConfig } from '../services/enrichmentConfigService';
import { buildConfigProcessingDeps } from '../services/enrichmentConfigDeps';
import * as llmServiceModule from '../utils/llmService';
import { triggerCreativeDirForUser } from '../services/onboardingCreativeDirService';
import { summarizeSessionIfNeeded } from '../services/sessionSummaryService';
import { chatbotDb } from '../services/chatbotService';
import { userDb } from '../services/db';
import { enrichWithRCA } from '../loops/instances/ai-eval-funnel/rcaEnricher';
import { asMutationId } from '../loops/core/types';
import { cronJobRegistry } from '../utils/cronJobRegistry';
import { restyleContent, generateBlogContent } from '../controllers/blog';
import { withRunFunding, type RunFunding } from '../services/funding/runFunding';
import * as workPlansImpl from '../emma/impl/workPlans';

const mockResolveBilling = resolveBillingUserId as jest.MockedFunction<typeof resolveBillingUserId>;
const mockMeter = meterUserUsage as jest.MockedFunction<typeof meterUserUsage>;

const ORG_ROOT = 'org-root-user';
const SESSION = 'session-abc';
const MODEL = 'anthropic.claude-sonnet-4-6';

const llmReply = (content: string) => ({ choices: [{ message: { content } }] }) as any;

/** The usageContext callLLM received on its Nth call. */
const usageContextOf = (spy: jest.SpyInstance, call = 0) => spy.mock.calls[call]?.[2]?.usageContext;

/** Let the fire-and-forget billing resolution settle. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

// The billing-subject cache is module-level with a 60s TTL, so every metering
// test uses its own user id rather than relying on test order.
let userSeq = 0;
const freshMember = () => `member-${++userSeq}`;

beforeEach(() => {
  mockResolveBilling.mockReset();
  mockMeter.mockReset();
  // Members (ids starting "member-") pool onto the org root (ENG-1217).
  mockResolveBilling.mockImplementation(async (userId: string) => (userId.startsWith('member-') ? ORG_ROOT : userId));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('callLLM metering resolves the billing subject', () => {
  let svc: AgentModeService;
  let create: jest.Mock;

  beforeEach(() => {
    svc = new AgentModeService();
    create = jest.fn().mockResolvedValue({
      id: 'gen-1',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      choices: [{ message: { content: 'ok' } }],
    });
    jest.spyOn(svc, 'getOpenRouterClient').mockResolvedValue({ chat: { completions: { create } } } as any);
  });

  const call = (usageContext: any) => svc.callLLM(MODEL, [{ role: 'user', content: 'hi' }], { usageContext });

  it('meters an org member with the org root as billingUserId', async () => {
    const member = freshMember();

    await call({ userId: member, sessionId: SESSION, feature: 'session_title' });
    await flush();

    expect(mockResolveBilling).toHaveBeenCalledWith(member);
    expect(mockMeter).toHaveBeenCalledTimes(1);
    expect(mockMeter).toHaveBeenCalledWith(expect.objectContaining({
      userId: member,
      billingUserId: ORG_ROOT,
      sessionId: SESSION,
      feature: 'session_title',
      model: MODEL,
      inputTokens: 100,
      outputTokens: 20,
    }));
  });

  it('never delays the response: callLLM returns before billing resolution settles', async () => {
    const member = freshMember();
    let release!: (v: string) => void;
    mockResolveBilling.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));

    const res = await call({ userId: member, feature: 'suggested_replies' });

    expect(res.choices[0].message.content).toBe('ok');
    expect(mockMeter).not.toHaveBeenCalled();
    release(ORG_ROOT);
    await flush();
    expect(mockMeter).toHaveBeenCalledWith(expect.objectContaining({ userId: member, billingUserId: ORG_ROOT }));
  });

  it('is tracked for graceful shutdown until the usage writes themselves settle (CodeRabbit, PR #2926)', async () => {
    const member = freshMember();
    let releaseWrite!: () => void;
    mockAsyncWrite = () => new Promise<void>((resolve) => { releaseWrite = resolve; });
    try {
      await call({ userId: member, feature: 'session_title' });
      await flush();

      // Billing is resolved and metering has STARTED, but the writes are still
      // in flight: runDrain (which awaits cronJobRegistry.drain()) must keep
      // waiting — settling on "started" would let the process exit mid-write.
      expect(mockMeter).toHaveBeenCalledWith(expect.objectContaining({ userId: member, billingUserId: ORG_ROOT }));
      expect(cronJobRegistry.snapshot().deferredLlmMetering).toBe(1);

      releaseWrite();
      await flush();
      expect(cronJobRegistry.snapshot().deferredLlmMetering).toBeUndefined();
    } finally {
      mockAsyncWrite = () => Promise.resolve();
    }
  });

  it('fails open: a resolution error still meters with billingUserId = userId and never rejects callLLM', async () => {
    const member = freshMember();
    mockResolveBilling.mockRejectedValueOnce(new Error('dynamo down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(call({ userId: member, sessionId: SESSION, feature: 'describe_image' })).resolves.toBeDefined();
    await flush();

    expect(mockMeter).toHaveBeenCalledTimes(1);
    expect(mockMeter).toHaveBeenCalledWith(expect.objectContaining({
      userId: member,
      billingUserId: member,
      sessionId: SESSION,
      feature: 'describe_image',
    }));
    expect(errSpy).toHaveBeenCalled();

    // A failure is not cached: the next call for the same user retries the lookup.
    await call({ userId: member, feature: 'describe_image' });
    await flush();
    expect(mockResolveBilling).toHaveBeenCalledTimes(2);
    expect(mockMeter).toHaveBeenLastCalledWith(expect.objectContaining({ userId: member, billingUserId: ORG_ROOT }));
  });

  it('caches the billing subject: a burst within the TTL resolves once, and it expires after', async () => {
    const member = freshMember();
    const nowSpy = jest.spyOn(Date, 'now');
    const t0 = 1_800_000_000_000;
    nowSpy.mockReturnValue(t0);

    await Promise.all([
      call({ userId: member, feature: 'session_title' }),
      call({ userId: member, feature: 'suggested_replies' }),
    ]);
    nowSpy.mockReturnValue(t0 + 59_000);
    await call({ userId: member, feature: 'finalize_guard_judge' });
    await flush();

    expect(mockResolveBilling).toHaveBeenCalledTimes(1);
    expect(mockMeter).toHaveBeenCalledTimes(3);
    for (const [ctx] of mockMeter.mock.calls) {
      expect(ctx).toMatchObject({ userId: member, billingUserId: ORG_ROOT });
    }

    nowSpy.mockReturnValue(t0 + 61_000);
    await call({ userId: member, feature: 'session_summary' });
    await flush();
    expect(mockResolveBilling).toHaveBeenCalledTimes(2);
  });

  it('meters a context that already carries billingUserId synchronously, with no resolve (agent loop unchanged)', async () => {
    const member = freshMember();

    await call({ userId: member, billingUserId: 'loop-billing', sessionId: SESSION, feature: 'agent_task:interactive' });

    // Asserted BEFORE any flush: this path is synchronous, exactly as before ENG-1858.
    expect(mockMeter).toHaveBeenCalledTimes(1);
    expect(mockMeter).toHaveBeenCalledWith(expect.objectContaining({
      userId: member,
      billingUserId: 'loop-billing',
      sessionId: SESSION,
      feature: 'agent_task:interactive',
    }));
    expect(mockResolveBilling).not.toHaveBeenCalled();
  });

  it('meters a userless (platform) context synchronously with no resolve and no invented user', async () => {
    await call({ feature: 'platform:eval_rca' });

    expect(mockMeter).toHaveBeenCalledTimes(1);
    const [ctx] = mockMeter.mock.calls[0];
    expect(ctx).toMatchObject({ feature: 'platform:eval_rca' });
    expect(ctx.userId).toBeUndefined();
    expect(ctx.billingUserId).toBeUndefined();
    expect(mockResolveBilling).not.toHaveBeenCalled();
  });
});

describe('call sites pass userId / sessionId / feature to callLLM', () => {
  const MEMBER = 'member-callsite';
  let callLLM: jest.SpyInstance;

  beforeEach(() => {
    callLLM = jest.spyOn(agentModeService, 'callLLM');
  });

  it('generateSuggestedReplies forwards the agent loop context (with its billingUserId)', async () => {
    callLLM.mockResolvedValue(llmReply('["Yes", "No"]'));
    const ctx = {
      userId: MEMBER,
      billingUserId: ORG_ROOT,
      sessionId: SESSION,
      feature: meteringFeature('suggested_replies', 'regular', null),
    };

    expect(await agentModeService.generateSuggestedReplies('Here is your plan.', [], ctx)).toEqual(['Yes', 'No']);
    expect(usageContextOf(callLLM)).toEqual({
      userId: MEMBER,
      billingUserId: ORG_ROOT,
      sessionId: SESSION,
      feature: 'suggested_replies:interactive',
    });
  });

  it('generateSuggestedReplies without a context is named, not agent_task', async () => {
    callLLM.mockResolvedValue(llmReply('["Ok"]'));
    await agentModeService.generateSuggestedReplies('x', []);
    expect(usageContextOf(callLLM)).toEqual({ feature: 'suggested_replies' });
  });

  it('generateSessionTitle forwards the session context', async () => {
    jest.spyOn(agentModeService, 'getDefaultModel').mockResolvedValue('gemini-3.1-flash-lite' as any);
    callLLM.mockResolvedValue(llmReply('{"title": "Competitive Analysis Report"}'));
    const ctx = { userId: MEMBER, sessionId: SESSION, feature: meteringFeature('session_title', 'regular', null) };

    expect(await agentModeService.generateSessionTitle('Research my competitors', ctx)).toBe('Competitive Analysis Report');
    expect(usageContextOf(callLLM)).toEqual({ userId: MEMBER, sessionId: SESSION, feature: 'session_title:interactive' });
  });

  it('describeImage threads the context through the vision call', async () => {
    callLLM.mockResolvedValue(llmReply('A blue logo'));
    // A non-anthropic/gemini model with a data URI: no download path.
    const result = await agentModeService.describeImage('gpt-4o', 'data:image/png;base64,iVBORw0KGgo=', 'what is it', {
      userId: MEMBER,
      sessionId: SESSION,
      feature: 'describe_image',
    });

    expect(result.success).toBe(true);
    expect(usageContextOf(callLLM)).toEqual({ userId: MEMBER, sessionId: SESSION, feature: 'describe_image' });
  });

  it('generateDiagnosticMessage carries the scheduled-run tag', async () => {
    callLLM.mockResolvedValue(llmReply('The publish succeeded; the report timed out.'));
    const feature = meteringFeature('diagnostic_message', 'scheduled', 'a1b2c3d4-0000-4000-8000-000000000001');

    await agentModeService.generateDiagnosticMessage(
      { errorType: 'timeout', errorMessage: 'timed out', userMessage: 'publish it' } as any,
      { userId: MEMBER, sessionId: SESSION, feature },
    );

    expect(usageContextOf(callLLM)).toEqual({
      userId: MEMBER,
      sessionId: SESSION,
      feature: 'diagnostic_message:scheduled:a1b2c3d4-0000-4000-8000-000000000001',
    });
  });

  it('scheduledTurnDefersToUser (controller) forwards the run context to the judge', async () => {
    callLLM.mockResolvedValue(llmReply('yes'));
    // A halt the regex does not catch, so the LLM judge is consulted.
    const novelHalt = "I've sketched the plan above — what's your preference on the breakdown before I build it?";
    const ctx = { userId: MEMBER, sessionId: SESSION, feature: 'scheduled_continuation_judge' };

    expect(await scheduledTurnDefersToUser(novelHalt, ctx)).toBe(true);
    expect(usageContextOf(callLLM)).toEqual(ctx);
  });

  it('summarizeSessionIfNeeded attributes the summary to the session owner', async () => {
    callLLM.mockResolvedValue(llmReply('{"summary": "Wrote a blog post."}'));
    jest.spyOn(chatbotDb, 'updateSessionSummary').mockResolvedValue(undefined as any);

    await summarizeSessionIfNeeded({
      sessionId: SESSION,
      userId: MEMBER,
      sessionType: 'scheduled',
      pageIdentifier: 'Weekly blog|scheduleId:abc123',
      messages: [{ role: 'user', content: 'write a blog post' }, { role: 'assistant', content: 'done' }],
      messageCount: 2,
    } as any);

    expect(usageContextOf(callLLM)).toEqual({
      userId: MEMBER,
      sessionId: SESSION,
      feature: 'session_summary:scheduled:abc123',
    });
  });

  it('processEnrichmentConfig meters alias inference and smart-field classification to the saving user', async () => {
    const generateJSONContent = jest.fn()
      .mockResolvedValueOnce({ stag: 'funding_stage' }) // llmInferAliases
      .mockResolvedValueOnce({}) // llmClassifySmartFields, first sample
      .mockResolvedValueOnce({}); // llmClassifySmartFields, second sample (ENG-2720: agreement)
    jest.spyOn(llmServiceModule, 'createLLMService').mockReturnValue({ generateJSONContent } as any);
    const deps = { ...buildConfigProcessingDeps(), readListConfig: jest.fn().mockResolvedValue(null) };

    await processEnrichmentConfig(
      {
        listId: 'list-1',
        userId: MEMBER,
        config: {
          schemaVersion: 1,
          fields: [
            { name: 'stag', type: 'string', instruction: 'funding stage', include: true, overwritePolicy: 'fill_if_empty' },
          ],
        } as any,
      },
      deps,
    );

    expect(generateJSONContent).toHaveBeenCalledTimes(3); // 1 alias + 2 classification samples, all metered to the saving user
    for (const call of generateJSONContent.mock.calls) {
      // generateJSONContent(system, user, format, onUsage, usageContext)
      expect(call[4]).toEqual({ userId: MEMBER, feature: 'crm_enrichment_config' });
    }
  });

  it('triggerCreativeDirForUser attributes the onboarding call to the triggering user', async () => {
    const generateJsonRobust = jest.fn().mockResolvedValue({
      concepts: ['VM', 'TR', 'SP', 'CE', 'CA', 'PI'],
      copy_angles: ['PA', 'OV', 'SPL', 'CH', 'DC'],
      format_archetypes: ['A', 'B', 'C'],
    });
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: MEMBER, companyName: 'Acme', icpResult: [] } as any);
    jest.spyOn(userDb, 'updateUser').mockResolvedValue(undefined as any);

    await triggerCreativeDirForUser(MEMBER, { llm: { generateJsonRobust } as any });

    expect(generateJsonRobust).toHaveBeenCalledTimes(1);
    // generateJsonRobust(system, user, onUsage, usageContext)
    expect(generateJsonRobust.mock.calls[0][3]).toEqual({ userId: MEMBER, feature: 'onboarding_creative_direction' });
  });

  it('eval RCA (platform-funded) records a platform:* feature and no user', async () => {
    callLLM.mockResolvedValue(llmReply(JSON.stringify({
      topHypotheses: ['a', 'b', 'c'],
      rankedFixes: [
        { title: 'a', impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'x' },
        { title: 'b', impact: 'med', confidence: 'med', cost_sp: 2, why_this_rank: 'y' },
        { title: 'c', impact: 'low', confidence: 'low', cost_sp: 3, why_this_rank: 'z' },
      ],
    })));

    await enrichWithRCA(
      {
        proposalId: asMutationId('prop-1'),
        sourceRuleId: 'capture-broken',
        hypothesis: 'capture is broken',
        kind: 'copy',
        payload: { targetKey: 'hero_heading', directive: 'rewrite', autoShipSafe: true },
        triggeringStats: { landed_count: 250 },
      } as any,
      [{ key: 'hero_heading', kind: 'copy' }] as any,
    );

    const ctx = usageContextOf(callLLM);
    expect(ctx).toEqual({ feature: 'platform:eval_rca' });
    expect(ctx).not.toHaveProperty('userId');
  });
});

// ENG-1816 F1: same class of bug as ENG-1858 above — these three call sites carried
// no userId, so their spend booked to "system" and escaped the funding policy on top
// of the billing gap. Fixed by reading the ambient RunFunding store instead of
// threading a new parameter through each function's signature. See
// finding-emma-llm-callsite-scope in the ENG-1816 brain for the original inventory.
describe('ENG-1816 F1: attribution leaks fixed via the ambient RunFunding store', () => {
  const MEMBER = 'member-eng1816';
  let callLLM: jest.SpyInstance;

  function funding(): RunFunding {
    return {
      route: 'agentweb',
      fallback: 'agentweb',
      ownerUserId: MEMBER,
      billingUserId: ORG_ROOT,
      resolvedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    callLLM = jest.spyOn(agentModeService, 'callLLM');
  });

  it('restyleContent (blog.ts) carries the run owner when called inside a RunFunding scope', async () => {
    callLLM.mockResolvedValue(llmReply(JSON.stringify({
      title: 'A Title',
      description: 'A description',
      content: 'Some content',
      imagePrompt: 'A prompt',
    })));

    await withRunFunding(funding(), () => restyleContent('original research', 'a topic'));

    // billingUserId is deliberately NOT forwarded from RunFunding, even though
    // funding() sets one: this ctx reaches meterWithResolvedBilling, which only
    // resolves the org-root billing subject (ENG-1858) when billingUserId is
    // absent. Forwarding RunFunding's billingUserId here would re-suppress that
    // resolution for org members — the exact ENG-1217 bug — for a value nothing
    // else reads yet (round-3 PR review finding).
    expect(usageContextOf(callLLM)).toEqual({
      feature: 'content_gen',
      userId: MEMBER,
    });
  });

  it('generateBlogContent (blog.ts) carries the run owner when called inside a RunFunding scope, and never forwards billingUserId', async () => {
    // Reaches meterWithResolvedBilling via a non-obvious path: generateJSONContent
    // -> invoke -> invokeGateway -> agentModeService.callLLM. A round-3 review
    // manually traced this and concluded (incorrectly) that this call site was
    // exempt from the ENG-1217 billingUserId-forwarding bug because it looked like
    // a direct meterUserUsage call; round-4 traced the gateway path fully and found
    // it reaches the exact same sink as restyleContent. This test pins the fix so
    // that mistake can't silently regress.
    callLLM.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        title: 'A Title',
        description: 'A description',
        content: 'Some content',
        imagePrompt: 'A prompt',
      }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });

    await withRunFunding(funding(), () => generateBlogContent('title draft', 'content draft'));

    expect(usageContextOf(callLLM)).toEqual({
      feature: 'content_gen',
      userId: MEMBER,
    });
  });

  it('wasStepRemovalUserAuthorized (emma/impl/workPlans.ts) carries the run owner and never forwards billingUserId', async () => {
    // ENG-2103 (F2 Pattern A): this helper moved from a private
    // AgentModeService method to a module export of emma/impl/workPlans.ts,
    // with `callLLM` now injected rather than reached via `this.callLLM`.
    // Retargeted from `(agentModeService as any).wasStepRemovalUserAuthorized(...)`
    // to call the module export directly, passing the same `callLLM` spy used
    // by the rest of this describe block so the assertion still observes the
    // real, unchanged call — not a mock that stopped being real.
    jest.spyOn(chatbotDb, 'getMostRecentRealUserMessage').mockResolvedValue({
      content: 'skip that step',
    } as any);
    callLLM.mockResolvedValue(llmReply('yes'));

    const authorized = await withRunFunding(funding(), () =>
      workPlansImpl.wasStepRemovalUserAuthorized(SESSION, [
        { fn: 'publish_post', stepTitle: 'Publish' },
      ], callLLM as any),
    );

    expect(authorized).toBe(true);
    expect(usageContextOf(callLLM)).toEqual({
      feature: 'step_removal_authorization_judge',
      userId: MEMBER,
    });
  });

  it('restyleContent outside any RunFunding scope still books to "system" — the ambient store, not a new required parameter, is what changed', async () => {
    callLLM.mockResolvedValue(llmReply(JSON.stringify({
      title: 'A Title',
      description: 'A description',
      content: 'Some content',
      imagePrompt: 'A prompt',
    })));

    await restyleContent('original research', 'a topic');

    const ctx = usageContextOf(callLLM);
    expect(ctx.userId).toBeUndefined();
    expect(ctx.billingUserId).toBeUndefined();
  });
});
