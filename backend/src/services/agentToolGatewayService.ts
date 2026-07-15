import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { isFastTripErrorClass } from './agentMode/core/errorRetryability';

export type AgentToolEffect =
  | 'read'
  | 'session_state'
  | 'internal_write'
  | 'external_send'
  | 'external_publish'
  | 'admin'
  | 'destructive'
  | 'unknown';

export type AgentToolRisk = 'low' | 'medium' | 'high';
export type AgentToolPolicySeverity = 'info' | 'warning' | 'critical';

export interface AgentToolPolicyFlag {
  code: string;
  severity: AgentToolPolicySeverity;
  message: string;
}

export interface AgentToolPolicyDecision {
  toolName: string;
  mode: 'observe' | 'enforce';
  allowed: boolean;
  effect: AgentToolEffect;
  risk: AgentToolRisk;
  flags: AgentToolPolicyFlag[];
}

export interface AgentToolPolicyInput {
  toolName: string;
  args?: unknown;
  isAdmin?: boolean;
  isSharedSession?: boolean;
  enforce?: boolean;
}

export interface AgentToolGatewayExecutionInput extends AgentToolPolicyInput {
  policyDecision?: AgentToolPolicyDecision;
  execute: () => Promise<unknown>;
  now?: () => number;
  /** AgentRun id scoping the repeated-failure breaker. No runId = no breaker. */
  runId?: string;
  /** Optional broader scope for expensive-media retry budgets, usually the chat session id. */
  budgetScopeId?: string;
}

export interface AgentToolContractValidationInput {
  toolName: string;
  args: unknown;
  inputSchema?: any;
  effect?: AgentToolEffect;
}

export interface AgentToolContractIssue {
  code: 'missing_required' | 'unknown_property' | 'type_mismatch' | 'invalid_args';
  path: string;
  message: string;
}

export type AgentToolContractValidationResult =
  | {
      status: 'valid';
      args: unknown;
      issues: AgentToolContractIssue[];
      repairs: string[];
    }
  | {
      status: 'repaired';
      args: unknown;
      issues: AgentToolContractIssue[];
      repairs: string[];
    }
  | {
      status: 'invalid';
      args: unknown;
      issues: AgentToolContractIssue[];
      repairs: string[];
      modelMessage: string;
    };

export type AgentToolGatewayExecutionOutcome =
  | {
      status: 'success';
      result: unknown;
      policyDecision: AgentToolPolicyDecision;
      durationMs: number;
    }
  | {
      status: 'error';
      error: unknown;
      policyDecision: AgentToolPolicyDecision;
      durationMs: number;
    };

export class AgentToolPolicyBlockedError extends Error {
  constructor(readonly policyDecision: AgentToolPolicyDecision) {
    super(`Tool "${policyDecision.toolName}" was blocked by Agent Tool Gateway policy.`);
    this.name = 'AgentToolPolicyBlockedError';
  }
}

export class AgentToolContractValidationError extends Error {
  constructor(readonly validation: Extract<AgentToolContractValidationResult, { status: 'invalid' }>) {
    super(validation.modelMessage);
    this.name = 'AgentToolContractValidationError';
  }
}

export class AgentToolRepeatedFailureError extends Error {
  constructor(
    readonly toolName: string,
    readonly failureCount: number,
    readonly lastErrorMessage: string,
    // ENG-167: 'timeout' surfaces a distinct, timeout-specific stop signal — a tool
    // that keeps timing out has no arguments to "fix", so the generic repeated-error
    // guidance is misleading and let the model keep retrying the slow tool.
    readonly reason: 'repeated' | 'timeout' = 'repeated',
    // ENG-167 follow-up: verified against the real session's turn-4 event timeline —
    // the model DID call report_product_issues successfully, but nothing told it to
    // stop there, so it immediately retried the same tool again, hung for 900s, and
    // the user never learned the bug had already been filed. When a run has already
    // filed a report, the stop message must say so and forbid filing a second one —
    // repeating the generic "offer to file a bug report" suggestion here is exactly
    // what let the model think it still needed to act on report_product_issues.
    readonly alreadyReportedThisRun: boolean = false,
    // ENG-167 follow-up (Greptile): when the SESSION-scoped breaker trips on a brand-
    // new run, `failureCount` is the cross-run aggregate — the tool may not have been
    // called at all yet in this run. Saying "in this run" here is factually wrong and
    // contradicts the model's own tool-call history, undermining trust in the stop
    // guidance. Scope the wording to where the count actually came from.
    readonly scope: 'run' | 'session' = 'run',
  ) {
    const timeoutScopePhrase = scope === 'session'
      ? `${failureCount} times across your recent turns in this chat session (not just this run)`
      : `${failureCount} times in this run`;
    super(
      reason === 'timeout'
        ? (alreadyReportedThisRun
          ? `Tool "${toolName}" has timed out ${timeoutScopePhrase} and is consistently unable to complete in time. ` +
            'STOP retrying it — retrying will keep timing out. You already filed a bug report for this via report_product_issues ' +
            '— do NOT file another. Deliver whatever you have already produced, tell the user this step timed out and ' +
            'that a bug report was already filed for it, and wrap up your turn now.'
          : `Tool "${toolName}" has timed out ${timeoutScopePhrase} and is consistently unable to complete in time. ` +
            'STOP retrying it — retrying will keep timing out. Deliver whatever you have already produced, tell the user this step ' +
            'timed out and could not be completed, and offer either to try a smaller/simpler version or to file a bug report on ' +
            'their behalf with report_product_issues.')
        : `Tool "${toolName}" already failed ${failureCount} times in this run with the same error: "${lastErrorMessage}". ` +
          'Do not retry it with the same approach. Fix the arguments to address that exact error, use a different tool, ' +
          'or tell the user what is blocking you.',
    );
    this.name = 'AgentToolRepeatedFailureError';
  }
}

export class AgentToolBudgetExceededError extends Error {
  constructor(
    readonly toolName: string,
    readonly failureCount: number,
    readonly budget: number,
    readonly scopeLabel: 'run' | 'session' = 'run',
  ) {
    super(
      `Tool "${toolName}" already failed ${failureCount} time(s) in this ${scopeLabel}, reaching its retry budget of ${budget}. ` +
      `Do not call it again in this ${scopeLabel}. Use the best available fallback, simplify the request, or tell the user what is blocking you.`,
    );
    this.name = 'AgentToolBudgetExceededError';
  }
}

// Per-run repeated-failure breaker. The June 9–12 telemetry showed a single run
// retrying linkedin_outreach 15 times in 16s against the same two errors — the
// model gets no signal to stop, so the gateway provides one. Counts are keyed
// by (runId, toolName, error head); a success for the tool clears its counts.
//
// ENG-124: NON-retryable error classes (auth / upstream_rejected / invalid_args /
// tool_unavailable / invalid_output — see core/errorRetryability.ts) trip one
// attempt earlier (threshold 2): for those classes an identical retry is
// KNOWN-pointless, so a second identical failure is already a spiral. The class
// is derived from the stored error head via the same classifier the telemetry
// uses, so breaker accounting and error taxonomy stay in lockstep.
const REPEATED_FAILURE_THRESHOLD = 3;
const NON_RETRYABLE_FAILURE_THRESHOLD = 2;
// ENG-167: timeouts are retryable per-error-head (a single timeout message trips at
// REPEATED_FAILURE_THRESHOLD), but a heavy tool that keeps timing out reports a
// slightly DIFFERENT message each attempt ("connection timed out after Nms", an
// AbortError, a Bedrock "ModelTimeoutException"), so no single head ever reaches the
// threshold and the model retried the same ~2-min tool until the run was exhausted —
// never reaching any other tool (including report_product_issues). Aggregate timeout-
// class failures for a tool across differing messages and trip at this count. Kept at
// 3 so a tool that succeeds after one or two transient timeouts is never blocked.
const TIMEOUT_FAILURE_THRESHOLD = 3;
// ENG-167 follow-up: the run-scoped aggregate above only ever sees ONE run. Verified
// against the actual production session that filed ENG-167 — create_html_file failed
// 6 times total across 4 SEPARATE ~10-minute turns (the user re-sending "try again"
// mints a brand-new runId with a zeroed counter each time), never once reaching 3
// within a single run. The run-scoped breaker never tripped, so the user hit the
// agentModeController.ts hard 10-minute wall-clock timeout on every turn instead.
// Aggregate timeout-class failures by SESSION (budgetScopeId) as well, across runs,
// and trip earlier (2, not 3) — each unit here already cost the user up to a full
// 10-minute controller-bounded turn, so waiting for a 3rd is needlessly slow.
const SESSION_TIMEOUT_FAILURE_THRESHOLD = 2;
const EXPENSIVE_MEDIA_FAILURE_BUDGET = 2;
const MAX_TRACKED_RUNS = 500;
const ERROR_KEY_LENGTH = 80;

const EXPENSIVE_MEDIA_TOOLS = new Set([
  'generate_image',
  'describe_image',
]);

const runFailureCounts = new Map<string, Map<string, number>>();

export function _resetAgentToolFailureBreaker(): void {
  runFailureCounts.clear();
}

function errorHead(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return message.slice(0, ERROR_KEY_LENGTH);
}

// ENG-182: LinkedIn per-recipient write actions carry a recipient identity in
// their args. Keyed on (tool, error-head) alone, a terminal per-recipient refusal
// ("Cannot resend yet" — an upstream_rejected fast-trip class, threshold 2) from
// two DIFFERENT profiles trips the breaker for linkedin_outreach as a whole, then
// blocks send-invite to genuinely different recipients that were never attempted.
// Isolate the failure accounting per recipient so a "already invited" for profile
// A does not block an invite to profile B. Every other tool (and any LinkedIn
// action without a recipient, e.g. search-people) returns '' — a single shared
// scope, exactly preserving the prior per-tool behavior.
//
// send-invite/send-message/send-inmail/get-profile/update-conversation-history
// identify the recipient by profile_url or provider_id; accept-invitation/
// cancel-invitation identify it by invitation_id (see agentModeService.ts). Read
// whichever this action actually carries so every allowlisted action resolves to
// a real per-recipient scope instead of ''.
//
// ENG-313: get-profile must be scoped too. When the model first calls get-profile
// with only keywords (no profile_url/provider_id) it fails "Either profile_url or
// provider_id is required" — an invalid_args fast-trip (threshold 2). Without a
// recipient scope those two arg-less failures shared scope '' with a LATER,
// corrected call that finally passed a valid profile_url, so the breaker blocked
// the corrected call. Scoping get-profile by its target means the arg-less
// failures (scope '') and the corrected call (scope = the profile URL) land in
// different buckets, so a materially different, now-valid attempt is not blocked.
const LINKEDIN_RECIPIENT_ACTIONS = new Set([
  'send-invite',
  'send-message',
  'send-inmail',
  'get-profile',
  'update-conversation-history',
  'cancel-invitation',
  'accept-invitation',
]);

// ENG-291: get_chat_history (the Daily Satisfaction Score Report's data source)
// is expensive in proportion to its request COST — a wide time window with a high
// limit and sync=true (which generates satisfaction scores on the fly) can take
// long enough to hit the tool timeout. When the report's heavy 24h/limit=1000/
// sync=true call timed out twice, the SESSION-scoped timeout breaker tripped and
// then hard-blocked EVERY later get_chat_history in the session — including the
// legitimate recovery paths the report tried next (the same window with sync=false,
// and a much smaller 6h window). The model was told "STOP retrying" and never got
// to run the cheaper request that would have completed. Scope the breaker by the
// request's cost signature (sync flag + limit + window-duration) — exactly like the
// per-recipient LinkedIn scoping above — so a materially cheaper/smaller call lands
// in a different bucket and is not blocked by an expensive call's timeouts. An
// IDENTICAL heavy request still shares one scope, so a genuine retry spiral on the
// same call is still caught.
function chatHistoryFailureScope(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  const sync = record.sync === true || record.sync === 'true' ? '1' : '0';
  const rawLimit = Number(record.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 500;
  const start = typeof record.start_time === 'string' ? Date.parse(record.start_time) : NaN;
  const end = typeof record.end_time === 'string' ? Date.parse(record.end_time) : NaN;
  const hours = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? Math.max(1, Math.round((end - start) / 3_600_000))
    : 0;
  return `sync=${sync}|limit=${limit}|hours=${hours}`;
}

function failureScope(toolName: string, args: unknown): string {
  if (toolName === 'get_chat_history') return chatHistoryFailureScope(args);
  if (toolName !== 'linkedin_outreach') return '';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  const action = typeof record.action === 'string' ? record.action.toLowerCase() : '';
  if (!LINKEDIN_RECIPIENT_ACTIONS.has(action)) return '';
  const target = typeof record.profile_url === 'string' && record.profile_url.trim()
    ? record.profile_url
    : typeof record.provider_id === 'string' && record.provider_id.trim()
    ? record.provider_id
    : typeof record.invitation_id === 'string' && record.invitation_id.trim()
    ? record.invitation_id
    : '';
  // Normalize so the same recipient with a trailing slash or query params
  // (LinkedIn appends miniProfileUrn tracking) collapses to one scope.
  return target.trim().toLowerCase().split('?')[0].replace(/\/+$/, '').slice(0, ERROR_KEY_LENGTH);
}

function getRunCounts(runId: string): Map<string, number> {
  let counts = runFailureCounts.get(runId);
  if (!counts) {
    counts = new Map();
    runFailureCounts.set(runId, counts);
    if (runFailureCounts.size > MAX_TRACKED_RUNS) {
      const oldest = runFailureCounts.keys().next().value;
      if (oldest !== undefined) runFailureCounts.delete(oldest);
    }
  }
  return counts;
}

// ENG-167 follow-up: a leading NUL byte can never prefix-match a real tool name key
// (`${toolName}\0...`), so this marker is safe to store in the SAME per-run counts
// map without a dedicated structure/eviction policy of its own.
const REPORTED_ISSUE_MARKER = '\0report_product_issues_filed';

/** Mark that report_product_issues succeeded in this run (ENG-167 follow-up) — so a
 * later timeout stop-message can tell the model not to file a second report. */
function markReportedIssue(runId: string): void {
  getRunCounts(runId).set(REPORTED_ISSUE_MARKER, 1);
}

function hasReportedIssue(runId: string): boolean {
  return runFailureCounts.get(runId)?.has(REPORTED_ISSUE_MARKER) ?? false;
}

/** Breaker threshold for one (tool, error-head) key: non-retryable classes trip
 * at 2 (identical retry is known-pointless), transient/unknown classes at 3.
 * Classified from the stored error head — same classifier as the telemetry. */
function failureThresholdFor(errorMessageHead: string): number {
  return isFastTripErrorClass(classifyToolErrorClass(errorMessageHead))
    ? NON_RETRYABLE_FAILURE_THRESHOLD
    : REPEATED_FAILURE_THRESHOLD;
}

/** Sum this tool's failures (within one recipient scope, ENG-182) whose stored
 * error head classifies as `timeout`, regardless of the exact wording (ENG-167).
 * Returns null when there are none. */
function countTimeoutFailures(
  id: string,
  toolName: string,
  scope: string,
): { count: number; errorMessage: string } | null {
  const counts = runFailureCounts.get(id);
  if (!counts) return null;
  const prefix = `${toolName}\0${scope}\0`;
  let total = 0;
  let sampleMessage = '';
  for (const [key, count] of counts) {
    if (!key.startsWith(prefix)) continue;
    const errorMessage = key.slice(prefix.length);
    if (classifyToolErrorClass(errorMessage) !== 'timeout') continue;
    total += count;
    if (!sampleMessage) sampleMessage = errorMessage;
  }
  return total > 0 ? { count: total, errorMessage: sampleMessage } : null;
}

function findTrippedFailure(
  runId: string,
  toolName: string,
  scope: string,
): { count: number; errorMessage: string; reason: 'repeated' | 'timeout' } | null {
  const counts = runFailureCounts.get(runId);
  if (!counts) return null;
  const prefix = `${toolName}\0${scope}\0`;
  // Timeout aggregate first so a spiral of same-tool timeouts (identical OR varied
  // wording) yields the timeout-specific stop guidance instead of the generic one.
  const timeoutAgg = countTimeoutFailures(runId, toolName, scope);
  if (timeoutAgg && timeoutAgg.count >= TIMEOUT_FAILURE_THRESHOLD) {
    return { ...timeoutAgg, reason: 'timeout' };
  }
  for (const [key, count] of counts) {
    if (!key.startsWith(prefix)) continue;
    const errorMessage = key.slice(prefix.length);
    if (count >= failureThresholdFor(errorMessage)) {
      return { count, errorMessage, reason: 'repeated' };
    }
  }
  return null;
}

/** Cross-run session aggregate for timeout-class failures (ENG-167 follow-up).
 * `countTimeoutFailures` is generic over the id it's keyed by, so passing the
 * session's budgetScopeId here reuses the exact same per-tool aggregation the
 * run-scoped check uses — just accumulated across every run in the session. */
function findTrippedSessionTimeout(
  budgetScopeId: string,
  toolName: string,
  scope: string,
): { count: number; errorMessage: string; reason: 'timeout' } | null {
  const timeoutAgg = countTimeoutFailures(budgetScopeId, toolName, scope);
  if (timeoutAgg && timeoutAgg.count >= SESSION_TIMEOUT_FAILURE_THRESHOLD) {
    return { ...timeoutAgg, reason: 'timeout' };
  }
  return null;
}

/** Whether a failure for this tool should also be recorded into the session-wide
 * (budgetScopeId) bucket, not just the per-run one. True for the pre-existing
 * expensive-media budget tools, and now also for any timeout-class failure
 * (ENG-167 follow-up) — a tool that's timing out is a session-wide signal, not
 * a per-run one, since the model retries it across separate user turns/runs. */
function shouldTrackInSessionScope(toolName: string, error: unknown): boolean {
  return mediaFailureBudget(toolName) != null || classifyToolErrorClass(error) === 'timeout';
}

function mediaFailureBudget(toolName: string): number | null {
  return EXPENSIVE_MEDIA_TOOLS.has(toolName) ? EXPENSIVE_MEDIA_FAILURE_BUDGET : null;
}

function countToolFailures(runId: string, toolName: string): number {
  const counts = runFailureCounts.get(runId);
  if (!counts) return 0;
  const prefix = `${toolName}\0`;
  let total = 0;
  for (const [key, count] of counts) {
    if (key.startsWith(prefix)) total += count;
  }
  return total;
}

function findTrippedBudget(runId: string, toolName: string): { count: number; budget: number } | null {
  const budget = mediaFailureBudget(toolName);
  if (budget == null) return null;
  const count = countToolFailures(runId, toolName);
  return count >= budget ? { count, budget } : null;
}

function recordToolFailure(runId: string, toolName: string, args: unknown, error: unknown): void {
  const counts = getRunCounts(runId);
  const key = `${toolName}\0${failureScope(toolName, args)}\0${errorHead(error)}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function clearToolFailures(runId: string, toolName: string, args: unknown): void {
  const counts = runFailureCounts.get(runId);
  if (!counts) return;
  // ENG-182: scope the clear to the SAME recipient that succeeded. A tool-wide
  // clear (prefix `${toolName}\0`) would let a success for recipient B wipe a
  // tripped/pending breaker for an unrelated recipient A, re-enabling the wasted
  // retries the per-recipient isolation exists to prevent. Non-recipient tools
  // resolve to scope '' — prefix `${toolName}\0\0` — preserving prior behavior.
  const prefix = `${toolName}\0${failureScope(toolName, args)}\0`;
  for (const key of counts.keys()) {
    if (key.startsWith(prefix)) counts.delete(key);
  }
}

const SIDE_EFFECTING_PREFIXES = [
  'add_',
  'create_',
  'delete_',
  'freeze_',
  'launch_',
  'manage_',
  'publish_',
  'send_',
  'set_',
  'update_',
];

const EXTERNAL_SEND_TOOLS = new Set([
  'send_email',
  'linkedin_outreach',
]);

const EXTERNAL_PUBLISH_TOOLS = new Set([
  'publish_blog_article',
  'publish_landing_page_changes',
]);

const SESSION_STATE_TOOLS = new Set([
  'install_skills',
  'set_work_plan_status',
  'save_memory',
]);

const READ_TOOLS = new Set([
  'you_search_web',
  'you_search_news',
  'google_search_web',
]);

const INTERNAL_WRITE_TOOLS = new Set([
  'save_file',
  'create_gtm_plan',
  'create_task_from_prompt',
  'create_work_plan',
]);

const READ_PREFIXES = [
  'ask_',
  'assess_',
  'describe_',
  'find_',
  'get_',
  'list_',
  'read_',
  'search_',
];

const DEFAULT_ARG_ALIASES: Record<string, string[]> = {
  content_draft: [
    'html_content',
    'content',
    'body',
    'text',
    'markdown',
    'draft',
    'document_content',
    'article_content',
  ],
  title_draft: ['title', 'headline', 'subject'],
  file_name: ['filename', 'fileName', 'name'],
  file_content: ['content', 'file', 'text', 'body', 'html_content', 'markdown'],
  file_url: ['url', 'fileUrl', 'file', 'href', 'link'],
  s3_key: ['s3Key', 'key', 'file_key', 'storage_key', 'object_key'],
  query: ['search_query', 'search', 'q', 'term'],
  page_id: ['pageId', 'landing_page_id', 'landingPageId'],
  task_description: ['instructions', 'instruction', 'prompt', 'task', 'description'],
  operations_json: ['replacement_json', 'operations', 'replacements', 'replacement_instructions'],
};

export function evaluateAgentToolPolicy(input: AgentToolPolicyInput): AgentToolPolicyDecision {
  const toolName = input.toolName || 'unknown';
  const effect = classifyToolEffect(toolName, input.args);
  const flags: AgentToolPolicyFlag[] = [];

  if (effect !== 'read') {
    flags.push({
      code: 'side_effecting_tool',
      severity: effect === 'session_state' ? 'info' : 'warning',
      message: `${toolName} can change state; record why it was selected and verify the outcome.`,
    });
  }

  if (effect === 'external_send' || effect === 'external_publish' || effect === 'destructive') {
    flags.push({
      code: 'confirmation_recommended',
      severity: 'critical',
      message: `${toolName} can affect external systems or delete data; require explicit user confirmation before enforcing this tool.`,
    });
  }

  if (input.isSharedSession && effect !== 'read' && effect !== 'session_state') {
    flags.push({
      code: 'shared_session_side_effect',
      severity: 'critical',
      message: `${toolName} is side-effecting inside a shared session.`,
    });
  }

  if (toolName === 'create_gtm_plan' && looksLikeTaskRequest(input.args)) {
    flags.push({
      code: 'possible_task_tool_mismatch',
      severity: 'warning',
      message: 'create_gtm_plan was selected for wording that looks like a task or follow-up. Prefer create_task_from_prompt when the user asked for a tracked task.',
    });
  }

  const risk = computeRisk(effect, flags);
  const enforce = input.enforce === true;

  return {
    toolName,
    mode: enforce ? 'enforce' : 'observe',
    allowed: !enforce || !flags.some((flag) => flag.severity === 'critical'),
    effect,
    risk,
    flags,
  };
}

export function validateAndRepairToolArgs(
  input: AgentToolContractValidationInput,
): AgentToolContractValidationResult {
  const schema = input.inputSchema;
  const issues: AgentToolContractIssue[] = [];
  const repairs: string[] = [];

  if (!schema || schema.type !== 'object') {
    return { status: 'valid', args: input.args, issues, repairs };
  }

  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
    return {
      status: 'invalid',
      args: input.args,
      issues: [{
        code: 'invalid_args',
        path: '$',
        message: `Tool "${input.toolName}" arguments must be a JSON object.`,
      }],
      repairs,
      modelMessage: buildSchemaRetryMessage(input.toolName, [{
        code: 'invalid_args',
        path: '$',
        message: `Tool "${input.toolName}" arguments must be a JSON object.`,
      }]),
    };
  }

  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, any>
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const allowAdditional = schema.additionalProperties !== false;
  const repairedArgs: Record<string, unknown> = { ...(input.args as Record<string, unknown>) };
  const propertyNames = Object.keys(properties);
  const lowRiskRepairAllowed = (input.effect ?? classifyToolEffect(input.toolName, input.args)) === 'read';

  for (const key of Object.keys(repairedArgs)) {
    if (properties[key]) continue;

    const aliasTarget = findAliasTarget({
      key,
      value: repairedArgs[key],
      properties,
      required,
      existingArgs: repairedArgs,
      allowExplicitAliasRepair: true,
      allowSemanticUrlRepair: lowRiskRepairAllowed,
    });

    if (aliasTarget) {
      repairedArgs[aliasTarget] = repairedArgs[key];
      delete repairedArgs[key];
      repairs.push(`${key}->${aliasTarget}`);
      continue;
    }

    if (!allowAdditional) {
      issues.push({
        code: 'unknown_property',
        path: `$.${key}`,
        message: `Unknown argument "${key}". Allowed arguments: ${propertyNames.join(', ') || '(none)'}.`,
      });
    }
  }

  const missingRequiredUrlTargetCount = required.filter((name: string) =>
    isMissingRequiredValue(repairedArgs[name], properties[name]) &&
    (name === 'url' || name.endsWith('_url') || name.endsWith('Url'))
  ).length;

  for (const name of required) {
    if (!isMissingRequiredValue(repairedArgs[name], properties[name])) continue;
    const aliasSource = findKnownAliasSource({
      target: name,
      properties,
      existingArgs: repairedArgs,
      allowExplicitAliasRepair: true,
      allowSemanticUrlRepair: lowRiskRepairAllowed && (
        !(name === 'url' || name.endsWith('_url') || name.endsWith('Url')) ||
        missingRequiredUrlTargetCount === 1
      ),
    });

    if (aliasSource) {
      repairedArgs[name] = repairedArgs[aliasSource];
      delete repairedArgs[aliasSource];
      repairs.push(`${aliasSource}->${name}`);
    }
  }

  for (const name of required) {
    if (isMissingRequiredValue(repairedArgs[name], properties[name])) {
      issues.push({
        code: 'missing_required',
        path: `$.${name}`,
        message: `Missing required argument "${name}".`,
      });
    }
  }

  for (const [name, propSchema] of Object.entries(properties)) {
    if (repairedArgs[name] === undefined || repairedArgs[name] === null) continue;
    if (!shouldStringifyJsonValue(name, repairedArgs[name], propSchema)) continue;
    repairedArgs[name] = JSON.stringify(repairedArgs[name]);
    repairs.push(`${name}:json_stringify`);
  }

  // Scalar coercion repair: LLMs frequently emit numbers/booleans as strings
  // (e.g. char_offset: "0", match_offset: "20", enabled: "true") even when the
  // tool schema declares `type: "number" | "integer" | "boolean"`. Without this
  // step those calls were hard-rejected by the type validator below, which was the
  // single largest failure mode for search_tool_response / read_tool_response in
  // production telemetry. Coerce a string that cleanly round-trips to the expected
  // scalar type so the call succeeds instead of bouncing back to the model.
  for (const [name, propSchema] of Object.entries(properties)) {
    if (repairedArgs[name] === undefined || repairedArgs[name] === null) continue;
    const coerced = coerceScalarForSchema(repairedArgs[name], propSchema);
    if (coerced.changed) {
      repairedArgs[name] = coerced.value;
      repairs.push(`${name}:scalar_coerce`);
      continue;
    }
    const container = coerceJsonContainerForSchema(repairedArgs[name], propSchema);
    if (container.changed) {
      repairedArgs[name] = container.value;
      repairs.push(`${name}:json_parse`);
    }
  }

  for (const [name, propSchema] of Object.entries(properties)) {
    if (repairedArgs[name] === undefined || repairedArgs[name] === null) continue;
    const typeIssue = validateJsonSchemaType(name, repairedArgs[name], propSchema);
    if (typeIssue) issues.push(typeIssue);
    issues.push(...validateJsonSchemaConstraints(name, repairedArgs[name], propSchema));
  }
  issues.push(...validateSemanticToolContract(input.toolName, repairedArgs));

  if (issues.length > 0) {
    return {
      status: 'invalid',
      args: repairedArgs,
      issues,
      repairs,
      modelMessage: buildSchemaRetryMessage(input.toolName, issues),
    };
  }

  return {
    status: repairs.length > 0 ? 'repaired' : 'valid',
    args: repairedArgs,
    issues,
    repairs,
  };
}

export function summarizeAgentToolPolicyFlags(
  decisions: Array<AgentToolPolicyDecision | undefined>,
): string | undefined {
  const entries = decisions
    .filter((decision): decision is AgentToolPolicyDecision => Boolean(decision))
    .flatMap((decision) =>
      decision.flags.map((flag) => `${decision.toolName}:${flag.code}:${flag.severity}`)
    );

  return entries.length > 0 ? entries.join(',') : undefined;
}

export function summarizeAgentToolPolicyModes(
  decisions: Array<AgentToolPolicyDecision | undefined>,
): string | undefined {
  const entries = decisions
    .filter((decision): decision is AgentToolPolicyDecision => Boolean(decision))
    .map((decision) => `${decision.toolName}:${decision.effect}:${decision.risk}:${decision.mode}`);

  return entries.length > 0 ? entries.join(',') : undefined;
}

export function buildSchemaRetryMessage(toolName: string, issues: AgentToolContractIssue[]): string {
  const details = issues.map((issue) => issue.message).join(' ');
  return `Tool "${toolName}" arguments failed schema validation before execution. ${details} Retry the same tool with arguments that exactly match the tool schema.`;
}

export async function executeAgentToolThroughGateway(
  input: AgentToolGatewayExecutionInput,
): Promise<AgentToolGatewayExecutionOutcome> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const policyDecision = input.policyDecision ?? evaluateAgentToolPolicy(input);

  if (!policyDecision.allowed) {
    return {
      status: 'error',
      error: new AgentToolPolicyBlockedError(policyDecision),
      policyDecision,
      durationMs: Math.max(0, now() - startedAt),
    };
  }

  if (input.runId) {
    const budgetScopeId = input.budgetScopeId ?? input.runId;
    const trippedBudget = findTrippedBudget(budgetScopeId, policyDecision.toolName);
    if (trippedBudget) {
      return {
        status: 'error',
        error: new AgentToolBudgetExceededError(
          policyDecision.toolName,
          trippedBudget.count,
          trippedBudget.budget,
          input.budgetScopeId ? 'session' : 'run',
        ),
        policyDecision,
        durationMs: Math.max(0, now() - startedAt),
      };
    }

    const recipientScope = failureScope(policyDecision.toolName, input.args);

    // Session-scoped timeout aggregate first (ENG-167 follow-up) — a tool that's
    // timed out repeatedly across earlier runs in this session should fail fast
    // here, before ever reaching the run-scoped check below (which only ever sees
    // this one run and would let a fresh runId through with a zeroed counter).
    if (input.budgetScopeId && input.budgetScopeId !== input.runId) {
      const trippedSession = findTrippedSessionTimeout(input.budgetScopeId, policyDecision.toolName, recipientScope);
      if (trippedSession) {
        return {
          status: 'error',
          error: new AgentToolRepeatedFailureError(
            policyDecision.toolName,
            trippedSession.count,
            trippedSession.errorMessage,
            trippedSession.reason,
            !!input.runId && hasReportedIssue(input.runId),
            'session',
          ),
          policyDecision,
          durationMs: Math.max(0, now() - startedAt),
        };
      }
    }

    const tripped = findTrippedFailure(input.runId, policyDecision.toolName, recipientScope);
    if (tripped) {
      return {
        status: 'error',
        error: new AgentToolRepeatedFailureError(
          policyDecision.toolName,
          tripped.count,
          tripped.errorMessage,
          tripped.reason,
          !!input.runId && hasReportedIssue(input.runId),
        ),
        policyDecision,
        durationMs: Math.max(0, now() - startedAt),
      };
    }
  }

  try {
    const result = await input.execute();
    // A resolved result can still encode a failure ({ success: false } /
    // { isError: true }). Tools like performDataAnalysis, getMetaAdsMetrics,
    // fathom_get_meetings and coding_agent signal failure this way instead of
    // throwing. Use the SAME canonical detector the dispatcher uses to downgrade
    // these (toolResultError, see toolDispatch.ts) so gateway failure accounting
    // and dispatcher classification stay in lockstep. Account a structured
    // failure exactly like the catch path; do NOT clear prior failure counts.
    const structuredFailure = toolResultError(result);
    if (structuredFailure) {
      if (input.runId) recordToolFailure(input.runId, policyDecision.toolName, input.args, structuredFailure);
      if (
        input.budgetScopeId
        && input.budgetScopeId !== input.runId
        && shouldTrackInSessionScope(policyDecision.toolName, structuredFailure)
      ) {
        recordToolFailure(input.budgetScopeId, policyDecision.toolName, input.args, structuredFailure);
      }
      // Keep returning status:'success' with the result so the dispatcher's
      // downgrade (toolDispatch.ts) carries the structured payload to the model.
      // Flipping to status:'error' here would strip `result`. The only observable
      // change is internal accounting — counts increment instead of being cleared.
      return {
        status: 'success',
        result,
        policyDecision,
        durationMs: Math.max(0, now() - startedAt),
      };
    }
    if (input.runId) clearToolFailures(input.runId, policyDecision.toolName, input.args);
    if (input.budgetScopeId && input.budgetScopeId !== input.runId) {
      clearToolFailures(input.budgetScopeId, policyDecision.toolName, input.args);
    }
    // ENG-167 follow-up: remember a successful report_product_issues call for the
    // rest of this run so a later timeout stop-message doesn't tell the model to
    // file a second one.
    if (input.runId && policyDecision.toolName === 'report_product_issues') {
      markReportedIssue(input.runId);
    }
    return {
      status: 'success',
      result,
      policyDecision,
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    if (input.runId) recordToolFailure(input.runId, policyDecision.toolName, input.args, error);
    if (
      input.budgetScopeId
      && input.budgetScopeId !== input.runId
      && shouldTrackInSessionScope(policyDecision.toolName, error)
    ) {
      recordToolFailure(input.budgetScopeId, policyDecision.toolName, input.args, error);
    }
    return {
      status: 'error',
      error,
      policyDecision,
      durationMs: Math.max(0, now() - startedAt),
    };
  }
}

function classifyToolEffect(toolName: string, args: unknown): AgentToolEffect {
  if (toolName.startsWith('delete_') || toolName === 'freeze_user_account') return 'destructive';
  if (EXTERNAL_SEND_TOOLS.has(toolName)) return 'external_send';
  if (EXTERNAL_PUBLISH_TOOLS.has(toolName)) return 'external_publish';
  if (toolName.startsWith('manage_')) return 'admin';
  if (SESSION_STATE_TOOLS.has(toolName)) return 'session_state';
  if (INTERNAL_WRITE_TOOLS.has(toolName)) return 'internal_write';

  if (toolName === 'linkedin_outreach') {
    const action = stringField(args, 'action').toLowerCase();
    if (action.includes('send') || action.includes('message') || action.includes('invite')) {
      return 'external_send';
    }
    return 'read';
  }

  if (toolName === 'call_hubspot_api') {
    const action = stringField(args, 'action').toUpperCase();
    if (action === 'CREATE_BROADCAST') return 'external_publish';
    if (
      action === 'DELETE' ||
      action === 'DELETE_BROADCAST' ||
      action === 'REMOVE_CONTACTS' ||
      action === 'PUBLISH'
    )
      return 'destructive';
    if (
      action === 'CREATE' ||
      action === 'UPDATE' ||
      action === 'CLONE' ||
      action === 'ADD_CONTACTS' ||
      action === 'ARCHIVE'
    )
      return 'internal_write';
    return 'read';
  }

  if (READ_TOOLS.has(toolName) || READ_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return 'read';
  if (SIDE_EFFECTING_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return 'internal_write';
  return 'unknown';
}

function computeRisk(effect: AgentToolEffect, flags: AgentToolPolicyFlag[]): AgentToolRisk {
  if (flags.some((flag) => flag.severity === 'critical')) return 'high';
  if (effect === 'external_send' || effect === 'external_publish' || effect === 'destructive') return 'high';
  if (flags.some((flag) => flag.severity === 'warning')) return 'medium';
  if (effect === 'internal_write' || effect === 'admin' || effect === 'unknown') return 'medium';
  return 'low';
}

function looksLikeTaskRequest(args: unknown): boolean {
  const haystack = safeStringify(args).toLowerCase();
  if (!haystack) return false;
  const taskWords = ['task', 'follow-up', 'follow up', 'todo', 'to-do', 'review'];
  const gtmWords = ['campaign', 'gtm', 'go-to-market', 'phase', 'work item', 'plan'];
  return taskWords.some((word) => haystack.includes(word)) &&
    !gtmWords.some((word) => haystack.includes(word));
}

function stringField(value: unknown, field: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : '';
}

function findAliasTarget(input: {
  key: string;
  value: unknown;
  properties: Record<string, any>;
  required: string[];
  existingArgs: Record<string, unknown>;
  allowExplicitAliasRepair: boolean;
  allowSemanticUrlRepair: boolean;
}): string | null {
  const propertyNames = Object.keys(input.properties);
  const normalizedKey = normalizeArgName(input.key);
  const normalizedMatch = propertyNames.find((name) => normalizeArgName(name) === normalizedKey);
  if (normalizedMatch && input.existingArgs[normalizedMatch] === undefined) {
    return normalizedMatch;
  }

  if (input.allowExplicitAliasRepair) {
    const explicitMatch = propertyNames.find((name) =>
      getSchemaAliases(input.properties[name]).some((alias) => normalizeArgName(alias) === normalizedKey)
    );
    if (explicitMatch && input.existingArgs[explicitMatch] === undefined) return explicitMatch;

    const defaultMatch = propertyNames.find((name) =>
      getDefaultAliases(name).some((alias) => normalizeArgName(alias) === normalizedKey)
    );
    if (defaultMatch && input.existingArgs[defaultMatch] === undefined) return defaultMatch;
  }

  if (!input.allowSemanticUrlRepair || typeof input.value !== 'string') return null;
  if (!looksLikeUrl(input.value)) return null;

  const urlLikeKeys = new Set(['url', 'link', 'href', 'uri']);
  if (!urlLikeKeys.has(normalizedKey)) return null;

  const missingRequiredUrlFields = input.required.filter((name) =>
    input.existingArgs[name] === undefined &&
    (name === 'url' || name.endsWith('_url') || name.endsWith('Url'))
  );

  if (missingRequiredUrlFields.length === 1) return missingRequiredUrlFields[0];
  return null;
}

function findKnownAliasSource(input: {
  target: string;
  properties: Record<string, any>;
  existingArgs: Record<string, unknown>;
  allowExplicitAliasRepair: boolean;
  allowSemanticUrlRepair: boolean;
}): string | null {
  const targetNormalized = normalizeArgName(input.target);
  for (const key of Object.keys(input.existingArgs)) {
    if (key === input.target) continue;
    if (!input.properties[key]) continue;
    if (normalizeArgName(key) === targetNormalized) return key;
  }

  if (input.allowExplicitAliasRepair) {
    const targetAliases = [
      ...getSchemaAliases(input.properties[input.target]),
      ...getDefaultAliases(input.target),
    ].map(normalizeArgName);
    for (const key of Object.keys(input.existingArgs)) {
      if (key === input.target) continue;
      if (targetAliases.includes(normalizeArgName(key))) return key;
    }
  }

  if (!input.allowSemanticUrlRepair) return null;
  if (!(input.target === 'url' || input.target.endsWith('_url') || input.target.endsWith('Url'))) return null;

  const urlLikeKeys = new Set(['url', 'link', 'href', 'uri']);
  for (const key of Object.keys(input.existingArgs)) {
    if (!urlLikeKeys.has(normalizeArgName(key))) continue;
    const value = input.existingArgs[key];
    if (typeof value === 'string' && looksLikeUrl(value)) return key;
  }

  return null;
}

function validateJsonSchemaType(name: string, value: unknown, schema: any): AgentToolContractIssue | null {
  const expected = schema?.type;
  if (!expected) return null;
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  const valid = expectedTypes.some((type) => {
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if (type === 'null') return value === null;
    return true;
  });

  if (valid) return null;
  return {
    code: 'type_mismatch',
    path: `$.${name}`,
    message: `Argument "${name}" has the wrong type. Expected ${expectedTypes.join(' or ')}.`,
  };
}

/**
 * Coerce a stringified scalar to the type the schema expects, when (and only when)
 * the round-trip is unambiguous. Used as a pre-validation repair so the model's
 * common "number-as-string" / "boolean-as-string" mistakes don't hard-fail.
 *
 * Behavior-preserving: returns `changed: false` for values that already match the
 * schema type, for non-string inputs, for schemas that also accept `string`, and
 * for strings that don't cleanly parse — so a genuinely wrong value still surfaces
 * as a type_mismatch issue downstream.
 */
function coerceScalarForSchema(value: unknown, schema: any): { changed: boolean; value: unknown } {
  if (typeof value !== 'string') return { changed: false, value };
  const expected = schema?.type;
  if (!expected) return { changed: false, value };
  const expectedTypes = Array.isArray(expected) ? expected : [expected];

  // If the schema accepts a string, the string is already valid — never coerce.
  if (expectedTypes.includes('string')) return { changed: false, value };

  const trimmed = value.trim();
  if (trimmed === '') return { changed: false, value };

  if (expectedTypes.includes('integer')) {
    // Strict integer: optional sign + digits only (no decimals, no exponent).
    if (/^[+-]?\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isInteger(n)) return { changed: true, value: n };
    }
  }

  if (expectedTypes.includes('number')) {
    // Finite decimal number (no NaN/Infinity, no trailing garbage).
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return { changed: true, value: n };
    }
  }

  if (expectedTypes.includes('boolean')) {
    const lower = trimmed.toLowerCase();
    if (lower === 'true') return { changed: true, value: true };
    if (lower === 'false') return { changed: true, value: false };
  }

  return { changed: false, value };
}

/**
 * Coerce a stringified JSON array/object to its parsed value when the schema
 * expects an `array` or `object` (and does NOT also accept `string`). LLMs
 * frequently double-encode a nested container argument — emitting
 * `files: "[{...}]"` instead of `files: [{...}]` — which the type validator then
 * hard-rejected with "Expected array." (ENG-127). Parse a string that cleanly
 * round-trips to the expected container type so the call succeeds instead of
 * bouncing back to the model.
 *
 * Behavior-preserving: returns `changed: false` for non-string inputs, for
 * schemas that also accept `string`, for strings that don't look like / parse as
 * JSON, and for parsed values whose type doesn't match the expected container —
 * so a genuinely wrong value still surfaces as a type_mismatch issue downstream.
 */
function coerceJsonContainerForSchema(value: unknown, schema: any): { changed: boolean; value: unknown } {
  if (typeof value !== 'string') return { changed: false, value };
  const expected = schema?.type;
  if (!expected) return { changed: false, value };
  const expectedTypes = Array.isArray(expected) ? expected : [expected];

  // If the schema accepts a string, the string is already valid — never coerce.
  if (expectedTypes.includes('string')) return { changed: false, value };

  const wantsArray = expectedTypes.includes('array');
  const wantsObject = expectedTypes.includes('object');
  if (!wantsArray && !wantsObject) return { changed: false, value };

  const trimmed = value.trim();
  const firstChar = trimmed[0];
  // Only attempt a parse for values that actually look like a JSON container.
  if (firstChar !== '[' && firstChar !== '{') return { changed: false, value };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { changed: false, value };
  }

  if (wantsArray && Array.isArray(parsed)) return { changed: true, value: parsed };
  if (wantsObject && Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { changed: true, value: parsed };
  }
  return { changed: false, value };
}

function validateJsonSchemaConstraints(name: string, value: unknown, schema: any): AgentToolContractIssue[] {
  const issues: AgentToolContractIssue[] = [];

  if (Array.isArray(value)) {
    if (typeof schema?.minItems === 'number' && value.length < schema.minItems) {
      issues.push({
        code: 'invalid_args',
        path: `$.${name}`,
        message: `Argument "${name}" must contain at least ${schema.minItems} item(s).`,
      });
    }

    if (schema?.items) {
      value.forEach((item, index) => {
        const typeIssue = validateJsonSchemaType(`${name}[${index}]`, item, schema.items);
        if (typeIssue) issues.push(typeIssue);
      });
    }
  }

  return issues;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateSemanticToolContract(toolName: string, args: Record<string, unknown>): AgentToolContractIssue[] {
  // ENG-243: intentionally NO length gate on linkedin_outreach send-invite notes.
  // The send path (LinkedInOutreachService.sendInvitation) resolves the account's
  // tier limit (200 free / 300 Premium) and auto-trims the note on a word boundary,
  // so a send never fails on length. Hard-rejecting an over-limit note here instead
  // produced repeated invalid_args failures (a fast-trip error class) that tripped
  // the anti-loop breaker after 2 attempts and sent 0 invites — and it contradicts
  // the tool description, which promises the backend auto-trims. The gateway cannot
  // know the account tier synchronously, so trimming is deferred to that send path.

  // ENG-106: the send_email_from_sender schema can only mark `to`/`subject`
  // required — the body is a 3-way alternative (html OR text OR body) the
  // hand-rolled validator's `required` cannot express (no anyOf support). Enforce
  // it semantically so a body-less email fails fast at validation with an
  // actionable message instead of a wasted round-trip + soft execution failure.
  if (toolName === 'send_email_from_sender') {
    if (isNonEmptyString(args.html) || isNonEmptyString(args.text) || isNonEmptyString(args.body)) return [];
    return [{
      code: 'invalid_args',
      path: '$.body',
      message: 'Provide a non-empty email body via html, text, or body.',
    }];
  }

  // ENG-106: get_meta_ads_metrics drops the hard `required: [campaign_ids]` so
  // legacy scalar/string id shapes the impl normalizes pass static validation.
  // Restore the "at least one usable campaign id" guarantee here, accepting every
  // shape execute() normalizes: non-empty array campaign_ids, non-empty string
  // campaign_ids, or non-empty string campaign_id.
  if (toolName === 'get_meta_ads_metrics') {
    const hasArrayIds = Array.isArray(args.campaign_ids)
      && args.campaign_ids.some((id) => isNonEmptyString(id));
    const hasStringIds = isNonEmptyString(args.campaign_ids);
    const hasLegacyId = isNonEmptyString(args.campaign_id);
    if (hasArrayIds || hasStringIds || hasLegacyId) return [];
    return [{
      code: 'invalid_args',
      path: '$.campaign_ids',
      message: 'Provide at least one campaign id via campaign_ids (array or string) or campaign_id. Use list_meta_ads_campaigns to find campaign IDs.',
    }];
  }

  return [];
}

function isMissingRequiredValue(value: unknown, schema: any): boolean {
  if (value === undefined) return true;
  if (value === null) return !schemaAllowsType(schema, 'null');
  return value === '';
}

function schemaAllowsType(schema: any, type: string): boolean {
  const expected = schema?.type;
  if (!expected) return false;
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  return expectedTypes.includes(type);
}

function shouldStringifyJsonValue(name: string, value: unknown, schema: any): boolean {
  if (!schemaAllowsType(schema, 'string')) return false;
  if (!value || typeof value !== 'object') return false;

  const normalizedName = normalizeArgName(name);
  const description = typeof schema?.description === 'string' ? schema.description.toLowerCase() : '';
  const contentMediaType = typeof schema?.contentMediaType === 'string' ? schema.contentMediaType.toLowerCase() : '';
  return normalizedName.endsWith('json') ||
    description.includes('json') ||
    contentMediaType.includes('json');
}

function getSchemaAliases(schema: any): string[] {
  const aliases = schema?.['x-aliases'] ?? schema?.aliases;
  return Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string') : [];
}

function getDefaultAliases(target: string): string[] {
  return DEFAULT_ARG_ALIASES[target] ?? [];
}

function normalizeArgName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '';
  }
}
