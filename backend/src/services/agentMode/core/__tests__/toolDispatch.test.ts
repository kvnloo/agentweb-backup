/**
 * Unit tests for the extracted tool-dispatch boundary (core/toolDispatch.ts).
 *
 * These test the module in ISOLATION with fake ports — no monolith, no network.
 * They pin the boundary's own contract: ordering, parallel-vs-sequential decision,
 * preflight-failure handling, error classification, S3 offload, and counter deltas.
 * The characterization snapshots (../../../__tests__/agentMode/characterization)
 * separately prove the monolith's observable behavior is unchanged.
 */

import {
  evaluateAgentToolPolicy,
  executeAgentToolThroughGateway,
  validateAndRepairToolArgs,
} from '../../../agentToolGatewayService';
import {
  executePreparedTools,
  stableStringify,
  seedMediaCallKeysFromHistory,
  seedSearchCallCountFromHistory,
  SEARCH_CALL_SESSION_CAP,
  type ExecutePreparedToolsInput,
  type ToolDispatchPorts,
} from '../toolDispatch';
import { CitationRegistry } from '../../../../utils/citations';
// ENG-105 wiring: the REAL output-contract validator + the REAL extractToolContent
// (now a monolith-free util) + the REAL error classifier, so this suite proves the
// production port — not a hand-copied mirror — downgrades empty output and tags it
// invalid_output.
import {
  validateToolOutputContract,
  ToolOutputContractError,
} from '../../../../utils/toolOutputContract';
import { extractToolContent } from '../../../../utils/extractToolContent';
import { classifyToolErrorClass } from '../../../../utils/toolErrorClassifier';
// The REAL downgrade the dispatcher is wired with in production, so the install_skills ledger
// shape below is established rather than assumed.
import { toolResultError as realToolResultError } from '../../../../utils/toolResultError';

/** Build a model tool_call in the shape the loop emits. */
function toolCall(id: string, name: string, args: string) {
  return { id, type: 'function', function: { name, arguments: args } };
}

/** Allow-all, repair-none policy + a gateway that runs `execute` and reports success. */
function makePorts(overrides: Partial<ToolDispatchPorts> = {}): ToolDispatchPorts {
  const execOrder: string[] = [];
  const base: ToolDispatchPorts = {
    evaluateAgentToolPolicy: () => ({ allowed: true, effect: 'read', flags: [] }) as any,
    validateAndRepairToolArgs: (i: any) => ({ status: 'valid', args: i.args }),
    getToolInputSchema: () => undefined,
    executeAgentToolThroughGateway: async (i) => {
      execOrder.push(i.toolName);
      try {
        const result = await i.execute();
        return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
      } catch (error) {
        return { status: 'error', error, durationMs: 1, policyDecision: i.policyDecision };
      }
    },
    executePreparedAgentTool: async (i: any) => ({ success: true, echo: i.toolName }),
    toolResultError: () => null,
    recordToolTelemetry: () => undefined,
    extractMinimalToolResult: (r: any) => r,
    extractToolContent: (r: any) => (typeof r === 'string' ? r : JSON.stringify(r)),
    formatToolError: (_name: string, msg: string) => `ERR: ${msg}`,
    uploadScreenshotToS3: async () => ({ url: 'https://s3/shot.png' }),
    uploadFileToS3WithPath: async () => ({ success: true, key: 'k' }),
    buildCrmDataChangedPayload: () => null,
    crmDataChangedEvent: 'crm:data-changed',
    socketEmit: undefined,
  };
  return { ...base, ...overrides, ...({ __execOrder: execOrder } as any) };
}

function makeInput(
  calls: any[],
  ports: ToolDispatchPorts,
  overrides: Partial<ExecutePreparedToolsInput> = {},
): ExecutePreparedToolsInput {
  return {
    toolCalls: calls,
    messages: [],
    toolCallsLedger: [],
    iteration: 0,
    agentRuntimeRunId: 'run-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    llmModel: 'gpt-test',
    mockMode: false,
    screenshotUrl: undefined,
    isDelegatedAccess: false,
    hasAdminAccess: true,
    isInteractiveShare: false,
    adminSkillToolNames: ['freeze_user_account'],
    excludeTools: undefined,
    publishedSkillsCount: 0,
    sessionAssociatedSkillIdsCount: 0,
    allowedToolNames: new Set<string>(),
    toolResponseS3Threshold: 10_000,
    maxToolContentSize: 300_000,
    ports,
    ...overrides,
  };
}

describe('executePreparedTools', () => {
  // ENG-2263: the ledger stores a MINIMISED result, so number checks need the full one.
  describe('observeFullToolResult (ENG-2263)', () => {
    const full = { success: true, lists: [{ leadCount: 5 }, { leadCount: 12 }], totalLists: 17 };

    it('hands the observer the FULL result while the ledger keeps the minimised one', async () => {
      const seen: Array<[string, any]> = [];
      const ports = makePorts({
        executePreparedAgentTool: async () => full,
        extractMinimalToolResult: () => ({}),
        observeFullToolResult: (name: string, r: any) => { seen.push([name, r]); },
      } as any);
      const input = makeInput([toolCall('c1', 'get_lead_lists', '{}')], ports);
      await executePreparedTools(input);
      expect(seen).toEqual([['get_lead_lists', full]]);
      expect(input.toolCallsLedger[0].result).toEqual({});
    });

    it('a throwing observer cannot break the turn or lose the ledger entry', async () => {
      const ports = makePorts({
        executePreparedAgentTool: async () => full,
        observeFullToolResult: () => { throw new Error('observer exploded'); },
      } as any);
      const input = makeInput([toolCall('c1', 'get_lead_lists', '{}')], ports);
      await expect(executePreparedTools(input)).resolves.toBeDefined();
      expect(input.toolCallsLedger).toHaveLength(1);
      expect(input.toolCallsLedger[0].name).toBe('get_lead_lists');
      expect(input.toolCallsLedger[0].error).toBeUndefined();
    });

    it('works when no observer is wired (every other caller)', async () => {
      const ports = makePorts({ executePreparedAgentTool: async () => full } as any);
      const input = makeInput([toolCall('c1', 'get_lead_lists', '{}')], ports);
      await executePreparedTools(input);
      expect(input.toolCallsLedger).toHaveLength(1);
    });

    it('does not observe a call that was refused', async () => {
      const seen: string[] = [];
      const ports = makePorts({
        executePreparedAgentTool: async () => full,
        observeFullToolResult: (name: string) => { seen.push(name); },
      } as any);
      const input = makeInput([toolCall('c1', 'send_email', '{}')], ports, { loopBreakerActive: true });
      await executePreparedTools(input);
      expect(seen).toEqual([]);
    });
  });

  // ENG-1337: the loop-breaker is a hard execution-layer deny, not just prose.
  describe('while loopBreakerActive', () => {
    const run = async (name: string, active = true) => {
      const executed: string[] = [];
      const ports = makePorts({
        executePreparedAgentTool: async (i: any) => { executed.push(i.toolName); return { success: true }; },
      } as any);
      const gateway = jest.spyOn(ports, 'executeAgentToolThroughGateway');
      const input = makeInput([toolCall('c1', name, '{}')], ports, { loopBreakerActive: active });
      await executePreparedTools(input);
      return { executed, input, gateway };
    };

    it.each(['send_email', 'create_lead', 'update_crm_contact', 'delete_campaign', 'publish_social_post'])(
      'denies write/publish/send tool %s before it reaches the gateway',
      async (name) => {
        const { executed, input } = await run(name);
        expect(executed).toEqual([]);
        expect(String(input.toolCallsLedger[0]?.error ?? '')).toMatch(/only read-only or verification tools/);
        expect(JSON.stringify(input.messages)).toContain('loop_breaker');
      },
    );

    it.each(['read_brand_guidelines', 'read_market_strategy', 'get_google_ads_report', 'list_leads', 'web_search'])(
      'still executes read-only/verification tool %s',
      async (name) => {
        const { executed } = await run(name);
        expect(executed).toEqual([name]);
      },
    );

    it('still denies install_skills (ENG-763 regression)', async () => {
      const { executed } = await run('install_skills');
      expect(executed).toEqual([]);
    });

    it('denies ask_user_question before it can halt the run with another question deck', async () => {
      const { executed, input, gateway } = await run('ask_user_question');
      expect(gateway).not.toHaveBeenCalled();
      expect(executed).toEqual([]);
      expect(String(input.toolCallsLedger[0]?.error ?? '')).toMatch(/only read-only or verification tools/);
      expect(JSON.stringify(input.messages)).toContain('loop_breaker');
    });

    it('still executes ask_user_question when the loop-breaker is inactive', async () => {
      const { executed, gateway } = await run('ask_user_question', false);
      expect(gateway).toHaveBeenCalledTimes(1);
      expect(executed).toEqual(['ask_user_question']);
    });

    it('does not deny writes when the loop-breaker is inactive', async () => {
      const { executed } = await run('send_email', false);
      expect(executed).toEqual(['send_email']);
    });
  });

  /*
   * Observed live (delegated session a1a6345a, Phoenix): this gate refused
   * `audit_ad_utm_coverage`, the `install_skills` fallback was refused by subscription, and the
   * model then ran an unrelated AD LIST and presented a confident "UTM Tagging Audit Summary —
   * PASS, 6/6 tagged" table built from it, as though the audit had run and passed. A downstream
   * truthfulness guard appended a correction, but BELOW the fabricated table.
   *
   * The gate error told the model to install the skill and said nothing about what to do when
   * the install itself fails — so it improvised. These pin the instruction it now carries.
   */
  describe('a skill-gated tool refusal', () => {
    const gatedInput = (ports: any) =>
      makeInput([toolCall('g', 'audit_ad_utm_coverage', '{}')], ports, {
        publishedSkillsCount: 1,
        sessionAssociatedSkillIdsCount: 1,
        allowedToolNames: new Set<string>(['read_brand_guidelines']),
      });

    it('forbids substituting another tool and presenting it as this tool having run', async () => {
      const ports = makePorts();
      const input = gatedInput(ports);

      await executePreparedTools(input);

      const err = String(input.toolCallsLedger[0]?.error ?? '');
      expect(err).toMatch(/do not run a different tool/i);
      expect(err).toMatch(/substituting other data makes the claim false/i);
    });

    it('says what to do when the install itself cannot succeed', async () => {
      const ports = makePorts();
      const input = gatedInput(ports);

      await executePreparedTools(input);

      const err = String(input.toolCallsLedger[0]?.error ?? '');
      // Was `/unavailable on their plan/i` -- ENG-1844 (de6002c8e, 2026-09-11) removed that
      // guessed cause deliberately: this gate fires BEFORE install_skills ever runs, and
      // install_skills refuses for four distinct reasons (billing, catalog gap, bad id, role),
      // only one of which is billing (the exact bug ENG-1795 exists for). Asserting a specific
      // guessed cause here pre-empts install_skills' own accurate, already-bucketed reason. The
      // invariant this test protects is now "defer, don't guess," not "name the billing cause."
      expect(err).toMatch(/do not guess or assume why/i);
      expect(err).toMatch(/relay install_skills' own response message/i);
    });

    it('keeps the prefix that classifyToolErrorClass keys tool_unavailable off', async () => {
      const ports = makePorts();
      const input = gatedInput(ports);

      await executePreparedTools(input);

      const err = String(input.toolCallsLedger[0]?.error ?? '');
      // Appending guidance must not change how the error is classified upstream.
      expect(err).toContain('is not available. You must install the required skill first using install_skills.');
      expect(classifyToolErrorClass(new Error(err))).toBe('tool_unavailable');
    });

    it('still does not execute the gated tool', async () => {
      const ports = makePorts();
      const input = gatedInput(ports);

      await executePreparedTools(input);

      expect((ports as any).__execOrder ?? []).not.toContain('audit_ad_utm_coverage');
    });

    /*
     * What a REFUSED install_skills actually looks like in the ledger, established here rather
     * than assumed anywhere downstream.
     *
     * `installSkills` never throws — every refusal returns `{ success: false, message }` and so
     * travels the dispatcher's SUCCESS path. The claim that this therefore reaches the ledger
     * with neither an `error` nor a `success: false` is WRONG, and worth pinning so nobody
     * re-derives it: the downgrade below (the REAL `toolResultError`, wired as the production
     * port is) converts a `success: false` result into a tool failure first, so the entry does
     * carry an `error`.
     *
     * Anything reading the ledger to decide whether the install worked keys off exactly that,
     * so this test is what keeps the two from drifting: unwire the downgrade and it fails here,
     * not silently in production.
     */
    it('a refused install_skills reaches the ledger as a failure, not a bare success', async () => {
      const ports = makePorts({
        toolResultError: realToolResultError,
        executePreparedAgentTool: async () => ({
          success: false,
          message: 'The requested skills are not available with your current subscription.',
        }),
      });
      const input = makeInput([toolCall('i', 'install_skills', '{"skillIds":["utm-audit"]}')], ports);

      await executePreparedTools(input);

      const entry = input.toolCallsLedger[0];
      expect(entry.name).toBe('install_skills');
      expect(String(entry.error)).toMatch(/not available with your current subscription/i);
    });

    /*
     * The gap the downgrade genuinely cannot cover. A PARTIAL install returns `success: true` —
     * something did install — so `toolResultError` raises nothing and the entry is an ordinary
     * success. Only the minimized RESULT can say that the skill the gated tool needed may have
     * been the one refused, which is why extractMinimalToolResult keeps `rejectedSkillIds`.
     */
    it('a PARTIAL install reaches the ledger as a success, so the result must carry the refusal', async () => {
      const partial = {
        success: true,
        message: 'Successfully installed 1 skill(s). Could not resolve these skill IDs to any known skill: no-such-id. This is an ID problem, not a billing one.',
        installedSkills: ['Some Other Skill'],
        rejectedSkillIds: ['utm-audit'],
        // The tool names installSkills resolved rejectedSkillIds to (agentModeService.ts) —
        // what buildUnavailableCapabilityNotice's per-tool scoping keys off. Included here so
        // this test proves it reaches the ledger through the actual dispatch boundary, not
        // just through extractMinimalToolResult called directly.
        rejectedToolNames: ['audit_ad_utm_coverage'],
      };
      const ports = makePorts({
        toolResultError: realToolResultError,
        executePreparedAgentTool: async () => partial,
      });
      const input = makeInput([toolCall('i', 'install_skills', '{"skillIds":["a","utm-audit"]}')], ports);

      await executePreparedTools(input);

      const entry = input.toolCallsLedger[0];
      expect(entry.error).toBeUndefined();
      expect(entry.result.rejectedToolNames).toEqual(['audit_ad_utm_coverage']);
      // makePorts' minimizer is identity, so this asserts the FIELD survives to the minimizer.
      // agentModeService.skills.test.ts pins that the real minimizer keeps it.
      expect(entry.result.rejectedSkillIds).toEqual(['utm-audit']);
    });
  });

  /*
   * ENG-1945 follow-up: install_skills now runs its real, gateway-routed execution
   * eagerly in Phase 1 (so a sibling call gated by it can unlock in the SAME batch —
   * see installSkillsSameBatchToolGate.test.ts), instead of only in Phase 2. That
   * eager call must be the tool's ONLY execution for a given tool_call_id, not an
   * extra one layered on top of Phase 2 — a second, independent execution through
   * the REAL gateway double-records failures against the same per-run breaker key,
   * which halves the model's genuine 2-strike retry budget for install_skills'
   * FAST_TRIP rejection classes (skill_install_refused/subscription_blocked/
   * invalid_args) without either the model or a human ever seeing two attempts.
   */
  describe('install_skills executes exactly once per call (breaker budget)', () => {
    const REJECTION = {
      success: false,
      message: 'Could not resolve these skill IDs to any known skill: no-such-skill.',
    };

    const realGatewayPorts = (spy: jest.Mock) =>
      makePorts({
        evaluateAgentToolPolicy,
        validateAndRepairToolArgs,
        toolResultError: realToolResultError,
        getToolInputSchema: () => undefined,
        executeAgentToolThroughGateway: spy,
        executePreparedAgentTool: async () => REJECTION,
      });

    it('calls the real gateway exactly once for a single install_skills tool call', async () => {
      const spy = jest.fn(executeAgentToolThroughGateway);
      const ports = realGatewayPorts(spy);
      const input = makeInput(
        [toolCall('i1', 'install_skills', '{"skillIds":["no-such-skill"]}')],
        ports,
        { agentRuntimeRunId: 'run-single-exec' },
      );

      await executePreparedTools(input);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(input.toolCallsLedger[0].error)).toContain('no-such-skill');
    });

    // The regression this pins: with a double execution, ONE rejected call in turn 1
    // already records 2 failures (fast-trip threshold), so turn 2 — the model's
    // first genuine retry — is silently short-circuited by the breaker instead of
    // re-running and reporting the real, bucketed rejection reason. With a single
    // execution, turn 1 records exactly 1 failure, so turn 2 still runs for real and
    // only turn 3 (the model's SECOND genuine retry) trips the breaker.
    it('takes two genuine identical failures across turns to trip the repeated-failure breaker, not one', async () => {
      const spy = jest.fn(executeAgentToolThroughGateway);
      const ports = realGatewayPorts(spy);
      const runId = 'run-breaker-budget';

      const turn2 = makeInput(
        [toolCall('i2', 'install_skills', '{"skillIds":["no-such-skill"]}')],
        ports,
        { agentRuntimeRunId: runId },
      );
      const turn1 = makeInput(
        [toolCall('i1', 'install_skills', '{"skillIds":["no-such-skill"]}')],
        ports,
        { agentRuntimeRunId: runId },
      );
      await executePreparedTools(turn1);
      await executePreparedTools(turn2);

      // Turn 2 must still be the REAL rejection reason (gateway ran install_skills
      // again), not a generic repeated-failure stop message — that only happens once
      // the breaker has actually seen 2 genuine failures.
      expect(String(turn2.toolCallsLedger[0].error)).toContain('no-such-skill');
      expect(spy).toHaveBeenCalledTimes(2);

      const turn3 = makeInput(
        [toolCall('i3', 'install_skills', '{"skillIds":["no-such-skill"]}')],
        ports,
        { agentRuntimeRunId: runId },
      );
      await executePreparedTools(turn3);

      // Now (2 genuine prior failures) the breaker trips: the gateway is still
      // invoked (it does the tripped-check internally) but its own `execute()` must
      // NOT run a 3rd time, and the model sees the repeated-failure stop message.
      expect(spy).toHaveBeenCalledTimes(3);
      expect(String(turn3.toolCallsLedger[0].error)).toMatch(/already failed 2 times/i);
    });
  });

  it('executes a batch and appends tool messages in original order', async () => {
    const ports = makePorts();
    const input = makeInput(
      [toolCall('a', 'read_brand_guidelines', '{}'), toolCall('b', 'read_market_strategy', '{}')],
      ports,
    );
    const result = await executePreparedTools(input);

    expect(input.messages.map((m: any) => m.name)).toEqual([
      'read_brand_guidelines',
      'read_market_strategy',
    ]);
    expect(input.toolCallsLedger.map((t: any) => t.name)).toEqual([
      'read_brand_guidelines',
      'read_market_strategy',
    ]);
    expect(result.pendingCounterUpdates).toEqual({
      read_brand_guidelines: 1,
      read_market_strategy: 1,
    });
    expect(result.failedCounterUpdates).toEqual({});
  });

  it('runs sequentially when wait_seconds is present and preserves order', async () => {
    const ports = makePorts();
    const input = makeInput(
      [
        toolCall('a', 'read_brand_guidelines', '{}'),
        toolCall('w', 'wait_seconds', '{"seconds":0}'),
        toolCall('b', 'read_market_strategy', '{}'),
      ],
      ports,
    );
    await executePreparedTools(input);
    // The fake gateway records execution order; sequential keeps emission order.
    expect((ports as any).__execOrder).toEqual([
      'read_brand_guidelines',
      'wait_seconds',
      'read_market_strategy',
    ]);
  });

  it('records a tool error: error message + failed counter, no pending counter', async () => {
    const ports = makePorts({
      executePreparedAgentTool: async (i: any) => {
        if (i.toolName === 'read_market_strategy') throw new Error('boom');
        return { success: true };
      },
    });
    const input = makeInput(
      [toolCall('a', 'read_brand_guidelines', '{}'), toolCall('b', 'read_market_strategy', '{}')],
      ports,
    );
    const result = await executePreparedTools(input);

    expect(input.toolCallsLedger[0]).toMatchObject({ name: 'read_brand_guidelines' });
    expect(input.toolCallsLedger[0].error).toBeUndefined();
    expect(input.toolCallsLedger[1]).toMatchObject({ name: 'read_market_strategy', error: 'boom' });
    // ENG-124: every executed-tool error now carries an explicit retryability
    // verdict line appended to the formatted error the model sees.
    expect(input.messages[1].content).toContain('ERR: boom');
    expect(input.messages[1].content).toContain('Retryable: no');
    expect(result.pendingCounterUpdates).toEqual({ read_brand_guidelines: 1 });
    expect(result.failedCounterUpdates).toEqual({ read_market_strategy: 1 });
  });

  it('marks a transient (rate-limit) tool error as retryable in the model-visible content (ENG-124)', async () => {
    const ports = makePorts({
      executePreparedAgentTool: async () => {
        throw new Error('429 too many requests — rate limit exceeded');
      },
    });
    const input = makeInput([toolCall('a', 'you_search_web', '{}')], ports);
    await executePreparedTools(input);

    expect(input.messages[0].content).toContain('Retryable: yes');
  });

  it('ENG-351: harvests web-search sources into the citation registry (deduped, numbered)', async () => {
    const ports = makePorts({
      executePreparedAgentTool: async (i: any) =>
        i.toolName === 'you_search_web'
          ? {
              success: true,
              results: [
                { url: 'https://www.grandviewresearch.com/report', title: 'CRM $163B', snippet: 's1' },
                { url: 'https://statista.com/crm', title: 'CRM stats' },
              ],
            }
          : { success: true },
    });
    const citationRegistry = new CitationRegistry();
    const input = makeInput(
      [toolCall('a', 'you_search_web', '{}'), toolCall('b', 'send_email', '{}')],
      ports,
      { citationRegistry },
    );

    await executePreparedTools(input);

    const cites = citationRegistry.list();
    expect(cites.map((c) => c.domain)).toEqual(['grandviewresearch.com', 'statista.com']);
    expect(cites.map((c) => c.id)).toEqual([1, 2]);
    expect(cites[0]).toMatchObject({ title: 'CRM $163B', snippet: 's1' });
  });

  it('marks an auth tool error as NOT retryable and tells the model to stop (ENG-124)', async () => {
    const ports = makePorts({
      executePreparedAgentTool: async () => {
        throw new Error('Unauthorized: invalid api key');
      },
    });
    const input = makeInput([toolCall('a', 'send_email', '{}')], ports);
    await executePreparedTools(input);

    expect(input.messages[0].content).toContain('Retryable: no');
    expect(input.messages[0].content).toContain('Do NOT retry');
  });

  it('downgrades a success result that toolResultError flags as an error', async () => {
    const ports = makePorts({
      toolResultError: (r: any) => (r?.bad ? 'flagged error' : null),
      executePreparedAgentTool: async () => ({ bad: true }),
    });
    const input = makeInput([toolCall('a', 'read_brand_guidelines', '{}')], ports);
    const result = await executePreparedTools(input);

    // The monolith's error branch stringifies non-Error errors as 'Unknown error'
    // for the ledger entry (behavior-preserving: toolResultError returns a string,
    // not an Error instance). The tool message content uses String(error).
    expect(input.toolCallsLedger[0].error).toBe('Unknown error');
    expect(input.toolCallsLedger[0].result).toEqual({ bad: true });
    expect(input.messages[0].content).toContain('ERR: flagged error');
    expect(input.messages[0].content).toContain('Retryable:');
    expect(result.failedCounterUpdates).toEqual({ read_brand_guidelines: 1 });
    expect(result.pendingCounterUpdates).toEqual({});
  });

  // ENG-2086: a tool can fail by echoing its own (unbounded) result back inside
  // `error` — call_google_ads_reporting_api's serving_chain mode JSON.stringifies
  // the full campaign/ad-group/keyword tree into `error` whenever the account
  // isn't fully READY/DELIVERING. Unlike the success path (which offloads/caps
  // `toolContent` above), this error branch had NO size guard at all, so a
  // multi-MB error message went out to the LLM provider unbounded and
  // OpenRouter/Gemini 400'd on the oversized request (prod session
  // d02669e9-c3b8-4b65-ab51-a9c045c63b65, surfaced as an opaque "please
  // rephrase" to the user). This pins that the error branch is capped the same
  // way the success branch caps `toolContent`.
  it('caps an oversized error message before it reaches the LLM', async () => {
    const huge = 'X'.repeat(400_000);
    const ports = makePorts({
      executePreparedAgentTool: async () => {
        throw new Error(huge);
      },
    });
    const input = makeInput([toolCall('a', 'call_google_ads_reporting_api', '{}')], ports);
    await executePreparedTools(input);

    const stored = input.messages[0].content as string;
    // The cap reserves room for the notice before slicing, so the final sealed
    // result never exceeds maxToolContentSize (300_000) — not "roughly", exactly.
    expect(stored.length).toBeLessThanOrEqual(300_000);
    expect(stored).toContain('[Error message truncated for size — original length:');
  });

  // ENG-2086 follow-up (CodeRabbit): the FINAL assembled content must be capped,
  // not just the raw message. formatToolError's per-tool fix text and
  // appendRetryabilityGuidance's verdict line are appended AFTER the raw
  // message — a raw-message-only cap could still let their added text push the
  // actual wire content past maxToolContentSize. Construct a raw message that
  // is UNDER the cap by itself but pushes over it once wrapped, and confirm the
  // final content is still bounded.
  it('caps the fully-formatted error content even when the raw message alone is under the limit', async () => {
    // 'ERR: ' (the fake formatToolError prefix) + this message is exactly
    // maxToolContentSize; appendRetryabilityGuidance's non-empty verdict line
    // then pushes the assembled content over.
    const justUnderCap = 'X'.repeat(300_000 - 'ERR: '.length);
    const ports = makePorts({
      executePreparedAgentTool: async () => {
        throw new Error(justUnderCap);
      },
    });
    const input = makeInput([toolCall('a', 'call_google_ads_reporting_api', '{}')], ports);
    await executePreparedTools(input);

    const stored = input.messages[0].content as string;
    // Proves the fix: the raw message (299,995 chars) is UNDER maxToolContentSize
    // on its own, so a raw-message-only cap would have left this untouched. The
    // assembled content (300,000+ once formatted and retryability-guided) must
    // still come out capped — exactly, notice included.
    expect(stored.length).toBeLessThanOrEqual(300_000);
    expect(stored).toContain('[Error message truncated for size — original length:');
  });

  // ENG-1626: a ToolResultPolicyBlockedError is a tool refusing BY DESIGN (e.g.
  // set_work_plan_status's out-of-order/missing-calls gates, which return
  // {success:false, blocked:true, reason:'...'} without throwing). It downgrades
  // to a model-visible error like any other, but must NOT feed failedCounterUpdates
  // (session.failedFunctions) -- that field is what the failure-cluster telemetry
  // and this issue's "set_work_plan_status failed 2x" reading were built from, so
  // a self-correcting gate refusal must not read as an infra flake.
  it('downgrades a ToolResultPolicyBlockedError result WITHOUT counting it as a failure', async () => {
    const { ToolResultPolicyBlockedError } = require('../../../../utils/toolResultError');
    const ports = makePorts({
      toolResultError: (r: any) =>
        r?.blocked === true ? new ToolResultPolicyBlockedError(r.message, r.reason) : null,
      executePreparedAgentTool: async () => ({
        success: false,
        blocked: true,
        reason: 'workplan_out_of_order',
        message: 'Cannot mark steps as completed. Earlier steps in the plan are not done yet.',
      }),
    });
    const input = makeInput([toolCall('a', 'set_work_plan_status', '{}')], ports);
    const result = await executePreparedTools(input);

    expect(input.toolCallsLedger[0].error).toBe(
      'Cannot mark steps as completed. Earlier steps in the plan are not done yet.',
    );
    expect(result.failedCounterUpdates).toEqual({});
  });

  it('offloads a large tool response to S3 and caps the in-memory copy', async () => {
    const big = 'Y'.repeat(15_000);
    const upload = jest.fn().mockResolvedValue({ success: true, key: 'tool-responses/sess-1/a.txt' });
    const ports = makePorts({
      executePreparedAgentTool: async () => big,
      extractToolContent: (r: any) => r,
      uploadFileToS3WithPath: upload,
    });
    const input = makeInput([toolCall('a', 'read_market_strategy', '{}')], ports);
    await executePreparedTools(input);

    expect(upload).toHaveBeenCalledTimes(1);
    const stored = input.messages[0].content as string;
    expect(stored).toContain('[Full response stored at S3 key: tool-responses/sess-1/a.txt');
    expect(stored).toContain('use search_tool_response');
    // capped at 20KB in-memory preview + header — much smaller than the full 15KB+headers
    expect(stored.length).toBeLessThan(15_000 + 500);
  });

  // ENG-940 follow-up B: uploadFileToS3WithPath signals failure by RETURNING
  // {success:false} (it swallows its own errors), so the offload used to be
  // skipped silently and the payload became indistinguishable from a small
  // response until the trimmer destroyed it.
  // ENG-1054: the in-memory preview is a hard byte slice, so it lands mid-JSON.
  // Handing the model an unterminated structure is what produced the production
  // "}]" final answer — the model closed our JSON instead of writing a reply.
  it('seals the S3 preview so a truncated response is never left mid-JSON', async () => {
    const big = `{"success":true,"ads":[${'{"id":"120248669405960585","picture":"https://s3.example.com/a.png"},'.repeat(500)}]}`;
    expect(big.length).toBeGreaterThan(20_000);
    const upload = jest.fn().mockResolvedValue({ success: true, key: 'tool-responses/sess-1/b.txt' });
    const ports = makePorts({
      executePreparedAgentTool: async () => big,
      extractToolContent: (r: any) => r,
      uploadFileToS3WithPath: upload,
    });
    const input = makeInput([toolCall('a', 'call_meta_marketing_api', '{}')], ports);
    await executePreparedTools(input);

    const stored = input.messages[0].content as string;
    const notice = '[Content truncated — full response in S3]';
    expect(stored).toContain(notice);

    // Everything between the S3 header and the notice must parse on its own.
    const body = stored.slice(stored.indexOf('\n\n') + 2, stored.indexOf(notice)).trim();
    const parsed = JSON.parse(body);
    expect(parsed.success).toBe(true);
    expect(Array.isArray(parsed.ads)).toBe(true);
    expect(parsed.ads.length).toBeGreaterThan(0);
  });

  it('retries a failed S3 offload once before giving up', async () => {
    const big = 'Y'.repeat(15_000);
    const upload = jest
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'SlowDown' })
      .mockResolvedValueOnce({ success: true, key: 'tool-responses/sess-1/a.txt' });
    const ports = makePorts({
      executePreparedAgentTool: async () => big,
      extractToolContent: (r: any) => r,
      uploadFileToS3WithPath: upload,
    });
    const input = makeInput([toolCall('a', 'read_market_strategy', '{}')], ports);
    await executePreparedTools(input);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(input.messages[0].content as string).toContain(
      '[Full response stored at S3 key: tool-responses/sess-1/a.txt',
    );
  });

  it('marks the response unrecoverable when both offload attempts fail', async () => {
    const big = 'Y'.repeat(15_000);
    const upload = jest.fn().mockResolvedValue({ success: false, error: 'AccessDenied' });
    const ports = makePorts({
      executePreparedAgentTool: async () => big,
      extractToolContent: (r: any) => r,
      uploadFileToS3WithPath: upload,
    });
    const input = makeInput([toolCall('a', 'read_market_strategy', '{}')], ports);
    await executePreparedTools(input);

    expect(upload).toHaveBeenCalledTimes(2);
    const stored = input.messages[0].content as string;
    expect(stored).toContain('could NOT be stored');
    expect(stored).not.toContain('[Full response stored at S3 key:');
    // The payload itself is still delivered in full for THIS turn.
    expect(stored).toContain(big);
  });

  it('marks the response unrecoverable when the offload throws', async () => {
    const big = 'Y'.repeat(15_000);
    const upload = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const ports = makePorts({
      executePreparedAgentTool: async () => big,
      extractToolContent: (r: any) => r,
      uploadFileToS3WithPath: upload,
    });
    const input = makeInput([toolCall('a', 'read_market_strategy', '{}')], ports);
    await executePreparedTools(input);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(input.messages[0].content as string).toContain('could NOT be stored');
  });

  it('preflight-blocks an admin-only tool for a non-admin session', async () => {
    const ports = makePorts();
    const input = makeInput(
      [toolCall('a', 'freeze_user_account', '{}')],
      ports,
      { hasAdminAccess: false },
    );
    const result = await executePreparedTools(input);

    expect(input.toolCallsLedger[0].error).toContain('requires admin access');
    expect(result.failedCounterUpdates).toEqual({ freeze_user_account: 1 });
    // the gateway should never have been reached for a preflight failure
    expect((ports as any).__execOrder).toEqual([]);
  });

  it('preflight-blocks org notification settings writes in a shared (share-link) session', async () => {
    const ports = makePorts();
    const input = makeInput(
      [toolCall('a', 'update_lead_notification_settings', '{"leadTypes":[]}')],
      ports,
      { hasAdminAccess: false, isInteractiveShare: true },
    );
    await executePreparedTools(input);

    expect(input.toolCallsLedger[0].error).toContain('not available in shared sessions');
    expect((ports as any).__execOrder).toEqual([]);
  });

  it.each([
    ['get_lead_notification_settings', '{}'],
    ['save_org_memory', '{"content":"Remember for the whole org: x"}'],
    ['delete_org_memory', '{"memoryId":"m1"}'],
    ['save_memory', '{"content":"x"}'],
    ['delete_memory', '{"memoryId":"m1"}'],
  ])('preflight-blocks owner-scoped %s in a shared (share-link) session', async (name, args) => {
    const ports = makePorts();
    const input = makeInput([toolCall('a', name, args)], ports, { hasAdminAccess: true, isInteractiveShare: true });
    await executePreparedTools(input);
    expect(input.toolCallsLedger[0].error).toContain('not available in shared sessions');
    expect((ports as any).__execOrder).toEqual([]);
  });

  it('still allows save_org_memory in the owner\'s own session', async () => {
    const ports = makePorts();
    const input = makeInput([toolCall('a', 'save_org_memory', '{"content":"x"}')], ports, { hasAdminAccess: true, isInteractiveShare: false });
    await executePreparedTools(input);
    expect(input.toolCallsLedger[0].error).toBeUndefined();
  });

  it('records a JSON-parse failure as a preflight error', async () => {
    const ports = makePorts();
    const input = makeInput([toolCall('a', 'read_brand_guidelines', '{not json}')], ports);
    const result = await executePreparedTools(input);

    expect(input.toolCallsLedger[0].error).toMatch(/Failed to parse arguments/);
    expect(result.failedCounterUpdates).toEqual({ read_brand_guidelines: 1 });
    expect((ports as any).__execOrder).toEqual([]);
  });

  // ENG-1477: create_html_file/save_file calls carrying a title or content
  // value with an unescaped inner quote (a quoted phrase, or HTML markup
  // like class="...") used to fail here with "Failed to parse arguments:
  // Expected ',' or '}' after property value" even though the call was
  // otherwise well-formed. The repair pass in parseToolCallArguments should
  // recover it and let the call reach the gateway.
  it('recovers a tool call whose arguments contain an unescaped inner quote', async () => {
    const ports = makePorts({
      executePreparedAgentTool: async (i: any) => ({ received: i.args }),
    });
    const raw = '{"title":"Phoenix FFL Merchants — "Creative Fatigue" Audit","content_draft":"<div class="header">Hi</div>"}';
    const input = makeInput([toolCall('a', 'read_brand_guidelines', raw)], ports);
    const result = await executePreparedTools(input);

    expect(input.toolCallsLedger[0].error).toBeUndefined();
    expect(input.toolCallsLedger[0].arguments).toEqual({
      title: 'Phoenix FFL Merchants — "Creative Fatigue" Audit',
      content_draft: '<div class="header">Hi</div>',
    });
    expect(result.failedCounterUpdates).toEqual({});
    expect((ports as any).__execOrder).toEqual(['read_brand_guidelines']);
  });

  // ENG-1477 follow-up: production evidence (AW-ChatMessages, session
  // 02ab5f5e...) showed the real prod failures were not unescaped quotes at
  // all — every one was a clean JSON prefix cut off mid-object, always
  // missing the required trailing field, never an unescaped quote anywhere.
  // That shape must be told "retry the same call", not ENG-124's default
  // "don't retry, fix your args" (there is nothing to fix).
  it('classifies a genuinely truncated tool call as retryable, not invalid_args', async () => {
    const ports = makePorts();
    // No unescaped quote anywhere — a clean prefix that stops dead with no
    // closing brace, matching the real production failure shape exactly.
    const raw = '{"title":"Phoenix FFL Merchants — 30-Day Report","format_requirements":"Dark theme"';
    const input = makeInput([toolCall('a', 'create_html_file', raw)], ports);
    const result = await executePreparedTools(input);

    expect(input.toolCallsLedger[0].error).toMatch(/Failed to parse arguments/);
    expect(input.messages[0].content).toContain('Retryable: yes');
    expect(input.messages[0].content).toContain('cut off');
    expect(result.failedCounterUpdates).toEqual({ create_html_file: 1 });
    expect((ports as any).__execOrder).toEqual([]);
  });

  it('sets skillsUpdated when install_skills is called', async () => {
    const ports = makePorts();
    const input = makeInput([toolCall('a', 'install_skills', '{}')], ports);
    const result = await executePreparedTools(input);
    expect(result.skillsUpdated).toBe(true);
  });

  it('emits the CRM socket event for a successful mutating tool when a payload is built', async () => {
    const emit = jest.fn();
    const ports = makePorts({
      buildCrmDataChangedPayload: (name: string) => (name === 'update_lead' ? { changed: true } : null),
      socketEmit: emit,
    });
    const input = makeInput([toolCall('a', 'update_lead', '{}')], ports);
    await executePreparedTools(input);
    expect(emit).toHaveBeenCalledWith('user:user-1', 'crm:data-changed', { changed: true });
  });

  // ENG-243: an overlong send-invite note must NOT be pre-blocked here. The send
  // path (sendInvitation) auto-trims to the account-tier limit, so the call should
  // reach the gateway and succeed instead of failing repeatedly and tripping the
  // anti-loop breaker (which sent 0 invites in a real scheduled session).
  it('lets an overlong LinkedIn send-invite note reach the gateway (tier-aware send path trims it)', async () => {
    const executeAgentToolThroughGatewaySpy = jest.fn(executeAgentToolThroughGateway);
    const ports = makePorts({
      evaluateAgentToolPolicy,
      validateAndRepairToolArgs,
      getToolInputSchema: () => ({
        type: 'object',
        properties: {
          action: { type: 'string' },
          profile_url: { type: 'string' },
          provider_id: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['action'],
      }),
      executeAgentToolThroughGateway: executeAgentToolThroughGatewaySpy,
    });
    const input = makeInput(
      [
        toolCall('li-1', 'linkedin_outreach', JSON.stringify({
          action: 'send-invite',
          profile_url: 'https://www.linkedin.com/in/example-person/',
          message: 'x'.repeat(201),
        })),
      ],
      ports,
    );

    const result = await executePreparedTools(input);

    expect(executeAgentToolThroughGatewaySpy).toHaveBeenCalledTimes(1);
    expect(input.toolCallsLedger[0]).toMatchObject({ name: 'linkedin_outreach' });
    expect(input.toolCallsLedger[0].error).toBeFalsy();
    expect(input.messages[0].content).not.toContain('200 characters or fewer');
    expect(result.failedCounterUpdates).toEqual({});
    expect(result.pendingCounterUpdates).toEqual({ linkedin_outreach: 1 });
  });

  it('blocks the third actual generate_image call shape after two failed attempts in the same session', async () => {
    const executePreparedAgentTool = jest.fn(async () => {
      throw new Error('Google image generation timed out after 10 minutes');
    });
    const ports = makePorts({
      evaluateAgentToolPolicy,
      validateAndRepairToolArgs,
      getToolInputSchema: () => ({
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          style: { type: 'string' },
        },
        required: ['prompt'],
      }),
      executeAgentToolThroughGateway,
      executePreparedAgentTool,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const input = makeInput(
        [
          toolCall(`img-${attempt}`, 'generate_image', JSON.stringify({
            prompt: `Create a paid social ad image, attempt ${attempt}`,
            style: 'photorealistic',
          })),
        ],
        ports,
        { agentRuntimeRunId: 'run-image-retry-storm' },
      );
      await executePreparedTools(input);

      if (attempt < 3) {
        expect(input.toolCallsLedger[0].error).toContain('Google image generation timed out');
      } else {
        expect(input.toolCallsLedger[0].error).toContain('retry budget of 2');
        expect(input.messages[0].content).toContain('Do not call it again in this session');
      }
    }

    expect(executePreparedAgentTool).toHaveBeenCalledTimes(2);
  });

  describe('media-generation time budget', () => {
    // A gateway fake that resolves to success with a unique asset result; records
    // which tools it actually executed so we can prove deferral skips the leaf call.
    function mediaPorts() {
      const executed: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          executed.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async (i: any) => ({ success: true, imageUrl: `https://s3/${i.toolName}.png` }),
      });
      return { ports, executed };
    }

    it('does NOT defer when no deadline is supplied (prior behavior preserved)', async () => {
      const { ports, executed } = mediaPorts();
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"1"}'),
          toolCall('b', 'generate_image', '{"prompt":"2"}'),
        ],
        ports,
        { mediaGenerationDeadlineMs: undefined, mediaAssetsProducedThisRun: 5 },
      );
      const result = await executePreparedTools(input);

      expect(executed).toEqual(['generate_image', 'generate_image']);
      expect(result.mediaBudgetDeferred).toBe(false);
      expect(result.mediaAssetsProduced).toBe(2);
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 2 });
    });

    it('defers a media-gen call once the deadline has passed and ≥1 asset already exists this run', async () => {
      const { ports, executed } = mediaPorts();
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 1 },
      );
      const result = await executePreparedTools(input);

      // The leaf tool was never executed.
      expect(executed).toEqual([]);
      expect(result.mediaBudgetDeferred).toBe(true);
      expect(result.mediaAssetsProduced).toBe(0);
      // Deferral is neither a success (no pending counter — work-plan gate untouched)
      // nor a failure (no failed counter — gateway breaker untouched).
      expect(result.pendingCounterUpdates).toEqual({});
      expect(result.failedCounterUpdates).toEqual({});
      // A tool-role message MUST still exist for the orphaned tool_call_id.
      expect(input.messages).toHaveLength(1);
      expect(input.messages[0]).toMatchObject({ tool_call_id: 'a', role: 'tool', name: 'generate_image' });
      expect(input.messages[0].content).toMatch(/paused|continue/i);
      expect(input.toolCallsLedger[0].result).toEqual({ deferred: true, reason: 'media_generation_time_budget' });
    });

    it('still makes forward progress (one batch) when over budget but nothing generated yet', async () => {
      const { ports, executed } = mediaPorts();
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"1"}'),
          toolCall('b', 'generate_image', '{"prompt":"2"}'),
          toolCall('c', 'generate_image', '{"prompt":"3"}'),
          toolCall('d', 'generate_image', '{"prompt":"4"}'),
        ],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 0 },
      );
      const result = await executePreparedTools(input);

      // The first batch (bounded concurrency) runs as forward progress — a batch of 3
      // concurrent images takes ~one image's wall-clock, so it is as cap-safe as the old
      // single-image forward progress while delivering more. The 4th (next batch) defers.
      expect(executed).toEqual(['generate_image', 'generate_image', 'generate_image']);
      expect(result.mediaAssetsProduced).toBe(3);
      expect(result.mediaBudgetDeferred).toBe(true);
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 3 });
      expect(input.messages.map((m: any) => m.content)).toEqual([
        expect.stringContaining('https://s3/generate_image.png'),
        expect.stringContaining('https://s3/generate_image.png'),
        expect.stringContaining('https://s3/generate_image.png'),
        expect.stringMatching(/paused|continue/i),
      ]);
    });

    it('does NOT defer non-media tools even when over budget', async () => {
      const { ports, executed } = mediaPorts();
      const input = makeInput(
        [
          toolCall('a', 'read_brand_guidelines', '{}'),
          toolCall('b', 'generate_image', '{"prompt":"x"}'),
        ],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 3 },
      );
      await executePreparedTools(input);

      // The read tool runs; only the media-gen call defers.
      expect(executed).toEqual(['read_brand_guidelines']);
    });

    it('forwards a deferred call to telemetry as a deferred result (ENG-103)', async () => {
      const { ports } = mediaPorts();
      const recordToolTelemetry = jest.fn();
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        { ...ports, recordToolTelemetry },
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 2 },
      );
      await executePreparedTools(input);

      // The deferred result is now PASSED to telemetry (no longer filtered out),
      // tagged status:'deferred' so the recorder routes it to toolDeferred — not
      // success/failure.
      expect(recordToolTelemetry).toHaveBeenCalledTimes(1);
      const forwarded = recordToolTelemetry.mock.calls[0][0];
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({ status: 'deferred', toolCall: expect.objectContaining({ id: 'a' }) });
    });

    // CodeRabbit (PR #2479): the persisted tool-role message's `mediaBudgetDeferred: true`
    // was set unconditionally for EVERY deferral, including a handler-supplied one (ENG-822's
    // anonymous-account-scoped refusal) that carries its own unrelated reason. Durability
    // checks (hasPersistedMediaBudgetDeferral, hasUnresolvedMediaDeferral) key off exactly
    // this flag to decide "should I auto-resume this" — so an ENG-822 refusal (a deliberate,
    // permanent policy block, never meant to be retried) would have been indistinguishable
    // from a genuine time-budget pause and incorrectly auto-retried.
    it('does NOT tag the persisted marker mediaBudgetDeferred for a handler-supplied (non-time-budget) deferral', async () => {
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => ({
          status: 'success',
          result: { deferred: true, reason: 'anonymous_account_scoped', message: 'Sign in to use this feature.' },
          durationMs: 1,
          policyDecision: i.policyDecision,
        }),
      });
      const input = makeInput([toolCall('a', 'generate_image', '{"prompt":"x"}')], ports, {});
      await executePreparedTools(input);

      expect(input.toolCallsLedger[0].result).toEqual({
        deferred: true,
        reason: 'anonymous_account_scoped',
        message: 'Sign in to use this feature.',
      });
      expect(input.messages[0]).toMatchObject({ tool_call_id: 'a', role: 'tool', content: 'Sign in to use this feature.' });
      expect(input.messages[0].metadata?.mediaBudgetDeferred).not.toBe(true);
    });

    it('a deferred call that did not run does not count as a produced asset', async () => {
      // Over budget with an asset already produced: a soft {success:false} would never
      // be reached because we defer BEFORE executing. Proves deferral short-circuits.
      const { ports } = mediaPorts();
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 2 },
      );
      const result = await executePreparedTools(input);
      expect(result.mediaAssetsProduced).toBe(0);
      expect(result.mediaBudgetDeferred).toBe(true);
    });
  });

  // ENG-1331: a Playwright-rendered asset loop (e.g. a display-ad size matrix) hits the
  // exact same "one batch exceeds the run's wall clock" failure MEDIA_GEN_TOOLS already
  // defers for — production evidence: a 12-size render silently stopped at 4 with no
  // deferral marker and no auto-resume. playwright_browser_take_screenshot now shares the
  // same deferral mechanism via DEFERRABLE_ASSET_TOOLS.
  describe('playwright screenshot deferral (ENG-1331)', () => {
    function screenshotPorts() {
      const executed: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          executed.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async (i: any) => ({ success: true, screenshotUrl: `https://s3/${i.toolName}.png` }),
      });
      return { ports, executed };
    }

    it('defers a screenshot call once the deadline has passed and ≥1 asset already exists this run', async () => {
      const { ports, executed } = screenshotPorts();
      const input = makeInput(
        [toolCall('a', 'playwright_browser_take_screenshot', '{"size":"300x250"}')],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 1 },
      );
      const result = await executePreparedTools(input);

      expect(executed).toEqual([]);
      expect(result.mediaBudgetDeferred).toBe(true);
      expect(result.mediaAssetsProduced).toBe(0);
      expect(result.pendingCounterUpdates).toEqual({});
      expect(input.messages[0]).toMatchObject({ tool_call_id: 'a', role: 'tool', name: 'playwright_browser_take_screenshot' });
      expect(input.toolCallsLedger[0].result).toEqual({ deferred: true, reason: 'media_generation_time_budget' });
    });

    it('does NOT defer when no deadline is supplied (prior behavior preserved)', async () => {
      const { ports, executed } = screenshotPorts();
      const input = makeInput(
        [toolCall('a', 'playwright_browser_take_screenshot', '{"size":"300x250"}')],
        ports,
        { mediaGenerationDeadlineMs: undefined, mediaAssetsProducedThisRun: 5 },
      );
      const result = await executePreparedTools(input);

      expect(executed).toEqual(['playwright_browser_take_screenshot']);
      expect(result.mediaBudgetDeferred).toBe(false);
      expect(result.mediaAssetsProduced).toBe(1);
    });

    it('counts a successful screenshot toward mediaAssetsProduced (the ≥1-asset deferral gate)', async () => {
      const { ports, executed } = screenshotPorts();
      const input = makeInput(
        [
          toolCall('a', 'playwright_browser_take_screenshot', '{"size":"300x250"}'),
          toolCall('b', 'playwright_browser_take_screenshot', '{"size":"728x90"}'),
        ],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 0 },
      );
      const result = await executePreparedTools(input);

      // First call makes forward progress (no asset produced yet this run); once it
      // succeeds the second is deferred the same turn.
      expect(executed).toEqual(['playwright_browser_take_screenshot']);
      expect(result.mediaAssetsProduced).toBe(1);
      expect(result.mediaBudgetDeferred).toBe(true);
    });
  });

  // ENG-2132: openrouter/deepseek/deepseek-v4-flash has no verified vision support
  // (no `supportsVision` entry in LLM_MODEL_REGISTRY). The prior gate only checked
  // "isn't Gemini" and assumed every other model could take an inline image — for
  // this model OpenRouter has no endpoint that accepts image input at all, so the
  // next LLM call 404'd with "No endpoints found that support image input" (prod
  // session ffe0e1ad-16f4-4ca6-ada2-3bc87c3d3761). Pins that the inline-image
  // branch requires a verified `supportsVision: true`, not just "not Gemini".
  describe('screenshot inline-image gating by model vision support (ENG-2132)', () => {
    function screenshotWithImagePorts() {
      return makePorts({
        executePreparedAgentTool: async () => ({
          raw: { content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }] },
        }),
        uploadScreenshotToS3: async () => ({ url: 'https://s3/shot.png' }),
      });
    }

    it('does NOT embed the image for a model with no verified vision support', async () => {
      const ports = screenshotWithImagePorts();
      const input = makeInput(
        [toolCall('a', 'playwright_browser_take_screenshot', '{}')],
        ports,
        { llmModel: 'openrouter/deepseek/deepseek-v4-flash' },
      );
      await executePreparedTools(input);

      const content = input.messages[0].content;
      expect(typeof content).toBe('string');
      expect(content).toContain('https://s3/shot.png');
      expect(JSON.stringify(content)).not.toContain('image_url');
    });

    it('still embeds the image for a non-Gemini model with verified vision support', async () => {
      const ports = screenshotWithImagePorts();
      const input = makeInput(
        [toolCall('a', 'playwright_browser_take_screenshot', '{}')],
        ports,
        { llmModel: 'gpt-5.4' },
      );
      await executePreparedTools(input);

      const content = input.messages[0].content as Array<{ type: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content.some((part) => part.type === 'image_url')).toBe(true);
    });

    it('still uses the text+URL fallback for Gemini (unrelated, pre-existing reason)', async () => {
      const ports = screenshotWithImagePorts();
      const input = makeInput(
        [toolCall('a', 'playwright_browser_take_screenshot', '{}')],
        ports,
        { llmModel: 'gemini-3.8-flash' },
      );
      await executePreparedTools(input);

      const content = input.messages[0].content;
      expect(typeof content).toBe('string');
      expect(content).toContain('https://s3/shot.png');
    });
  });

  describe('adaptive hard-cap deferral (ENG-510)', () => {
    // Gateway fake whose media-gen calls report a configurable wall-clock duration,
    // so we can prove the deferral reserves enough time for one more call below the
    // whole-turn hard cap (which a fixed soft-budget deadline cannot when a single
    // image is slow enough to nearly consume the whole budget).
    function mediaPortsWithDuration(durationMs: number) {
      const executed: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          executed.push(i.toolName);
          const result = await i.execute();
          const isMedia = i.toolName === 'generate_image' || i.toolName === 'generate_video';
          return { status: 'success', result, durationMs: isMedia ? durationMs : 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async (i: any) => ({ success: true, imageUrl: `https://s3/${i.toolName}.png` }),
      });
      return { ports, executed };
    }

    it('defers the next media call when within one media-call duration of the hard cap, even before the soft deadline', async () => {
      const { ports, executed } = mediaPortsWithDuration(5000);
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        ports,
        {
          // Soft budget NOT exceeded — the old fixed-deadline check alone would run it.
          mediaGenerationDeadlineMs: Date.now() + 60_000,
          mediaAssetsProducedThisRun: 1,
          // Only ~100ms left before the whole-turn hard cap, but a media call takes ~5s.
          generationHardCapMs: Date.now() + 100,
          longestMediaCallMsThisRun: 5000,
        } as any,
      );
      const result = await executePreparedTools(input);

      expect(executed).toEqual([]);
      expect(result.mediaBudgetDeferred).toBe(true);
      expect(result.mediaAssetsProduced).toBe(0);
      expect(input.toolCallsLedger[0].result).toEqual({ deferred: true, reason: 'media_generation_time_budget' });
    });

    it('does NOT defer when there is ample time before the hard cap', async () => {
      const { ports, executed } = mediaPortsWithDuration(5000);
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        ports,
        {
          mediaGenerationDeadlineMs: Date.now() + 60_000,
          mediaAssetsProducedThisRun: 1,
          generationHardCapMs: Date.now() + 600_000, // plenty of headroom for another call
          longestMediaCallMsThisRun: 5000,
        } as any,
      );
      const result = await executePreparedTools(input);

      expect(executed).toEqual(['generate_image']);
      expect(result.mediaBudgetDeferred).toBe(false);
      expect(result.mediaAssetsProduced).toBe(1);
    });

    it('defers a solo per-iteration media call when the run-wide longest duration will not fit before the hard cap', async () => {
      // The real prod failure mode: variants emitted ONE PER ITERATION. Iteration 2's solo
      // generate_image must be deferred because iteration 1's image (threaded in via
      // longestMediaCallMsThisRun) was slow and there is < one image of time left.
      const { ports, executed } = mediaPortsWithDuration(5000);
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        ports,
        {
          mediaGenerationDeadlineMs: Date.now() + 60_000, // soft budget NOT exceeded
          mediaAssetsProducedThisRun: 1,                  // a prior iteration already produced one
          generationHardCapMs: Date.now() + 3000,         // < the longest observed media call
          longestMediaCallMsThisRun: 5000,                // prior iteration's image took ~5s
        } as any,
      );
      const result = await executePreparedTools(input);

      expect(executed).toEqual([]);
      expect(result.mediaBudgetDeferred).toBe(true);
      expect(result.mediaAssetsProduced).toBe(0);
    });

    it('reports the longest media-call duration this iteration, carrying the prior-run floor', async () => {
      const { ports } = mediaPortsWithDuration(5000);
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        ports,
        {
          generationHardCapMs: Date.now() + 600_000,
          longestMediaCallMsThisRun: 8000, // a slower earlier call this run
        } as any,
      );
      const result = await executePreparedTools(input);
      // Max of this batch's 5s call and the 8s prior-run floor.
      expect(result.longestMediaCallMs).toBe(8000);
    });

    it('is inert when no hard cap is supplied (budget disabled / unit tests)', async () => {
      const { ports, executed } = mediaPortsWithDuration(5000);
      const input = makeInput(
        [toolCall('a', 'generate_image', '{"prompt":"x"}')],
        ports,
        {
          mediaGenerationDeadlineMs: undefined,
          generationHardCapMs: undefined,
          longestMediaCallMsThisRun: 5000,
          mediaAssetsProducedThisRun: 3,
        } as any,
      );
      const result = await executePreparedTools(input);
      expect(executed).toEqual(['generate_image']);
      expect(result.mediaBudgetDeferred).toBe(false);
    });
  });

  describe('bounded-concurrency media batches (ENG-510)', () => {
    // Gateway that tracks how many tool executions overlap in flight, so we can prove
    // batched media-gen runs concurrently but capped — not strictly serial, not unbounded.
    function concurrencyPorts() {
      let inFlight = 0;
      let maxInFlight = 0;
      const executed: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setImmediate(r)); // yield so batch siblings start before we finish
          const result = await i.execute();
          executed.push(i.toolName);
          inFlight--;
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async (i: any) => ({ success: true, imageUrl: `https://s3/${i.toolName}.png` }),
      });
      return { ports, executed, maxInFlight: () => maxInFlight };
    }

    it('runs several batched image variants concurrently, capped at 3 in flight', async () => {
      const { ports, executed, maxInFlight } = concurrencyPorts();
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"1"}'),
          toolCall('b', 'generate_image', '{"prompt":"2"}'),
          toolCall('c', 'generate_image', '{"prompt":"3"}'),
          toolCall('d', 'generate_image', '{"prompt":"4"}'),
        ],
        ports,
      );
      const result = await executePreparedTools(input);

      expect(executed).toHaveLength(4);
      expect(maxInFlight()).toBe(3); // concurrent, but bounded to 3
      expect(result.mediaAssetsProduced).toBe(4);
      // Results preserve emission order regardless of completion order.
      expect(input.toolCallsLedger.map((t: any) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('stays strictly sequential when wait_seconds is present', async () => {
      const { ports, maxInFlight } = concurrencyPorts();
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"1"}'),
          toolCall('w', 'wait_seconds', '{"seconds":0}'),
          toolCall('b', 'generate_image', '{"prompt":"2"}'),
        ],
        ports,
      );
      await executePreparedTools(input);
      expect(maxInFlight()).toBe(1);
    });

    it('delivers the succeeding variants when one in the batch fails (partial success under rate limits)', async () => {
      // The bounded concurrency raises the chance of a provider 429; the image service
      // already retries 429/503 with backoff, but if one variant still exhausts its
      // retries the batch must NOT be all-or-nothing — the others still deliver and the
      // failure is reported so the user can retry just that one (same as a deferral).
      const executed: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          executed.push(i.toolName);
          if (i.args && i.args.prompt === '2') {
            return { status: 'error', error: new Error('429 Too Many Requests — rate limit exceeded'), durationMs: 1, policyDecision: i.policyDecision };
          }
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async (i: any) => ({ success: true, imageUrl: `https://s3/${i.toolName}.png` }),
      });
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"1"}'),
          toolCall('b', 'generate_image', '{"prompt":"2"}'), // exhausts retries → fails
          toolCall('c', 'generate_image', '{"prompt":"3"}'),
        ],
        ports,
      );
      const result = await executePreparedTools(input);

      // Two variants delivered, one failed — not all-or-nothing.
      expect(result.mediaAssetsProduced).toBe(2);
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 2 });
      expect(result.failedCounterUpdates).toEqual({ generate_image: 1 });
      // Emission order preserved; the failing variant carries the (retryable) error.
      expect(input.toolCallsLedger.map((t: any) => t.id)).toEqual(['a', 'b', 'c']);
      expect(input.toolCallsLedger[1].error).toBeTruthy();
    });

    it('defers the next BATCH as a unit once over budget with an asset produced', async () => {
      const { ports, executed } = concurrencyPorts();
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"1"}'),
          toolCall('b', 'generate_image', '{"prompt":"2"}'),
          toolCall('c', 'generate_image', '{"prompt":"3"}'),
          toolCall('d', 'generate_image', '{"prompt":"4"}'),
          toolCall('e', 'generate_image', '{"prompt":"5"}'),
          toolCall('f', 'generate_image', '{"prompt":"6"}'),
        ],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 0 },
      );
      const result = await executePreparedTools(input);
      // First batch of 3 runs (forward progress); the second batch is deferred as a unit.
      expect(executed).toHaveLength(3);
      expect(result.mediaAssetsProduced).toBe(3);
      expect(result.mediaBudgetDeferred).toBe(true);
    });
  });

  describe('media deferral halts state-changing dependents (ENG-922)', () => {
    // Policy: Meta Graph calls are writes, lookups are reads, media-gen is a write.
    function graphPorts() {
      const executed: string[] = [];
      const ports = makePorts({
        evaluateAgentToolPolicy: (i: any) => ({
          allowed: true,
          effect: i.toolName === 'lookup_thing' ? 'read' : 'write',
          flags: [],
        }) as any,
        executeAgentToolThroughGateway: async (i) => {
          executed.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async (i: any) => ({ success: true, imageUrl: `https://s3/${i.toolName}.png` }),
      });
      return { ports, executed };
    }
    const img = (id: string) => toolCall(id, 'generate_image', `{"prompt":"${id}"}`);
    const graph = (id: string) => toolCall(id, 'call_meta_marketing_api', `{"path":"act_1/adimages","id":"${id}"}`);

    it('3 completed + 1 deferred image -> zero Graph writes after the deferral (same iteration)', async () => {
      const { ports, executed } = graphPorts();
      // Graph write emitted FIRST: must still not run before or after the deferred image.
      const input = makeInput(
        [graph('g'), img('a'), img('b'), img('c'), img('d')],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 0 },
      );
      const result = await executePreparedTools(input);
      expect(executed.filter((n) => n === 'generate_image')).toHaveLength(3);
      expect(executed).not.toContain('call_meta_marketing_api');
      expect(result.mediaAssetsProduced).toBe(3);
      expect(result.mediaBudgetDeferred).toBe(true);
      // Every tool_call_id is still answered, in emission order.
      expect(input.messages.map((m: any) => m.tool_call_id)).toEqual(['g', 'a', 'b', 'c', 'd']);
      expect(input.toolCallsLedger.find((t: any) => t.id === 'g').result).toMatchObject({ deferred: true });
    });

    it('still runs read-only calls after a deferral', async () => {
      const { ports, executed } = graphPorts();
      const input = makeInput(
        [img('a'), img('b'), img('c'), img('d'), toolCall('r', 'lookup_thing', '{}')],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 0 },
      );
      await executePreparedTools(input);
      expect(executed).toContain('lookup_thing');
    });

    it('defers a Graph write in a LATER iteration once media was deferred earlier this run', async () => {
      const { ports, executed } = graphPorts();
      const input = makeInput([graph('g')], ports, { priorMediaBudgetDeferred: true });
      const result = await executePreparedTools(input);
      expect(executed).toEqual([]);
      expect(input.messages.map((m: any) => m.tool_call_id)).toEqual(['g']);
      expect(result.pendingCounterUpdates).toEqual({});
      expect(result.failedCounterUpdates).toEqual({});
    });

    it('defers a Graph write on the sequential (wait_seconds) path after a deferral', async () => {
      const { ports, executed } = graphPorts();
      const input = makeInput(
        [toolCall('w', 'wait_seconds', '{"seconds":0}'), img('a'), graph('g')],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 1 },
      );
      await executePreparedTools(input);
      expect(executed).not.toContain('call_meta_marketing_api');
      expect(executed).not.toContain('generate_image');
    });

    it('normal 4-image + Graph batch under budget runs everything (unchanged path)', async () => {
      const { ports, executed } = graphPorts();
      const input = makeInput([img('a'), img('b'), img('c'), img('d'), graph('g')], ports);
      const result = await executePreparedTools(input);
      expect(executed.filter((n) => n === 'generate_image')).toHaveLength(4);
      expect(executed[executed.length - 1]).toBe('call_meta_marketing_api');
      expect(result.mediaBudgetDeferred).toBe(false);
      expect(result.mediaAssetsProduced).toBe(4);
    });
  });

  describe('same-turn duplicate dedupe (ENG-108)', () => {
    it('collapses two identical calls: executes once, answers BOTH tool_call_ids, no failure', async () => {
      const ports = makePorts();
      const input = makeInput(
        [
          toolCall('a', 'create_lead', '{"email":"x@y.com"}'),
          toolCall('b', 'create_lead', '{"email":"x@y.com"}'),
        ],
        ports,
      );
      const result = await executePreparedTools(input);

      // The tool executed exactly once.
      expect((ports as any).__execOrder).toEqual(['create_lead']);
      // Every emitted tool_call_id is answered, with the real result before the
      // duplicate's "use that result" note.
      expect(input.messages.map((m: any) => m.tool_call_id)).toEqual(['a', 'b']);
      expect(input.messages[0].content).toBe('{"success":true,"echo":"create_lead"}');
      expect(input.messages[1].content).toContain('was already handled by tool_call_id a');
      // The duplicate is neither a success counter nor a failed counter increment.
      expect(result.pendingCounterUpdates).toEqual({ create_lead: 1 });
      expect(result.failedCounterUpdates).toEqual({});
      // The duplicate ledger entry references the call that IS handled and has no error.
      const dupEntry = input.toolCallsLedger.find((t: any) => t.id === 'b');
      expect(dupEntry.duplicateOf).toBe('a');
      expect(dupEntry.error).toBeUndefined();
    });

    it('treats arg-order differences as the same call (stable key)', async () => {
      const ports = makePorts();
      const input = makeInput(
        [
          toolCall('a', 'create_lead', '{"a":1,"b":2}'),
          toolCall('b', 'create_lead', '{"b":2,"a":1}'),
        ],
        ports,
      );
      await executePreparedTools(input);
      expect((ports as any).__execOrder).toEqual(['create_lead']);
    });

    it('does NOT collapse distinct args — both execute, both ids answered', async () => {
      const ports = makePorts();
      const input = makeInput(
        [
          toolCall('a', 'create_lead', '{"email":"x@y.com"}'),
          toolCall('b', 'create_lead', '{"email":"z@y.com"}'),
        ],
        ports,
      );
      const result = await executePreparedTools(input);

      expect((ports as any).__execOrder).toEqual(['create_lead', 'create_lead']);
      expect(input.messages.map((m: any) => m.tool_call_id).sort()).toEqual(['a', 'b']);
      expect(result.pendingCounterUpdates).toEqual({ create_lead: 2 });
    });

    it('does NOT collapse identical calls for a non-dedupable tool (wait_seconds)', async () => {
      const ports = makePorts();
      const input = makeInput(
        [
          toolCall('a', 'wait_seconds', '{"seconds":1}'),
          toolCall('b', 'wait_seconds', '{"seconds":1}'),
        ],
        ports,
      );
      await executePreparedTools(input);
      // Both identical wait_seconds calls execute (exempt set honored).
      expect((ports as any).__execOrder).toEqual(['wait_seconds', 'wait_seconds']);
    });

    it('records suppression separately and keeps duplicates OUT of success/failure telemetry', async () => {
      const recordDuplicateSuppression = jest.fn();
      const recordToolTelemetry = jest.fn();
      const ports = makePorts({ recordDuplicateSuppression, recordToolTelemetry });
      const input = makeInput(
        [
          toolCall('a', 'create_lead', '{"email":"x@y.com"}'),
          toolCall('b', 'create_lead', '{"email":"x@y.com"}'),
        ],
        ports,
      );
      await executePreparedTools(input);

      // Suppression recorded once with the suppressed entry.
      expect(recordDuplicateSuppression).toHaveBeenCalledTimes(1);
      const suppressed = recordDuplicateSuppression.mock.calls[0][0];
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0]).toMatchObject({ duplicateOfId: 'a', toolCall: expect.objectContaining({ id: 'b' }) });

      // The suppressed duplicate must NOT appear in the success/failure telemetry.
      const telemetered = recordToolTelemetry.mock.calls[0][0];
      const telemeteredIds = telemetered.map((r: any) => r.toolCall?.id);
      expect(telemeteredIds).not.toContain('b');
      expect(telemeteredIds).toContain('a');
    });
  });

  // Counter-pollution fix (xCures incident, prod session 7c8ff5b2-…): a media-gen
  // tool can return success WITHOUT producing an asset — the generate_image
  // confirmation gate returns {success:true, awaitingUserConfirmation:true} to pause
  // before editing existing images. Those non-producing successes must NOT count
  // toward calledFunctions (the set_work_plan_status completion gate) or the
  // media-asset budget, or an image step can complete with 3 of 18 images while the
  // counter reads 76.
  describe('media-gen confirmation-gate successes do not pollute counters', () => {
    it('does NOT count a generate_image confirmation-gate pause toward calledFunctions', async () => {
      const ports = makePorts({
        executePreparedAgentTool: async () => ({
          success: true,
          awaitingUserConfirmation: true,
          requiresConfirmation: true,
          message: 'Image edit requires user confirmation',
        }),
      });
      const input = makeInput([toolCall('a', 'generate_image', '{"prompt":"edit","inputImages":["u"]}')], ports);
      const result = await executePreparedTools(input);

      // No asset produced, so no counter and no media-asset increment.
      expect(result.pendingCounterUpdates).toEqual({});
      expect(result.mediaAssetsProduced).toBe(0);
      // It is NOT an error either — no failed counter, and the tool-role message is appended.
      expect(result.failedCounterUpdates).toEqual({});
      expect(input.messages).toHaveLength(1);
      expect(input.messages[0]).toMatchObject({ tool_call_id: 'a', role: 'tool', name: 'generate_image' });
    });

    it('DOES count a generate_image success that produced an asset', async () => {
      const ports = makePorts({
        executePreparedAgentTool: async () => ({ success: true, imageUrl: 'https://s3/x.png', filename: 'x.png' }),
      });
      const input = makeInput([toolCall('a', 'generate_image', '{"prompt":"fresh"}')], ports);
      const result = await executePreparedTools(input);

      expect(result.pendingCounterUpdates).toEqual({ generate_image: 1 });
      expect(result.mediaAssetsProduced).toBe(1);
    });

    it('counts only the producing call when a batch mixes a real asset and a confirmation pause', async () => {
      const ports = makePorts({
        executePreparedAgentTool: async (i: any) =>
          i.functionArgs?.inputImages
            ? { success: true, awaitingUserConfirmation: true }
            : { success: true, imageUrl: 'https://s3/fresh.png', filename: 'fresh.png' },
      });
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"fresh"}'),
          toolCall('b', 'generate_image', '{"prompt":"edit","inputImages":["u"]}'),
        ],
        ports,
      );
      const result = await executePreparedTools(input);

      // Two generate_image calls, but only one produced an asset.
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 1 });
      expect(result.mediaAssetsProduced).toBe(1);
    });

    it('requires an edit call (inputImages set) to use one of the approved sources', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({
          prompt: 'edit', confirm: true, inputImages: ['https://assets.example.com/unapproved.png'],
        }))],
        ports,
        {
          approvedRevisionImageSources: ['https://assets.example.com/approved.png'],
        },
      );

      const result = await executePreparedTools(input);

      expect(execOrder).toEqual([]);
      expect(result.failedCounterUpdates).toEqual({ generate_image: 1 });
      expect(result.pendingCounterUpdates).toEqual({});
      expect(input.toolCallsLedger[0]).toMatchObject({
        name: 'generate_image',
        error: expect.stringContaining('source mismatch'),
      });
      expect(input.messages[0].content).toContain('source mismatch');
    });

    it('allows an edit call that uses exactly the approved source', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async () => ({ success: true, imageUrl: 'https://s3/edited.png', filename: 'edited.png' }),
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({
          prompt: 'edit', confirm: true, inputImages: ['https://assets.example.com/approved.png'],
        }))],
        ports,
        {
          approvedRevisionImageSources: ['https://assets.example.com/approved.png'],
        },
      );

      const result = await executePreparedTools(input);

      expect(execOrder).toEqual(['generate_image']);
      expect(result.failedCounterUpdates).toEqual({});
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 1 });
    });

    // Review fix: `logo_image` is a real edit source at execution time —
    // imageGeneration.ts's generateImage() appends it onto inputImages before
    // generating — but the gate previously only inspected inputImages/input_images.
    // A call with confirm:true, no inputImages, and an unapproved logo_image sailed
    // through as "not an edit" (getInputImages returned []) and bypassed source
    // validation entirely. Must be rejected the same way a mismatched inputImages
    // call is.
    it('rejects a logo_image that is not one of the approved sources, even with no inputImages set', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({
          prompt: 'add our logo', confirm: true, logo_image: 'https://assets.example.com/unapproved-logo.png',
        }))],
        ports,
        {
          approvedRevisionImageSources: ['https://assets.example.com/approved.png'],
        },
      );

      const result = await executePreparedTools(input);

      expect(execOrder).toEqual([]);
      expect(result.failedCounterUpdates).toEqual({ generate_image: 1 });
      expect(result.pendingCounterUpdates).toEqual({});
      expect(input.toolCallsLedger[0]).toMatchObject({
        name: 'generate_image',
        error: expect.stringContaining('source mismatch'),
      });
    });

    it('allows a logo_image that matches exactly the approved source', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async () => ({ success: true, imageUrl: 'https://s3/branded.png', filename: 'branded.png' }),
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({
          prompt: 'add our logo', confirm: true, logo_image: 'https://assets.example.com/approved.png',
        }))],
        ports,
        {
          approvedRevisionImageSources: ['https://assets.example.com/approved.png'],
        },
      );

      const result = await executePreparedTools(input);

      expect(execOrder).toEqual(['generate_image']);
      expect(result.failedCounterUpdates).toEqual({});
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 1 });
    });

    // ENG-2166: a real customer (Vincent Hu) hit this. An approved-source list is
    // fixed for the WHOLE run (e.g. revisionService.ts's Slack-driven "revise this
    // asset" flow sets one approved URL for the whole bounded runVerifiedChat call).
    // Once one confirmed edit against that URL succeeded, every LATER, UNRELATED
    // generate_image call in the same run — plain text-to-image, no inputImages at
    // all — started failing with "Expected one of: [the one approved URL]. Received
    // none.", permanently blocking all new generations for the rest of the session.
    // A call with no inputImages isn't an edit/revision at all, so the approved-
    // source gate must never apply to it, regardless of whether an approved-sources
    // list happens to be active for the run.
    it('never blocks a plain text-to-image call (no inputImages) even when an approved-sources list is active (ENG-2166)', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async () => ({ success: true, imageUrl: 'https://s3/fresh.png', filename: 'fresh.png' }),
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({ prompt: 'a brand new unrelated image' }))],
        ports,
        {
          approvedRevisionImageSources: ['https://assets.example.com/approved.png'],
        },
      );

      const result = await executePreparedTools(input);

      expect(execOrder).toEqual(['generate_image']);
      expect(result.failedCounterUpdates).toEqual({});
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 1 });
    });

    // Same case with confirm:true set but still no inputImages — confirm is only
    // meaningful for an edit; a plain generation must not be gated on it either.
    it('never blocks a plain text-to-image call with confirm=true but no inputImages (ENG-2166)', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
        executePreparedAgentTool: async () => ({ success: true, imageUrl: 'https://s3/fresh2.png', filename: 'fresh2.png' }),
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({ prompt: 'edit', confirm: true }))],
        ports,
        {
          approvedRevisionImageSources: ['https://assets.example.com/approved.png'],
        },
      );

      const result = await executePreparedTools(input);

      expect(execOrder).toEqual(['generate_image']);
      expect(result.failedCounterUpdates).toEqual({});
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 1 });
    });
  });

  // ── ENG-105: the REAL validateToolOutput port, end-to-end through dispatch ──────
  // The isolated toolOutputContract.test.ts proves the validator in a vacuum (with a
  // mirror extractor). This wires the ACTUAL production port — the real
  // validateToolOutputContract composed with the real extractToolContent — into
  // executePreparedTools, the same composition agentModeService does, and proves a
  // tool that returns WITHOUT throwing but yields no usable output is downgraded to a
  // structured failure (failed-counter incremented, telemetry errorClass
  // invalid_output via the real classifier) instead of a silent success.
  describe('ENG-105: real validateToolOutput port wiring', () => {
    /** makePorts + the production validateToolOutput composition, returning a tool result. */
    function portsWithRealValidator(
      toolReturns: unknown,
      recordToolTelemetry = jest.fn(),
    ) {
      return makePorts({
        // The real production wiring: validateToolOutputContract(result, extractToolContent).
        validateToolOutput: (result: any) => validateToolOutputContract(result, extractToolContent),
        // Real extractor on the content path so the wired composition is genuine.
        extractToolContent,
        executePreparedAgentTool: async () => toolReturns,
        recordToolTelemetry,
      });
    }

    // Every output that the contract must reject, with the value the tool "successfully" returns.
    const invalidCases: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['an empty string', ''],
      ["the literal string 'undefined'", 'undefined'],
      ['an empty content array', { content: [] }],
    ];

    it.each(invalidCases)(
      'downgrades a success that extracts to %s -> failure + errorClass invalid_output',
      async (_label, toolReturns) => {
        const recordToolTelemetry = jest.fn();
        const ports = portsWithRealValidator(toolReturns, recordToolTelemetry);
        const input = makeInput([toolCall('a', 'fetch_thing', '{}')], ports);

        const result = await executePreparedTools(input);

        // Downgraded to a failure: failed counter incremented, no pending counter.
        expect(result.failedCounterUpdates).toEqual({ fetch_thing: 1 });
        expect(result.pendingCounterUpdates).toEqual({});

        // The failure is the structured ToolOutputContractError, and the REAL classifier
        // tags it invalid_output (distinct from execution failures).
        const telemetered = recordToolTelemetry.mock.calls[0][0];
        const entry = telemetered.find((r: any) => r.toolCall?.id === 'a');
        expect(entry.status).toBe('error');
        expect(entry.error).toBeInstanceOf(ToolOutputContractError);
        expect(classifyToolErrorClass(entry.error)).toBe('invalid_output');

        // The model sees a structured tool error, not the garbage output.
        expect(input.toolCallsLedger[0].name).toBe('fetch_thing');
        expect(input.messages[0]).toMatchObject({ role: 'tool', name: 'fetch_thing' });
      },
    );

    it('passes a VALID string result through unchanged — success, no downgrade', async () => {
      const recordToolTelemetry = jest.fn();
      const ports = portsWithRealValidator('GTM Plan: step 1, step 2, step 3', recordToolTelemetry);
      const input = makeInput([toolCall('a', 'fetch_thing', '{}')], ports);

      const result = await executePreparedTools(input);

      expect(result.pendingCounterUpdates).toEqual({ fetch_thing: 1 });
      expect(result.failedCounterUpdates).toEqual({});
      const telemetered = recordToolTelemetry.mock.calls[0][0];
      const entry = telemetered.find((r: any) => r.toolCall?.id === 'a');
      expect(entry.status).toBe('success');
      expect(input.messages[0].content).toContain('GTM Plan: step 1');
    });

    it('passes an image-only content array through unchanged — non-text payload is NOT empty output', async () => {
      // The false-positive the reviewer flagged: an image-only success must survive.
      const recordToolTelemetry = jest.fn();
      const imageResult = {
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KG...' } }],
      };
      const ports = portsWithRealValidator(imageResult, recordToolTelemetry);
      const input = makeInput([toolCall('a', 'generate_diagram', '{}')], ports);

      const result = await executePreparedTools(input);

      expect(result.pendingCounterUpdates).toEqual({ generate_diagram: 1 });
      expect(result.failedCounterUpdates).toEqual({});
      const telemetered = recordToolTelemetry.mock.calls[0][0];
      const entry = telemetered.find((r: any) => r.toolCall?.id === 'a');
      expect(entry.status).toBe('success');
    });
  });
});

// ENG-510: cross-iteration media-gen dedupe. The ENG-108 dedupe is per-iteration, so a
// model that re-emits an identical generate_image in a LATER iteration of the same turn
// (e.g. resuming after a timeout) would regenerate the image. The dispatcher suppresses a
// media-gen call whose successful result is already recorded from an earlier iteration —
// scoped to media tools so repeated mutations still run, and only for successes so a failed
// call stays retryable.
describe('executePreparedTools — cross-iteration media dedupe (ENG-510)', () => {
  const imageGatewayPorts = () =>
    makePorts({
      executePreparedAgentTool: async (_i: any) => ({ success: true, imageUrl: 'https://s3/img.png' }),
    });

  it('records a produced media key, then suppresses the same generate_image next iteration', async () => {
    // Iteration 1: fresh run, one image call → executes and is recorded.
    const ports1 = imageGatewayPorts();
    const in1 = makeInput([toolCall('a', 'generate_image', '{"prompt":"sun"}')], ports1, {
      priorMediaCallKeys: new Map<string, string>(),
    });
    const r1 = await executePreparedTools(in1);
    expect((ports1 as any).__execOrder).toEqual(['generate_image']);
    expect(r1.producedMediaCallKeys.size).toBe(1);
    expect(r1.mediaAssetsProduced).toBe(1);

    // Iteration 2: the SAME call, with iteration 1's keys threaded in → suppressed.
    const ports2 = imageGatewayPorts();
    const in2 = makeInput([toolCall('b', 'generate_image', '{"prompt":"sun"}')], ports2, {
      priorMediaCallKeys: r1.producedMediaCallKeys,
    });
    const r2 = await executePreparedTools(in2);
    expect((ports2 as any).__execOrder).toEqual([]); // did NOT regenerate
    expect(r2.mediaAssetsProduced).toBe(0);
    expect(r2.pendingCounterUpdates.generate_image).toBeUndefined();
    // Still answers the tool_call_id so the next LLM turn has no orphan.
    const msg = in2.messages.find((m: any) => m.tool_call_id === 'b');
    expect(msg).toBeDefined();
    expect(msg.role).toBe('tool');
  });

  // ENG-1331: deliberately the OPPOSITE of generate_image's cross-iteration dedupe.
  // A dimension-based filename (e.g. "300x250.png") is inherently reused across
  // attempts, and this exact template's QA step ("Fix and re-render failures before
  // delivery") calls for re-taking a screenshot with that SAME filename after fixing
  // a problem — deduping it would silently keep the broken original with no error
  // surfaced. generate_image's dedupe protects against re-paying for an expensive,
  // rate-limited external call; a screenshot has the opposite risk profile (cheap,
  // local, and legitimately re-requested), so it must stay retryable even when an
  // identical-argument call already succeeded earlier this run.
  it('does NOT cross-iteration-dedupe a screenshot — a same-filename re-render must still run', async () => {
    const screenshotPorts = () =>
      makePorts({
        executePreparedAgentTool: async (_i: any) => ({ success: true, screenshotUrl: 'https://s3/300x250.png' }),
      });

    const ports1 = screenshotPorts();
    const in1 = makeInput(
      [toolCall('a', 'playwright_browser_take_screenshot', '{"filename":"300x250.png"}')],
      ports1,
      { priorMediaCallKeys: new Map<string, string>() },
    );
    const r1 = await executePreparedTools(in1);
    expect((ports1 as any).__execOrder).toEqual(['playwright_browser_take_screenshot']);
    // producedMediaCallKeys IS populated for a screenshot too (countsAsAsset uses the
    // broader DEFERRABLE_ASSET_TOOLS, kept for the deferral/duration bookkeeping this
    // key-recording is bundled with) — the protection isn't that the key is absent,
    // it's that the SUPPRESSION check below never consults it for this tool name.
    expect(r1.producedMediaCallKeys.size).toBe(1);

    const ports2 = screenshotPorts();
    const in2 = makeInput(
      [toolCall('b', 'playwright_browser_take_screenshot', '{"filename":"300x250.png"}')],
      ports2,
      // Simulate a key that WOULD suppress a generate_image call, to prove
      // screenshot ignores priorMediaCallKeys entirely rather than merely never
      // populating it.
      { priorMediaCallKeys: new Map([[`playwright_browser_take_screenshot:${stableStringify({ filename: '300x250.png' })}`, 'a']]) },
    );
    const r2 = await executePreparedTools(in2);
    expect((ports2 as any).__execOrder).toEqual(['playwright_browser_take_screenshot']); // re-ran, not suppressed
    expect(r2.mediaAssetsProduced).toBe(1);
  });

  it('does NOT suppress a distinct variant (different args) from a prior iteration', async () => {
    const prior = new Map<string, string>([[`generate_image:${stableStringify({ prompt: 'sun' })}`, 'a']]);
    const ports = imageGatewayPorts();
    const input = makeInput([toolCall('b', 'generate_image', '{"prompt":"moon"}')], ports, {
      priorMediaCallKeys: prior,
    });
    const result = await executePreparedTools(input);
    expect((ports as any).__execOrder).toEqual(['generate_image']); // moon still generated
    expect(result.mediaAssetsProduced).toBe(1);
  });

  it('does NOT suppress a repeated non-media (mutating) call across iterations', async () => {
    // Even if a non-media key were present, the media-only guard leaves it alone, so a
    // legitimately-repeated send_email still runs.
    const prior = new Map<string, string>([[`send_email:${stableStringify({ to: 'x' })}`, 'a']]);
    const ports = makePorts();
    const input = makeInput([toolCall('b', 'send_email', '{"to":"x"}')], ports, {
      priorMediaCallKeys: prior,
    });
    await executePreparedTools(input);
    expect((ports as any).__execOrder).toEqual(['send_email']); // repeated mutation runs
  });

  it('does NOT record a FAILED generation, so it stays retryable next iteration', async () => {
    const ports = makePorts({
      executePreparedAgentTool: async (_i: any) => {
        throw new Error('provider timeout');
      },
    });
    const input = makeInput([toolCall('a', 'generate_image', '{"prompt":"sun"}')], ports, {
      priorMediaCallKeys: new Map<string, string>(),
    });
    const result = await executePreparedTools(input);
    expect(result.producedMediaCallKeys.size).toBe(0); // failure not recorded → retryable
  });
});

describe('seedMediaCallKeysFromHistory (ENG-1239)', () => {
  // The in-run dedupe map above (priorMediaCallKeys) only ever starts non-empty when the
  // CALLER threads a prior iteration's keys into it — it always starts empty at the top of
  // a fresh turn (agentModeService.ts: `new Map()`), so a media auto-continuation (a brand
  // new turn) got NO code-level dedupe protection against the model re-emitting an
  // already-done generate_image call — only the LLM-prompt "already generated" awareness
  // block, which the model can ignore. This reconstructs the SAME key shape
  // (`name:stableStringify(args)`) from persisted history so a continuation turn seeds the
  // dispatcher's dedupe map with what already actually happened, hardening it beyond the
  // prompt-only guard.
  const successMsg = (name: string, args: string, iso: string) => ({
    role: 'assistant',
    timestamp: iso,
    metadata: { toolCalls: [{ id: 'x', name, arguments: JSON.parse(args), result: { success: true, imageUrl: 'https://s3/img.png' } }] },
  });

  it('returns an empty map for non-array input', () => {
    expect(seedMediaCallKeysFromHistory(undefined, 0).size).toBe(0);
    expect(seedMediaCallKeysFromHistory(null, 0).size).toBe(0);
  });

  it('seeds a key for a successful generate_image call at/after sinceMs', () => {
    const sinceMs = Date.parse('2026-08-14T18:00:00Z');
    const msgs = [successMsg('generate_image', '{"prompt":"sun"}', '2026-08-14T18:20:51.906Z')];
    const seeded = seedMediaCallKeysFromHistory(msgs, sinceMs);
    expect(seeded.get(`generate_image:${stableStringify({ prompt: 'sun' })}`)).toBe('x');
  });

  it('ignores a call from BEFORE sinceMs (an unrelated, much earlier session/turn)', () => {
    const sinceMs = Date.parse('2026-08-14T18:00:00Z');
    const msgs = [successMsg('generate_image', '{"prompt":"sun"}', '2026-08-01T00:00:00Z')];
    expect(seedMediaCallKeysFromHistory(msgs, sinceMs).size).toBe(0);
  });

  // CodeRabbit (PR #2479): the boundary comparison is `ts >= sinceMs` (inclusive) — pin
  // the exact-equal case explicitly, not just a call safely after the bound.
  it('seeds a call whose timestamp is exactly sinceMs (inclusive boundary)', () => {
    const sinceMs = Date.parse('2026-08-14T18:00:00Z');
    const msgs = [successMsg('generate_image', '{"prompt":"sun"}', new Date(sinceMs).toISOString())];
    const seeded = seedMediaCallKeysFromHistory(msgs, sinceMs);
    expect(seeded.get(`generate_image:${stableStringify({ prompt: 'sun' })}`)).toBe('x');
  });

  it('does NOT seed a deferred call (nothing was actually produced)', () => {
    const msgs = [{
      role: 'assistant',
      timestamp: '2026-08-14T18:20:51.906Z',
      metadata: { toolCalls: [{ id: 'x', name: 'generate_image', arguments: { prompt: 'sun' }, result: { deferred: true, reason: 'media_generation_time_budget' } }] },
    }];
    expect(seedMediaCallKeysFromHistory(msgs, 0).size).toBe(0);
  });

  it('does NOT seed a FAILED call (it must stay retryable, not be treated as a duplicate)', () => {
    const msgs = [{
      role: 'assistant',
      timestamp: '2026-08-14T18:20:51.906Z',
      metadata: { toolCalls: [{ id: 'x', name: 'generate_image', arguments: { prompt: 'sun' }, error: 'provider timeout' }] },
    }];
    expect(seedMediaCallKeysFromHistory(msgs, 0).size).toBe(0);
  });

  it('does NOT seed a confirmation-gate pause (awaitingUserConfirmation, no asset produced)', () => {
    const msgs = [{
      role: 'assistant',
      timestamp: '2026-08-14T18:20:51.906Z',
      metadata: { toolCalls: [{ id: 'x', name: 'generate_image', arguments: { prompt: 'sun' }, result: { success: true, awaitingUserConfirmation: true } }] },
    }];
    expect(seedMediaCallKeysFromHistory(msgs, 0).size).toBe(0);
  });

  it('ignores a non-media tool call entirely (e.g. send_email)', () => {
    const msgs = [{
      role: 'assistant',
      timestamp: '2026-08-14T18:20:51.906Z',
      metadata: { toolCalls: [{ id: 'x', name: 'send_email', arguments: { to: 'a@b.com' }, result: { success: true } }] },
    }];
    expect(seedMediaCallKeysFromHistory(msgs, 0).size).toBe(0);
  });

  it('ignores malformed entries and non-assistant messages', () => {
    const msgs = [
      null,
      undefined,
      { role: 'user', content: 'hi' },
      { role: 'assistant', metadata: {} },
      { role: 'assistant', metadata: { toolCalls: [null, {}] } },
    ];
    expect(seedMediaCallKeysFromHistory(msgs as any, 0).size).toBe(0);
  });

  // ENG-1331: deliberately does NOT seed a key for a screenshot, unlike
  // generate_image. This reconstruction feeds the cross-iteration dedupe a
  // screenshot must stay exempt from (see toolDispatch.ts's dedupe-check comment) —
  // a dimension-based filename is legitimately reused when the QA step re-renders a
  // corrected size, and seeding it here would make that re-render look like an
  // already-done duplicate on the very next continuation turn.
  it('does NOT seed a key for a successful playwright_browser_take_screenshot call', () => {
    const msgs = [{
      role: 'assistant',
      timestamp: '2026-08-18T09:12:37.587Z',
      metadata: {
        toolCalls: [{
          id: 'x',
          name: 'playwright_browser_take_screenshot',
          arguments: { filename: 'AgentWeb-300x250-MediumRectangle.png' },
          result: { success: true, screenshotUrl: 'https://s3/300x250.png' },
        }],
      },
    }];
    expect(seedMediaCallKeysFromHistory(msgs, 0).size).toBe(0);
  });
});

// ENG-426: prod incident — a research turn made 193 web-search calls (73 file reads, 503
// retained messages, 17.4M prompt tokens, $8.68) before an outer time limit ended it. The
// loop's exact-match anti-loop signature check never caught it because each search varied
// its query text. This is a session-wide volume cap on WEB_SEARCH_TOOL_NAMES, mirroring
// Claude Code's own fix for the identical failure mode (default-200-per-session WebSearch
// cap) — every prior call counts regardless of arguments, so rephrasing can't outrun it.
describe('search-call session budget (ENG-426)', () => {
  const searchPorts = () =>
    makePorts({
      executePreparedAgentTool: async (_i: any) => ({ success: true, results: [] }),
    });

  it('allows a search call under the cap and counts it in searchCallsThisIteration', async () => {
    const ports = searchPorts();
    const input = makeInput([toolCall('a', 'you_search_web', '{"query":"AI readiness"}')], ports, {
      priorSearchCallCount: 0,
    });
    const result = await executePreparedTools(input);
    expect((ports as any).__execOrder).toEqual(['you_search_web']);
    expect(result.searchCallsThisIteration).toBe(1);
    expect(result.failedCounterUpdates).toEqual({});
  });

  it('rejects a search call once the prior count already meets the cap — does NOT execute it', async () => {
    const ports = searchPorts();
    const input = makeInput([toolCall('a', 'you_search_web', '{"query":"one more angle"}')], ports, {
      priorSearchCallCount: SEARCH_CALL_SESSION_CAP,
    });
    const result = await executePreparedTools(input);

    expect((ports as any).__execOrder).toEqual([]); // never dispatched to the gateway
    expect(result.searchCallsThisIteration).toBe(0);
    expect(result.failedCounterUpdates).toEqual({ you_search_web: 1 });

    const msg = input.messages.find((m: any) => m.tool_call_id === 'a');
    expect(msg.content).toContain('Search budget reached');
    const ledgerEntry = input.toolCallsLedger.find((t: any) => t.id === 'a');
    expect(ledgerEntry.error).toContain('Search budget reached');
  });

  it('shares ONE budget across the different search tools (you_search_web, google_search_web, you_search_news)', async () => {
    const ports = searchPorts();
    const input = makeInput(
      [
        toolCall('a', 'you_search_web', '{"query":"x"}'),
        toolCall('b', 'google_search_web', '{"query":"y"}'),
      ],
      ports,
      { priorSearchCallCount: SEARCH_CALL_SESSION_CAP - 1 },
    );
    const result = await executePreparedTools(input);

    // "a" is the CAPth call this session — allowed. "b" would be CAP+1 — rejected.
    expect((ports as any).__execOrder).toEqual(['you_search_web']);
    expect(result.searchCallsThisIteration).toBe(1);
    const rejected = input.messages.find((m: any) => m.tool_call_id === 'b');
    expect(rejected.content).toContain('Search budget reached');
  });

  it('does NOT cap a non-search tool once the search budget is exhausted', async () => {
    const ports = makePorts();
    const input = makeInput([toolCall('a', 'create_lead', '{"email":"x@y.com"}')], ports, {
      priorSearchCallCount: SEARCH_CALL_SESSION_CAP + 50,
    });
    const result = await executePreparedTools(input);
    expect((ports as any).__execOrder).toEqual(['create_lead']);
    expect(result.failedCounterUpdates).toEqual({});
  });

  it('accumulates searchCallsThisIteration across multiple allowed calls in one batch', async () => {
    const ports = searchPorts();
    const input = makeInput(
      [
        toolCall('a', 'you_search_web', '{"query":"x"}'),
        toolCall('b', 'you_search_web', '{"query":"y"}'),
        toolCall('c', 'you_search_web', '{"query":"z"}'),
      ],
      ports,
      { priorSearchCallCount: 0 },
    );
    const result = await executePreparedTools(input);
    expect(result.searchCallsThisIteration).toBe(3);
  });

  it('defaults priorSearchCallCount to 0 when the caller does not wire it (no behavior change for unmigrated callers)', async () => {
    const ports = searchPorts();
    const input = makeInput([toolCall('a', 'you_search_web', '{"query":"x"}')], ports);
    const result = await executePreparedTools(input);
    expect((ports as any).__execOrder).toEqual(['you_search_web']);
  });

  it('does not count an exact-duplicate search suppressed by same-turn dedupe toward the budget', async () => {
    const ports = searchPorts();
    const input = makeInput(
      [
        toolCall('a', 'you_search_web', '{"query":"same"}'),
        toolCall('b', 'you_search_web', '{"query":"same"}'),
      ],
      ports,
      { priorSearchCallCount: 0 },
    );
    const result = await executePreparedTools(input);
    // Only one real dispatch (ENG-108 same-turn dedupe collapses the second).
    expect((ports as any).__execOrder).toEqual(['you_search_web']);
    expect(result.searchCallsThisIteration).toBe(1);
  });
});

describe('seedSearchCallCountFromHistory (ENG-426)', () => {
  const searchMsg = (name: string, query: string) => ({
    role: 'assistant',
    metadata: { toolCalls: [{ id: 'x', name, arguments: { query } }] },
  });

  it('returns 0 for non-array input', () => {
    expect(seedSearchCallCountFromHistory(undefined)).toBe(0);
    expect(seedSearchCallCountFromHistory(null)).toBe(0);
  });

  it('counts a you_search_web call', () => {
    expect(seedSearchCallCountFromHistory([searchMsg('you_search_web', 'a')])).toBe(1);
  });

  it('counts google_search_web and you_search_news too — every WEB_SEARCH_TOOL_NAMES member shares one budget', () => {
    const msgs = [
      searchMsg('you_search_web', 'a'),
      searchMsg('google_search_web', 'b'),
      searchMsg('you_search_news', 'c'),
    ];
    expect(seedSearchCallCountFromHistory(msgs)).toBe(3);
  });

  it('counts multiple search calls within one assistant message', () => {
    const msg = {
      role: 'assistant',
      metadata: { toolCalls: [
        { id: 'x', name: 'you_search_web', arguments: { query: 'a' } },
        { id: 'y', name: 'you_search_web', arguments: { query: 'b' } },
      ] },
    };
    expect(seedSearchCallCountFromHistory([msg])).toBe(2);
  });

  it('counts a call regardless of success/failure — this is a volume cap, not a duplicate detector', () => {
    const failed = {
      role: 'assistant',
      metadata: { toolCalls: [{ id: 'x', name: 'you_search_web', arguments: { query: 'a' }, error: 'timeout' }] },
    };
    expect(seedSearchCallCountFromHistory([failed])).toBe(1);
  });

  it('ignores a non-search tool call (e.g. send_email)', () => {
    const msg = { role: 'assistant', metadata: { toolCalls: [{ id: 'x', name: 'send_email', arguments: {} }] } };
    expect(seedSearchCallCountFromHistory([msg])).toBe(0);
  });

  it('ignores non-assistant messages and malformed entries', () => {
    const msgs = [
      null,
      undefined,
      { role: 'user', content: 'hi' },
      { role: 'assistant', metadata: {} },
      { role: 'assistant', metadata: { toolCalls: [null, {}] } },
    ];
    expect(seedSearchCallCountFromHistory(msgs as any)).toBe(0);
  });

  // CodeRabbit (PR #2633): appendSuppressedDuplicate persists a ledger entry for the
  // COLLAPSED call too (name + duplicateOf), so the next LLM turn isn't left with an
  // orphaned tool_call_id. That entry never actually dispatched — no network call, no
  // budget spent — so a later turn reconstructing the count from this same history must
  // not count it a second time for one real search.
  it('does not double-count a same-turn suppressed duplicate persisted in history', () => {
    const msg = {
      role: 'assistant',
      metadata: {
        toolCalls: [
          { id: 'a', name: 'you_search_web', arguments: { query: 'x' } },
          { id: 'b', name: 'you_search_web', arguments: { query: 'x' }, duplicateOf: 'a' },
        ],
      },
    };
    expect(seedSearchCallCountFromHistory([msg])).toBe(1);
  });
});
