/**
 * Tool-dispatch boundary for the AgentMode core loop (strangler seam).
 *
 * Extracted (behavior-preserving) from `agentModeService.generateMarketingResponse`'s
 * per-iteration tool-handling block. This is the single legible boundary the core
 * loop dispatches through:
 *
 *     validate/prepare tool calls (policy + arg repair + preflight failures)
 *       → decide parallel-vs-sequential
 *       → execute through the gateway
 *       → classify tool-result errors
 *       → process results (screenshot S3, minimal-result, CRM socket emit,
 *          large-response S3 offload, DynamoDB truncation)
 *       → append tool-result messages + accumulate counter deltas
 *
 * The monolith loop calls `executePreparedTools` instead of inlining ~370 lines.
 * To stay behavior-preserving the function MUTATES the same `messages` and
 * `toolCalls` arrays the loop owns (preserving exact ordering + object identity),
 * and every entangled side-effect (gateway exec, S3 upload, socket emit, telemetry,
 * tool-error classification, minimal-result extraction, error formatting) is
 * injected as a PORT rather than imported here — so this module drags none of the
 * 24k-line monolith into the core and is unit-testable with fakes.
 *
 * The characterization harness proves the tool-call sequence, final content,
 * responseMessages shape, and LLM-turns consumed are byte-identical before/after.
 */

import type { AgentToolPolicyDecision } from '../../agentToolGatewayService';

/**
 * Media-generation tools whose batches must run sequentially (rate limits) AND are
 * subject to the per-run time budget (see `mediaGenerationDeadlineMs`). A single
 * call to one of these can take minutes; an 18-image work-plan step (LinkedIn Ads
 * "Generate 3 Images Per Hook") can exceed the run's 10-min wall clock, get killed
 * mid-step, and never reach set_work_plan_status. The budget lets each run do a
 * bounded chunk and stop gracefully so the batch converges across turns.
 */
export const MEDIA_GEN_TOOLS = new Set<string>([
  'generate_image',
  'generate_video',
  'generate_voiceover',
]);

/**
 * A media-gen tool can return `success: true` WITHOUT producing an asset: the
 * generate_image / generate_video human-in-the-loop confirmation gate returns
 * `{ success: true, awaitingUserConfirmation: true }` (no imageUrl/videoUrl) to
 * pause for approval BEFORE editing existing assets. Counting those non-producing
 * returns toward calledFunctions is the proven cause of the xCures incident's
 * "generate_image called 76× but only 3 images exist" counter pollution
 * (prod session 7c8ff5b2-…) — it inflated calledFunctions.generate_image far past
 * the set_work_plan_status requiredFunctionCalls gate while no assets were made.
 *
 * Returns true only when a media-gen success actually produced/queued an asset
 * (i.e. it is NOT a confirmation-gate pause). Non-media tools are unaffected.
 */
export function mediaGenProducedAsset(toolName: string, result: any): boolean {
  if (!MEDIA_GEN_TOOLS.has(toolName)) return true; // not a media-gen tool — N/A
  if (result && typeof result === 'object'
    && ((result as any).awaitingUserConfirmation === true || (result as any).requiresConfirmation === true)) {
    return false;
  }
  return true;
}

/** A tool-result outcome from the gateway, normalized into the loop's union shape. */
export interface ToolExecOutcome {
  status: 'success' | 'error';
  result?: any;
  error?: any;
  durationMs: number;
  policyDecision?: AgentToolPolicyDecision;
}

/**
 * Internal per-call result the dispatcher tracks. `deferred` means a media-gen call
 * was NOT executed because the run's time budget was already spent — it is neither a
 * success (no asset, no counter increment) nor a failure (no error, does not trip the
 * gateway breaker); the model is told to stop and ask the user to continue.
 */
export interface DispatchToolResult {
  status: 'success' | 'error' | 'deferred';
  toolCall: any;
  functionArgs: any;
  result?: any;
  error?: any;
  duration: number;
  policyDecision?: AgentToolPolicyDecision;
}

/** A preflight (validation/policy) failure recorded before execution. */
export interface PreflightToolResult {
  status: 'error';
  toolCall: any;
  functionArgs: any;
  error: Error;
  duration: number;
  policyDecision?: AgentToolPolicyDecision;
}

/**
 * The injected ports. These keep the genuinely-entangled bits (exact gateway call,
 * S3 specifics, socket payload, telemetry, classification, instance helpers) OUT of
 * core while letting the pure dispatch/append logic live here. The monolith wires
 * these to its own implementations; tests wire fakes.
 */
export interface ToolDispatchPorts {
  /** evaluate the tool gateway policy for a (tool, args) pair */
  evaluateAgentToolPolicy: (input: {
    toolName: string;
    args: any;
    isAdmin: boolean;
    isSharedSession: boolean;
    enforce: boolean;
  }) => AgentToolPolicyDecision;
  /** validate + (optionally) repair tool args against the schema */
  validateAndRepairToolArgs: (input: {
    toolName: string;
    args: any;
    inputSchema: any;
    effect: any;
  }) => any;
  /** look up a tool's JSON-schema input shape for arg validation */
  getToolInputSchema: (toolName: string) => any;
  /** execute one prepared tool through the gateway (breaker + telemetry live here) */
  executeAgentToolThroughGateway: (input: {
    toolName: string;
    args: any;
    policyDecision: AgentToolPolicyDecision;
    runId: string;
    budgetScopeId?: string;
    execute: () => Promise<any>;
  }) => Promise<ToolExecOutcome>;
  /** the leaf tool executor (the gateway's `execute` calls this) */
  executePreparedAgentTool: (input: any) => Promise<any>;
  /** classify a "successful" result that actually encodes an error -> downgrade to error */
  toolResultError: (result: any) => any;
  /** record per-iteration tool telemetry (best-effort, observability-only) */
  recordToolTelemetry: (telemetryToolResults: Array<DispatchToolResult | PreflightToolResult>) => void;
  /** extract the minimal result stored on the toolCalls ledger entry */
  extractMinimalToolResult: (result: any, toolName: string) => any;
  /** extract the string content fed back to the model as the tool message */
  extractToolContent: (result: any) => string;
  /** format a tool error into the string the model sees */
  formatToolError: (toolName: string, errorMessage: string) => string;
  /** upload a playwright screenshot data-url to S3; returns { url } or null */
  uploadScreenshotToS3: (dataUrl: string, userId: string) => Promise<{ url: string } | null>;
  /** upload a large tool response to S3; returns { success, key } */
  uploadFileToS3WithPath: (
    content: string,
    fileName: string,
    contentType: string,
    path: string,
  ) => Promise<{ success: boolean; key?: string }>;
  /** build the CRM-data-changed socket payload for a mutating tool (or null) */
  buildCrmDataChangedPayload: (toolName: string, functionArgs: any) => any;
  /** the socket event name for CRM data changes */
  crmDataChangedEvent: string;
  /** the socket emitter (or undefined when no socket is attached) */
  socketEmit?: (room: string, event: string, payload: any) => void;
}

/** Everything the dispatcher needs from the loop's current iteration + run context. */
export interface ExecutePreparedToolsInput {
  /** the tool_calls array the model emitted this turn */
  toolCalls: any[];
  /** the running message array — MUTATED in place (tool messages appended) */
  messages: any[];
  /** the cumulative toolCalls ledger — MUTATED in place (entries pushed) */
  toolCallsLedger: any[];
  // ---- run/iteration context ----
  iteration: number;
  agentRuntimeRunId: string;
  sessionId: string;
  userId: string;
  llmModel: string;
  mockMode: boolean;
  screenshotUrl?: string;
  isDelegatedAccess: boolean;
  hasAdminAccess: boolean;
  isInteractiveShare: boolean;
  // ---- skill/tool gating (read-only) ----
  adminSkillToolNames: string[];
  excludeTools?: string[];
  publishedSkillsCount: number;
  sessionAssociatedSkillIdsCount: number;
  allowedToolNames: Set<string>;
  // ---- limits ----
  toolResponseS3Threshold: number;
  maxToolContentSize: number;
  /**
   * Wall-clock deadline (epoch ms, from Date.now()) past which NEW media-generation
   * calls (generate_image/video/voiceover) in this run are gracefully deferred
   * instead of executed — so a long image batch stops short of the run's hard
   * timeout and asks the user to continue, rather than being killed mid-step.
   * ON by default in production: the caller supplies a 7-min deadline unless
   * AGENT_MODE_MEDIA_BUDGET_MS=0. It is undefined only when explicitly disabled
   * (AGENT_MODE_MEDIA_BUDGET_MS=0) or in unit tests — in that case the budget is off
   * and prior behavior is preserved. (NOT opt-in: unset env means the 7-min default.)
   */
  mediaGenerationDeadlineMs?: number;
  /**
   * Count of media assets already produced in this run before this iteration. The
   * budget only defers once at least one asset exists this run, so a run that is
   * already over budget when it starts still produces (and persists) at least one
   * image before stopping — guaranteeing forward progress every turn.
   */
  mediaAssetsProducedThisRun?: number;
  // ---- ports ----
  ports: ToolDispatchPorts;
}

/** The dispatcher's return: counter deltas + whether skills were updated this turn. */
export interface ExecutePreparedToolsResult {
  /** per-tool successful-call counts to flush via incrementCalledFunctions */
  pendingCounterUpdates: Record<string, number>;
  /** per-tool failed-call counts to flush via incrementFailedFunctions */
  failedCounterUpdates: Record<string, number>;
  /** true if an install_skills call ran (loop refreshes skills next iteration) */
  skillsUpdated: boolean;
  /** number of media-gen assets successfully produced this iteration (for run-budget tracking) */
  mediaAssetsProduced: number;
  /** true if one or more media-gen calls were deferred this iteration due to the time budget */
  mediaBudgetDeferred: boolean;
}

/**
 * Dispatch the prepared tool calls for one iteration. Mutates `messages` and
 * `toolCallsLedger` (the loop's arrays) and returns counter deltas + skillsUpdated.
 *
 * The body is a 1:1 behavior-preserving move of the monolith's Phase 1/2/3 block;
 * only the captured variables become inputs and the entangled calls become ports.
 */
export async function executePreparedTools(
  input: ExecutePreparedToolsInput,
): Promise<ExecutePreparedToolsResult> {
  const {
    toolCalls: responseToolCalls,
    messages,
    toolCallsLedger: toolCalls,
    iteration,
    agentRuntimeRunId,
    sessionId,
    userId,
    llmModel,
    mockMode,
    screenshotUrl,
    isDelegatedAccess,
    hasAdminAccess,
    isInteractiveShare,
    adminSkillToolNames,
    excludeTools,
    publishedSkillsCount,
    sessionAssociatedSkillIdsCount,
    allowedToolNames,
    toolResponseS3Threshold,
    maxToolContentSize,
    mediaGenerationDeadlineMs,
    mediaAssetsProducedThisRun = 0,
    ports,
  } = input;

  const pendingCounterUpdates: Record<string, number> = {};
  const failedCounterUpdates: Record<string, number> = {};
  let skillsUpdated = false;
  let mediaAssetsProduced = 0;
  let mediaBudgetDeferred = false;

  // Phase 1: Validate and prepare tool calls (synchronous)
  const preparedCalls: Array<{ toolCall: any; functionArgs: any; policyDecision: AgentToolPolicyDecision }> = [];
  const preflightToolResults: PreflightToolResult[] = [];

  const appendPreflightToolFailure = (
    toolCall: any,
    functionArgs: any,
    errorMessage: string,
    content: any,
    policyDecision?: AgentToolPolicyDecision,
  ) => {
    const error = new Error(errorMessage);
    (messages as any[]).push({
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content,
      metadata: { timestamp: new Date().toISOString() },
    });
    toolCalls.push({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: functionArgs ?? toolCall.function.arguments,
      error: error.message,
      duration: 0,
    });
    failedCounterUpdates[toolCall.function.name] =
      (failedCounterUpdates[toolCall.function.name] || 0) + 1;
    preflightToolResults.push({
      status: 'error',
      toolCall,
      functionArgs,
      error,
      duration: 0,
      policyDecision,
    });
  };

  for (const toolCall of responseToolCalls) {
    try {
      const functionArgs = JSON.parse(toolCall.function.arguments);

      // Enforce skill-based tool access; block admin-only tools without admin access,
      // block context-restricted/shared-session tools even if the LLM hallucinates them.
      if (!hasAdminAccess && adminSkillToolNames.includes(toolCall.function.name)) {
        const errorMsg = isInteractiveShare
          ? `Tool "${toolCall.function.name}" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.`
          : `Tool "${toolCall.function.name}" requires admin access. This session does not have admin privileges.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      if (isInteractiveShare && toolCall.function.name === 'connect_account') {
        const errorMsg = 'Account connections are not available in shared sessions. Tell the user they need to open Agent Mode in their own account to connect this account, then come back here.';
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      if (excludeTools?.includes(toolCall.function.name)) {
        const errorMsg = `Tool "${toolCall.function.name}" is not available in this context.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      if (publishedSkillsCount > 0 && sessionAssociatedSkillIdsCount > 0 && !allowedToolNames.has(toolCall.function.name)) {
        const errorMsg = `Tool "${toolCall.function.name}" is not available. You must install the required skill first using install_skills.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      if (toolCall.function.name === 'install_skills') {
        skillsUpdated = true;
      }

      const initialPolicyDecision = ports.evaluateAgentToolPolicy({
        toolName: toolCall.function.name,
        args: functionArgs,
        isAdmin: hasAdminAccess,
        isSharedSession: isInteractiveShare,
        enforce: process.env.AGENT_TOOL_GATEWAY_ENFORCE === 'true',
      });

      const inputSchema = ports.getToolInputSchema(toolCall.function.name);
      const contractResult = ports.validateAndRepairToolArgs({
        toolName: toolCall.function.name,
        args: functionArgs,
        inputSchema,
        effect: initialPolicyDecision.effect,
      });

      if (contractResult.status === 'invalid') {
        const errorContent = ports.formatToolError(toolCall.function.name, contractResult.modelMessage);
        appendPreflightToolFailure(toolCall, functionArgs, contractResult.modelMessage, errorContent, initialPolicyDecision);
        continue;
      }

      const preparedFunctionArgs = contractResult.args;
      const policyDecision = ports.evaluateAgentToolPolicy({
        toolName: toolCall.function.name,
        args: preparedFunctionArgs,
        isAdmin: hasAdminAccess,
        isSharedSession: isInteractiveShare,
        enforce: process.env.AGENT_TOOL_GATEWAY_ENFORCE === 'true',
      });

      if (contractResult.status === 'repaired') {
        policyDecision.flags.push({
          code: 'args_repaired',
          severity: 'info',
          message: `Tool arguments were repaired before execution: ${contractResult.repairs.join(', ')}`,
        });
      }

      if (!policyDecision.allowed) {
        const errorMsg = `Tool "${toolCall.function.name}" was blocked by Agent Tool Gateway policy: ${policyDecision.flags.map((flag) => flag.message).join(' ')}`;
        appendPreflightToolFailure(toolCall, preparedFunctionArgs, errorMsg, JSON.stringify({ error: errorMsg, policy: policyDecision }), policyDecision);
        continue;
      }

      preparedCalls.push({ toolCall, functionArgs: preparedFunctionArgs, policyDecision });
    } catch (error) {
      console.error(`AgentMode: Tool argument parse error for ${toolCall.function.name}:`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      const errorContent = ports.formatToolError(toolCall.function.name, `Failed to parse arguments: ${errMsg}`);
      appendPreflightToolFailure(toolCall, undefined, `Failed to parse arguments: ${errMsg}`, errorContent);
    }
  }

  // Phase 2: Execute tools — sequential if wait_seconds is present (so the wait
  // happens in order) or when multiple media-gen calls are batched (rate limits),
  // parallel otherwise.
  const hasWaitTool = preparedCalls.some(({ toolCall }) => toolCall.function.name === 'wait_seconds');
  const hasMultipleMediaGenTools = preparedCalls.length > 1 && preparedCalls.some(({ toolCall }) =>
    toolCall.function.name === 'generate_image' || toolCall.function.name === 'generate_video' || toolCall.function.name === 'generate_voiceover'
  );

  let toolResults: DispatchToolResult[];

  const runOne = (toolCall: any, functionArgs: any, policyDecision: AgentToolPolicyDecision) =>
    ports.executeAgentToolThroughGateway({
      toolName: toolCall.function.name,
      args: functionArgs,
      policyDecision,
      runId: agentRuntimeRunId,
      budgetScopeId: sessionId,
      execute: () => ports.executePreparedAgentTool({
        llmModel,
        toolName: toolCall.function.name,
        functionArgs,
        userId,
        sessionId,
        mockMode,
        socketEmit: ports.socketEmit,
        screenshotUrl,
        isDelegatedAccess,
      }),
    });

  const toDispatchResult = (
    outcome: ToolExecOutcome,
    toolCall: any,
    functionArgs: any,
  ): DispatchToolResult =>
    outcome.status === 'success'
      ? { status: 'success', toolCall, functionArgs, result: outcome.result, duration: outcome.durationMs, policyDecision: outcome.policyDecision }
      : { status: 'error', toolCall, functionArgs, error: outcome.error, duration: outcome.durationMs, policyDecision: outcome.policyDecision };

  // Per-run media-generation time budget. Once the run is over its deadline AND has
  // already produced at least one asset (this run, including earlier calls in this
  // same batch), further media-gen calls are DEFERRED rather than executed — so a
  // long image batch stops short of the run's hard wall-clock timeout and asks the
  // user to continue, instead of being killed mid-step with nothing persisted. The
  // "≥1 asset" gate guarantees a run that starts already-over-budget still makes one
  // unit of forward progress before stopping. The budget is ON by default in
  // production (caller passes a 7-min deadline); it is only disabled when no deadline
  // is supplied (AGENT_MODE_MEDIA_BUDGET_MS=0, and the unit tests), which preserves
  // prior behavior. It is NOT opt-in — an unset env var still applies the 7-min default.
  let assetsThisBatch = 0;
  const isMediaGenTool = (toolCall: any) => MEDIA_GEN_TOOLS.has(toolCall.function.name);
  const shouldDeferMedia = (toolCall: any): boolean =>
    mediaGenerationDeadlineMs != null
    && isMediaGenTool(toolCall)
    && Date.now() > mediaGenerationDeadlineMs
    && (mediaAssetsProducedThisRun + assetsThisBatch) >= 1;
  const makeDeferred = (toolCall: any, functionArgs: any, policyDecision: AgentToolPolicyDecision): DispatchToolResult => {
    mediaBudgetDeferred = true;
    return { status: 'deferred', toolCall, functionArgs, duration: 0, policyDecision };
  };
  // A genuine media asset: a gateway success that isn't an encoded {success:false}
  // AND actually produced an asset (not a confirmation-gate pause — see
  // mediaGenProducedAsset). Keeps the deferral budget's notion of "an asset exists
  // this batch" consistent with the calledFunctions / mediaAssetsProduced counters.
  const countsAsAsset = (dr: DispatchToolResult): boolean =>
    dr.status === 'success'
    && isMediaGenTool(dr.toolCall)
    && !ports.toolResultError(dr.result)
    && mediaGenProducedAsset(dr.toolCall.function.name, dr.result);

  if (hasWaitTool || hasMultipleMediaGenTools) {
    toolResults = [];
    for (const { toolCall, functionArgs, policyDecision } of preparedCalls) {
      if (shouldDeferMedia(toolCall)) {
        toolResults.push(makeDeferred(toolCall, functionArgs, policyDecision));
        continue;
      }
      const outcome = await runOne(toolCall, functionArgs, policyDecision);
      const dr = toDispatchResult(outcome, toolCall, functionArgs);
      if (countsAsAsset(dr)) assetsThisBatch++;
      toolResults.push(dr);
    }
  } else {
    // Parallel path carries at most one media-gen call (a solo call; any media call
    // batched with other tools forces the sequential path above), so a single
    // pre-launch deferral check is race-free.
    const toolPromises = preparedCalls.map(async ({ toolCall, functionArgs, policyDecision }) => {
      if (shouldDeferMedia(toolCall)) {
        return makeDeferred(toolCall, functionArgs, policyDecision);
      }
      const outcome = await runOne(toolCall, functionArgs, policyDecision);
      const dr = toDispatchResult(outcome, toolCall, functionArgs);
      if (countsAsAsset(dr)) assetsThisBatch++;
      return dr;
    });
    toolResults = await Promise.all(toolPromises);
  }

  // Downgrade "successful" results that actually encode an error.
  toolResults = toolResults.map((toolResult) => {
    if (toolResult.status !== 'success') return toolResult;
    const error = ports.toolResultError(toolResult.result);
    if (!error) return toolResult;
    return {
      status: 'error' as const,
      toolCall: toolResult.toolCall,
      functionArgs: toolResult.functionArgs,
      result: toolResult.result,
      error,
      duration: toolResult.duration,
      policyDecision: toolResult.policyDecision,
    };
  });
  // Deferred calls never executed, so they carry no success/error telemetry signal.
  const telemetryToolResults: Array<DispatchToolResult | PreflightToolResult> = [
    ...preflightToolResults,
    ...toolResults.filter((r) => r.status !== 'deferred'),
  ];

  // Runtime-spine telemetry (best-effort, observability-only).
  ports.recordToolTelemetry(telemetryToolResults);

  // Phase 3: Process results in original order — append to messages, toolCalls, counters
  for (const toolResult of toolResults) {
    if (toolResult.status === 'success') {
      const { toolCall, functionArgs, result, duration } = toolResult;

      // For playwright screenshots, upload the base64 image to S3 to replace the
      // ~300KB base64 JSON payload with a lightweight URL.
      let processedResult = result;
      if (toolCall.function.name === 'playwright_browser_take_screenshot') {
        const imageContent = (result.raw?.content as any[])?.find((c: any) => c.type === 'image');
        if (imageContent?.data) {
          try {
            const dataUrl = `data:${imageContent.mimeType || 'image/png'};base64,${imageContent.data}`;
            const uploadResult = await ports.uploadScreenshotToS3(dataUrl, userId);
            if (uploadResult) {
              processedResult = { screenshotUrl: uploadResult.url, dataUrl, success: true };
            }
          } catch (e) {
            console.error('AgentMode: Failed to upload playwright screenshot to S3:', e);
          }
        }
      }

      const minimalResult = ports.extractMinimalToolResult(processedResult, toolCall.function.name);

      toolCalls.push({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: functionArgs,
        result: minimalResult,
        duration,
      });

      // Notify the CRM page to refresh after a successful CRM-mutating tool.
      if (ports.socketEmit) {
        const crmPayload = ports.buildCrmDataChangedPayload(toolCall.function.name, functionArgs);
        const toolSucceeded = !(processedResult && (processedResult as any).success === false);
        if (crmPayload && toolSucceeded) {
          ports.socketEmit(`user:${userId}`, ports.crmDataChangedEvent, crmPayload);
        }
      }

      // A media-gen "success" that only paused for confirmation produced no asset —
      // do NOT count it toward calledFunctions (the set_work_plan_status completion
      // gate) or the per-run media-asset total. See mediaGenProducedAsset: this is
      // the fix for the counter pollution that let an image step be marked complete
      // with 3 of 18 images (calledFunctions.generate_image=76, assets=3).
      const producedAsset = mediaGenProducedAsset(toolCall.function.name, result);

      if (producedAsset) {
        // For create_social_media_posts, count actual posts in the array (not function calls)
        const counterIncrement = toolCall.function.name === 'create_social_media_posts'
          ? ((functionArgs.posts as any[])?.length ?? 1)
          : 1;
        pendingCounterUpdates[toolCall.function.name] =
          (pendingCounterUpdates[toolCall.function.name] || 0) + counterIncrement;

        // Track media assets produced this iteration so the loop can carry a running
        // per-run total into the next call's time-budget decision.
        if (MEDIA_GEN_TOOLS.has(toolCall.function.name)) {
          mediaAssetsProduced += 1;
        }
      }

      // For playwright screenshots, pass the image back to the LLM as a vision input.
      let toolContent: any;
      const isGeminiModel = llmModel.startsWith('gemini-');
      if (toolCall.function.name === 'playwright_browser_take_screenshot' && (processedResult as any).dataUrl && !isGeminiModel) {
        toolContent = [
          { type: 'text', text: 'Screenshot captured. Analyze the image below to verify the result visually. Do not include the raw image URL or data URI in your response to the user.' },
          { type: 'image_url', image_url: { url: (processedResult as any).dataUrl, detail: 'high' } },
        ];
      } else if (toolCall.function.name === 'playwright_browser_take_screenshot' && (processedResult as any).screenshotUrl && isGeminiModel) {
        toolContent = `Screenshot captured. URL: ${(processedResult as any).screenshotUrl}\n\n${ports.extractToolContent(result)}`;
      } else {
        toolContent = ports.extractToolContent(result);
      }

      // Large response: upload full content to S3 (search_tool_response retrieves later),
      // then cap the in-memory copy to prevent worker OOM.
      const S3_IN_MEMORY_CAP = 20_000;
      if (typeof toolContent === 'string' && toolContent.length > toolResponseS3Threshold) {
        try {
          const uploadResult = await ports.uploadFileToS3WithPath(
            toolContent,
            `${toolCall.id}.txt`,
            'text/plain',
            `tool-responses/${sessionId}`,
          );
          if (uploadResult.success && uploadResult.key) {
            const header = `[Full response stored at S3 key: ${uploadResult.key} (${toolContent.length} chars) — use search_tool_response tool to find specific fields]\n\n`;
            const preview = toolContent.length > S3_IN_MEMORY_CAP
              ? toolContent.substring(0, S3_IN_MEMORY_CAP) + '\n\n[Content truncated — full response in S3]'
              : toolContent;
            toolContent = header + preview;
          }
        } catch (e) {
          console.error('AgentMode: Failed to save large tool response to S3:', e);
        }
      }

      const truncatedToolContent = typeof toolContent === 'string' && toolContent.length > maxToolContentSize
        ? toolContent.substring(0, maxToolContentSize) + '\n\n[Content truncated for storage — original size: ' + toolContent.length + ' chars]'
        : toolContent;
      (messages as any[]).push({
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: truncatedToolContent,
        metadata: { timestamp: new Date().toISOString() },
      });
    } else if (toolResult.status === 'deferred') {
      // Budget deferral: the media-gen call was NOT executed. It is neither a success
      // (no asset, no pending counter — so set_work_plan_status's requiredFunctionCalls
      // gate is unaffected) nor a failure (no error, no failed counter, does not feed
      // the gateway's repeated-failure breaker). We still MUST append a tool-role
      // message for this tool_call_id, or the next LLM turn rejects the orphaned call.
      // The content tells the model to stop generating now, summarize what's done, and
      // ask the user to reply "continue" — the asset-awareness block then resumes the
      // batch on the next turn without regenerating the already-saved images.
      const { toolCall, functionArgs } = toolResult;
      const deferContent =
        `⚠️ Media generation paused for this turn — the assistant has been working on this batch for a while and is approaching the per-response time limit. `
        + `The image(s) already generated this session are saved. `
        + `Do NOT call ${toolCall.function.name} again right now. Instead: briefly tell the user how many assets are done versus still remaining, then ask them to reply "continue" to generate the rest. `
        + `When they continue, generate ONLY the still-missing assets (see the already-generated assets list), then mark the step complete.`;
      toolCalls.push({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: functionArgs || toolCall.function.arguments,
        result: { deferred: true, reason: 'media_generation_time_budget' },
        duration: 0,
      });
      messages.push({
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: deferContent,
        metadata: { timestamp: new Date().toISOString(), mediaBudgetDeferred: true },
      });
    } else {
      const { toolCall, functionArgs, error, duration } = toolResult;
      toolCalls.push({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: functionArgs || toolCall.function.arguments,
        error: error instanceof Error ? error.message : 'Unknown error',
        ...(toolResult.result !== undefined
          ? { result: ports.extractMinimalToolResult(toolResult.result, toolCall.function.name) }
          : {}),
        duration,
      });

      failedCounterUpdates[toolCall.function.name] =
        (failedCounterUpdates[toolCall.function.name] || 0) + 1;

      const errMsg = error instanceof Error ? error.message : String(error);
      const errorContent = ports.formatToolError(toolCall.function.name, errMsg);
      messages.push({
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: errorContent,
        metadata: { timestamp: new Date().toISOString() },
      });
    }
  }

  return { pendingCounterUpdates, failedCounterUpdates, skillsUpdated, mediaAssetsProduced, mediaBudgetDeferred };
}
