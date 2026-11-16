/**
 * Agent graders (ENG-2137, ENG-2128 surface A): verified task success, tool-call correctness,
 * groundedness, instruction adherence (ENG-2189) and cost per successful task.
 *
 * Every function here is pure and deterministic: callers pass one session's work plan, tool
 * ledger (AW-ChatMessages `metadata.toolCalls`) and Dev-AW-LoopEvents rows, and get back a
 * verdict with its reason. Loading lives in agentGraderLoader.ts; the read-only report is
 * scripts/evalAgentGraders.ts. Nothing here calls an LLM or changes runtime behaviour.
 *
 * None of these graders is validated against human labels yet, so none may gate or alert
 * (evalRegistry.ts, ENG-2128 principle 2).
 */

import {
  claimBackedByLedger,
  claimLooselyMatchedByLedger,
  prefilterClaimClasses,
  type ClaimClass,
  type FinalizeLedgerEntry,
} from '../../services/agentMode/core/finalizeGuard';
import { mediaGenProducedAsset } from '../../services/agentMode/core/toolDispatch';
import { isReadOnlyToolName } from '../../utils/toolWriteClassification';
import { toolResultError } from '../../utils/toolResultError';
import { wilsonInterval, type Interval } from './agreement';

/**
 * Eval-registry id → version of each session grader below. Stored with every online score
 * (evalV2Sampler.ts) so a trend never silently mixes verdicts from different logic: bump a
 * grader's version in the same change that alters what it returns.
 */
export const AGENT_GRADER_VERSIONS = {
  'agent-task-success': 1,
  // 2 (ENG-2190): write-without-read-back/repeated-mutation coverage extended past ad
  // platforms to CRM leads, email send, social publish and landing-page publish.
  'agent-tool-correctness': 2,
  'agent-groundedness-offline': 1,
  'agent-reply-length-adherence': 1,
  'agent-format-adherence': 1,
  'agent-act-without-asking': 1,
} as const;

export type AgentGraderId = keyof typeof AGENT_GRADER_VERSIONS;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One step of `AW-ChatSessions.workPlan.steps` (status is 'pending' | 'completed' | 'skipped'). */
export interface GraderWorkPlanStep {
  stepCount?: number;
  status: string;
  requiredFunctionCalls?: string[];
}

export interface GraderWorkPlan {
  title?: string;
  steps: GraderWorkPlanStep[];
  /** ENG-1811: required functions whose step was removed before they ever succeeded. */
  pendingRequiredFunctionCalls?: string[];
}

/** One tool call from the session ledger, in call order. */
export interface LedgerCall {
  id?: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'success' | 'error';
  /** The minimal result persisted on the ledger (what the finalize guard reads). */
  result?: unknown;
  /** The full tool output the model saw (the tool message), when it parsed as JSON. */
  output?: unknown;
}

/** One Dev-AW-LoopEvents agent-mode row; `runId` is the row's subjectId. */
export interface AgentLoopEvent {
  eventType: string;
  runId: string;
  ts: string;
  dimensions: Record<string, string | number | boolean | null>;
}

/** One user message and what the agent did before the next one (AW-ChatMessages order). */
export interface GraderTurn {
  userText: string;
  /** Text of the last genuine assistant reply before the next user message. */
  replyText?: string;
  /** Tools that ran in the turn (its tool-result messages), in order. */
  toolNames: string[];
}

export interface SessionForGrading {
  sessionId: string;
  workPlan?: GraderWorkPlan;
  ledger: LedgerCall[];
  events: AgentLoopEvent[];
  /** The last real turn is a crash placeholder (resumePlan.isRunFailurePlaceholder). */
  endsWithRunFailurePlaceholder: boolean;
  /** Text of the last genuine assistant turn. */
  finalReply?: string;
  userTurns: number;
  /** Per-turn text for the adherence checks; absent means none apply. */
  turns?: GraderTurn[];
}

// ---------------------------------------------------------------------------
// Task success (ENG-1710 relaxed completion label)
// ---------------------------------------------------------------------------

export type TaskVerdict = 'success' | 'failure' | 'excluded';

export type TaskReason =
  // excluded: no fair label can be derived
  | 'run_did_not_finish'
  | 'no_work_plan'
  | 'zero_tool_calls'
  | 'plan_never_engaged'
  // success
  | 'plan_complete'
  | 'plan_complete_one_trailing_pending'
  // failure
  | 'no_step_completed'
  | 'pending_steps'
  | 'completed_step_without_tool_evidence'
  | 'required_function_never_succeeded';

export interface TaskSuccessResult {
  verdict: TaskVerdict;
  reason: TaskReason;
  detail?: string;
  steps: { total: number; completed: number; skipped: number; pending: number };
}

/** Tools that only manage the session's own plan; calling them alone is not work on the task. */
const PLAN_MANAGEMENT_TOOLS = new Set<string>([
  'create_work_plan',
  'modify_work_plan',
  'set_work_plan_status',
  'launch_predefined_work_plan',
  'recommend_predefined_work_plan',
]);

const EVT_TOOL_INVOKED = 'agent_tool_invoked';
const EVT_TOOL_SUCCEEDED = 'agent_tool_succeeded';
const EVT_TOOL_FAILED = 'agent_tool_failed';

function eventToolName(e: AgentLoopEvent): string | undefined {
  const name = e.dimensions.toolName;
  return typeof name === 'string' && name ? name : undefined;
}

function toolCallCount(session: SessionForGrading): number {
  const invoked = session.events.filter((e) => e.eventType === EVT_TOOL_INVOKED).length;
  return Math.max(session.ledger.length, invoked);
}

function workToolCallCount(session: SessionForGrading): number {
  const fromLedger = session.ledger.filter((c) => !PLAN_MANAGEMENT_TOOLS.has(c.toolName)).length;
  const fromEvents = session.events.filter((e) => {
    const name = eventToolName(e);
    return e.eventType === EVT_TOOL_INVOKED && !!name && !PLAN_MANAGEMENT_TOOLS.has(name);
  }).length;
  return Math.max(fromLedger, fromEvents);
}

/** A ledger call that returned without an error and whose result is not an encoded failure. */
function callSucceeded(call: LedgerCall): boolean {
  return call.status === 'success' && !toolResultError(call.result) && !toolResultError(call.output);
}

/** Tool names with at least one successful call, from the ledger and the loop events. */
function succeededToolNames(session: SessionForGrading): Set<string> {
  const names = new Set<string>();
  for (const call of session.ledger) if (callSucceeded(call)) names.add(call.toolName);
  for (const e of session.events) {
    const name = eventToolName(e);
    if (e.eventType === EVT_TOOL_SUCCEEDED && name) names.add(name);
  }
  return names;
}

/**
 * success | failure | excluded from the work plan, with tool evidence for every completed step.
 *
 * ENG-1710 relaxed rule: the plan counts as complete when every step is completed or skipped,
 * allowing at most one pending step and only as the last one (8/10 of the strict label's
 * worst disagreements were an optional trailing "Review & Refine" step). Sessions with no fair
 * label are excluded rather than failed: runs that did not finish (crash placeholder), sessions
 * with no work plan, no tool calls at all, or a plan that was never engaged.
 *
 * "Verified, not self-reported": a step marked completed whose requiredFunctionCalls never
 * succeeded in this session, or a plan finished while ENG-1811's removed-step debt is still
 * outstanding, is a failure.
 */
export function gradeTaskSuccess(session: SessionForGrading): TaskSuccessResult {
  const steps = session.workPlan?.steps ?? [];
  const completed = steps.filter((s) => s.status === 'completed').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const pendingIdx = steps.flatMap((s, i) => (s.status === 'completed' || s.status === 'skipped' ? [] : [i]));
  const counts = { total: steps.length, completed, skipped, pending: pendingIdx.length };
  const result = (verdict: TaskVerdict, reason: TaskReason, detail?: string): TaskSuccessResult => ({
    verdict,
    reason,
    ...(detail ? { detail } : {}),
    steps: counts,
  });

  if (session.endsWithRunFailurePlaceholder) return result('excluded', 'run_did_not_finish');
  if (steps.length === 0) return result('excluded', 'no_work_plan');
  if (toolCallCount(session) === 0) return result('excluded', 'zero_tool_calls');
  if (completed + skipped === 0 && workToolCallCount(session) === 0) return result('excluded', 'plan_never_engaged');

  if (completed === 0) return result('failure', 'no_step_completed');
  const trailingOnly = pendingIdx.length === 0 || (pendingIdx.length === 1 && pendingIdx[0] === steps.length - 1);
  if (!trailingOnly) return result('failure', 'pending_steps', `${pendingIdx.length}/${steps.length} steps pending`);

  const succeeded = succeededToolNames(session);
  for (const step of steps) {
    if (step.status !== 'completed') continue;
    const missing = (step.requiredFunctionCalls ?? []).filter((fn) => !succeeded.has(fn));
    if (missing.length > 0) {
      return result('failure', 'completed_step_without_tool_evidence', `step ${step.stepCount ?? '?'}: ${missing.join(',')}`);
    }
  }
  const debt = (session.workPlan?.pendingRequiredFunctionCalls ?? []).filter((fn) => !succeeded.has(fn));
  if (debt.length > 0) return result('failure', 'required_function_never_succeeded', debt.join(','));

  return pendingIdx.length === 0 ? result('success', 'plan_complete') : result('success', 'plan_complete_one_trailing_pending');
}

// ---------------------------------------------------------------------------
// Tool-call correctness
// ---------------------------------------------------------------------------

export type ToolFindingKind =
  /** The model sent arguments that failed validation (errorClass invalid_args / schema_reject). */
  | 'invalid_args'
  /** A policy gate refused the call. */
  | 'policy_blocked'
  /** The model called a tool the session does not have installed. */
  | 'uninstalled_tool'
  /** The same tool failed 3+ times in one run (runRecorder's repeated_tool_failures threshold). */
  | 'repeated_failure'
  /** An external ad-platform write reported success and nothing later read that object's type on the account (ENG-592). */
  | 'write_without_read_back'
  /** Later reads of the same type exist, but none named the object: read-back cannot be confirmed. Does not fail the session. */
  | 'write_read_back_unconfirmed'
  /** The same successful write was sent again: the first "success" did not stick (ENG-286). */
  | 'repeated_mutation'
  /** ENG-2190: a landing-page deploy reported success but its own post-deploy smoke test (reused from landingPageSmokeTest.ts, surfaced on the ledger as launchReadiness) says the page doesn't actually load or convert. */
  | 'landing_page_publish_unverified';

export interface ToolFinding {
  kind: ToolFindingKind;
  toolName: string;
  runId?: string;
  callId?: string;
  detail?: string;
}

/** Findings that are evidence the session's tool use was wrong; the others are reported only. */
const FAILING_FINDINGS: ReadonlySet<ToolFindingKind> = new Set<ToolFindingKind>([
  'invalid_args',
  'policy_blocked',
  'uninstalled_tool',
  'repeated_failure',
  'write_without_read_back',
  'repeated_mutation',
  'landing_page_publish_unverified',
]);

export interface ToolCorrectnessResult {
  verdict: 'pass' | 'fail';
  toolCalls: number;
  mutations: number;
  findings: ToolFinding[];
}

/** Same threshold as runRecorder.computeRunVerdict's repeated_tool_failures. */
const REPEATED_FAILURE_THRESHOLD = 3;

function failureFindings(events: readonly AgentLoopEvent[]): ToolFinding[] {
  const findings: ToolFinding[] = [];
  const perRunTool = new Map<string, { count: number; flagged: boolean }>();
  for (const e of events) {
    if (e.eventType !== EVT_TOOL_FAILED) continue;
    const toolName = eventToolName(e) ?? 'unknown';
    const errorClass = String(e.dimensions.errorClass ?? '');
    const failureType = String(e.dimensions.failureType ?? '');
    const base = { toolName, runId: e.runId };
    if (errorClass === 'invalid_args' || failureType === 'schema_reject') findings.push({ kind: 'invalid_args', ...base });
    else if (errorClass === 'policy_blocked') findings.push({ kind: 'policy_blocked', ...base });
    else if (errorClass === 'tool_unavailable' || failureType === 'model_uninstalled_tool') {
      findings.push({ kind: 'uninstalled_tool', ...base });
    }

    const key = `${e.runId}\u0000${toolName}`;
    const entry = perRunTool.get(key) ?? { count: 0, flagged: false };
    entry.count++;
    perRunTool.set(key, entry);
    if (!entry.flagged && (errorClass === 'repeated_failure' || entry.count >= REPEATED_FAILURE_THRESHOLD)) {
      entry.flagged = true;
      findings.push({ kind: 'repeated_failure', ...base, detail: errorClass === 'repeated_failure' ? 'gateway repeated_failure' : `${entry.count} failures` });
    }
  }
  return findings;
}

// --- ad-platform writes and reads ------------------------------------------

type Platform = 'google_ads' | 'meta_ads' | 'linkedin_ads' | 'crm_lead' | 'email_send' | 'social_post';

/** How a call touches an ad platform: which account, which entity types, which object ids. */
interface PlatformAccess {
  platform: Platform;
  account: string;
  kind: 'write' | 'read';
  /** Entity types read or written; empty when unknown. */
  entities: string[];
  /** Numeric object ids the call names (args, and for writes the created ids in the output). */
  ids: Set<string>;
  /** For a create: ids of the new object, from the tool output only (args name its parents). */
  createdIds: Set<string>;
}

const GOOGLE_READ_ACTIONS = new Set(['LIST']);
const META_READ_ACTIONS = new Set(['LIST', 'GET']);
const LINKEDIN_READ_ACTIONS = new Set(['LIST', 'GET']);
/** Actions that are neither an object-state write nor a read of one (searches, uploads, previews, tests). */
const NON_OBJECT_ACTION = /^(SEARCH|PREVIEW|GET_MATCH_QUALITY|LIST_FACETS|ESTIMATE_REACH|SEND_TEST|UPLOAD.*)$/;

/** GAQL `FROM` resource → the call_google_ads_api entity_type it reads. */
const GAQL_RESOURCE_ENTITY: Record<string, string> = {
  campaign: 'CAMPAIGN',
  campaign_budget: 'BUDGET',
  ad_group: 'AD_GROUP',
  ad_group_ad: 'AD',
  ad_group_criterion: 'KEYWORD',
  keyword_view: 'KEYWORD',
  conversion_action: 'CONVERSION_ACTION',
  campaign_criterion: 'CAMPAIGN_CRITERION',
  campaign_asset: 'CAMPAIGN_ASSET',
  asset_group: 'ASSET_GROUP',
  bidding_strategy: 'BIDDING_STRATEGY',
};

/** Entities the Search serving-chain verifier reads (tools.ts call_google_ads_reporting_api). */
const SERVING_CHAIN_ENTITIES = ['CAMPAIGN', 'BUDGET', 'AD_GROUP', 'AD', 'KEYWORD'];
const DASHBOARD_ENTITIES = ['CAMPAIGN'];

const ACCOUNT_KEYS = new Set(['customer_id', 'account_id', 'client_id']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function normalizeAccount(v: unknown): string | undefined {
  const s = typeof v === 'number' ? String(v) : str(v);
  return s ? s.replace(/^act_/i, '').replace(/-/g, '') : undefined;
}

/** Numeric ids (5+ digits) anywhere in a value — resource names, id args, GAQL text. */
function collectIds(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 10000) into.add(String(value));
    return;
  }
  if (typeof value === 'string') {
    for (const m of value.match(/\d{5,}/g) ?? []) into.add(m);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, into, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectIds(v, into, depth + 1);
  }
}

/** Ids from the object-identifying keys of a record (`*_id`, `*_ids`, `*resource_name*`, `id`). */
function idsFromKeys(record: Record<string, unknown> | undefined, account: string): Set<string> {
  const ids = new Set<string>();
  if (!record) return ids;
  for (const [key, value] of Object.entries(record)) {
    if (ACCOUNT_KEYS.has(key)) continue;
    if (/(^id$|_ids?$|resource_?name)/i.test(key)) collectIds(value, ids);
  }
  ids.delete(account);
  return ids;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function gaqlEntities(query: string | undefined): string[] {
  const from = query?.match(/\bFROM\s+([a-z_]+)/i)?.[1]?.toLowerCase();
  const entity = from ? GAQL_RESOURCE_ENTITY[from] : undefined;
  return entity ? [entity] : [];
}

/** Classify a ledger call as an ad-platform write, read, or neither (null). */
function platformAccess(call: LedgerCall): PlatformAccess | null {
  const args = call.args;
  const action = str(args.action)?.toUpperCase() ?? '';
  const entity = str(args.entity_type)?.toUpperCase();
  const entities = entity ? [entity] : [];

  if (call.toolName === 'call_google_ads_reporting_api') {
    const account = normalizeAccount(args.customer_id);
    if (!account) return null;
    const mode = str(args.mode) ?? 'raw';
    const ids = new Set<string>();
    collectIds(args.query, ids);
    collectIds(args.campaign_ids, ids);
    ids.delete(account);
    const readEntities = mode === 'serving_chain' ? SERVING_CHAIN_ENTITIES : mode === 'dashboard' ? DASHBOARD_ENTITIES : gaqlEntities(str(args.query));
    return { platform: 'google_ads', account, kind: 'read', entities: readEntities, ids, createdIds: new Set() };
  }

  let platform: Platform;
  let account: string | undefined;
  let readActions: Set<string>;
  if (call.toolName === 'call_google_ads_api') {
    platform = 'google_ads';
    account = normalizeAccount(args.customer_id);
    readActions = GOOGLE_READ_ACTIONS;
    // validate_only asks Google to check the payload and write nothing.
    if (args.validate_only === true) return null;
    // OFFLINE_CONVERSION uploads are events, not object state that can be read back.
    if (entity === 'OFFLINE_CONVERSION') return null;
  } else if (call.toolName === 'call_meta_marketing_api') {
    platform = 'meta_ads';
    account = normalizeAccount(args.account_id);
    readActions = META_READ_ACTIONS;
  } else if (call.toolName === 'call_linkedin_marketing_api') {
    platform = 'linkedin_ads';
    account = normalizeAccount(args.account_id);
    readActions = LINKEDIN_READ_ACTIONS;
  } else {
    return null;
  }
  if (!account || !action || NON_OBJECT_ACTION.test(action)) return null;

  if (readActions.has(action)) {
    return { platform, account, kind: 'read', entities, ids: idsFromKeys(args, account), createdIds: new Set() };
  }
  const returned = new Set([...idsFromKeys(asRecord(call.output), account), ...idsFromKeys(asRecord(call.result), account)]);
  const ids = new Set([...idsFromKeys(args, account), ...returned]);
  const createdIds = /^(CREATE|ADD|COPY)/.test(action) ? returned : new Set<string>();
  return { platform, account, kind: 'write', entities, ids, createdIds };
}

/** The tool itself read the object back and said so (existing per-tool read-backs). */
function verifiedInTool(call: LedgerCall): boolean {
  for (const payload of [call.output, call.result]) {
    const r = asRecord(payload);
    if (!r) continue;
    if (r.readBackVerified === true || r.spend_cap_verified === true || r.verified === true) return true;
    // Google CONVERSION_ACTION CREATE/UPDATE read the action back and report drift.
    if ('drift' in r) return true;
    // ENG-2190: email and social publish have no separate "read it back" tool — the
    // provider-issued id THEY return is the only confirmation the send/post ever
    // happened, so a non-empty one counts as verified in place of a later read.
    if (typeof r.emailId === 'string' && r.emailId.trim()) return true;
    if (typeof r.post_id === 'string' && r.post_id.trim()) return true;
    if (typeof r.post_url === 'string' && r.post_url.trim()) return true;
  }
  return false;
}

// --- CRM, email and social writes (ENG-2190) --------------------------------

/** CRM lead writes: create (no id returned — see the account-only match below) and update. */
const CRM_LEAD_WRITE_TOOLS = new Set(['add_leads_to_list', 'update_lead']);
/** Reads that confirm a CRM write: list-scoped, some with no id filter at all. */
const CRM_LEAD_READ_TOOLS = new Set(['get_leads', 'search_leads', 'get_lead_details', 'get_leads_needing_followup', 'get_lead_conversation_statuses']);
/** Sends whose own response carries the provider message id (verifiedInTool above); no read-back tool exists. */
const EMAIL_SEND_TOOLS = new Set(['send_email_to_lead', 'send_email_from_sender']);
/** Publishes whose own response carries the post id/URL (verifiedInTool above); no read-back tool exists. */
const SOCIAL_PUBLISH_TOOLS = new Set(['post_on_connected_account']);

/**
 * Classify a write or read on a non-ad-platform surface into the same PlatformAccess shape
 * `platformAccess` uses for ad platforms, so it flows through the same writeFindings /
 * readBackAfter machinery rather than a second detection pipeline (ENG-2190, ENG-592's scope
 * beyond ad writes).
 *
 * CRM: `add_leads_to_list` never returns the created lead's id in a form the model (or this
 * grader) can match — its `importedIdentifiers` are human-readable descriptors, not lead ids —
 * so its only possible confirmation is a later read of the same list. That is exactly what
 * `readBackAfter` already does for a write whose id is unknown, or a same-type read with no id
 * filter at all (`get_leads`/`search_leads` with no `lead_id`): both count as confirmed.
 * `update_lead` additionally matches by the specific lead id it named.
 *
 * Email/social have no "read it back" tool at all: verifiedInTool (above) is their entire
 * confirmation path, from the provider id the write's own response carries. Returning them here
 * with empty `ids`/`createdIds` means readBackAfter can never confirm them by a later call, so a
 * write whose own response lacked that id correctly reports write_without_read_back — the same
 * verdict an ad-platform write nothing ever reads gets.
 */
function nonAdPlatformAccess(call: LedgerCall): PlatformAccess | null {
  const args = call.args;
  if (CRM_LEAD_WRITE_TOOLS.has(call.toolName) || CRM_LEAD_READ_TOOLS.has(call.toolName)) {
    const account = str(args.list_id);
    if (!account) return null;
    const ids = new Set<string>();
    const leadId = str(args.lead_id);
    if (leadId) ids.add(leadId);
    const kind = CRM_LEAD_WRITE_TOOLS.has(call.toolName) ? 'write' : 'read';
    return { platform: 'crm_lead', account, kind, entities: ['LEAD'], ids, createdIds: new Set() };
  }
  if (EMAIL_SEND_TOOLS.has(call.toolName)) {
    return { platform: 'email_send', account: 'email', kind: 'write', entities: ['EMAIL_MESSAGE'], ids: new Set(), createdIds: new Set() };
  }
  if (SOCIAL_PUBLISH_TOOLS.has(call.toolName)) {
    return { platform: 'social_post', account: 'social', kind: 'write', entities: ['SOCIAL_POST'], ids: new Set(), createdIds: new Set() };
  }
  return null;
}

/** A write that reported success and actually executed (not a confirmation halt or a block). */
function reportedWriteSuccess(call: LedgerCall): boolean {
  if (!callSucceeded(call)) return false;
  for (const payload of [call.output, call.result]) {
    const r = asRecord(payload);
    if (!r) continue;
    if (r.awaitingUserConfirmation === true || r.requiresConfirmation === true || r.blocked === true) return false;
  }
  return true;
}

type ReadBack = 'confirmed' | 'unconfirmed' | 'none';

/**
 * What the successful calls after a write, on the same platform account, say about it.
 * Confirmed: a read names the object's id; or reads its type with no id filter (every object);
 * or reads its type when the write's own id is unknown; or, for a create, a later call uses the
 * new object's id (the platform accepted it, so it exists). Unconfirmed: reads of the type exist
 * but their filters name other objects (often a parent, e.g. keywords read by campaign id).
 */
function readBackAfter(write: PlatformAccess, later: ReadonlyArray<{ call: LedgerCall; access: PlatformAccess | null }>): ReadBack {
  let sameType = false;
  for (const { call, access } of later) {
    if (!access || access.platform !== write.platform || access.account !== write.account || !callSucceeded(call)) continue;
    if (write.createdIds.size > 0) {
      const used = new Set<string>();
      collectIds(call.args, used);
      if ([...write.createdIds].some((id) => used.has(id))) return 'confirmed';
    }
    if (access.kind !== 'read') continue;
    if ([...access.ids].some((id) => write.ids.has(id))) return 'confirmed';
    if (!write.entities.some((e) => access.entities.includes(e))) continue;
    if (access.ids.size === 0 || write.ids.size === 0) return 'confirmed';
    sameType = true;
  }
  return sameType ? 'unconfirmed' : 'none';
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const r = asRecord(value);
  if (r) return `{${Object.keys(r).sort().map((k) => `${k}:${stableKey(r[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function writeFindings(ledger: readonly LedgerCall[]): { findings: ToolFinding[]; mutations: number } {
  const findings: ToolFinding[] = [];
  const accesses = ledger.map((call) => ({ call, access: platformAccess(call) ?? nonAdPlatformAccess(call) }));
  const seenWrites = new Set<string>();
  let mutations = 0;
  accesses.forEach(({ call, access }, i) => {
    if (!access || access.kind !== 'write' || !reportedWriteSuccess(call)) return;
    mutations++;
    const finding = (kind: ToolFindingKind) => findings.push({
      kind,
      toolName: call.toolName,
      ...(call.id ? { callId: call.id } : {}),
      detail: `${access.entities[0] ?? '?'} ${str(call.args.action)?.toUpperCase() ?? '?'}`,
    });

    const key = `${call.toolName}\u0000${stableKey(call.args)}`;
    if (seenWrites.has(key)) finding('repeated_mutation');
    seenWrites.add(key);

    if (verifiedInTool(call)) return;
    const readBack = readBackAfter(access, accesses.slice(i + 1));
    if (readBack === 'none') finding('write_without_read_back');
    else if (readBack === 'unconfirmed') finding('write_read_back_unconfirmed');
  });
  return { findings, mutations };
}

/** Deploy tools whose own response carries `launchReadiness` (agentModeService's ENG-1868 minimizer). */
const LANDING_PAGE_DEPLOY_TOOLS = new Set(['generate_landing_page', 'deploy_landing_page']);

/**
 * ENG-2190: a landing-page deploy that reported success but whose own post-deploy smoke test
 * says the page doesn't actually load or convert (a lead form that doesn't capture, or a URL
 * that doesn't come up at all). Reuses the existing smoke test's verdict — surfaced on the
 * ledger as `launchReadiness` by agentModeService's minimizer (utils/landingPageLaunchReadiness.ts,
 * itself backed by services/landingPageSmokeTest.ts) — rather than re-fetching the URL here.
 * `ready` defaults true until the (fire-and-forget) smoke test has actually run, so this never
 * flags a page whose smoke test simply hasn't completed yet — only one that ran and failed.
 */
function landingPageFindings(ledger: readonly LedgerCall[]): ToolFinding[] {
  const findings: ToolFinding[] = [];
  for (const call of ledger) {
    if (!LANDING_PAGE_DEPLOY_TOOLS.has(call.toolName) || !callSucceeded(call)) continue;
    for (const payload of [call.output, call.result]) {
      const readiness = asRecord(asRecord(payload)?.launchReadiness);
      if (!readiness || readiness.ready !== false) continue;
      const reasons = Array.isArray(readiness.reasons) ? readiness.reasons.filter((r): r is string => typeof r === 'string') : [];
      findings.push({
        kind: 'landing_page_publish_unverified',
        toolName: call.toolName,
        ...(call.id ? { callId: call.id } : {}),
        ...(reasons.length ? { detail: reasons.join('; ') } : {}),
      });
      break; // one finding per call even if both output and result carry launchReadiness
    }
  }
  return findings;
}

/**
 * Tool-call correctness for one session: failure classes from the loop events, plus
 * write-without-read-back and repeated identical writes from the ledger (args live only there).
 *
 * The read-back check is the grader-side half of ENG-592: an external write (Google Ads, Meta,
 * LinkedIn, CRM leads, email send, social publish) that reported success counts as verified only
 * when the tool itself read the object back (readBackVerified / spend_cap_verified / verified /
 * drift / a provider message-or-post id) or a later call in the session confirms it
 * (readBackAfter). A write whose type was read later but never by an id matching it is reported
 * as write_read_back_unconfirmed without failing. Landing-page publish is checked separately
 * (landingPageFindings): it has its own read-back signal (the post-deploy smoke test) rather
 * than a follow-up tool call to look for.
 */
export function gradeToolCorrectness(input: { events: readonly AgentLoopEvent[]; ledger: readonly LedgerCall[] }): ToolCorrectnessResult {
  const { findings: writes, mutations } = writeFindings(input.ledger);
  const findings = [...failureFindings(input.events), ...writes, ...landingPageFindings(input.ledger)];
  const invoked = input.events.filter((e) => e.eventType === EVT_TOOL_INVOKED).length;
  return {
    verdict: findings.some((f) => FAILING_FINDINGS.has(f.kind)) ? 'fail' : 'pass',
    toolCalls: Math.max(invoked, input.ledger.length),
    mutations,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Groundedness (finalize-guard claim classes, offline, no LLM)
// ---------------------------------------------------------------------------

export interface GroundednessResult {
  verdict: 'grounded' | 'ungrounded' | 'no_claims';
  /** Claim classes the lexicon found in the reply. */
  claimClasses: ClaimClass[];
  /** Found, with no successful tool call behind them, strict or loose. */
  unbackedClaimClasses: ClaimClass[];
  /** Found, backed only by a loose tool-name match (the guard never corrects these). */
  ambiguousClaimClasses: ClaimClass[];
}

const GUARD_PORTS = { toolResultError, mediaGenProducedAsset };

function toFinalizeLedger(ledger: readonly LedgerCall[]): FinalizeLedgerEntry[] {
  return ledger.map((c) => ({ toolName: c.toolName, status: c.status, result: c.result }));
}

/**
 * Completion claims in the final reply vs successful tool calls, using the finalize guard's own
 * lexicon and claim→tool matchers (finalizeGuard.ts). The runtime guard asks an LLM judge which
 * lexicon hits are real claims; offline every hit counts as a claim, so this over-reports
 * relative to the guard and is an upper bound until it is validated (ENG-2150 shadow data).
 * The ledger is the whole session's, since a final reply may report earlier turns' work.
 */
export function gradeGroundedness(finalReply: string | undefined, toolLedger: readonly LedgerCall[]): GroundednessResult {
  const claimClasses = finalReply ? prefilterClaimClasses(finalReply) : [];
  if (claimClasses.length === 0) {
    return { verdict: 'no_claims', claimClasses, unbackedClaimClasses: [], ambiguousClaimClasses: [] };
  }
  const ledger = toFinalizeLedger(toolLedger);
  const unbacked: ClaimClass[] = [];
  const ambiguous: ClaimClass[] = [];
  for (const cls of claimClasses) {
    if (claimBackedByLedger(cls, ledger, GUARD_PORTS)) continue;
    if (claimLooselyMatchedByLedger(cls, ledger, GUARD_PORTS)) ambiguous.push(cls);
    else unbacked.push(cls);
  }
  return {
    verdict: unbacked.length > 0 ? 'ungrounded' : 'grounded',
    claimClasses,
    unbackedClaimClasses: unbacked,
    ambiguousClaimClasses: ambiguous,
  };
}

// ---------------------------------------------------------------------------
// Instruction adherence (ENG-2189): requested length, requested format, acting when told to
// ---------------------------------------------------------------------------

/**
 * Each check fires only on a user turn that carries an explicit, machine-readable instruction,
 * and grades the agent's reply to that turn. Vague asks ("keep it short", "be concise") and
 * anything the regexes cannot read with confidence are not applicable, never failures, so a
 * rate is always over the sessions where the instruction was unambiguous. A session passes when
 * every applicable turn passes, fails when any fails, and is not applicable when no turn applies.
 */
export type AdherenceVerdict = 'pass' | 'fail' | 'not_applicable';

export type AdherenceReason =
  // not applicable
  | 'no_length_request'
  | 'no_format_request'
  | 'no_act_instruction'
  | 'delivered_via_tool'
  | 'no_reply'
  // pass
  | 'within_requested_length'
  | 'format_followed'
  | 'acted_without_asking'
  | 'confirmed_consequential_action'
  // fail
  | 'exceeded_requested_length'
  | 'table_missing'
  | 'list_missing'
  | 'asked_permission_after_instruction';

export interface AdherenceResult {
  verdict: AdherenceVerdict;
  reason: AdherenceReason;
  /** User turns the check applied to. */
  applicableTurns: number;
  /** Counts only, never message text, e.g. `turn 2: 240 words vs <= 100 words`. */
  detail?: string;
}

const NUMBER_WORDS: Record<string, number> = {
  single: 1, one: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100,
};

type LengthUnit = 'word' | 'sentence' | 'paragraph' | 'page';

export interface LengthRequest {
  max: number;
  unit: LengthUnit;
}

const COUNT = String.raw`(\d{1,4}|a single|a couple of|single|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|fifty|hundred)`;
const UNIT = String.raw`(words?|sentences?|paragraphs?|pages?)`;
/** "in 3 sentences", "under 100 words", "no more than two paragraphs", "maximum of 2 pages", "keep it to one paragraph". */
const LENGTH_LIMIT = new RegExp(
  String.raw`\b(?:in|under|within|below|no more than|not more than|at most|max(?:imum)?(?: of)?|up to|less than|fewer than|limit(?: it| this| that)? to|keep (?:it|this|that|the \w+) (?:to|under|below|within))\s+` +
    `${COUNT}\\s+${UNIT}\\b`,
  'i',
);
/** "a 100-word summary", "a one-paragraph answer", "a two-sentence reply". */
const LENGTH_COMPOUND = new RegExp(String.raw`\b${COUNT}[- ](word|sentence|paragraph|page)\s+(?:summary|answer|reply|response|overview|version|recap|explanation|description|update)\b`, 'i');
/** A length that applies to each of several items ("3 posts, each under 100 words") cannot be read off the whole reply. */
const PER_ITEM = /\b(?:each|per|every|apiece|variations?|versions|options|alternatives|posts|emails|ads|headlines|captions|tweets|messages|slides|sections|articles|drafts)\b/i;
/** Word counts of a printed page, and the slack every limit gets (a greeting, a follow-up offer). */
const WORDS_PER_PAGE = 500;
const LENGTH_TOLERANCE = 1.5;
const WORD_SLACK = 25;

function sentenceOf(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('\n', index), text.lastIndexOf('. ', index), text.lastIndexOf('? ', index), text.lastIndexOf('! ', index));
  const ends = ['\n', '. ', '? ', '! '].map((d) => text.indexOf(d, index)).filter((i) => i !== -1);
  return text.slice(start + 1, ends.length ? Math.min(...ends) : text.length);
}

function countOf(raw: string): number | undefined {
  const key = raw.toLowerCase().replace(/^a (single|couple of)$/, (_, w: string) => (w === 'single' ? 'single' : 'couple'));
  const n = /^\d+$/.test(key) ? Number(key) : NUMBER_WORDS[key];
  return n !== undefined && n > 0 ? n : undefined;
}

function unitOf(raw: string): LengthUnit {
  return raw.toLowerCase().replace(/s$/, '') as LengthUnit;
}

/**
 * Length and format requests count only in a message short enough to be a direct instruction.
 * In a pasted brief or a scheduled task spec they usually govern one part of the output, not the
 * chat reply (measured: every "one sentence" hit in a 7-day prod window came from one ~12k-char
 * scheduled spec whose reply was a multi-part report).
 */
const DIRECT_INSTRUCTION_MAX_CHARS = 1000;

function lengthRequestsFrom(re: RegExp, userText: string): LengthRequest[] {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: LengthRequest[] = [];
  for (let m = global.exec(userText); m; m = global.exec(userText)) {
    const max = countOf(m[1]);
    const unit = unitOf(m[2]);
    if (max && !PER_ITEM.test(sentenceOf(userText, m.index))) out.push({ max, unit });
  }
  return out;
}

/**
 * Every explicit length bound the user message states — there can be more than one, e.g.
 * "in 3 sentences and under 50 words" gives both a sentence bound and a word bound, and a reply
 * must satisfy each independently. Each matched span is unambiguously a size limit of a known
 * unit, so combining them is safe (unlike guessing which of several unrelated instructions a
 * single check should apply to) — no need to abstain just because there is more than one.
 */
export function parseLengthRequests(userText: string): LengthRequest[] {
  if (userText.length > DIRECT_INSTRUCTION_MAX_CHARS) return [];
  const found = [...lengthRequestsFrom(LENGTH_LIMIT, userText), ...lengthRequestsFrom(LENGTH_COMPOUND, userText)];
  const seen = new Map<string, LengthRequest>();
  for (const req of found) {
    const key = `${req.unit}:${req.max}`;
    if (!seen.has(key)) seen.set(key, req);
  }
  return [...seen.values()];
}

/** The single explicit length bound a user message states, when there is exactly one. */
export function parseLengthRequest(userText: string): LengthRequest | undefined {
  const all = parseLengthRequests(userText);
  return all.length === 1 ? all[0] : undefined;
}

/**
 * Chat replies may be HTML or markdown: tags become line breaks, markup is not words.
 * Paragraph-LEVEL boundaries (`<p>`, `<div>`, headings, 2+ consecutive `<br>`) become a blank
 * line, so paragraphCount doesn't undercount an HTML reply (3 `<p>` elements measuring as 1
 * paragraph because `</p>` collapsed to a single newline like any other line break). A lone
 * `<br>` or a list item stays a simple line break — a list, or a soft break inside one block of
 * text, is not itself a new paragraph.
 */
function plainText(reply: string): string {
  return reply
    .replace(/(?:<\s*br\s*\/?>\s*){2,}/gi, '\n\n')
    .replace(/<\s*\/?\s*(p|div|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<\s*(br|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\n\s*\n/g, '\n\n');
}

export function wordCount(text: string): number {
  return plainText(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function sentenceCount(text: string): number {
  return plainText(text).split(/(?<=[.!?])\s+|\n+/).filter((s) => /[\p{L}\p{N}]{2,}/u.test(s)).length;
}

function paragraphCount(text: string): number {
  return plainText(text).split(/\n\s*\n/).filter((p) => /[\p{L}\p{N}]/u.test(p)).length;
}

/** Whether a reply is over the request by more than the tolerance; with the measured and allowed size. */
export function exceedsLength(reply: string, req: LengthRequest): { over: boolean; measured: number; allowed: number; unit: string } {
  if (req.unit === 'word' || req.unit === 'page') {
    const words = req.unit === 'page' ? req.max * WORDS_PER_PAGE : req.max;
    const allowed = Math.floor(words * LENGTH_TOLERANCE) + WORD_SLACK;
    const measured = wordCount(reply);
    return { over: measured > allowed, measured, allowed, unit: 'words' };
  }
  const measured = req.unit === 'sentence' ? sentenceCount(reply) : paragraphCount(reply);
  const allowed = Math.floor(req.max * LENGTH_TOLERANCE) + (req.unit === 'sentence' ? 2 : 1);
  return { over: measured > allowed, measured, allowed, unit: `${req.unit}s` };
}

export type FormatRequest = 'table' | 'list';

const NEGATED = /\b(?:no|not|don'?t|do not|without|avoid|instead of|rather than)\s+(?:\w+\s+){0,2}$/i;
const TABLE_REQUEST = /\b(?:(?:in|as|into|using|use|with|make|create|build|give me|show(?: me)?|put (?:it|this|that|them|these|those|everything) in|format(?:ted)? (?:it |this )?as|organi[sz]e (?:it|this|them|these) (?:in|into))\s+(?:a |an )?(?:\w+ )?table\b|table format\b|tabular\b)/i;
const LIST_REQUEST = /\b(?:bullet(?:ed)?[ -]?(?:points?|list|form|format)|in bullets|as bullets|bulleted)\b/i;
/** A table or list meant for a file, sheet or other system, not for the chat reply. */
const EXTERNAL_TARGET_WORD = /\b(?:sheets?|spreadsheet|excel|csv|google|doc(?:ument)?|pdf|airtable|notion|database|crm|hubspot|slides?|deck|presentation|email|landing page|website|post)\b/i;
/**
 * The external keyword instead names the INPUT being formatted ("the CSV data below", "this
 * spreadsheet export") rather than a destination — the tell is the keyword sitting directly
 * before a data-ish noun. Only this specific, narrow pattern is carved out of
 * EXTERNAL_TARGET_WORD: everything else keeps the original broad "any external system named
 * nearby" reading, since a genuine destination is usually phrased loosely ("in Airtable",
 * "to our CRM") and a false negative here (missing a real destination) is worse than the
 * false positive this fixes (a table request for pasted CSV data wrongly excluded).
 */
const EXTERNAL_SOURCE_DATA = /\b(?:sheets?|spreadsheet|excel|csv|google|doc(?:ument)?|pdf|airtable|notion|database|crm|hubspot|slides?|deck|presentation|email|landing page|website|post)\s+(?:data|file|export|list|records?|rows?|report)\b/i;

function isExternalTarget(sentence: string): boolean {
  return EXTERNAL_TARGET_WORD.test(sentence) && !EXTERNAL_SOURCE_DATA.test(sentence);
}
/** Tools whose output is the deliverable, so its format is not in the chat reply. */
const PRODUCING_TOOL = /(create|generate|write|draft|update|publish|post|send|export|save|upload|doc|sheet|slide|email|blog|article|image|video|landing)/i;

function firstUnnegated(re: RegExp, text: string): RegExpExecArray | undefined {
  const global = new RegExp(re.source, 'gi');
  for (let m = global.exec(text); m; m = global.exec(text)) {
    if (!NEGATED.test(text.slice(Math.max(0, m.index - 30), m.index))) return m;
  }
  return undefined;
}

/** A chat-format request (table or bulleted list) in a user message; a table wins when both are asked. */
export function parseFormatRequest(userText: string): FormatRequest | undefined {
  if (userText.length > DIRECT_INSTRUCTION_MAX_CHARS) return undefined;
  for (const [kind, re] of [['table', TABLE_REQUEST], ['list', LIST_REQUEST]] as const) {
    const m = firstUnnegated(re, userText);
    if (m && !isExternalTarget(sentenceOf(userText, m.index))) return kind;
  }
  return undefined;
}

const MARKDOWN_TABLE = /^\s*\|?[^\n|]*\|[^\n]*\n\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
const LIST_LINE = /^\s*(?:[-*•+]|\d{1,2}[.)])\s+\S/gm;

export function replyHasFormat(reply: string, kind: FormatRequest): boolean {
  if (kind === 'table') return MARKDOWN_TABLE.test(reply) || /<table\b/i.test(reply);
  return (reply.match(LIST_LINE)?.length ?? 0) >= 2 || /<li\b/i.test(reply);
}

/** Told to act without asking: explicit anywhere, or a short go-ahead message. */
const ACT_EXPLICIT = /\b(?:(?:don'?t|do not|stop|no need to|without) (?:ask(?:ing)?|check(?:ing)? (?:in|with me|back)|confirm(?:ing|ation)?|wait(?:ing)? for (?:my )?(?:approval|confirmation))|you (?:don'?t|do not) need (?:my )?(?:permission|approval|confirmation)|(?:you have|with) my (?:permission|approval|go-ahead))\b/i;
const ACT_GO_AHEAD = /\b(?:go ahead|go for it|just do it|do it now|proceed|yes,? do it|please do it|make it happen)\b/i;
/** "how should we proceed?", "before you go ahead": a question about acting, not an instruction to. */
const NOT_A_GO_AHEAD = /\b(?:how|when|whether|if|before|until|can I|should I|do I)\s+(?:\w+\s+){0,3}$/i;
const GO_AHEAD_MAX_CHARS = 200;

export function isActInstruction(userText: string): boolean {
  const text = userText.trim();
  if (ACT_EXPLICIT.test(text)) return true;
  if (text.length > GO_AHEAD_MAX_CHARS) return false;
  const m = firstUnnegated(ACT_GO_AHEAD, text);
  return !!m && !NOT_A_GO_AHEAD.test(text.slice(0, m.index));
}

/** Asking whether to proceed at all: a permission request whatever else the reply holds. */
const ASKS_TO_PROCEED = /\b(?:(?:shall|should|can|may) I (?:go ahead|proceed|start|begin|continue|move forward)|(?:ok(?:ay)?|good|ready) (?:for me )?to (?:proceed|go ahead|start)|(?:would you like|do you want) me to (?:go ahead|proceed|start|begin|continue)|shall we (?:proceed|go ahead|start)|please confirm|(?:awaiting|waiting for) your (?:confirmation|approval|go-ahead))\b/i;
/** An offer to do something: a permission request only when the reply is little else. */
const OFFERS = /\b(?:would you like me to|do you want me to|want me to|should I|shall I)\b/i;
const OFFER_ONLY_MAX_WORDS = 80;
/**
 * A wh-word within roughly the first few words of the sentence — catches both a bare clarifying
 * question ("Which account should I use?") and one prefixed by a stock phrase ("Please confirm
 * which account to update?", which would otherwise match ASKS_TO_PROCEED's bare "please confirm"
 * and be misread as asking permission to proceed, when it is really asking which target to act
 * on). Checking only the literal start of the sentence missed the prefixed form.
 */
const WH_EARLY_WORD_WINDOW = 5;
const WH_WORD = /\b(?:which|what|who|where|when|how)\b/i;
function startsWithClarifyingWh(sentence: string): boolean {
  const lead = sentence.trim().split(/\s+/).slice(0, WH_EARLY_WORD_WINDOW).join(' ');
  return WH_WORD.test(lead);
}
/** Confirming a spend, publish, send or irreversible step is correct even after "go ahead" (ENG-1312 rule). */
const CONSEQUENTIAL = /(?:\$\s?\d|\bbudgets?\b|\bspend\b|\bbid\b|\bpublish|\bsend\b|\bsending\b|\blaunch|\bgo live\b|\bdelete|\bremove|\bcharge|\bpay(?:ment)?\b|\bactivate|\bunpause|\benable\b)/i;

function questionSentences(reply: string): string[] {
  return plainText(reply)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => s.trim().endsWith('?') || /please confirm/i.test(s));
}

/** The reply's permission request, if it makes one (a which/what clarifying question does not count). */
export function permissionRequest(reply: string): string | undefined {
  const offerOnly = wordCount(reply) <= OFFER_ONLY_MAX_WORDS;
  return questionSentences(reply).find((s) => !startsWithClarifyingWh(s) && (ASKS_TO_PROCEED.test(s) || (offerOnly && OFFERS.test(s))));
}

/**
 * A tool call that actually did the requested work: not a plan-management call, and not a
 * read-only lookup (list/search/get/…) either — reading context or checking existing state is
 * not the same as having performed the action the user asked for (ENG-1276's read/write
 * classifier, reused here rather than a second one: a turn that only listed documents and then
 * asked whether to create the draft never acted).
 */
function isWorkTool(name: string): boolean {
  return !PLAN_MANAGEMENT_TOOLS.has(name) && !isReadOnlyToolName(name);
}

function adherenceOf(
  turns: readonly GraderTurn[],
  notApplicable: AdherenceReason,
  gradeTurn: (turn: GraderTurn) => { reason: AdherenceReason; detail?: string } | undefined,
  failing: ReadonlySet<AdherenceReason>,
): AdherenceResult {
  let applicable = 0;
  let firstPass: { reason: AdherenceReason; detail?: string } | undefined;
  // Keep scanning after the first failure so applicableTurns counts every applicable turn in the
  // session (the correct denominator for the rate), not just the ones up to the first failure;
  // the FIRST failure is still what's reported, as the clearest single example.
  let firstFailure: { reason: AdherenceReason; detail?: string; turnIndex: number } | undefined;
  let lastNa: AdherenceReason | undefined;
  for (const [i, turn] of turns.entries()) {
    const graded = gradeTurn(turn);
    if (!graded) continue;
    if (graded.reason === 'no_reply' || graded.reason === 'delivered_via_tool') {
      lastNa = graded.reason;
      continue;
    }
    applicable++;
    if (failing.has(graded.reason)) {
      firstFailure ??= { ...graded, turnIndex: i };
      continue;
    }
    firstPass ??= graded;
  }
  if (firstFailure) {
    return {
      verdict: 'fail',
      reason: firstFailure.reason,
      applicableTurns: applicable,
      detail: `turn ${firstFailure.turnIndex + 1}${firstFailure.detail ? `: ${firstFailure.detail}` : ''}`,
    };
  }
  if (firstPass) return { verdict: 'pass', reason: firstPass.reason, applicableTurns: applicable, ...(firstPass.detail ? { detail: firstPass.detail } : {}) };
  return { verdict: 'not_applicable', reason: lastNa ?? notApplicable, applicableTurns: 0 };
}

function lengthDetail(req: LengthRequest, m: ReturnType<typeof exceedsLength>): string {
  return `${m.measured} ${m.unit} vs <= ${req.max} ${req.unit}${req.max === 1 ? '' : 's'} (fails above ${m.allowed})`;
}

/**
 * Reply length vs every explicit length bound the user asked for (words, sentences, paragraphs,
 * pages) — checked independently, so "in 3 sentences and under 50 words" fails if the reply
 * breaks either bound, not just whichever one this function happened to look at first.
 */
export function gradeLengthAdherence(turns: readonly GraderTurn[]): AdherenceResult {
  return adherenceOf(turns, 'no_length_request', (turn) => {
    const reqs = parseLengthRequests(turn.userText);
    if (reqs.length === 0) return undefined;
    if (!turn.replyText) return { reason: 'no_reply' };
    const replyText = turn.replyText;
    const measured = reqs.map((req) => ({ req, m: exceedsLength(replyText, req) }));
    const violated = measured.find(({ m }) => m.over);
    if (violated) return { reason: 'exceeded_requested_length', detail: lengthDetail(violated.req, violated.m) };
    return { reason: 'within_requested_length', detail: measured.map(({ req, m }) => lengthDetail(req, m)).join('; ') };
  }, new Set(['exceeded_requested_length']));
}

/** A table or bulleted list asked for in chat, and present in the reply. */
export function gradeFormatAdherence(turns: readonly GraderTurn[]): AdherenceResult {
  return adherenceOf(turns, 'no_format_request', (turn) => {
    const kind = parseFormatRequest(turn.userText);
    if (!kind) return undefined;
    if (turn.toolNames.some((n) => isWorkTool(n) && PRODUCING_TOOL.test(n))) return { reason: 'delivered_via_tool' };
    if (!turn.replyText) return { reason: 'no_reply' };
    if (replyHasFormat(turn.replyText, kind)) return { reason: 'format_followed', detail: kind };
    return { reason: kind === 'table' ? 'table_missing' : 'list_missing' };
  }, new Set(['table_missing', 'list_missing']));
}

/**
 * Told to act ("go ahead", "don't ask"), the agent ran no work tool that turn and asked for
 * permission instead. Confirming a spend, publish, send or irreversible step still passes.
 */
export function gradePermissionAdherence(turns: readonly GraderTurn[]): AdherenceResult {
  return adherenceOf(turns, 'no_act_instruction', (turn) => {
    if (!isActInstruction(turn.userText)) return undefined;
    // A tool-only turn (the agent ran a work tool and gave no separate reply text this turn,
    // e.g. it acts first and reports back later) has acted, so this must be checked before the
    // no_reply case below — otherwise it wrongly abstains instead of passing.
    if (turn.toolNames.some(isWorkTool)) return { reason: 'acted_without_asking' };
    if (!turn.replyText) return { reason: 'no_reply' };
    const ask = permissionRequest(turn.replyText);
    if (!ask) return { reason: 'acted_without_asking' };
    if (CONSEQUENTIAL.test(ask)) return { reason: 'confirmed_consequential_action' };
    return { reason: 'asked_permission_after_instruction' };
  }, new Set(['asked_permission_after_instruction']));
}

export interface AdherenceResults {
  length: AdherenceResult;
  format: AdherenceResult;
  permission: AdherenceResult;
}

export function gradeAdherence(turns: readonly GraderTurn[] = []): AdherenceResults {
  return { length: gradeLengthAdherence(turns), format: gradeFormatAdherence(turns), permission: gradePermissionAdherence(turns) };
}

/** Registry id of each adherence check. */
export const ADHERENCE_GRADER_IDS = {
  length: 'agent-reply-length-adherence',
  format: 'agent-format-adherence',
  permission: 'agent-act-without-asking',
} as const satisfies Record<keyof AdherenceResults, AgentGraderId>;

export interface AdherenceRate {
  graderId: AgentGraderId;
  /** Sessions the check applied to (pass + fail). */
  n: number;
  passes: number;
  rate: number | null;
  /** 95% Wilson score interval on the pass rate; null when n is 0. */
  ci: Interval | null;
  notApplicable: number;
}

/** Pass rate of each adherence check over the sessions it applied to, with n and a Wilson CI. */
export function adherenceRates(results: readonly AdherenceResults[]): AdherenceRate[] {
  return (Object.keys(ADHERENCE_GRADER_IDS) as Array<keyof AdherenceResults>).map((key) => {
    const verdicts = results.map((r) => r[key].verdict);
    const passes = verdicts.filter((v) => v === 'pass').length;
    const n = passes + verdicts.filter((v) => v === 'fail').length;
    return {
      graderId: ADHERENCE_GRADER_IDS[key],
      n,
      passes,
      rate: n ? passes / n : null,
      ci: n ? wilsonInterval(passes, n) : null,
      notApplicable: results.length - n,
    };
  });
}

// ---------------------------------------------------------------------------
// Efficiency per successful task
// ---------------------------------------------------------------------------

/** Spend for one session from AW-SpendEvents (settled rows with references.sessionId). */
export interface SessionSpend {
  costMicroUsd: number;
  tokens: number;
}

export interface EfficiencyInput {
  task: TaskVerdict;
  userTurns: number;
  /** Absent when AW-SpendEvents has no settled row for the session. */
  spend?: SessionSpend;
  /** Dev-AW-LoopEvents durationMs of the session's tool calls. */
  toolDurationsMs: number[];
}

export interface EfficiencySummary {
  /** Sessions with a success or failure label (excluded ones are not counted). */
  graded: number;
  successes: number;
  successRate: number | null;
  successRateCI: Interval | null;
  meanTurnsPerSuccess: number | null;
  meanTokensPerSuccess: number | null;
  /** Spend of every graded session that has spend data, divided by its successes: failures are charged to successes. */
  costPerSuccessUsd: number | null;
  medianSuccessCostUsd: number | null;
  /** Graded sessions with spend data (cost figures cover only these). */
  gradedWithSpend: number;
  toolLatencyP50Ms: number | null;
  toolLatencyP95Ms: number | null;
}

function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Nearest-rank percentile. */
function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Turns, tokens, cost and tool latency per successful task, with n and a Wilson CI on the rate. */
export function efficiencyMetrics(inputs: readonly EfficiencyInput[]): EfficiencySummary {
  const graded = inputs.filter((i) => i.task !== 'excluded');
  const wins = graded.filter((i) => i.task === 'success');
  const withSpend = graded.filter((i) => i.spend);
  const winsWithSpend = wins.filter((i) => i.spend);
  const costOf = (i: EfficiencyInput) => (i.spend?.costMicroUsd ?? 0) / 1e6;
  const latencies = wins.flatMap((i) => i.toolDurationsMs);
  return {
    graded: graded.length,
    successes: wins.length,
    successRate: graded.length ? wins.length / graded.length : null,
    successRateCI: graded.length ? wilsonInterval(wins.length, graded.length) : null,
    meanTurnsPerSuccess: mean(wins.map((i) => i.userTurns)),
    meanTokensPerSuccess: mean(winsWithSpend.map((i) => i.spend?.tokens ?? 0)),
    costPerSuccessUsd: winsWithSpend.length ? withSpend.reduce((a, i) => a + costOf(i), 0) / winsWithSpend.length : null,
    medianSuccessCostUsd: percentile(winsWithSpend.map(costOf), 0.5),
    gradedWithSpend: withSpend.length,
    toolLatencyP50Ms: percentile(latencies, 0.5),
    toolLatencyP95Ms: percentile(latencies, 0.95),
  };
}

// ---------------------------------------------------------------------------
// Task type and per-group aggregation
// ---------------------------------------------------------------------------

export type TaskType = 'ads' | 'landing_page' | 'outreach' | 'content' | 'research' | 'other';

/**
 * Keyword task taxonomy over the work-plan title. No category is stored on a session's plan,
 * so, like ENG-1710's benchmark, this is a heuristic: first match wins, in this order.
 */
const TASK_TYPE_PATTERNS: ReadonlyArray<[TaskType, RegExp]> = [
  ['ads', /\b(ads?|advert\w*|campaigns?|ppc|adwords|keywords?|bid\w*|budgets?|meta|facebook|google ads)\b/i],
  ['landing_page', /\b(landing|lander|website|web ?page|page)\b/i],
  ['outreach', /\b(outreach|prospect\w*|leads?|cold|invites?|connections?|sequences?)\b/i],
  ['content', /\b(blog|posts?|content|articles?|social|newsletter|videos?|images?|creatives?|copy)\b/i],
  ['research', /\b(research|audit|analy\w*|competitor\w*|reports?|review|insights?)\b/i],
];

export function classifyTaskType(workPlanTitle: string | undefined): TaskType {
  if (!workPlanTitle) return 'other';
  for (const [type, re] of TASK_TYPE_PATTERNS) if (re.test(workPlanTitle)) return type;
  return 'other';
}

export interface GradedSession {
  sessionId: string;
  model: string;
  taskType: TaskType;
  task: TaskSuccessResult;
  tools: ToolCorrectnessResult;
  groundedness: GroundednessResult;
  adherence: AdherenceResults;
  efficiency: EfficiencyInput;
}

export function gradeSession(session: SessionForGrading, model: string, spend: SessionSpend | undefined): GradedSession {
  const task = gradeTaskSuccess(session);
  const toolDurationsMs = session.events.flatMap((e) =>
    (e.eventType === EVT_TOOL_SUCCEEDED || e.eventType === EVT_TOOL_FAILED) && typeof e.dimensions.durationMs === 'number'
      ? [e.dimensions.durationMs]
      : []);
  return {
    sessionId: session.sessionId,
    model,
    taskType: classifyTaskType(session.workPlan?.title),
    task,
    tools: gradeToolCorrectness(session),
    groundedness: gradeGroundedness(session.finalReply, session.ledger),
    adherence: gradeAdherence(session.turns),
    efficiency: { task: task.verdict, userTurns: session.userTurns, ...(spend ? { spend } : {}), toolDurationsMs },
  };
}

export interface GroupReport extends EfficiencySummary {
  model: string;
  taskType: TaskType;
  sessions: number;
  excluded: number;
  toolFailSessions: number;
  writeWithoutReadBackSessions: number;
  /** Sessions labelled success that also had an unverified external write. */
  successWithUnverifiedWrite: number;
  ungroundedSessions: number;
  adherence: AdherenceRate[];
}

/** Aggregate graded sessions per model × task type, largest groups first. */
export function aggregateByModelAndTaskType(sessions: readonly GradedSession[]): GroupReport[] {
  const groups = new Map<string, GradedSession[]>();
  for (const s of sessions) {
    const key = `${s.model}\u0000${s.taskType}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const hasUnverifiedWrite = (s: GradedSession) => s.tools.findings.some((f) => f.kind === 'write_without_read_back');
  return [...groups.values()]
    .map((list) => ({
      model: list[0].model,
      taskType: list[0].taskType,
      sessions: list.length,
      excluded: list.filter((s) => s.task.verdict === 'excluded').length,
      toolFailSessions: list.filter((s) => s.tools.verdict === 'fail').length,
      writeWithoutReadBackSessions: list.filter(hasUnverifiedWrite).length,
      successWithUnverifiedWrite: list.filter((s) => s.task.verdict === 'success' && hasUnverifiedWrite(s)).length,
      ungroundedSessions: list.filter((s) => s.groundedness.verdict === 'ungrounded').length,
      adherence: adherenceRates(list.map((s) => s.adherence)),
      ...efficiencyMetrics(list.map((s) => s.efficiency)),
    }))
    .sort((a, b) => b.graded - a.graded || b.sessions - a.sessions || a.model.localeCompare(b.model));
}
