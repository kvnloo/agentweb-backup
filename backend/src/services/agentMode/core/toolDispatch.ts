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
import { isReadOnlyToolName } from '../../../utils/toolWriteClassification';
import { ToolResultPolicyBlockedError } from '../../../utils/toolResultError';
import { Citation, CitationRegistry, WEB_SEARCH_TOOL_NAMES, buildCitationIndexBlock } from '../../../utils/citations';
import { appendRetryabilityGuidance } from './errorRetryability';
import { LLM_MODEL_REGISTRY } from '../llmModelRegistry';
import { sealTruncatedPayload, sealTruncatedPayloadWithNotice } from './truncatedPayload';
import { normalizeRepairedToolCallArguments, parseToolCallArguments, TruncatedToolCallArgumentsError } from './repairToolCallArguments';
import {
  buildToolResponseS3Header,
  buildToolResponseUnavailableHeader,
} from '../../../utils/toolResponseS3Ref';
// OTel spine (ENG-141). Direct imports, NOT ports: both are pure/inert without
// exporter env config (spans become no-ops), so they don't entangle the module
// or affect the characterization contract — telemetry only, never behavior.
import { endExecuteToolSpan, startRunChildSpan } from '../../../observability/tracing';
import { restrictionRefusal, SHARE_VISITOR_BLOCKED_TOOLS } from '../../toolRestrictionProfiles';
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
 * ENG-1331: MEDIA_GEN_TOOLS' three rate-limited generation APIs share a time-budget
 * deferral + auto-continuation mechanism (ENG-510/ENG-1239) that
 * `playwright_browser_take_screenshot` never joined — even though a
 * Playwright-rendered asset loop (e.g. a display-ad size matrix: create_html_file +
 * one screenshot per size) hits the exact same "one batch exceeds the run's wall
 * clock" failure. Without deferral eligibility it just runs until the whole-turn
 * hard cap, with no deferral marker and no auto-resume — production evidence: a
 * 12-size render stopped at 4 with nothing surfaced, then the closing synthesis
 * claimed all 12 (the false-completion-claim guard now catches THAT symptom, but
 * this is the mechanism that let the run truncate unannounced in the first place).
 *
 * Superset of MEDIA_GEN_TOOLS used ONLY for the deferral / asset-count /
 * duration-tracking checks below — deliberately NOT folded into MEDIA_GEN_TOOLS
 * itself, which also drives forced-serial batching (`hasMultipleMediaGenTools`
 * below) and the confirmation-gate-pause check in `mediaGenProducedAsset`, both
 * legitimately specific to rate-limited external generation APIs and not
 * applicable to a local, unrate-limited browser screenshot.
 */
export const DEFERRABLE_ASSET_TOOLS = new Set<string>([
  ...MEDIA_GEN_TOOLS,
  'playwright_browser_take_screenshot',
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

/** Minimal shape of a persisted assistant message this reads — deliberately loose so it
 * doesn't need to import the full ChatMessage type from chatbotService. */
interface HistoryMessageLike {
  role?: string;
  timestamp?: string;
  metadata?: {
    timestamp?: string;
    toolCalls?: Array<{ id?: string; name?: string; arguments?: unknown; result?: any; error?: string; duplicateOf?: string }>;
  } | null;
}

/**
 * ENG-1239: `priorMediaCallKeys` (see executePreparedTools above) only ever contains what
 * the CALLER threads in — every fresh turn starts it as `new Map()`
 * (agentModeService.ts), so a media auto-continuation (a brand-new turn, not a later
 * iteration of the SAME turn) got no code-level dedupe protection at all against the
 * model re-emitting an already-completed generate_image call — only the LLM-prompt
 * "already generated" awareness block, which relies on the model actually obeying it.
 *
 * This reconstructs the identical key shape (`name:stableStringify(args)` →
 * tool_call_id) from PERSISTED session history instead, so a continuation turn can seed
 * the dispatcher's dedupe map with what already actually happened — the dispatcher then
 * refuses a genuine duplicate outright, the same hard guarantee same-turn iterations
 * already get. Only counts a call that actually produced an asset (matches
 * `mediaGenProducedAsset` / `countsAsAsset` above: no error, not deferred, not a
 * confirmation-gate pause) — a failed or deferred call must stay retryable, not be
 * mistaken for a duplicate. Bounded to `sinceMs` so an old, unrelated, coincidentally-
 * identical request from a much earlier session/turn is never treated as a duplicate.
 */
export function seedMediaCallKeysFromHistory(
  messages: HistoryMessageLike[] | undefined | null,
  sinceMs: number,
): Map<string, string> {
  const seeded = new Map<string, string>();
  if (!Array.isArray(messages)) return seeded;
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    const toolCalls = message.metadata?.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    const rawTs = message.timestamp || message.metadata?.timestamp;
    const ts = rawTs ? Date.parse(rawTs) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) continue;
    for (const tc of toolCalls) {
      // ENG-1331: deliberately MEDIA_GEN_TOOLS here, not the broader
      // DEFERRABLE_ASSET_TOOLS — see the dedupe-key check below for why
      // playwright_browser_take_screenshot must stay OUT of this reconstruction.
      if (!tc?.name || !MEDIA_GEN_TOOLS.has(tc.name)) continue;
      if (tc.error || !tc.result || tc.result.deferred === true || tc.result.success === false) continue;
      if (!mediaGenProducedAsset(tc.name, tc.result)) continue;
      const key = `${tc.name}:${stableStringify(tc.arguments)}`;
      if (!seeded.has(key)) seeded.set(key, tc.id || '');
    }
  }
  return seeded;
}

/**
 * ENG-426: session-wide cap on `WEB_SEARCH_TOOL_NAMES` calls. Prod incident: a research
 * turn made 193 web searches (73 file reads, 503 retained messages, 17.4M prompt tokens,
 * $8.68) before an outer time limit ended it — the loop's exact-match anti-loop signature
 * check (name + byte-identical arguments) never caught it, because each search varied its
 * query text. This is a volume cap, not a dedupe: every prior call in the session counts
 * regardless of arguments or outcome, so the model can't outrun it by rephrasing the query.
 *
 * Mirrors Claude Code's own fix for the identical failure mode ("Added a session-wide
 * limit on WebSearch tool calls (default 200) to stop runaway search loops",
 * `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`). Default set well above legitimate heavy
 * single-topic research (rarely >20-30 distinct searches) while decisively catching a
 * runaway. Override with AGENT_MODE_MAX_SEARCH_CALLS_PER_SESSION.
 */
export const SEARCH_CALL_SESSION_CAP = Math.max(
  1,
  parseInt(process.env.AGENT_MODE_MAX_SEARCH_CALLS_PER_SESSION || '60', 10) || 60,
);

/**
 * ENG-426: count prior `WEB_SEARCH_TOOL_NAMES` calls across the WHOLE persisted session
 * history. Deliberately NOT time-bounded (unlike `seedMediaCallKeysFromHistory` above) —
 * a session naturally resets to zero the moment the user starts a new chat (a fresh
 * `sessionId` has empty history), which is AgentMode's equivalent of Claude Code's
 * `/clear`, so there is no old-unrelated-session risk to bound against here. Counts every
 * call regardless of success/failure/arguments: this bounds the tool's volume, it does not
 * detect duplicates.
 */
export function seedSearchCallCountFromHistory(
  messages: HistoryMessageLike[] | undefined | null,
): number {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    const toolCalls = message.metadata?.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      // CodeRabbit (PR #2633): appendSuppressedDuplicate ALSO pushes a ledger entry with
      // the collapsed call's name and a `duplicateOf` id (see executePreparedTools below)
      // so the next LLM turn isn't left with an orphaned tool_call_id — but that entry
      // never actually dispatched (no network call, no budget spent). Counting it here
      // would inflate a later turn's seeded count for a search that only ran once.
      if (tc?.duplicateOf) continue;
      if (tc?.name && WEB_SEARCH_TOOL_NAMES.has(tc.name)) count++;
    }
  }
  return count;
}

/** A tool-result outcome from the gateway, normalized into the loop's union shape. */
/**
 * Owner-scoped tools a share-link visitor (who runs as the owner's userId) must never reach:
 * org settings reads/writes and org/personal memory writes. Memory written here is injected
 * into later owner/org sessions, so a visitor could otherwise poison or delete it.
 */
export const SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS: ReadonlySet<string> = SHARE_VISITOR_BLOCKED_TOOLS;

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
  /**
   * ENG-2263: observe the FULL (pre-minimisation) result of a successful tool call. Optional and
   * observability-only - the ledger stores a minimised result, so anything that needs the real numbers
   * must take them here. Must not throw; a throw is swallowed.
   */
  observeFullToolResult?: (toolName: string, fullResult: any) => void;
  /** extract the minimal result stored on the toolCalls ledger entry */
  extractMinimalToolResult: (result: any, toolName: string) => any;
  /** extract the string content fed back to the model as the tool message */
  extractToolContent: (result: any) => string;
  /** format a tool error into the string the model sees */
  formatToolError: (toolName: string, errorMessage: string) => string;
  /** upload a playwright screenshot data-url to S3; returns { url } or null */
  uploadScreenshotToS3: (dataUrl: string, userId: string) => Promise<{ url: string } | null>;
  /**
   * upload a large tool response to S3; returns { success, key }.
   * It reports failure by RETURNING success:false with `error` — it swallows its
   * own exceptions — so callers must check the result, not just catch (ENG-940).
   */
  uploadFileToS3WithPath: (
    content: string,
    fileName: string,
    contentType: string,
    path: string,
  ) => Promise<{ success: boolean; key?: string; error?: string }>;
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
  /**
   * ENG-2072: tri-state — see ToolContext.isUnattendedRun in mcp/client/toolRegistry.ts.
   * Forwarded verbatim to executePreparedAgentTool so it survives into the tool
   * dispatch context; an explicit `false` (attended) must not collapse to
   * `undefined` on the way through.
   */
  isUnattendedRun?: boolean;
  // ---- skill/tool gating (read-only) ----
  adminSkillToolNames: string[];
  excludeTools?: string[];
  /**
   * ENG-1337: true while the ENG-763 anti-loop directive is active for this turn.
   * The directive forbids write/publish/send tools in prose; this makes it a hard
   * execution-layer deny: any tool not classified read-only (fail-safe allowlist in
   * utils/toolWriteClassification) — including install_skills — is refused before
   * it reaches the gateway. Read-only/verification tools still execute.
   */
  loopBreakerActive?: boolean;
  publishedSkillsCount: number;
  sessionAssociatedSkillIdsCount: number;
  allowedToolNames: Set<string>;
  /** Diagnostic detail for the skill-install gate refusal log (ENG-2299); must not throw. */
  describeGateRefusal?: (toolName: string) => Record<string, unknown>;
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
   * The turn's REAL wall-clock cap (epoch ms) — the ENG-907 budget, set only when the
   * caller actually armed `withGenerationTimeout`. Unlike the two media deadlines above
   * this is not an invented ceiling: callers that impose no cap (scheduled, Slack, GTM,
   * email) leave it undefined. Tools that must return a result before the turn is
   * guillotined bound their own work with it (ENG-1133's lead import).
   */
  turnHardCapMs?: number;
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
  /**
   * ENG-936: optional approved image source URLs that must be used for image
   * revisions. When supplied, a confirm=true `generate_image` call is rejected
   * unless every requested input image is in this allow-list.
   */
  approvedRevisionImageSources?: string[];
  /**
   * ENG-426: count of `WEB_SEARCH_TOOL_NAMES` calls already made this SESSION before
   * this iteration — seeded from persisted history via `seedSearchCallCountFromHistory`
   * plus any earlier iterations of this same turn (the loop accumulates
   * `searchCallsThisIteration` across iterations, same pattern as media asset tracking
   * above). The cap check always runs; defaulting to 0 only means a caller that doesn't
   * thread this through (or a unit test) starts counting from zero for that one call,
   * so cross-iteration/cross-turn accumulation requires wiring it, as agentModeService.ts does.
   */
  priorSearchCallCount?: number;
  /**
   * ENG-922: true once an EARLIER iteration of this same run deferred a media-gen call on
   * the time budget. The media set is then incomplete for the rest of the turn, so any
   * state-changing call (Meta Graph upload/creative/ad, send, publish, ...) the model emits
   * afterwards is deferred instead of acting on the half-finished batch. Read-only calls
   * still run. Undefined/false preserves prior behaviour.
   */
  priorMediaBudgetDeferred?: boolean;
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
  /**
   * ENG-426: number of `WEB_SEARCH_TOOL_NAMES` calls ALLOWED to execute this iteration
   * (i.e. not rejected by the session search-call cap). The loop adds this to its
   * running `priorSearchCallCount` and threads the total into the next iteration, the
   * same accumulate-and-thread pattern as `mediaAssetsProduced`/`mediaAssetsProducedThisRun`.
   */
  searchCallsThisIteration: number;
}

/**
 * ENG-936: normalize image input fields into a single string array for source checks.
 *
 * Review fix: `logo_image` is folded in alongside `inputImages`/`input_images`.
 * `imageGeneration.ts`'s `generateImage()` appends `params.logoImage` onto
 * `params.inputImages` before generating (and `agentModeService.ts`'s own
 * `editsExistingImage` check already treats `inputImages.length > 0 || !!logoImage`
 * as equivalent), so a `logo_image` is a real edit source at execution time — this
 * gate must see it too, or a call with `confirm:true`, no `inputImages`, and an
 * unapproved `logo_image` sails through as "not an edit" and bypasses source
 * validation entirely.
 */
function getInputImages(toolCallArgs: any): string[] {
  const rawInputImages = toolCallArgs?.inputImages ?? toolCallArgs?.input_images;
  const images: string[] = [];
  if (typeof rawInputImages === 'string') {
    images.push(rawInputImages);
  } else if (Array.isArray(rawInputImages)) {
    images.push(...rawInputImages.filter((item): item is string => typeof item === 'string'));
  }

  const logoImage = toolCallArgs?.logo_image ?? toolCallArgs?.logoImage;
  if (typeof logoImage === 'string' && logoImage.length > 0) {
    images.push(logoImage);
  }

  return images;
}

/**
 * ENG-936: ensure a revision-style image edit binds to an explicitly approved
 * source URL before execution. A false pass here means `confirm=true` was issued
 * for the wrong source and must be stopped before gateway execution.
 *
 * ENG-2166 fix: this gate exists to validate an EDIT's source, not to gate
 * `generate_image` in general. `approvedRevisionImageSources` is fixed for an
 * entire run (e.g. revisionService.ts's Slack-driven "revise this asset" flow
 * sets it once for the whole bounded runVerifiedChat call). Previously, once
 * that list was non-empty, EVERY generate_image call for the rest of the run
 * was forced through this check — including plain text-to-image calls that
 * never set inputImages at all and were never attempting an edit. A real
 * customer session hit this: Emma made one approved, confirmed edit, then
 * every subsequent unrelated text-to-image call in the same run failed with
 * "Expected one of: [the one approved URL]. Received none." — permanently
 * blocking all new generations for the rest of the session. A call with no
 * inputImages isn't a revision at all, so this gate must not apply to it
 * regardless of whether an approved-sources list happens to be active.
 */
function isApprovedImageSourceForRevision(
  args: any,
  approvedSources: string[] | undefined,
): { approved: boolean; errorMessage?: string } {
  if (!approvedSources || approvedSources.length === 0) {
    return { approved: true };
  }

  const inputImages = getInputImages(args);
  if (!Array.isArray(inputImages) || inputImages.length === 0) {
    // Not an edit — a plain generation never needs an approved source.
    return { approved: true };
  }

  const mismatch = inputImages.find((url) => !approvedSources.includes(url));
  if (!mismatch) {
    return { approved: true };
  }

  return {
    approved: false,
    errorMessage:
      `generate_image source mismatch under confirmation gate. ` +
      `Expected one of: ${approvedSources.join(', ')}. ` +
      `Received: ${mismatch}`,
  };
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
    isUnattendedRun,
    adminSkillToolNames,
    excludeTools,
    loopBreakerActive = false,
    publishedSkillsCount,
    sessionAssociatedSkillIdsCount,
    allowedToolNames,
    describeGateRefusal,
    toolResponseS3Threshold,
    maxToolContentSize,
    mediaGenerationDeadlineMs,
    mediaAssetsProducedThisRun = 0,
    generationHardCapMs,
    turnHardCapMs,
    longestMediaCallMsThisRun = 0,
    priorMediaCallKeys,
    approvedRevisionImageSources,
    priorSearchCallCount = 0,
    priorMediaBudgetDeferred = false,
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
  // ENG-426: search calls ALLOWED to execute this iteration (see SEARCH_CALL_SESSION_CAP).
  let searchCallsThisIteration = 0;
  // ENG-1945 follow-up: install_skills calls that already ran an eager head-start
  // execution in Phase 1 below (so a sibling call gated by the newly-installed skill,
  // appearing later in this SAME batch, sees it unlocked). Keyed by tool_call_id so
  // Phase 2's runOne can replay this outcome instead of executing install_skills a
  // second time for the identical call — see the eager block below for why a second,
  // independent execution is unsafe rather than merely redundant.
  const eagerToolOutcomes = new Map<string, ToolExecOutcome>();
  // Same, but keyed by (name + args) signature rather than tool_call_id: the eager
  // block below runs BEFORE the shared same-turn dedupe check further down (that
  // check's own suppression bookkeeping — messages/ledger/counters — must stay
  // ordered after every call has had a chance to unlock siblings, so it can't be
  // moved earlier to gate the eager execution itself). Without this, two
  // install_skills calls with IDENTICAL arguments emitted in the same batch (the
  // model repeats itself) would each run the eager execution for real — the second
  // one re-recording a failure/re-mutating session state for a call the later
  // dedupe check goes on to suppress as a duplicate anyway.
  const eagerInstallSkillsByArgs = new Map<string, ToolExecOutcome>();

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
      // ENG-1477: a large or quote-rich value (report titles with a quoted
      // phrase, HTML content with attribute quotes) sometimes comes back with
      // an inner `"` the model failed to escape, which JSON.parse reads as an
      // early string terminator. Retry through a repair pass before failing —
      // see repairToolCallArguments.ts for the observed failure signature.
      const functionArgs = parseToolCallArguments(toolCall.function.arguments);
      // ENG-2597: when the raw arguments needed repair (duplicated object,
      // unescaped quote), store the repaired form on the tool call so the
      // assistant turn persisted to history replays valid JSON next turn.
      normalizeRepairedToolCallArguments(toolCall, functionArgs);

      // Enforce skill-based tool access; block admin-only tools without admin access,
      // block context-restricted/shared-session tools even if the LLM hallucinates them.
      if (!hasAdminAccess && adminSkillToolNames.includes(toolCall.function.name)) {
        const errorMsg = isInteractiveShare
          ? (restrictionRefusal('share_visitor', toolCall.function.name, adminSkillToolNames) as string)
          : `Tool "${toolCall.function.name}" requires admin access. This session does not have admin privileges.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      // A share-link visitor runs under the owner's userId, so owner-only org-settings
      // writes must be refused here rather than by the tool's own role check. The rules live in the
      // share_visitor restriction profile (toolRestrictionProfiles.ts); executeTool enforces the same
      // profile, so a path that does not come through this preflight (voice) is refused there too.
      if (isInteractiveShare) {
        const refusal = restrictionRefusal('share_visitor', toolCall.function.name, adminSkillToolNames);
        if (refusal) {
          appendPreflightToolFailure(toolCall, functionArgs, refusal, JSON.stringify({ error: refusal }));
          continue;
        }
      }

      // ask_user_question passes the ask_ read classifier but halts the run for a question deck.
      if (loopBreakerActive && (
        toolCall.function.name === 'ask_user_question'
        || !isReadOnlyToolName(toolCall.function.name)
      )) {
        const errorMsg = `Tool "${toolCall.function.name}" was not run: the same request has repeated several times, so only read-only or verification tools may run this turn. Do not retry it; use a read-only tool or answer the user directly.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg, deniedBy: 'loop_breaker' }));
        continue;
      }

      if (excludeTools?.includes(toolCall.function.name)) {
        const errorMsg = `Tool "${toolCall.function.name}" is not available in this context.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      // ENG-426: session-wide search-call budget. Checked against calls already
      // ALLOWED (prior turns + earlier this iteration loop), so a call that itself
      // trips the cap is rejected before counting toward its own limit.
      if (WEB_SEARCH_TOOL_NAMES.has(toolCall.function.name)
          && priorSearchCallCount + searchCallsThisIteration >= SEARCH_CALL_SESSION_CAP) {
        const used = priorSearchCallCount + searchCallsThisIteration;
        const errorMsg =
          `Search budget reached: this session has already used ${used} web-search calls `
          + `(limit ${SEARCH_CALL_SESSION_CAP}). Stop searching. Answer now using what you've `
          + `already found, or tell the user you've hit the research limit and ask how they'd `
          + `like to proceed.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      if (publishedSkillsCount > 0 && sessionAssociatedSkillIdsCount > 0 && !allowedToolNames.has(toolCall.function.name)) {
        /*
         * The install directive alone left the model with no instruction for the case where the
         * install ALSO fails. Observed in a live delegated session: the gate refused
         * `audit_ad_utm_coverage`, `install_skills` was refused, and the model then ran an
         * unrelated AD LIST and presented a confident "UTM Tagging Audit Summary — PASS, 6/6
         * tagged" table built from it. A downstream truthfulness guard appended a correction,
         * but underneath the fabricated table — a correction is not a substitute for not
         * fabricating.
         *
         * ENG-1844 review (found while working a different ticket, bundled in per Manan):
         * this used to name ONE specific cause ("for example it is not available on this
         * subscription") and tell the model to assert it plainly. install_skills refuses for
         * FOUR distinct reasons (unentitled/billing, unavailable/catalog gap, unresolved/bad
         * id, forbidden/role) — see `describeRejections` — and ENG-1795 exists specifically
         * because collapsing the non-billing ones into a billing claim is false. This fires
         * BEFORE install_skills ever runs, so asserting a specific cause here pre-empts its
         * own accurate, already-bucketed reason. Defer to that instead of guessing.
         *
         * The prefix is unchanged: `classifyToolErrorClass` keys 'tool_unavailable' off it.
         */
        let gateDetail: Record<string, unknown> = {};
        try { gateDetail = describeGateRefusal ? describeGateRefusal(toolCall.function.name) : {}; } catch { gateDetail = { describeError: true }; }
        try {
          console.warn('[tool-gate-refused]', JSON.stringify({
            sessionId,
            userId,
            tool: String(toolCall.function.name).slice(0, 128),
            allowedToolCount: allowedToolNames.size,
            publishedSkillsCount,
            ...gateDetail,
          }));
        } catch { /* diagnostics must never change the refusal */ }
        const errorMsg = `Tool "${toolCall.function.name}" is not available. You must install the required skill first using install_skills.`
          + ` If install_skills cannot install it, STOP — do NOT guess or assume why (it is not always a billing/subscription limit). Relay install_skills' own response message to the user exactly as it states the reason.`
          + ` Do NOT run a different tool and present its output as this tool's result: reporting that a specific check ran, or passed, is a claim about THAT check, and substituting other data makes the claim false.`;
        appendPreflightToolFailure(toolCall, functionArgs, errorMsg, JSON.stringify({ error: errorMsg }));
        continue;
      }

      const initialPolicyDecision = ports.evaluateAgentToolPolicy({
        toolName: toolCall.function.name,
        args: functionArgs,
        isAdmin: hasAdminAccess,
        isSharedSession: isInteractiveShare,
        enforce: process.env.AGENT_TOOL_GATEWAY_ENFORCE === 'true',
      });

      if (toolCall.function.name === 'install_skills') {
        skillsUpdated = true;
      }

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

      if (toolCall.function.name === 'install_skills') {
        /*
         * ENG-1945: a model very commonly emits install_skills AND a tool that skill
         * gates in the SAME batch ("install the browser skill, then navigate"). Phase 2
         * below runs every prepared call's tool ONLY after this whole Phase-1 loop
         * finishes gating every call in the batch against `allowedToolNames` — so the
         * sibling navigate/snapshot/etc. call, appearing later in this same array, was
         * rejected as "not available" a beat before the install it depends on actually
         * took effect.
         *
         * Run install_skills HERE instead — once, for real, through the gateway — the
         * moment it has cleared every preflight gate every other tool call clears before
         * reaching Phase 2 (schema validation/repair above, policy allow-check just
         * above). That ordering matters, not just for consistency: running it any
         * earlier (e.g. on the raw pre-repair args, before the policy gate) could
         * execute — and mutate session state via addAssociatedSkills — for a call this
         * same loop iteration goes on to preflight-reject a moment later, leaving the
         * model told the call never happened while it actually did.
         *
         * The outcome is cached by tool_call_id in `eagerToolOutcomes` and Phase 2's
         * runOne replays it instead of executing install_skills a SECOND time for the
         * identical call. A second independent execution is not just redundant, it is
         * actively unsafe for the repeated-failure breaker: a rejected install (bad
         * skillId, unentitled skill) classifies as a FAST_TRIP error class
         * (skill_install_refused/subscription_blocked/invalid_args — 2-failure
         * threshold), and the gateway's own failure counter is keyed by run+tool+scope,
         * not by tool_call_id — so two executions of ONE model-emitted call would
         * record two failures and trip the breaker after a single turn instead of two,
         * silently halving the model's real retry budget and replacing install_skills'
         * accurate, bucketed rejection reason with a generic "stop retrying" message on
         * what the model experiences as its very next attempt.
         */
        const argsKey = stableStringify(preparedFunctionArgs);
        let outcome = eagerInstallSkillsByArgs.get(argsKey);
        if (!outcome) {
          // Same execute_tool span shape runOne (Phase 2) creates for every other tool —
          // this eager call is install_skills' only real execution now, so it must be the
          // one carrying the span, or the tool would vanish from OTel entirely.
          const span = startRunChildSpan(agentRuntimeRunId, `${SPAN_EXECUTE_TOOL_PREFIX} install_skills`, {
            [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OP_EXECUTE_TOOL,
            [ATTR_GEN_AI_TOOL_NAME]: 'install_skills',
            [ATTR_SESSION_ID]: sessionId,
          });
          outcome = await ports.executeAgentToolThroughGateway({
            toolName: 'install_skills',
            args: preparedFunctionArgs,
            policyDecision,
            runId: agentRuntimeRunId,
            budgetScopeId: sessionId,
            execute: () => ports.executePreparedAgentTool({
              llmModel,
              toolName: 'install_skills',
              functionArgs: preparedFunctionArgs,
              userId,
              sessionId,
              mockMode,
              isDelegatedAccess,
              isUnattendedRun,
              ...(isInteractiveShare ? { restrictionProfile: 'share_visitor' as const } : {}),
            }),
          });
          endExecuteToolSpan(span, outcome.status === 'error'
            ? { errorClass: classifyToolErrorClass(outcome.error), error: outcome.error }
            : {});
        }
        eagerInstallSkillsByArgs.set(argsKey, outcome);
        eagerToolOutcomes.set(toolCall.id, outcome);
        const result = outcome.status === 'success' ? outcome.result : undefined;
        if (Array.isArray(result?.installedToolNames)) {
          result.installedToolNames.forEach((name: string) => allowedToolNames.add(name));
        }
      }

      if (
        toolCall.function.name === 'generate_image'
        && Array.isArray(approvedRevisionImageSources)
        && approvedRevisionImageSources.length > 0
      ) {
        const sourceCheck = isApprovedImageSourceForRevision(
          preparedFunctionArgs,
          approvedRevisionImageSources,
        );
        if (!sourceCheck.approved) {
          const errorMsg = sourceCheck.errorMessage || 'generate_image rejected: unapproved source image.';
          const guidance = appendRetryabilityGuidance(
            ports.formatToolError(toolCall.function.name, errorMsg),
            'invalid_args',
          );
          appendPreflightToolFailure(
            toolCall,
            preparedFunctionArgs,
            errorMsg,
            guidance,
            policyDecision,
          );
          continue;
        }
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
      // ENG-510: cross-iteration dedupe for MEDIA_GEN_TOOLS only. The per-iteration check
      // above misses an identical generate_image re-emitted in a LATER iteration of the
      // same turn (e.g. resuming after a timeout, the model re-requests an image it already
      // made). Suppress it if that exact call already produced an asset earlier this turn.
      //
      // ENG-1331: deliberately NOT extended to playwright_browser_take_screenshot, unlike
      // the deferral/asset-count/duration checks above. generate_image's dedupe protects
      // against re-paying for an expensive, rate-limited external API call; a screenshot is
      // a cheap local action with the opposite risk profile — this exact template's own QA
      // step ("Fix and re-render failures before delivery") calls for re-taking a screenshot
      // with the SAME dimension-based filename after correcting a problem, and this dedupe
      // would silently swallow that legitimate re-render as a false "already done" duplicate,
      // leaving the broken original in place with no error surfaced. Media-only (not
      // screenshot) so a legitimately-repeated mutating call (send_email) is also never
      // blocked; only successful generations are recorded, so a failed call can still retry.
      if (
        MEDIA_GEN_TOOLS.has(toolCall.function.name)
        && priorMediaCallKeys?.has(dedupeKey)
      ) {
        const duplicateOfId = priorMediaCallKeys.get(dedupeKey) as string;
        suppressedDuplicates.push({ toolCall, functionArgs: preparedFunctionArgs, duplicateOfId });
        continue;
      }
      seenToolCallKeys.set(dedupeKey, toolCall.id);

      // ENG-426: count this call toward the session search-call budget only once it has
      // cleared same-turn/cross-iteration dedupe and is genuinely about to execute — an
      // exact-duplicate call suppressed above never reaches the gateway, so it shouldn't
      // consume budget either.
      if (WEB_SEARCH_TOOL_NAMES.has(toolCall.function.name)) {
        searchCallsThisIteration++;
      }

      preparedCalls.push({ toolCall, functionArgs: preparedFunctionArgs, policyDecision, dedupeKey });
    } catch (error) {
      console.error(`AgentMode: Tool argument parse error for ${toolCall.function.name}:`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      // ENG-124: unparseable args are never retryable as-is — EXCEPT when the
      // arguments were genuinely truncated mid-stream (ENG-1477 follow-up):
      // there is no bad argument to fix there, so "fix your args" is actively
      // wrong guidance and just burns retries on cosmetic variations of an
      // already-complete call. classifyToolErrorClass recognizes
      // TruncatedToolCallArgumentsError by name and routes it to the
      // retryable 'truncated_response' class instead of the hardcoded
      // 'invalid_args' used for every other parse failure.
      const errorContent = appendRetryabilityGuidance(
        ports.formatToolError(toolCall.function.name, `Failed to parse arguments: ${errMsg}`),
        error instanceof TruncatedToolCallArgumentsError ? classifyToolErrorClass(error) : 'invalid_args',
      );
      appendPreflightToolFailure(toolCall, undefined, `Failed to parse arguments: ${errMsg}`, errorContent);
    }
  }

  // Phase 2: Execute tools — sequential if wait_seconds is present (so the wait happens
  // in order) or multiple screenshot calls are batched (see hasMultipleScreenshotCalls),
  // bounded-concurrent when multiple media-gen calls are batched (rate limits), parallel
  // otherwise.
  const hasWaitTool = preparedCalls.some(({ toolCall }) => toolCall.function.name === 'wait_seconds');
  const hasMultipleMediaGenTools = preparedCalls.length > 1 && preparedCalls.some(({ toolCall }) =>
    toolCall.function.name === 'generate_image' || toolCall.function.name === 'generate_video' || toolCall.function.name === 'generate_voiceover'
  );
  // ENG-1331: unlike the 3 rate-limited generation APIs above, multiple
  // playwright_browser_take_screenshot calls in one turn act on the SAME shared browser
  // page (resize-then-screenshot per size) — running them with bounded concurrency would
  // race on that shared state, not just on a provider rate limit. Force strict sequential
  // instead, alongside wait_seconds, so each call's deferral decision also settles
  // race-free against the prior one's result (the plain parallel path below assumes at
  // most one deferrable-asset call ever reaches it — see its comment).
  const hasMultipleScreenshotCalls = preparedCalls.length > 1 && preparedCalls.filter(({ toolCall }) =>
    toolCall.function.name === 'playwright_browser_take_screenshot'
  ).length > 1;

  let toolResults: DispatchToolResult[];

  const runOne = async (toolCall: any, functionArgs: any, policyDecision: AgentToolPolicyDecision): Promise<ToolExecOutcome> => {
    // ENG-1945 follow-up: install_skills already ran (for real, through the gateway) in
    // Phase 1 above so a sibling call gated by it could unlock within the same batch —
    // replay that outcome instead of executing it again. See the Phase-1 eager block for
    // why a second execution is unsafe, not merely redundant.
    const cachedOutcome = eagerToolOutcomes.get(toolCall.id);
    if (cachedOutcome) return cachedOutcome;

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
          isUnattendedRun,
          // ENG-2816: a share-link visitor's tool call carries its restriction down to executeTool, which enforces it
          // again (defence in depth: the preflight above is the model-facing refusal, this is the one every path shares).
          ...(isInteractiveShare ? { restrictionProfile: 'share_visitor' as const } : {}),
          // Long-render tools (compose_video) read this to hand off before the run's hard
          // wall-clock timeout rather than blocking until killed with no asset (ENG-123).
          renderDeadlineMs: mediaGenerationDeadlineMs,
          // Run wall-clock budget deadline so wait_seconds can cap its sleep and not be
          // killed mid-wait by the generation timeout (ENG-124).
          runBudgetDeadlineMs: mediaGenerationDeadlineMs,
          // The turn's real cap, for tools that must hand a result back before the turn
          // is killed (ENG-1133). Deliberately NOT the media deadline above: that one is
          // a soft media-only budget, so it both under-budgets the work and, once it has
          // passed, would report no time left while the turn still has minutes.
          turnHardCapMs,
          // ENG-1945 follow-up: the server's own id for the run THIS call is executing
          // within, so a tool (report_product_issues) can verify a same-turn claim against
          // ground truth instead of requiring the model to know/supply an opaque id.
          agentRuntimeRunId,
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
  // ENG-1331: DEFERRABLE_ASSET_TOOLS (MEDIA_GEN_TOOLS + playwright_browser_take_screenshot)
  // — broader than the name once was, so a Playwright render loop gets the same
  // deferral/asset-counting/duration-tracking treatment as generate_image et al.
  const isDeferrableAssetTool = (toolCall: any) => DEFERRABLE_ASSET_TOOLS.has(toolCall.function.name);
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
    isDeferrableAssetTool(toolCall)
    && (mediaAssetsProducedThisRun + assetsThisBatch) >= 1
    && (softBudgetExceeded() || withinOneMediaCallOfHardCap());
  const makeDeferred = (toolCall: any, functionArgs: any, policyDecision: AgentToolPolicyDecision): DispatchToolResult => {
    mediaBudgetDeferred = true;
    return { status: 'deferred', toolCall, functionArgs, duration: 0, policyDecision };
  };
  // ENG-922: once a media call defers, the media set is INCOMPLETE for this turn. A
  // state-changing non-media call (a Meta Graph upload/creative/ad write, a send, a
  // publish) must not run against it — that is how a half-finished batch leaves
  // orphaned images/creatives on an ad account. Read-only lookups cannot publish or
  // orphan anything, so they still run. An unclassified effect fails CLOSED.
  const isStateChangingDependent = (toolCall: any, policyDecision: AgentToolPolicyDecision | undefined): boolean =>
    !isDeferrableAssetTool(toolCall)
    // Already executed in Phase 1 (e.g. install_skills): replay the real cached outcome.
    && !eagerToolOutcomes.has(toolCall.id)
    && (policyDecision?.effect ?? 'unknown') !== 'read';
  let mediaDeferredThisTurn = priorMediaBudgetDeferred;
  // A genuine media asset: a gateway success that isn't an encoded {success:false}
  // AND actually produced an asset (not a confirmation-gate pause — see
  // mediaGenProducedAsset). Keeps the deferral budget's notion of "an asset exists
  // this batch" consistent with the calledFunctions / mediaAssetsProduced counters.
  const countsAsAsset = (dr: DispatchToolResult): boolean =>
    dr.status === 'success'
    && isDeferrableAssetTool(dr.toolCall)
    && !ports.toolResultError(dr.result)
    && mediaGenProducedAsset(dr.toolCall.function.name, dr.result);
  // ENG-510: track how long a media call actually took so the adaptive reserve (and the
  // value returned to the loop) reflects real latency. Updated as each call settles so a
  // later call in the SAME batch already sees the earlier call's duration.
  const recordMediaDuration = (dr: DispatchToolResult): void => {
    if (isDeferrableAssetTool(dr.toolCall) && dr.status !== 'deferred') {
      longestMediaCallMs = Math.max(longestMediaCallMs, dr.duration || 0);
    }
  };

  if (hasWaitTool || hasMultipleScreenshotCalls) {
    // Strict sequential: wait_seconds must take effect in emission order, so nothing
    // batched with it may overlap it; multiple screenshot calls share one browser page
    // (see hasMultipleScreenshotCalls above) and must not race on it either.
    toolResults = [];
    for (const { toolCall, functionArgs, policyDecision } of preparedCalls) {
      if (shouldDeferMedia(toolCall)) {
        mediaDeferredThisTurn = true;
        toolResults.push(makeDeferred(toolCall, functionArgs, policyDecision));
        continue;
      }
      if (mediaDeferredThisTurn && isStateChangingDependent(toolCall, policyDecision)) {
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
    // ENG-922: media calls run FIRST (bounded batches), non-media calls after. A
    // same-iteration Graph write otherwise races the final image and can publish an
    // incomplete creative set. Results are still written by original index, so the
    // model-visible emission order is preserved.
    const indexed = preparedCalls.map((preparedCall, index) => ({ preparedCall, index }));
    const mediaCalls = indexed.filter(({ preparedCall }) => isDeferrableAssetTool(preparedCall.toolCall));
    const otherCalls = indexed.filter(({ preparedCall }) => !isDeferrableAssetTool(preparedCall.toolCall));
    for (let start = 0; start < mediaCalls.length; start += MEDIA_GEN_MAX_CONCURRENCY) {
      const batch = mediaCalls.slice(start, start + MEDIA_GEN_MAX_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async ({ preparedCall: { toolCall, functionArgs, policyDecision } }) => {
          if (shouldDeferMedia(toolCall)) {
            mediaDeferredThisTurn = true;
            return makeDeferred(toolCall, functionArgs, policyDecision);
          }
          const outcome = await runOne(toolCall, functionArgs, policyDecision);
          return toDispatchResult(outcome, toolCall, functionArgs);
        }),
      );
      batchResults.forEach((dr, i) => {
        if (countsAsAsset(dr)) assetsThisBatch++;
        recordMediaDuration(dr);
        toolResults[batch[i].index] = dr;
      });
    }
    const otherResults = await Promise.all(
      otherCalls.map(async ({ preparedCall: { toolCall, functionArgs, policyDecision } }) => {
        if (mediaDeferredThisTurn && isStateChangingDependent(toolCall, policyDecision)) {
          return makeDeferred(toolCall, functionArgs, policyDecision);
        }
        const outcome = await runOne(toolCall, functionArgs, policyDecision);
        return toDispatchResult(outcome, toolCall, functionArgs);
      }),
    );
    otherResults.forEach((dr, i) => {
      toolResults[otherCalls[i].index] = dr;
    });
  } else {
    // Parallel path carries at most one deferrable-asset call (a solo call; a media-gen
    // call batched with other tools forces the bounded-concurrency path above, and 2+
    // screenshot calls force the strict-sequential path above), so a single pre-launch
    // deferral check is race-free.
    const toolPromises = preparedCalls.map(async ({ toolCall, functionArgs, policyDecision }) => {
      if (shouldDeferMedia(toolCall)) {
        return makeDeferred(toolCall, functionArgs, policyDecision);
      }
      // ENG-922: an earlier iteration already deferred media this turn — hold back
      // state-changing calls so they never act on the incomplete set.
      if (mediaDeferredThisTurn && isStateChangingDependent(toolCall, policyDecision)) {
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
      try { ports.observeFullToolResult?.(toolCall.function.name, processedResult); } catch { /* observability only */ }

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

        // Track media/deferrable assets produced this iteration so the loop can carry a
        // running per-run total into the next call's time-budget decision (ENG-1331:
        // includes playwright_browser_take_screenshot, consistent with shouldDeferMedia's
        // "≥1 asset produced this batch" gate above).
        if (DEFERRABLE_ASSET_TOOLS.has(toolCall.function.name)) {
          mediaAssetsProduced += 1;
        }
      }

      // For playwright screenshots, pass the image back to the LLM as a vision input —
      // but only to a model that can actually take one.
      //
      // ENG-2132: this used to gate on `!isGeminiModel` alone, added in a0e5523ce for a
      // DIFFERENT, Gemini-specific reason (its OpenAI-compat endpoint 400s on `image_url`
      // inside a tool-role message regardless of vision capability). That condition
      // silently assumed every OTHER model accepts an inline image, which is false for a
      // model with no verified vision support at all — openrouter/deepseek/deepseek-v4-flash
      // has no `supportsVision` entry in LLM_MODEL_REGISTRY, so OpenRouter has no endpoint
      // for it that accepts image input, and the next LLM call 404s with "No endpoints
      // found that support image input" (prod session ffe0e1ad-16f4-4ca6-ada2-3bc87c3d3761,
      // 2026-09-23). Use the SAME registry flag getVisionModelOptions already trusts for
      // this, rather than inferring capability from "isn't Gemini".
      let toolContent: any;
      const isGeminiModel = llmModel.startsWith('gemini-');
      const modelSupportsInlineScreenshot = !isGeminiModel && LLM_MODEL_REGISTRY[llmModel]?.supportsVision === true;
      if (toolCall.function.name === 'playwright_browser_take_screenshot' && (processedResult as any).dataUrl && modelSupportsInlineScreenshot) {
        toolContent = [
          { type: 'text', text: 'Screenshot captured. Analyze the image below to verify the result visually. Do not include the raw image URL or data URI in your response to the user.' },
          { type: 'image_url', image_url: { url: (processedResult as any).dataUrl, detail: 'high' } },
        ];
      } else if (toolCall.function.name === 'playwright_browser_take_screenshot' && (processedResult as any).screenshotUrl) {
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
        // ENG-940: this offload is the ONLY thing that keeps the payload readable
        // once the trimmer compresses this message, so a failure here is not a
        // cosmetic miss — it is silent data loss on a later turn. Retry once (the
        // common failure is a transient S3 blip), and if it still cannot be stored
        // say so in the message rather than letting it pass for a small response.
        // Note uploadFileToS3WithPath reports failure by RETURNING {success:false};
        // the catch only covers a port that throws.
        let uploadedKey: string | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 2 && !uploadedKey; attempt++) {
          try {
            const uploadResult = await ports.uploadFileToS3WithPath(
              toolContent,
              `${toolCall.id}.txt`,
              'text/plain',
              `tool-responses/${sessionId}`,
            );
            if (uploadResult.success && uploadResult.key) uploadedKey = uploadResult.key;
            else lastError = uploadResult.error;
          } catch (e) {
            lastError = e;
          }
        }

        if (uploadedKey) {
          const header = buildToolResponseS3Header(uploadedKey, toolContent.length);
          // ENG-1054: seal the slice instead of leaving the JSON it cut open. A bare
          // substring lands mid-string/mid-object, and a model handed an unterminated
          // structure completes it rather than answering — that is where the
          // production `}]` final answer came from.
          const preview = toolContent.length > S3_IN_MEMORY_CAP
            ? sealTruncatedPayload(toolContent.substring(0, S3_IN_MEMORY_CAP))
            : toolContent;
          toolContent = header + preview;
        } else {
          console.error(
            `AgentMode: Failed to save large ${toolCall.function.name} response ` +
            `(${toolContent.length} chars) to S3 after 2 attempts:`,
            lastError,
          );
          // Keep the payload in full for THIS turn — it is now the only copy —
          // and prepend the notice so the loss is visible on every later turn.
          toolContent = buildToolResponseUnavailableHeader(toolContent.length) + toolContent;
        }
      }

      // ENG-1054: seal here too. This cap is a SECOND bare cut on the same payload,
      // reached when the S3 offload above failed and left the content full-size —
      // an unsealed slice here would reopen the JSON just as the preview one did.
      const truncatedToolContent = typeof toolContent === 'string' && toolContent.length > maxToolContentSize
        ? sealTruncatedPayloadWithNotice(
          toolContent.substring(0, maxToolContentSize),
          '[Content truncated for storage — original size: ' + toolContent.length + ' chars]',
        )
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
      // The content tells the model to stop generating now and summarize what's done;
      // the server's automatic continuation (ENG-1239/ENG-2371) resumes the batch without
      // asking the customer to reply "continue" and without regenerating saved images.
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
        + `Do NOT call ${toolCall.function.name} again right now. Instead: briefly tell the user how many assets are done versus still remaining and that the rest will continue automatically. `
        + `Do NOT ask the user to reply "continue" — the server resumes the batch automatically (ENG-2371) and generates ONLY the still-missing assets.`;
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
        // CodeRabbit (PR #2479): mediaBudgetDeferred must mean exactly what it says — a
        // genuine per-turn media time-budget pause — not any deferral. A handler-supplied
        // deferral (ENG-822's anonymous-account-scoped refusal, or any future one) carries
        // its own unrelated reason and is a deliberate, permanent policy decision, never
        // meant to be auto-retried. Durability checks (hasPersistedMediaBudgetDeferral,
        // hasUnresolvedMediaDeferral) key off exactly this flag to decide whether to
        // auto-resume, so tagging it unconditionally would have made those checks retry a
        // policy refusal as if it were a timing issue.
        metadata: { timestamp: new Date().toISOString(), ...(handlerDeferral ? {} : { mediaBudgetDeferred: true }) },
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

      // ENG-1626 / ENG-1636: a ToolResultPolicyBlockedError (result.blocked===true
      // + a reason, e.g. set_work_plan_status's out-of-order/missing-calls/
      // insufficient-assets gates) is the tool refusing BY DESIGN, not a
      // malfunction. agentToolGatewayService already excludes these from the
      // repeated-failure breaker for the same reason; this counter feeds
      // session.failedFunctions, the exact field the failure-cluster telemetry
      // and this issue's "failed 2x" reading were built from, so it needs the
      // same carve-out or a self-correcting gate refusal reads as an infra flake.
      if (!(error instanceof ToolResultPolicyBlockedError)) {
        failedCounterUpdates[toolCall.function.name] =
          (failedCounterUpdates[toolCall.function.name] || 0) + 1;
      }

      // ENG-124: the model-visible error carries (a) what failed (formatToolError
      // names the tool + reason, with per-tool fix text), and (b+c) an explicit
      // retryable yes/no verdict + actionable next step derived from the same
      // classifier the telemetry uses — so a terminal failure (auth, provider
      // rejection, schema reject) carries a hard stop signal instead of inviting
      // a retry spiral.
      //
      // ENG-2086: unlike the success path above, this branch had no size guard at
      // all. A tool can fail by echoing its own (unbounded) result back inside
      // `error` — call_google_ads_reporting_api's serving_chain mode does exactly
      // this, JSON.stringify-ing the full campaign/ad-group/keyword tree into
      // `error` whenever the account isn't fully READY/DELIVERING. For a large
      // account that reached multiple MB, went out to the LLM provider unbounded
      // (this branch is on the hot path to the next request, not just persistence),
      // and OpenRouter/Gemini 400'd on the oversized request — surfaced to the user
      // as an opaque "please rephrase" (prod session d02669e9-c3b8-4b65-ab51-a9c045c63b65,
      // 2026-09-22).
      //
      // Cap the FINAL assembled content, not the raw message: formatToolError's
      // per-tool fix text and appendRetryabilityGuidance's verdict line are each
      // appended AFTER this point, so bounding only the raw message would still
      // let their added text push the actual wire content past maxToolContentSize.
      const errMsg = error instanceof Error ? error.message : String(error);
      const formattedError = appendRetryabilityGuidance(
        ports.formatToolError(toolCall.function.name, errMsg),
        classifyToolErrorClass(error),
      );
      let errorContent = formattedError;
      if (formattedError.length > maxToolContentSize) {
        const notice = `[Error message truncated for size — original length: ${formattedError.length} chars]`;
        // Reserve room for the notice AND the '\n\n' separator sealTruncatedPayload
        // inserts before it — otherwise appending the notice after slicing to the
        // full cap pushes the sealed result past maxToolContentSize (CodeRabbit,
        // PR #3039). Mirrors messageSizeGuard.ts's fitContent, which reserves the
        // same way for the DynamoDB persistence cap.
        const sliceBudget = Math.max(0, maxToolContentSize - notice.length - 2);
        errorContent = sealTruncatedPayloadWithNotice(formattedError.substring(0, sliceBudget), notice);
      }
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

  return { pendingCounterUpdates, failedCounterUpdates, skillsUpdated, mediaAssetsProduced, mediaBudgetDeferred, longestMediaCallMs, producedMediaCallKeys, searchCallsThisIteration };
}
