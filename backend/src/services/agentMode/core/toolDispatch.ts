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
import { classifyToolErrorClass } from '../../../utils/toolErrorClassifier';
import { Citation, CitationRegistry, WEB_SEARCH_TOOL_NAMES, buildCitationIndexBlock } from '../../../utils/citations';
import { appendRetryabilityGuidance } from './errorRetryability';
import { sealTruncatedPayload } from './truncatedPayload';
// OTel spine (ENG-141). Direct imports, NOT ports: both are pure/inert without
// exporter env config (spans become no-ops), so they don't entangle the module
// or affect the characterization contract — telemetry only, never behavior.
import { endExecuteToolSpan, startRunChildSpan } from '../../../observability/tracing';
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_SESSION_ID,
  GEN_AI_OP_EXECUTE_TOOL,
  SPAN_EXECUTE_TOOL_PREFIX,
} from '../../../observability/semconv';

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
 * ENG-510: how many media-gen calls batched in ONE assistant turn may run at once.
 * Multi-variant requests were previously forced strictly serial (concurrency 1) to
 * respect provider rate limits, but that makes N independent variants take N× a single
 * image's wall-clock and blow the whole-turn cap. Run them with BOUNDED concurrency
 * instead — big enough to finish a batch in ~one image's time, small enough to stay
 * under provider rate limits. Override with AGENT_MODE_MEDIA_GEN_CONCURRENCY (min 1).
 */
export const MEDIA_GEN_MAX_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.AGENT_MODE_MEDIA_GEN_CONCURRENCY || '3', 10) || 3,
);

/**
 * Tools exempt from same-turn dedupe (ENG-108) — they have legitimate repeat
 * semantics within a single assistant turn, so two identical calls are NOT a
 * double-execution bug. `wait_seconds` is the canonical case (sleeping twice is
 * meaningful and intended). Keep this set conservative: only add a tool here
 * when an identical call back-to-back in one turn is genuinely valid.
 */
export const NON_DEDUPABLE_TOOLS = new Set<string>([
  'wait_seconds',
]);

/**
 * Deterministic, key-sorted stringify so two calls with the same fields in a
 * different order ({a,b} vs {b,a}) produce the same dedupe key. Used only to
 * build the same-turn dedupe signature — not for storage or model output.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

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
  /**
   * Validate a "successful" result against the minimum-output contract (ENG-105):
   * returns an Error when the output is empty/undefined/unusable so the boundary
   * can downgrade it to a structured tool failure (telemetry class invalid_output),
   * else null. Optional — when absent the contract check is skipped (behavior
   * preserved for callers that don't wire it).
   */
  validateToolOutput?: (result: any) => any;
  /** record per-iteration tool telemetry (best-effort, observability-only) */
  recordToolTelemetry: (telemetryToolResults: Array<DispatchToolResult | PreflightToolResult>) => void;
  /**
   * Record same-turn duplicate tool-call suppression (ENG-108), SEPARATELY from
   * success/failure telemetry (suppressed duplicates are deliberately NOT passed
   * to recordToolTelemetry, which buckets non-success as a failure). Optional +
   * observability-only. */
  recordDuplicateSuppression?: (
    entries: Array<{ toolCall: any; functionArgs: any; duplicateOfId: string }>,
  ) => void;
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
  /** ENG-351: per-message citation registry — MUTATED in place (web-search sources registered) */
  citationRegistry?: CitationRegistry;
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
  /**
   * ENG-510: wall-clock deadline (epoch ms) of the controller's whole-turn hard cap
   * (GENERATION_TIMEOUT_MS, default 10 min). The fixed soft budget above leaves only a
   * fixed headroom below this cap and assumes fast images; a single slow high-quality
   * image can take ~6–7 min and nearly consume the budget, so the NEXT media call slips
   * past the soft-deadline check and then runs past the hard cap — losing every already-
   * generated image. When supplied, the dispatcher also defers a media call once the time
   * left before this cap is less than the longest media call observed this run (see
   * `longestMediaCallMsThisRun`), so the turn ends gracefully with its finished images
   * persisted. Undefined disables the adaptive check (mirrors the soft-budget disable).
   */
  generationHardCapMs?: number;
  /**
   * Longest media-call wall-clock duration (ms) observed so far this run, across prior
   * iterations. Seeds the adaptive hard-cap reserve so the decision uses real observed
   * latency rather than a guess. The dispatcher returns an updated value each iteration.
   */
  longestMediaCallMsThisRun?: number;
  /**
   * ENG-510: dedupe keys (`name:stableStringify(args)` -> first tool_call_id) of media-gen
   * calls that ALREADY produced an asset in EARLIER iterations of this turn. The ENG-108
   * dedupe is per-iteration, so a model that re-emits an identical generate_image in a
   * later iteration (e.g. re-requesting an image it already made when resuming after a
   * timeout) would regenerate it. When a media-gen call's key is already here, the
   * dispatcher suppresses it — scoped to media tools ONLY, so legitimately-repeated
   * mutating calls (send_email, create_lead) across iterations still run. The dispatcher
   * returns the keys produced THIS iteration via `producedMediaCallKeys` for the loop to
   * accumulate. Only SUCCESSFUL generations are recorded, so a failed call stays retryable.
   */
  priorMediaCallKeys?: Map<string, string>;
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
  /**
   * ENG-510: longest media-call wall-clock duration (ms) observed this run, including
   * this iteration's calls. The loop threads it back in as `longestMediaCallMsThisRun`
   * so the adaptive hard-cap reserve tracks the run's actual media latency.
   */
  longestMediaCallMs: number;
  /**
   * ENG-510: dedupe keys of media-gen calls that produced an asset THIS iteration
   * (`name:stableStringify(args)` -> tool_call_id). The loop merges these into the set it
   * passes back as `priorMediaCallKeys` next iteration, so an identical re-request later in
   * the same turn is suppressed instead of regenerating the image.
   */
  producedMediaCallKeys: Map<string, string>;
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
    citationRegistry,
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
    generationHardCapMs,
    longestMediaCallMsThisRun = 0,
    priorMediaCallKeys,
    ports,
  } = input;
  // ENG-510: keys of media-gen assets successfully produced this iteration, returned to the
  // loop to accumulate across iterations for cross-iteration media dedupe (see below).
  const producedMediaCallKeys = new Map<string, string>();

  const pendingCounterUpdates: Record<string, number> = {};
  const failedCounterUpdates: Record<string, number> = {};
  let skillsUpdated = false;
  let mediaAssetsProduced = 0;
  let mediaBudgetDeferred = false;

  // Phase 1: Validate and prepare tool calls (synchronous)
  const preparedCalls: Array<{ toolCall: any; functionArgs: any; policyDecision: AgentToolPolicyDecision; dedupeKey: string }> = [];
  const preflightToolResults: PreflightToolResult[] = [];

  // Same-turn dedupe (ENG-108): collapse identical (name + args) calls emitted in
  // ONE assistant turn so they execute once and can't double-bill. We still MUST
  // answer every emitted tool_call_id (or the next LLM turn rejects the orphaned
  // call — same invariant the deferred-media path documents), so a suppressed
  // duplicate gets its own tool-role message pointing at the call that IS being
  // handled. Suppression is neither success nor failure: no counter, no telemetry
  // through the success/failure path.
  const seenToolCallKeys = new Map<string, string>(); // dedupe key -> first tool_call_id
  const suppressedDuplicates: Array<{ toolCall: any; functionArgs: any; duplicateOfId: string }> = [];

  const appendSuppressedDuplicate = (
    suppressed: { toolCall: any; functionArgs: any; duplicateOfId: string },
  ) => {
    const { toolCall, functionArgs, duplicateOfId } = suppressed;
    const suppressMsg =
      `This call was collapsed: an identical ${toolCall.function.name} call with the same arguments `
      + `was already handled by tool_call_id ${duplicateOfId}. Use that completed tool result — do not repeat this call.`;
    (messages as any[]).push({
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: suppressMsg,
      metadata: { timestamp: new Date().toISOString(), duplicateSuppressed: true, duplicateOfId },
    });
    toolCalls.push({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: functionArgs,
      duplicateOf: duplicateOfId,
      duration: 0,
    });
  };

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
        // ENG-124: schema rejects carry the explicit not-retryable-as-is verdict
        // (fix the args first) so the model can't spiral on the identical call.
        const errorContent = appendRetryabilityGuidance(
          ports.formatToolError(toolCall.function.name, contractResult.modelMessage),
          classifyToolErrorClass(contractResult.modelMessage),
        );
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

      // Same-turn dedupe (ENG-108): if an identical (name + canonical args) call
      // was already accepted this turn and the tool isn't exempt, collapse this
      // one — do NOT execute it. Still answer its tool_call_id with a tool-role
      // message + a ledger entry so the next LLM turn isn't left with an orphan.
      const dedupeKey = `${toolCall.function.name}:${stableStringify(preparedFunctionArgs)}`;
      if (!NON_DEDUPABLE_TOOLS.has(toolCall.function.name) && seenToolCallKeys.has(dedupeKey)) {
        const duplicateOfId = seenToolCallKeys.get(dedupeKey) as string;
        suppressedDuplicates.push({ toolCall, functionArgs: preparedFunctionArgs, duplicateOfId });
        continue;
      }
      // ENG-510: cross-iteration dedupe for MEDIA-GEN tools only. The per-iteration check
      // above misses an identical generate_image re-emitted in a LATER iteration of the
      // same turn (e.g. resuming after a timeout, the model re-requests an image it already
      // made). Suppress it if that exact call already produced an asset earlier this turn.
      // Media-only so a legitimately-repeated mutating call (send_email) is never blocked;
      // only successful generations are recorded, so a failed call can still be retried.
      if (
        MEDIA_GEN_TOOLS.has(toolCall.function.name)
        && priorMediaCallKeys?.has(dedupeKey)
      ) {
        const duplicateOfId = priorMediaCallKeys.get(dedupeKey) as string;
        suppressedDuplicates.push({ toolCall, functionArgs: preparedFunctionArgs, duplicateOfId });
        continue;
      }
      seenToolCallKeys.set(dedupeKey, toolCall.id);

      preparedCalls.push({ toolCall, functionArgs: preparedFunctionArgs, policyDecision, dedupeKey });
    } catch (error) {
      console.error(`AgentMode: Tool argument parse error for ${toolCall.function.name}:`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      // ENG-124: unparseable args are never retryable as-is — emit the corrected-
      // arguments verdict alongside the formatted error.
      const errorContent = appendRetryabilityGuidance(
        ports.formatToolError(toolCall.function.name, `Failed to parse arguments: ${errMsg}`),
        'invalid_args',
      );
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

  const runOne = async (toolCall: any, functionArgs: any, policyDecision: AgentToolPolicyDecision): Promise<ToolExecOutcome> => {
    // OTel `execute_tool` span (ENG-141) — observability only; the gateway call,
    // its outcome shape, and error propagation are untouched.
    const span = startRunChildSpan(agentRuntimeRunId, `${SPAN_EXECUTE_TOOL_PREFIX} ${toolCall.function.name}`, {
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OP_EXECUTE_TOOL,
      [ATTR_GEN_AI_TOOL_NAME]: toolCall.function.name,
      [ATTR_SESSION_ID]: sessionId,
    });
    try {
      const outcome = await ports.executeAgentToolThroughGateway({
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
          // Long-render tools (compose_video) read this to hand off before the run's hard
          // wall-clock timeout rather than blocking until killed with no asset (ENG-123).
          renderDeadlineMs: mediaGenerationDeadlineMs,
          // Run wall-clock budget deadline so wait_seconds can cap its sleep and not be
          // killed mid-wait by the generation timeout (ENG-124).
          runBudgetDeadlineMs: mediaGenerationDeadlineMs,
        }),
      });
      endExecuteToolSpan(span, outcome.status === 'error'
        ? { errorClass: classifyToolErrorClass(outcome.error), error: outcome.error }
        : {});
      return outcome;
    } catch (err) {
      // The gateway normalizes tool failures into outcomes; a throw here is
      // unexpected — record it on the span and rethrow unchanged.
      endExecuteToolSpan(span, { errorClass: classifyToolErrorClass(err), error: err });
      throw err;
    }
  };

  const toDispatchResult = (
    outcome: ToolExecOutcome,
    toolCall: any,
    functionArgs: any,
  ): DispatchToolResult =>
    outcome.status === 'success'
      // A handler may decline to run at all and say so with `deferred: true`
      // (ENG-822's anonymous account-scoped refusal). That is neither a success
      // nor a failure — same accounting as the media-budget deferral below — so
      // it maps to 'deferred' rather than being counted either way.
      ? ((outcome.result as any)?.deferred === true
          ? { status: 'deferred' as const, toolCall, functionArgs, result: outcome.result, duration: outcome.durationMs, policyDecision: outcome.policyDecision }
          : { status: 'success' as const, toolCall, functionArgs, result: outcome.result, duration: outcome.durationMs, policyDecision: outcome.policyDecision })
      : { status: 'error' as const, toolCall, functionArgs, error: outcome.error, duration: outcome.durationMs, policyDecision: outcome.policyDecision };

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
  // ENG-510: run-wide longest media-call duration, seeded from prior iterations and
  // updated as calls settle below, so the adaptive reserve reflects real latency.
  let longestMediaCallMs = longestMediaCallMsThisRun;
  const isMediaGenTool = (toolCall: any) => MEDIA_GEN_TOOLS.has(toolCall.function.name);
  // Fixed soft-budget deadline passed (the original, fast-image assumption).
  const softBudgetExceeded = (): boolean =>
    mediaGenerationDeadlineMs != null && Date.now() > mediaGenerationDeadlineMs;
  // ENG-510: not enough time before the whole-turn hard cap to finish another media
  // call the size of the longest one seen this run. Catches the slow-single-image case
  // the fixed soft headroom can't: after one ~6.5-min image there is < one image of
  // time left, so the next call would run past the cap and lose the finished image(s).
  const withinOneMediaCallOfHardCap = (): boolean =>
    generationHardCapMs != null
    && longestMediaCallMs > 0
    && (generationHardCapMs - Date.now()) < longestMediaCallMs;
  const shouldDeferMedia = (toolCall: any): boolean =>
    isMediaGenTool(toolCall)
    && (mediaAssetsProducedThisRun + assetsThisBatch) >= 1
    && (softBudgetExceeded() || withinOneMediaCallOfHardCap());
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
  // ENG-510: track how long a media call actually took so the adaptive reserve (and the
  // value returned to the loop) reflects real latency. Updated as each call settles so a
  // later call in the SAME batch already sees the earlier call's duration.
  const recordMediaDuration = (dr: DispatchToolResult): void => {
    if (isMediaGenTool(dr.toolCall) && dr.status !== 'deferred') {
      longestMediaCallMs = Math.max(longestMediaCallMs, dr.duration || 0);
    }
  };

  if (hasWaitTool) {
    // Strict sequential: wait_seconds must take effect in emission order, so nothing
    // batched with it may overlap it.
    toolResults = [];
    for (const { toolCall, functionArgs, policyDecision } of preparedCalls) {
      if (shouldDeferMedia(toolCall)) {
        toolResults.push(makeDeferred(toolCall, functionArgs, policyDecision));
        continue;
      }
      const outcome = await runOne(toolCall, functionArgs, policyDecision);
      const dr = toDispatchResult(outcome, toolCall, functionArgs);
      if (countsAsAsset(dr)) assetsThisBatch++;
      recordMediaDuration(dr);
      toolResults.push(dr);
    }
  } else if (hasMultipleMediaGenTools) {
    // ENG-510: run batched media-gen with BOUNDED concurrency (MEDIA_GEN_MAX_CONCURRENCY
    // at a time) instead of strictly serial, so N independent variants finish in ~one
    // image's wall-clock and fit under the whole-turn cap — while staying under provider
    // rate limits. Budget/duration state settles BETWEEN batches, so the deferral decision
    // (and the >=1-asset forward-progress gate) is made per batch, race-free. Results are
    // written by index so emission order is preserved regardless of completion order.
    toolResults = new Array(preparedCalls.length);
    for (let start = 0; start < preparedCalls.length; start += MEDIA_GEN_MAX_CONCURRENCY) {
      const batch = preparedCalls.slice(start, start + MEDIA_GEN_MAX_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async ({ toolCall, functionArgs, policyDecision }) => {
          if (shouldDeferMedia(toolCall)) {
            return makeDeferred(toolCall, functionArgs, policyDecision);
          }
          const outcome = await runOne(toolCall, functionArgs, policyDecision);
          return toDispatchResult(outcome, toolCall, functionArgs);
        }),
      );
      batchResults.forEach((dr, i) => {
        if (countsAsAsset(dr)) assetsThisBatch++;
        recordMediaDuration(dr);
        toolResults[start + i] = dr;
      });
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
      recordMediaDuration(dr);
      return dr;
    });
    toolResults = await Promise.all(toolPromises);
  }

  // Downgrade "successful" results that actually encode an error (toolResultError)
  // OR that fail the minimum-output contract (ENG-105: undefined/empty/{}/empty
  // content array). The encoded-error check runs first; the output-contract check
  // catches the empty/invalid-output case the encoded-error check does not. Either
  // way the call becomes a structured tool failure rather than feeding garbage to
  // the model and being counted as a success.
  toolResults = toolResults.map((toolResult) => {
    if (toolResult.status !== 'success') return toolResult;
    const encodedError = ports.toolResultError(toolResult.result);
    const error = encodedError
      ?? (ports.validateToolOutput ? ports.validateToolOutput(toolResult.result) : null);
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
  // ENG-510: record media-gen calls that SUCCEEDED this iteration (post-downgrade), keyed
  // by their dedupe signature, so the loop can suppress an identical re-request in a later
  // iteration of this turn. Only genuine successes are recorded — a failed or downgraded
  // generation is NOT, so it stays retryable. toolResults is index-aligned with
  // preparedCalls in every execution path.
  toolResults.forEach((dr, i) => {
    const pc = preparedCalls[i];
    if (pc && dr.status === 'success' && countsAsAsset(dr)) {
      producedMediaCallKeys.set(pc.dedupeKey, pc.toolCall.id);
    }
  });

  // Deferred calls never executed, but they ARE forwarded to telemetry as their
  // own class (ENG-103): the telemetry layer records them via toolDeferred (not
  // toolInvoked/succeeded/failed), so deferred/skipped is accounted separately
  // from success and failure and never pollutes the reliability ratio.
  const telemetryToolResults: Array<DispatchToolResult | PreflightToolResult> = [
    ...preflightToolResults,
    ...toolResults,
  ];

  // Runtime-spine telemetry (best-effort, observability-only).
  ports.recordToolTelemetry(telemetryToolResults);

  // Record same-turn duplicate suppression SEPARATELY (ENG-108) — never through
  // recordToolTelemetry above, which would mislabel a suppression as a failure.
  if (suppressedDuplicates.length > 0) {
    ports.recordDuplicateSuppression?.(suppressedDuplicates);
  }

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

      // ENG-351: harvest web-search sources into the per-message citation registry from the
      // FULL result here — extractMinimalToolResult below trims search results to {} for storage,
      // so this is the only place the structured sources are still available.
      let citationBatch: Citation[] = [];
      if (citationRegistry && WEB_SEARCH_TOOL_NAMES.has(toolCall.function.name)) {
        citationBatch = citationRegistry.registerSearchResults(processedResult?.results);
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

      // ENG-351 Phase 2: prepend the {{cite:N}} id→source map so the model can cite each
      // figure inline. Prepend so it survives the large-response truncation/S3 path below.
      if (citationBatch.length > 0 && typeof toolContent === 'string') {
        toolContent = buildCitationIndexBlock(citationBatch) + toolContent;
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
            // ENG-1054: seal the slice instead of leaving the JSON it cut open.
            // A bare substring lands mid-string/mid-object, and a model handed an
            // unterminated structure completes it rather than answering — that is
            // where the production `}]` final answer came from.
            const preview = toolContent.length > S3_IN_MEMORY_CAP
              ? sealTruncatedPayload(toolContent.substring(0, S3_IN_MEMORY_CAP))
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
      // A handler-supplied deferral (ENG-822) carries its own instruction and
      // reason; only the media-budget deferral gets the media prose below.
      const handlerDeferral = (toolResult as any).result?.deferred === true
        ? (toolResult as any).result
        : null;
      const deferContent = handlerDeferral?.message
        ? String(handlerDeferral.message)
        : `⚠️ Media generation paused for this turn — the assistant has been working on this batch for a while and is approaching the per-response time limit. `
        + `The image(s) already generated this session are saved. `
        + `Do NOT call ${toolCall.function.name} again right now. Instead: briefly tell the user how many assets are done versus still remaining, then ask them to reply "continue" to generate the rest. `
        + `When they continue, generate ONLY the still-missing assets (see the already-generated assets list), then mark the step complete.`;
      toolCalls.push({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: functionArgs || toolCall.function.arguments,
        result: handlerDeferral || { deferred: true, reason: 'media_generation_time_budget' },
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

      // ENG-124: the model-visible error carries (a) what failed (formatToolError
      // names the tool + reason, with per-tool fix text), and (b+c) an explicit
      // retryable yes/no verdict + actionable next step derived from the same
      // classifier the telemetry uses — so a terminal failure (auth, provider
      // rejection, schema reject) carries a hard stop signal instead of inviting
      // a retry spiral.
      const errMsg = error instanceof Error ? error.message : String(error);
      const errorContent = appendRetryabilityGuidance(
        ports.formatToolError(toolCall.function.name, errMsg),
        classifyToolErrorClass(error),
      );
      messages.push({
        tool_call_id: toolCall.id,
        role: 'tool',
        name: toolCall.function.name,
        content: errorContent,
        metadata: { timestamp: new Date().toISOString() },
      });
    }
  }

  // Same-turn duplicates are appended only after the real tool results above, so
  // the model sees the completed original call before the "use that result" note.
  for (const suppressed of suppressedDuplicates) {
    appendSuppressedDuplicate(suppressed);
  }

  return { pendingCounterUpdates, failedCounterUpdates, skillsUpdated, mediaAssetsProduced, mediaBudgetDeferred, longestMediaCallMs, producedMediaCallKeys };
}
