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

  it('records a JSON-parse failure as a preflight error', async () => {
    const ports = makePorts();
    const input = makeInput([toolCall('a', 'read_brand_guidelines', '{not json}')], ports);
    const result = await executePreparedTools(input);

    expect(input.toolCallsLedger[0].error).toMatch(/Failed to parse arguments/);
    expect(result.failedCounterUpdates).toEqual({ read_brand_guidelines: 1 });
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

    it('requires revision source inputImages when approved sources are provided', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({ prompt: 'edit', confirm: true }))],
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
        error: expect.stringContaining('explicit approved source inputImages'),
      });
      expect(input.messages[0].content).toContain('explicit approved source inputImages');
    });

    it('requires revision source inputImages even without explicit confirm=true', async () => {
      const execOrder: string[] = [];
      const ports = makePorts({
        executeAgentToolThroughGateway: async (i) => {
          execOrder.push(i.toolName);
          const result = await i.execute();
          return { status: 'success', result, durationMs: 1, policyDecision: i.policyDecision };
        },
      });

      const input = makeInput(
        [toolCall('a', 'generate_image', JSON.stringify({ prompt: 'edit' }))],
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
        error: expect.stringContaining('explicit approved source inputImages'),
      });
      expect(input.messages[0].content).toContain('explicit approved source inputImages');
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
