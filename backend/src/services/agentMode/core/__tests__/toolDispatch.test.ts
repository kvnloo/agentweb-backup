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
  type ExecutePreparedToolsInput,
  type ToolDispatchPorts,
} from '../toolDispatch';

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
    expect(input.messages[1].content).toBe('ERR: boom');
    expect(result.pendingCounterUpdates).toEqual({ read_brand_guidelines: 1 });
    expect(result.failedCounterUpdates).toEqual({ read_market_strategy: 1 });
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
    expect(input.messages[0].content).toBe('ERR: flagged error');
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

  it('blocks the actual overlong LinkedIn send-invite tool-call shape before gateway execution', async () => {
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

    expect(executeAgentToolThroughGatewaySpy).not.toHaveBeenCalled();
    expect(input.toolCallsLedger[0]).toMatchObject({
      name: 'linkedin_outreach',
      error: expect.stringContaining('200 characters or fewer'),
    });
    expect(input.messages[0]).toMatchObject({
      role: 'tool',
      name: 'linkedin_outreach',
      content: expect.stringContaining('Rewrite it as a complete shorter note before retrying'),
    });
    expect(result.failedCounterUpdates).toEqual({ linkedin_outreach: 1 });
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

    it('still produces one asset when over budget but nothing has been generated yet (forward progress)', async () => {
      const { ports, executed } = mediaPorts();
      const input = makeInput(
        [
          toolCall('a', 'generate_image', '{"prompt":"1"}'),
          toolCall('b', 'generate_image', '{"prompt":"2"}'),
          toolCall('c', 'generate_image', '{"prompt":"3"}'),
        ],
        ports,
        { mediaGenerationDeadlineMs: Date.now() - 1, mediaAssetsProducedThisRun: 0 },
      );
      const result = await executePreparedTools(input);

      // First call runs (no asset existed yet); the remaining two defer.
      expect(executed).toEqual(['generate_image']);
      expect(result.mediaAssetsProduced).toBe(1);
      expect(result.mediaBudgetDeferred).toBe(true);
      expect(result.pendingCounterUpdates).toEqual({ generate_image: 1 });
      expect(input.messages.map((m: any) => m.content)).toEqual([
        expect.stringContaining('https://s3/generate_image.png'),
        expect.stringMatching(/paused|continue/i),
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
      // Every emitted tool_call_id is answered with a tool-role message.
      const answeredIds = input.messages.map((m: any) => m.tool_call_id).sort();
      expect(answeredIds).toEqual(['a', 'b']);
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
  });
});
