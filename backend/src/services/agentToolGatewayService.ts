import { createHash } from 'crypto';
import { toolResultError, ToolResultPolicyBlockedError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { getMetaAdsMetricsArgsSchema, repairMetaAdsMetricsAlias } from '../utils/metaCampaignIds';
import { isFastTripErrorClass } from './agentMode/core/errorRetryability';
import type { ZodIssue } from 'zod';
import { suggestMemorySplitPoint } from '../utils/memoryContentLimit';

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
// ENG-291 follow-up: cost-scoping get_chat_history (chatHistoryFailureScope) fixed the
// hard-block of legitimate cheaper recovery calls, but it also removed the session-wide
// protection the prior shared-'' scope provided: a model that keeps VARYING sync/limit/
// window lands each attempt in a DIFFERENT cost bucket, so neither the per-scope session
// timeout breaker (threshold 2 per bucket) nor the media budget (get_chat_history is not
// a media tool) ever trips — and each timeout can burn a full ~10-minute controller-
// bounded turn. Cap the TOTAL get_chat_history timeouts across ALL cost buckets in a
// session with a coarse aggregate budget. Kept deliberately high (6) so the few genuine
// reduced-request recovery paths (sync=false, smaller window/limit) still run before the
// aggregate cap engages — only a sustained, multi-bucket timeout spiral trips it.
const CHAT_HISTORY_FAILURE_BUDGET = 6;
// ENG-1668 follow-up: scoping call_google_ads_api's breaker per (entity, action,
// target) (googleAdsFailureScope, below) fixed the false cross-action blocking that
// caused this ticket, but it also means each of the tool's ~35+ entity/action
// combinations now gets its OWN fresh 2-3-failure allowance — a model that fails a
// DIFFERENT combination every attempt (rather than repeating one mistake) could
// burn far more failed calls than the old shared-bucket breaker ever allowed before
// tripping anything. Same gap class ENG-291 hit with get_chat_history's cost-scoped
// buckets; same fix shape: a coarse run-scoped cap on TOTAL call_google_ads_api
// failures regardless of which scope they land in. Kept run-scoped (not session-wide
// like CHAT_HISTORY_FAILURE_BUDGET) deliberately: a stale count should not persist
// into an unrelated later turn and reintroduce the over-blocking this ticket was
// about. Threshold well above the worst real session on record (8 failures, all pre-
// dating the hoist fix that now prevents most of them outright) and well below the
// theoretical worst-case drift, so only a genuine multi-vector spiral trips it.
// Env-overridable (not just a hardcoded guess): there's no real production traffic
// yet to tune this against, so ops can adjust it from observed telemetry without a
// deploy once there is.
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const GOOGLE_ADS_RUN_FAILURE_BUDGET = readPositiveIntEnv('GOOGLE_ADS_RUN_FAILURE_BUDGET', 10);
const MAX_TRACKED_RUNS = 500;
const ERROR_KEY_LENGTH = 80;

const EXPENSIVE_MEDIA_TOOLS = new Set([
  'generate_image',
  'describe_image',
]);

const runFailureCounts = new Map<string, Map<string, number>>();

// ENG-1668 follow-up: in-flight reservations for the run-scoped aggregate budget
// below, keyed by `${runId}\0${toolName}`. See findTrippedRunBudget/reserveRunBudgetSlot.
const pendingRunBudgetReservations = new Map<string, number>();

export function _resetAgentToolFailureBreaker(): void {
  runFailureCounts.clear();
  pendingRunBudgetReservations.clear();
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

// ENG-969: get_lead_details returns a structured not-found failure ("The
// specified lead does not exist in this list") for a lead_id/list_id pair
// that doesn't resolve — a normal per-entity outcome, not a retry spiral.
// Verified in production session 6082779b-f9f1-4e38-a8eb-34abbc3da419: three
// DIFFERENT lead ids each 404'd against the wrong list (unscoped, so all
// three shared the tool-wide '' bucket) and tripped the breaker at threshold
// 3, permanently blocking every later call in the run — including ones with
// corrected, valid list_id + lead_id. Scope by the target lead (exactly like
// the ENG-182/ENG-313 LinkedIn per-recipient scoping above) so a miss on one
// lead doesn't block a call for a different lead; a genuine repeat on the
// SAME lead still trips.
// ENG-2808: the same per-(list_id, lead_id) outcome applies to every lead-targeted
// tool that returns the structured "lead does not exist in this list" miss.
// add_lead_engagement failed 10/33 in one window on exactly this miss; a tool-wide
// bucket let three wrong ids block the corrected call for the rest of the run.
const LEAD_SCOPED_TOOLS = new Set([
  'get_lead_details',
  'add_lead_engagement',
  'get_lead_engagements',
  'update_lead',
  'send_email_to_lead',
]);

function leadDetailsFailureScope(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  const listId = typeof record.list_id === 'string' ? record.list_id.trim() : '';
  const leadId = typeof record.lead_id === 'string' ? record.lead_id.trim() : '';
  // Hash rather than slice to ERROR_KEY_LENGTH: two DIFFERENT (list_id, lead_id)
  // pairs must never collapse into the same breaker bucket just because they
  // share a long common prefix — a truncated slice could otherwise merge
  // unrelated targets and reintroduce the exact cross-lead blocking this scope
  // exists to prevent. JSON-encode the pair rather than joining with a plain
  // "|" delimiter: list_id/lead_id are caller-controlled strings, so a literal
  // "|" inside one could make two DIFFERENT pairs (e.g. ("a|b","c") and
  // ("a","b|c")) hash identically — JSON.stringify's quoting makes the
  // boundary between the two values unambiguous regardless of content.
  return createHash('sha256').update(JSON.stringify([listId, leadId])).digest('hex');
}

// ENG-1636: scope Meta failures to one (entity, action, target) so a bucket cannot
// lock the whole tool — six per-ad tracking-preflight refusals froze every read-back
// and the corrected retry for the rest of the run (Phoenix, session 822c1ed4). Most
// specific id wins so an AD write and an account-wide LIST never share a bucket.
// JSON-encode like the lead scope above: ids are caller-controlled strings, so a
// plain delimiter could make two different targets collide into one scope.
function metaMarketingFailureScope(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const entity = str(record.entity_type).toUpperCase();
  const action = str(record.action).toUpperCase();
  const target = str(record.ad_id) || str(record.ad_set_id) || str(record.campaign_id) || str(record.account_id);
  if (!entity && !action && !target) return '';
  return createHash('sha256').update(JSON.stringify([entity, action, target])).digest('hex');
}

// ENG-1668: same shared-bucket class as ENG-1636 above, hit on call_google_ads_api
// instead of Meta. Verified against production session 87334a61-2e06-4018-960e-
// 9e7759403423: a BUDGET UPDATE call missing budget_resource_name tripped the
// tool-wide bucket, then blocked the model's very next, fully corrected KEYWORD
// UPDATE and KEYWORD ADD_NEGATIVE calls — reporting the stale BUDGET UPDATE error
// for both even though neither one touched a budget. Most-specific resource name
// wins so a write against one entity and a read/list against another never share
// a bucket; JSON-encode like the scopes above so no id can forge a collision.
// campaign_resource_name is checked before budget_resource_name: CAMPAIGN UPDATE
// can optionally carry budget_resource_name to reassign a campaign onto a shared
// budget (emma/tools.ts's CAMPAIGN action matrix), so two DIFFERENT campaigns
// reassigned to the SAME shared budget must not collide into one scope just
// because they share that value — campaign_resource_name is the actual identity
// of what's being updated there, budget_resource_name is a payload field on it.
function googleAdsFailureScope(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const record = args as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const entity = str(record.entity_type).toUpperCase();
  const action = str(record.action).toUpperCase();
  const target =
    str(record.campaign_resource_name) ||
    str(record.budget_resource_name) ||
    str(record.ad_group_resource_name) ||
    str(record.criterion_resource_name) ||
    str(record.ad_resource_name) ||
    str(record.asset_group_resource_name) ||
    str(record.conversion_action_resource_name) ||
    str(record.customer_id);
  if (!entity && !action && !target) return '';
  return createHash('sha256').update(JSON.stringify([entity, action, target])).digest('hex');
}

function failureScope(toolName: string, args: unknown): string {
  if (toolName === 'get_chat_history') return chatHistoryFailureScope(args);
  if (LEAD_SCOPED_TOOLS.has(toolName)) return leadDetailsFailureScope(args);
  if (toolName === 'call_meta_marketing_api') return metaMarketingFailureScope(args);
  if (toolName === 'call_google_ads_api') return googleAdsFailureScope(args);
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
 * a per-run one, since the model retries it across separate user turns/runs.
 *
 * ENG-1220: a rate_limit-class failure on a media tool (gpt-image-2 429s) is
 * transient — the gateway's own retryability guidance tells the model to wait
 * and retry it. Counting it toward the tiny (2) session-wide media budget the
 * same as a permanent failure (safety-filter rejection, invalid args) locked
 * generate_image for the rest of the session even though the rate limit clears.
 * Exclude rate_limit specifically so a real retry spiral (any other class)
 * still trips the budget, but a temporary 429 does not. Hard-quota exhaustion
 * (OpenAI/Azure `insufficient_quota`, "exceeded your current quota") is also
 * 429-shaped but permanent, not transient — classifyToolErrorClass buckets it
 * as 'quota_exceeded', a distinct class from 'rate_limit', so it is NOT
 * exempted here and still counts toward the session-wide media budget. */
function shouldTrackInSessionScope(toolName: string, error: unknown): boolean {
  if (mediaFailureBudget(toolName) != null) {
    return classifyToolErrorClass(error) !== 'rate_limit';
  }
  return classifyToolErrorClass(error) === 'timeout';
}

function mediaFailureBudget(toolName: string): number | null {
  return EXPENSIVE_MEDIA_TOOLS.has(toolName) ? EXPENSIVE_MEDIA_FAILURE_BUDGET : null;
}

// The coarse tool-wide aggregate budget applied in findTrippedBudget. Extends the
// expensive-media budget with get_chat_history's higher cross-bucket timeout cap
// (ENG-291). Kept separate from mediaFailureBudget so shouldTrackInSessionScope's
// media branch is unchanged — get_chat_history reaches the session bucket only via
// its timeout branch, so this aggregate counts get_chat_history TIMEOUTS specifically,
// not one-off arg errors.
function aggregateFailureBudget(toolName: string): number | null {
  if (toolName === 'get_chat_history') return CHAT_HISTORY_FAILURE_BUDGET;
  return mediaFailureBudget(toolName);
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

// ENG-1668 follow-up: countToolFailures only reflects CONFIRMED failures — recorded
// after execute() resolves. Concurrent same-run tool calls (Promise.all — the exact
// shape of the production incident, 4 call_google_ads_api calls dispatched in one
// turn) all run their check synchronously before any sibling's execute() settles, so
// every one of them sees the SAME stale confirmed count and none accounts for the
// others. Track in-flight attempts — reserved the instant a call passes every check
// and commits to executing, released once its outcome is known either way — and fold
// them into the threshold. This closes the race without predicting outcomes: a
// reservation only ever nudges a SIBLING call in the same synchronous burst; it's
// never held past its own call resolving, and a call that succeeds never converts its
// reservation into a permanent failure.
function reserveRunBudgetSlot(runId: string, toolName: string): void {
  if (toolName !== 'call_google_ads_api') return;
  const key = `${runId}\0${toolName}`;
  const isNewKey = !pendingRunBudgetReservations.has(key);
  pendingRunBudgetReservations.set(key, (pendingRunBudgetReservations.get(key) ?? 0) + 1);
  // Same defensive LRU bound as runFailureCounts (MAX_TRACKED_RUNS) — a reservation
  // is normally released the instant its own execute() settles, so this map should
  // stay near-empty, but an execute() that never resolves (no timeout wrapper found
  // around it in toolDispatch.ts's runOne) would otherwise leave a permanent phantom
  // entry with no other cleanup path.
  if (isNewKey && pendingRunBudgetReservations.size > MAX_TRACKED_RUNS) {
    const oldest = pendingRunBudgetReservations.keys().next().value;
    if (oldest !== undefined) pendingRunBudgetReservations.delete(oldest);
  }
}

function releaseRunBudgetSlot(runId: string, toolName: string): void {
  if (toolName !== 'call_google_ads_api') return;
  const key = `${runId}\0${toolName}`;
  const current = pendingRunBudgetReservations.get(key) ?? 0;
  if (current <= 1) pendingRunBudgetReservations.delete(key);
  else pendingRunBudgetReservations.set(key, current - 1);
}

// ENG-1668 follow-up: a run-scoped backstop, separate from aggregateFailureBudget
// above — that one is keyed by budgetScopeId (session-wide, for tools whose failures
// are deliberately tracked cross-run), this one by runId directly, using the SAME
// per-run counts every per-scope breaker check already writes via recordToolFailure,
// plus any in-flight reservation (see above) for concurrency safety.
function findTrippedRunBudget(runId: string, toolName: string): { count: number; budget: number } | null {
  if (toolName !== 'call_google_ads_api') return null;
  const pending = pendingRunBudgetReservations.get(`${runId}\0${toolName}`) ?? 0;
  const count = countToolFailures(runId, toolName) + pending;
  return count >= GOOGLE_ADS_RUN_FAILURE_BUDGET ? { count, budget: GOOGLE_ADS_RUN_FAILURE_BUDGET } : null;
}

function findTrippedBudget(runId: string, toolName: string): { count: number; budget: number } | null {
  const budget = aggregateFailureBudget(toolName);
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

export const EXTERNAL_SEND_TOOLS = new Set([
  'send_email',
  'linkedin_outreach',
  'manage_crm_sequence', // ENG-964: activation starts drip email to real leads
]);

export const EXTERNAL_PUBLISH_TOOLS = new Set([
  'publish_blog_article',
  'publish_landing_page_changes',
  'enable_session_tracking', // ENG-2327: commits to a customer's live repo
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

// ENG-1668 follow-up: the nested-wrapper hoist below is generic across EVERY tool
// in the registry, not just call_google_ads_api — a wide blast radius for a fix
// aimed at one specific mistake. Restrict it to keys that actually look like an
// invented catch-all wrapper (the real mistake pattern: the model reaches for a
// generic word for "the real arguments", e.g. `params`), rather than firing on ANY
// undeclared object-valued key. This is the difference between "any future tool
// whose schema happens to reuse a property name inside some unrelated stray
// object could theoretically get silently reinterpreted" and "only these ~15 known
// generic names can ever trigger a hoist" — a tool author adding a new tool does
// not need to know this mechanism exists to be safe from it, because their own
// schema's real field names are never treated as wrapper candidates.
const LIKELY_WRAPPER_KEY_NAMES = new Set([
  'params', 'param', 'args', 'arguments', 'data', 'payload',
  'fields', 'field', 'filters', 'filter', 'options', 'config',
  'input', 'body', 'values', 'updates', 'attributes', 'properties',
]);

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
  // playwright_browser_evaluate requires `function`; models send `expression`/`script` (ENG-2473).
  function: ['expression', 'script', 'js', 'code'],
  // monitor_lead_volume / assess_client_health etc. require `client_name_or_email`;
  // scheduled report runs send `client_id: "<email>"` (ENG-2610).
  client_name_or_email: ['client_id', 'client_email', 'client'],
};

/** call_hubspot_api actions that only read. */
const HUBSPOT_READ_ACTIONS: ReadonlySet<string> = new Set([
  'GET', 'LIST', 'SEARCH', 'GET_CONTACTS', 'GET_FORM_FIELDS', 'GET_METRICS', 'GET_PERFORMANCE', 'GET_STATS', 'GET_SUBMISSIONS',
  'LIST_ASSETS', 'LIST_BROADCASTS', 'LIST_CHANNELS', 'LIST_PIPELINES', 'LIST_SUBSCRIPTION_TYPES',
]);

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

import { normalizeHubSpotArgs } from './agentMode/crmToolArgs';
import { normalizeAttioArgs } from './agentMode/attioTools';

// ENG-2570: call_hubspot_api CONTACT_LIST GET — models put the list id in
// `query` ({listId:"17"}, "listId=17", 17) instead of `list_id`, then loop to
// repeated_failure (prod session 6935593b, 2026-10-17). Move an unambiguous id
// into list_id. Scoped to this tool/action; never overwrites list_id and never
// touches free-text queries.
const HUBSPOT_QUERY_ID_KEYS = ['list_id', 'listId', 'listid', 'id'];
function extractHubSpotListIdFromQuery(query: unknown): string | null {
  if (typeof query === 'number') {
    return Number.isSafeInteger(query) && query > 0 ? String(query) : null;
  }
  if (typeof query === 'string') {
    const trimmed = query.trim();
    if (/^\d+$/.test(trimmed)) return trimmed;
    const kv = /^(?:list_?id|id)\s*[=:]\s*["']?(\d+)["']?$/i.exec(trimmed);
    return kv ? kv[1] : null;
  }
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    const obj = query as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== 1 || !HUBSPOT_QUERY_ID_KEYS.includes(keys[0])) return null;
    return extractHubSpotListIdFromQuery(obj[keys[0]]);
  }
  return null;
}

function repairHubSpotListIdFromQuery(
  toolName: string,
  args: Record<string, unknown>,
  properties: Record<string, unknown>,
): string | null {
  if (toolName !== 'call_hubspot_api' || !properties.list_id) return null;
  if (String(args.entity_type ?? '').toUpperCase() !== 'CONTACT_LIST') return null;
  if (String(args.action ?? '').toUpperCase() !== 'GET') return null;
  if (args.list_id !== undefined && args.list_id !== null && args.list_id !== '') return null;
  const listId = extractHubSpotListIdFromQuery(args.query);
  if (!listId) return null;
  args.list_id = listId;
  delete args.query;
  return 'query->list_id';
}

// ENG-2572: playwright_browser_evaluate calls the value of `function`. Models often send an
// IIFE (`(() => {...})()`) or a bare expression (`JSON.stringify({...})`), which Playwright
// evaluates and then fails on with "TypeError: result is not a function". Wrap those
// values in a zero-arg arrow. Values that are already function sources are left unchanged.
const FUNCTION_SOURCE_RE = /^(?:async\s+)?(?:function\b|[A-Za-z_$][\w$]*\s*=>)/;

// Arrow functions whose parameter list nests parens/brackets, e.g.
// `async (x = Promise.resolve(1)) => x`, need a balanced scan, not a regex.
function isParenArrowFunctionSource(source: string): boolean {
  const body = source.replace(/^async\s*/, '');
  if (!body.startsWith('(')) return false;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return /^\s*=>/.test(body.slice(i + 1));
    }
  }
  return false;
}

export function repairEvaluateFunctionArg(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName !== 'playwright_browser_evaluate') return null;
  const value = args.function;
  if (typeof value !== 'string') return null;
  const source = value.trim();
  if (!source || FUNCTION_SOURCE_RE.test(source) || isParenArrowFunctionSource(source)) return null;
  args.function = `() => (${source.replace(/;\s*$/, '')})`;
  return 'function:wrap_expression';
}

// ENG-2581: GAQL has no `quality_info.ad_relevance`; Google's ad-relevance
// component is `quality_info.creative_quality_score`. Models keep emitting the
// former despite tool-description guidance, so rewrite it (or drop it when the
// real field is already selected).
const GAQL_AD_RELEVANCE_RE = /\b((?:ad_group_criterion\.)?quality_info\.)ad_relevance\b/g;

export function repairGaqlAdRelevance(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName !== 'call_google_ads_reporting_api') return null;
  const query = args.query;
  if (typeof query !== 'string' || !/quality_info\.ad_relevance\b/.test(query)) return null;
  if (/quality_info\.creative_quality_score\b/.test(query)) {
    args.query = query
      .replace(/,\s*(?:ad_group_criterion\.)?quality_info\.ad_relevance\b/g, '')
      .replace(/(?:ad_group_criterion\.)?quality_info\.ad_relevance\b\s*,\s*/g, '');
  } else {
    args.query = query.replace(GAQL_AD_RELEVANCE_RE, '$1creative_quality_score');
  }
  return 'query:gaql_ad_relevance';
}

export function validateAndRepairToolArgs(
  input: AgentToolContractValidationInput,
): AgentToolContractValidationResult {
  const typedSchema = TYPED_READ_TOOL_SCHEMAS.get(input.toolName);
  if (typedSchema) {
    const preparedArgs = repairMetaAdsMetricsAlias(input.args);
    const parsed = typedSchema.safeParse(preparedArgs);
    const alias = preparedArgs === input.args ? undefined : Object.keys(input.args as object)
      .find((key) => normalizeArgName(key) === 'campaignids');
    const repairs = alias ? [`${alias}->campaign_ids`] : [];
    if (parsed.success) {
      return { status: repairs.length ? 'repaired' : 'valid', args: parsed.data, issues: [], repairs };
    }
    const issues = parsed.error.issues.map((issue) => zodIssueToContractIssue(input.toolName, issue));
    return { status: 'invalid', args: preparedArgs, issues, repairs, modelMessage: buildSchemaRetryMessage(input.toolName, issues) };
  }

  const schema = input.inputSchema;
  const issues: AgentToolContractIssue[] = [];
  const repairs: string[] = [];

  if (!schema || schema.type !== 'object') {
    // ENG-2572: the playwright evaluate repair must not depend on a resolved
    // schema — MCP tools often arrive here with no inputSchema.
    if (input.args && typeof input.args === 'object' && !Array.isArray(input.args)) {
      const evalArgs: Record<string, unknown> = { ...(input.args as Record<string, unknown>) };
      const evalRepair = repairEvaluateFunctionArg(input.toolName, evalArgs);
      if (evalRepair) return { status: 'repaired', args: evalArgs, issues, repairs: [evalRepair] };
      const gaqlRepair = repairGaqlAdRelevance(input.toolName, evalArgs);
      if (gaqlRepair) return { status: 'repaired', args: evalArgs, issues, repairs: [gaqlRepair] };
    }
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
  let repairedArgs: Record<string, unknown> = { ...(input.args as Record<string, unknown>) };
  if (input.toolName === 'call_hubspot_api') {
    const normalized = normalizeHubSpotArgs(repairedArgs);
    if (JSON.stringify(normalized) !== JSON.stringify(repairedArgs)) {
      repairs.push(repairedArgs.query !== undefined && normalized.query === undefined ? 'query->list_id' : 'hubspot:aliases');
      repairedArgs = normalized;
    }
  }
  if (input.toolName === 'call_attio_api') {
    const { args, entityType, action } = normalizeAttioArgs(repairedArgs);
    const normalized = { ...args, ...(entityType ? { entity_type: entityType } : {}), action };
    if (JSON.stringify(normalized) !== JSON.stringify(repairedArgs)) repairs.push('attio:aliases');
    repairedArgs = normalized;
  }
  // ENG-2791: playwright_browser_fill_form requires `fields`; models send `elements`.
  // Scoped to this tool so other tools declaring `fields` (e.g. Meta insights) keep
  // rejecting an undeclared `elements` argument.
  if (
    input.toolName === 'playwright_browser_fill_form' &&
    repairedArgs.fields === undefined &&
    repairedArgs.elements !== undefined &&
    properties.fields &&
    !properties.elements
  ) {
    repairedArgs.fields = repairedArgs.elements;
    delete repairedArgs.elements;
    repairs.push('elements->fields');
  }
  const propertyNames = Object.keys(properties);
  const lowRiskRepairAllowed = (input.effect ?? classifyToolEffect(input.toolName, input.args)) === 'read';

  for (const key of Object.keys(repairedArgs)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) continue;

    // ENG-1668: a common LLM mistake — inventing a wrapper object (e.g.
    // `params: { criterion_resource_name: ... }`) around fields that actually
    // belong at the top level, instead of matching the flat schema. Verified in
    // production session 87334a61-2e06-4018-960e-9e7759403423: the model supplied
    // every required resource-name argument, just nested one level too deep, and
    // the handler reported them as missing since it only reads top-level args.
    // Hoist the wrapper's own keys up to the top level — either an exact
    // property-name match, or (ENG-1668 follow-up) the SAME alias resolution
    // applied to top-level keys below, so a nested key that is BOTH misplaced
    // AND misnamed (e.g. `params: { criterion: ... }` instead of
    // criterion_resource_name) is still caught rather than silently dropped.
    // Only fills empty slots — never overwrites a value already present at the
    // top level — only applies to a wrapper key that isn't itself a declared
    // property, so a genuinely nested schema field (e.g. this same tool's
    // `address` object for CAMPAIGN ADD_PROXIMITY) is left untouched — and (ENG-1668
    // follow-up) only fires for keys that look like an invented wrapper
    // (LIKELY_WRAPPER_KEY_NAMES above), not any arbitrary undeclared object-valued
    // key, to keep this tool-agnostic mechanism's blast radius narrow. Hoists apply
    // one at a time so a second nested key can't clobber the first's target once
    // it's filled.
    const wrapperValue = repairedArgs[key];
    if (
      LIKELY_WRAPPER_KEY_NAMES.has(key.toLowerCase())
      && wrapperValue && typeof wrapperValue === 'object' && !Array.isArray(wrapperValue)
    ) {
      const nested = wrapperValue as Record<string, unknown>;
      let hoistedAny = false;
      for (const nestedKey of Object.keys(nested)) {
        const nestedTarget = properties[nestedKey] && repairedArgs[nestedKey] === undefined
          ? nestedKey
          : !properties[nestedKey]
          ? findAliasTarget({
              key: nestedKey,
              value: nested[nestedKey],
              properties,
              required,
              existingArgs: repairedArgs,
              allowExplicitAliasRepair: true,
              allowSemanticUrlRepair: lowRiskRepairAllowed,
            })
          : null;
        if (!nestedTarget) continue;
        repairedArgs[nestedTarget] = nested[nestedKey];
        repairs.push(`${key}.${nestedKey}->${nestedTarget}`);
        hoistedAny = true;
      }
      if (hoistedAny) {
        delete repairedArgs[key];
        continue;
      }
    }

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

  const hubspotListIdRepair = repairHubSpotListIdFromQuery(input.toolName, repairedArgs, properties);
  if (hubspotListIdRepair) repairs.push(hubspotListIdRepair);

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

  const evaluateRepair = repairEvaluateFunctionArg(input.toolName, repairedArgs);
  if (evaluateRepair) repairs.push(evaluateRepair);
  const gaqlAdRelevanceRepair = repairGaqlAdRelevance(input.toolName, repairedArgs);
  if (gaqlAdRelevanceRepair) repairs.push(gaqlAdRelevanceRepair);

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
    const idString = coerceIdIntegerToString(name, repairedArgs[name], propSchema);
    if (idString.changed) {
      repairedArgs[name] = idString.value;
      repairs.push(`${name}:scalar_coerce`);
      continue;
    }
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

  // ENG-2858: Playwright MCP rejects fill_form fields without a string `name`
  // (zod invalid_type at fields[i].name). Models describe the field under the
  // browser_click-style `element` key (or label/description) instead. Fill the
  // missing name from those, falling back to `ref`; never overwrite a name.
  // Runs after wrapper hoisting and JSON-string parsing so `fields` sent as a
  // JSON string or nested in a wrapper object is repaired too.
  if (input.toolName === 'playwright_browser_fill_form' && Array.isArray(repairedArgs.fields)) {
    let filled = false;
    const fields = (repairedArgs.fields as unknown[]).map((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return field;
      const f = field as Record<string, unknown>;
      if (typeof f.name === 'string' && f.name.trim()) return field;
      const aliasKey = ['element', 'label', 'description', 'field'].find(
        (k) => typeof f[k] === 'string' && (f[k] as string).trim(),
      );
      const name = aliasKey ? (f[aliasKey] as string) : typeof f.ref === 'string' && f.ref.trim() ? f.ref : undefined;
      if (!name) return field;
      const next: Record<string, unknown> = { ...f, name };
      if (aliasKey) delete next[aliasKey];
      filled = true;
      return next;
    });
    if (filled) {
      repairedArgs.fields = fields;
      repairs.push('fill_form:field.name');
    }
  }

  // ENG-3089: once the name repair above landed, the same daily run kept failing
  // on the next required key: fields[i].type (3 of the 4 post-fix failures). A
  // field with a plain text value and no type is a textbox. Never overwrite a
  // type the model sent, and never guess for a boolean-looking value (that is a
  // checkbox or radio, and guessing wrong would toggle the wrong control) —
  // those fall through to the next-step message in validateSemanticToolContract.
  if (input.toolName === 'playwright_browser_fill_form' && Array.isArray(repairedArgs.fields)) {
    let typed = false;
    const fields = (repairedArgs.fields as unknown[]).map((field) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return field;
      const f = field as Record<string, unknown>;
      if (f.type !== undefined && f.type !== null && f.type !== '') return field;
      if (typeof f.value !== 'string' || isBooleanLikeString(f.value)) return field;
      typed = true;
      return { ...f, type: 'textbox' };
    });
    if (typed) {
      repairedArgs.fields = fields;
      repairs.push('fill_form:field.type');
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
const TYPED_READ_TOOL_SCHEMAS = new Map([['get_meta_ads_metrics', getMetaAdsMetricsArgsSchema]]);

function zodIssueToContractIssue(toolName: string, issue: ZodIssue): AgentToolContractIssue {
  const path = issue.path.reduce<string>((value, part) => value + (typeof part === 'number' ? `[${part}]` : `.${part}`), '$');
  if (path === '$') return { code: 'invalid_args', path, message: `Tool "${toolName}" arguments must be a JSON object.` };
  const code = (issue as ZodIssue & { params?: { contractCode?: AgentToolContractIssue['code'] } }).params?.contractCode ?? 'invalid_args';
  return { code, path, message: issue.message };
}

export function summarizeAgentToolPolicyFlags(
  decisions: Array<AgentToolPolicyDecision | undefined>,
): string | undefined {
  const entries = decisions
    .filter((decision): decision is AgentToolPolicyDecision => Boolean(decision))
    .flatMap((decision) =>
      decision.flags.map((flag) => {
        const base = `${decision.toolName}:${flag.code}:${flag.severity}`;
        // ENG-1668 follow-up: args_repaired is the one flag whose message carries
        // per-call detail (toolDispatch.ts embeds validateAndRepairToolArgs's
        // `repairs` list, e.g. "params.criterion_resource_name->criterion_resource_name")
        // rather than a fixed template. Without it, this telemetry line shows only
        // a bare repair COUNT (see argsRepairedCount in agentModeService.ts) —
        // diagnosing an unexpected repair meant re-deriving it from raw args in a
        // session dump. Every other flag code's message is a static per-tool
        // template that adds nothing beyond the code itself, so they're
        // intentionally left out to avoid bloating every tool call's telemetry line.
        return flag.code === 'args_repaired' ? `${base}(${flag.message})` : base;
      })
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

    const trippedRunBudget = findTrippedRunBudget(input.runId, policyDecision.toolName);
    if (trippedRunBudget) {
      return {
        status: 'error',
        error: new AgentToolBudgetExceededError(
          policyDecision.toolName,
          trippedRunBudget.count,
          trippedRunBudget.budget,
          'run',
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

  // ENG-1668 follow-up: reserve this attempt against the run-scoped aggregate
  // BEFORE awaiting execute(), so a sibling call dispatched concurrently in the
  // same batch sees this attempt when it runs its own findTrippedRunBudget check
  // above — closing the check-then-act race under concurrent same-run tool calls.
  // Always released in `finally` below, regardless of outcome.
  if (input.runId) reserveRunBudgetSlot(input.runId, policyDecision.toolName);

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
      // ENG-1636: a ToolResultPolicyBlockedError is a gate refusing BY DESIGN
      // (blocked:true + reason — `by_design` per toolFailureType). The refusal names
      // its own remedy and invites a corrected call; counting it as a malfunction let
      // six identical pre-flight refusals trip the breaker and refuse that exact
      // corrected retry. Deliberate refusals are not failures; nothing is recorded —
      // and nothing is cleared either, since a refusal is not a success.
      const deliberateRefusal = structuredFailure instanceof ToolResultPolicyBlockedError;
      if (!deliberateRefusal && input.runId) {
        recordToolFailure(input.runId, policyDecision.toolName, input.args, structuredFailure);
      }
      if (
        !deliberateRefusal
        && input.budgetScopeId
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
  } finally {
    if (input.runId) releaseRunBudgetSlot(input.runId, policyDecision.toolName);
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
    // ENABLE turns a workflow live (it enrolls contacts and runs its actions, emails included).
    if (action === 'ENABLE') return 'external_publish';
    // SUBMIT posts a form submission into the customer's HubSpot, which can trigger its notifications and workflows.
    if (action === 'SUBMIT') return 'external_send';
    if (
      action === 'DELETE' ||
      action === 'DELETE_BROADCAST' ||
      action === 'REMOVE_CONTACTS' ||
      action === 'PUBLISH' ||
      action === 'UNPUBLISH'
    )
      return 'destructive';
    if (
      action === 'CREATE' ||
      action === 'UPDATE' ||
      action === 'CLONE' ||
      action === 'ADD_CONTACTS' ||
      action === 'ARCHIVE' ||
      action === 'DISABLE' ||
      action === 'ADD_ASSET' ||
      action === 'REMOVE_ASSET'
    )
      return 'internal_write';
    // Only the known reads are reads; an action this list does not know is treated as a write (fail closed), not as safe to repeat.
    if (HUBSPOT_READ_ACTIONS.has(action)) return 'read';
    return 'internal_write';
  }

  if (toolName === 'call_attio_api') {
    const action = stringField(args, 'action').toUpperCase();
    if (action === 'REMOVE_ENTRIES') return 'destructive';
    if (action === 'CREATE' || action === 'ADD_ENTRIES') return 'internal_write';
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
      // A key that is a real schema property is the caller's own argument, not an alias (ENG-2610).
      if (Object.prototype.hasOwnProperty.call(input.properties, key)) continue;
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
  if (schema === false) {
    return {
      code: 'invalid_args',
      path: `$.${name}`,
      message: `Argument "${name}" is not allowed by the tool schema.`,
    };
  }
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
 * Lossless integer -> string repair for identifier fields (ENG-2472). Models emit
 * IDs as bare integers (live repro: call_hubspot_api `list_id: 17`) where the
 * schema declares `string`, and then retry the same shape until the run is
 * classified degraded. Deliberately narrow so a genuinely wrong primitive still
 * surfaces as type_mismatch: only id-named fields (`id`, `*_id`, `*Id`), only
 * safe integers, only when `string` is the sole accepted type, and — because
 * enum is not validated downstream — only when any declared enum contains the
 * coerced value.
 */
function coerceIdIntegerToString(name: string, value: unknown, schema: any): { changed: boolean; value: unknown } {
  // ENG-2509: finite non-integer decimals and booleans are lossless and unambiguous
  // as strings (`ratio: 1.5` -> "1.5", `flag: true` -> "true"), so they coerce for
  // any field. Bare integers stay limited to id-named fields: an integer in a
  // non-id string field (`file_url: 123`, `action: 7`) usually means the model
  // filled the wrong field and must keep surfacing as type_mismatch.
  const isDecimal = typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value);
  const isBoolean = typeof value === 'boolean';
  const isIdInteger = typeof value === 'number' && Number.isSafeInteger(value) && /(^id$|_id$|[a-z]Id$)/.test(name);
  if (!isDecimal && !isBoolean && !isIdInteger) return { changed: false, value };
  const expected = schema?.type;
  const expectedTypes = Array.isArray(expected) ? expected : [expected];
  if (expectedTypes.length !== 1 || expectedTypes[0] !== 'string') return { changed: false, value };
  const coerced = String(value);
  if (Array.isArray(schema?.enum) && !schema.enum.includes(coerced)) return { changed: false, value };
  return { changed: true, value: coerced };
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

  // Measured in Unicode characters (code points) via `Array.from`, which is what
  // JSON Schema `maxLength` means. The schema is what we advertise to the model,
  // so this validator must enforce exactly that and nothing stricter.
  //
  // The downstream runtime guard is held to the same unit — see
  // accountMemoryDb.addMemory in services/db.ts, which also counts code points.
  // Both sides must move together: measuring UTF-16 code units here would reject
  // 1,001 emoji that the declared `maxLength: 2000` plainly accepts, which is a
  // contract stricter than its schema — the exact defect ENG-821 exists to fix.
  if (typeof value === 'string' && typeof schema?.maxLength === 'number') {
    // ENG-1048: state the received length and the overflow, not just the limit.
    // Knowing only the ceiling makes the correction guess-and-check — a reported
    // run walked save_memory content down 2926 → 2306 → 2128 → 1817 against a
    // 2000 limit, one model turn per guess, and those rejections also crowd real
    // tool results out of the context window (ENG-940).
    const received = Array.from(value).length;
    if (received > schema.maxLength) {
      issues.push({
        code: 'invalid_args',
        path: `$.${name}`,
        message: `Argument "${name}" must be at most ${schema.maxLength} character(s) — received ${received}; remove at least ${received - schema.maxLength}. Suggested split point: character ${suggestMemorySplitPoint(value, schema.maxLength)} — keep the text before it, and send the rest in further calls of at most ${schema.maxLength} character(s) each if the tool allows (ENG-1199).`,
      });
    }
  }

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

  // ENG-3089: Playwright MCP answers a field it cannot act on with a raw zod
  // dump, which tells the model nothing about what to do next. Name the missing
  // key and the next step instead. `ref` cannot be repaired here: it only exists
  // in a page snapshot.
  if (toolName === 'playwright_browser_fill_form' && Array.isArray(args.fields)) {
    const issues: AgentToolContractIssue[] = [];
    args.fields.forEach((field, i) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return;
      const f = field as Record<string, unknown>;
      if (!isNonEmptyString(f.ref)) {
        issues.push({
          code: 'invalid_args',
          path: `$.fields[${i}].ref`,
          message:
            `fields[${i}] has no "ref". A CSS selector alone is not accepted. Call playwright_browser_snapshot to get ` +
            `the current page, then retry playwright_browser_fill_form using the ref shown for that field.`,
        });
      }
      if (!FILL_FORM_FIELD_TYPES.includes(f.type as string)) {
        issues.push({
          code: 'invalid_args',
          path: `$.fields[${i}].type`,
          message: `fields[${i}] needs "type": one of ${FILL_FORM_FIELD_TYPES.join(', ')} (use checkbox or radio with value "true" or "false").`,
        });
      }
    });
    return issues;
  }

  return [];
}

const FILL_FORM_FIELD_TYPES = ['textbox', 'checkbox', 'radio', 'combobox', 'slider'];

function isBooleanLikeString(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === 'false';
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
