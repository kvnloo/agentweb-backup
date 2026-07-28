/**
 * Shared marketing-action contract + deterministic top-3 selector (ENG-445).
 *
 * ONE typed contract for "a recommended marketing action" and ONE deterministic
 * selector that every surface (portal "3 moves today" card, reports, Slack —
 * ENG-444) consumes. This prevents each surface from inventing its own
 * recommendation format or ranking. Consumers render; they never re-rank.
 *
 * Shape lineage (deliberately reused, not reinvented):
 *   - provenance (`sourceKind`/`sourceId`) mirrors loops/core `MutationProposal`
 *     (proposals carry their producing rule/run) — a "source report/run ID" is
 *     an existing report or run identifier, e.g. an `AW-AgentRuns` runId or a
 *     loop `RunId`;
 *   - tiered impact/confidence mirrors `RcaRankedFix` (ai-eval-funnel);
 *   - "a recommendation is the product" + stable machine ids mirrors
 *     `AskUserQuestionOption` (agentMode/core/askUserQuestion.ts);
 *   - the pure-module style (injected inputs, exported constants, explicit
 *     tie-break chain) mirrors `healthScoreService.ts` and the top-3 slice in
 *     `onboardingLoopApproval.ts`.
 *
 * Determinism contract (ENG-445 behavioral assertions):
 *   - identity: `marketingActionId(actionType, scopeId)` — a normalized content
 *     hash, so the same underlying action/scope ALWAYS gets the same id, and
 *     status changes never move it;
 *   - ranking: critical/campaign-priority tier first (a low-priority campaign
 *     can never displace a higher-priority action unless explicitly critical),
 *     then a weighted score over business impact > campaign priority > urgency
 *     > confidence > ease of execution, then per-factor tie-breaks, then
 *     lexicographic id, then canonical-JSON content — a total order, so the
 *     output is invariant under input permutation;
 *   - cap: at most MAX_MARKETING_ACTIONS (3); empty input → empty output,
 *     never placeholders.
 *
 * This module is PURE (no I/O, no network, no AWS). Persistence and transport
 * are the consumers' job (ENG-446 exposes canonical payloads through existing
 * report/run data). Deep links are portal paths per
 * `customerPortalPages.CUSTOMER_PORTAL_PAGES` or absolute URLs; this module
 * treats them as opaque non-empty strings.
 */

import { createHash } from 'crypto';

/** Tier used by every ranking factor. Mirrors RcaImpact/RcaConfidence. */
export type MarketingActionTier = 'high' | 'medium' | 'low';

/** Lifecycle status. Changing status NEVER changes the action id. */
export type MarketingActionStatus = 'proposed' | 'approved' | 'dismissed' | 'completed';

/** How a surface should present the call-to-action. */
export type MarketingActionCtaType = 'approve' | 'review' | 'navigate';

/** What kind of artifact produced this action. */
export type MarketingActionSourceKind = 'report' | 'run';

const TIERS: readonly MarketingActionTier[] = ['high', 'medium', 'low'];
const STATUSES: readonly MarketingActionStatus[] = [
  'proposed',
  'approved',
  'dismissed',
  'completed',
];
const CTA_TYPES: readonly MarketingActionCtaType[] = ['approve', 'review', 'navigate'];
const SOURCE_KINDS: readonly MarketingActionSourceKind[] = ['report', 'run'];

/** The five ranking factors (behavioral assertion 3) plus the explicit
 *  critical escalation (assertion 4). */
export interface MarketingActionPriorityInputs {
  businessImpact: MarketingActionTier;
  campaignPriority: MarketingActionTier;
  urgency: MarketingActionTier;
  confidence: MarketingActionTier;
  easeOfExecution: MarketingActionTier;
  /** Explicit escalation: ONLY a critical action may displace actions from
   *  higher-priority campaigns. Critical actions rank above all non-critical
   *  actions; among criticals the weighted score decides. */
  critical?: boolean;
}

/** A candidate action as produced from existing report/run data (ENG-446). */
export interface MarketingActionCandidate {
  /** Action verb/type, e.g. "pause_ad", "scale_budget". Non-empty. */
  actionType: string;
  /** Concise human-readable recommendation. Non-empty. */
  recommendation: string;
  /** Scope/campaign identifier the action applies to. Non-empty. */
  scopeId: string;
  /** Evidence lines backing the recommendation. */
  evidence: string[];
  /** Expected impact of taking the action. Non-empty. */
  expectedImpact: string;
  /** Which artifact produced this candidate. */
  sourceKind: MarketingActionSourceKind;
  /** The producing report/run id (existing primitive, e.g. AW-AgentRuns runId). */
  sourceId: string;
  /** Ranking factor inputs. */
  priority: MarketingActionPriorityInputs;
  /** How surfaces present the CTA. */
  ctaType: MarketingActionCtaType;
  /** Deep-link target: a customer-portal path (see CUSTOMER_PORTAL_PAGES) or URL. */
  deepLink: string;
}

/** A selected action: the candidate plus its stable id and lifecycle status. */
export interface MarketingAction extends MarketingActionCandidate {
  /** Stable id derived from (actionType, scopeId) — see marketingActionId(). */
  id: string;
  status: MarketingActionStatus;
}

/** Behavioral assertion 1: a surface never shows more than three moves. */
export const MAX_MARKETING_ACTIONS = 3;

/** Thrown on any structurally invalid candidate/payload. Fail loud, never
 *  silently drop or degrade (complete-work-only / avoid-fallbacks). */
export class MarketingActionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketingActionContractError';
  }
}

/**
 * Stable identity for "the same underlying action on the same scope".
 * Normalized (trim + lowercase) so cosmetic variance in producers does not
 * mint new ids; hashed so the id is one opaque token with no delimiter
 * ambiguity. Duplicate candidates collapse onto this id (assertion 5) and
 * status transitions preserve it (assertion 7).
 */
export function marketingActionId(actionType: string, scopeId: string): string {
  const canonical = `${actionType.trim().toLowerCase()}\u0000${scopeId.trim().toLowerCase()}`;
  return `act_${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

const TIER_VALUE: Record<MarketingActionTier, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Factor weights, most important first (assertion 3's stated order). */
const WEIGHTS = {
  businessImpact: 5,
  campaignPriority: 4,
  urgency: 3,
  confidence: 2,
  easeOfExecution: 1,
} as const;

/** Critical actions occupy a tier above 'high' campaign priority. */
const CRITICAL_TIER = TIER_VALUE.high + 1;

function effectiveCampaignTier(priority: MarketingActionPriorityInputs): number {
  return priority.critical === true ? CRITICAL_TIER : TIER_VALUE[priority.campaignPriority];
}

function weightedScore(priority: MarketingActionPriorityInputs): number {
  return (
    WEIGHTS.businessImpact * TIER_VALUE[priority.businessImpact] +
    WEIGHTS.campaignPriority * TIER_VALUE[priority.campaignPriority] +
    WEIGHTS.urgency * TIER_VALUE[priority.urgency] +
    WEIGHTS.confidence * TIER_VALUE[priority.confidence] +
    WEIGHTS.easeOfExecution * TIER_VALUE[priority.easeOfExecution]
  );
}

/** Canonical JSON with sorted keys — the last-resort content tie-break so the
 *  comparator is a TOTAL order even for same-identity, same-score variants. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface RankedCandidate {
  candidate: MarketingActionCandidate;
  id: string;
  campaignTier: number;
  score: number;
  canonical: string;
}

/**
 * Deterministic total order. Chain:
 *   1. critical/campaign-priority tier (desc)   — assertion 4
 *   2. weighted five-factor score (desc)        — assertion 3
 *   3. per-factor tiers, most-important first (desc)
 *   4. id (asc, lexicographic)                  — assertion 2 tie-break
 *   5. canonical content (asc)                  — total order for same-id variants
 */
function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (a.campaignTier !== b.campaignTier) return b.campaignTier - a.campaignTier;
  if (a.score !== b.score) return b.score - a.score;
  for (const factor of [
    'businessImpact',
    'campaignPriority',
    'urgency',
    'confidence',
    'easeOfExecution',
  ] as const) {
    const av = TIER_VALUE[a.candidate.priority[factor]];
    const bv = TIER_VALUE[b.candidate.priority[factor]];
    if (av !== bv) return bv - av;
  }
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.canonical !== b.canonical) return a.canonical < b.canonical ? -1 : 1;
  return 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertCandidate(candidate: unknown, index: number): asserts candidate is MarketingActionCandidate {
  if (candidate === null || typeof candidate !== 'object') {
    throw new MarketingActionContractError(
      `Invalid marketing-action candidate at index ${index}: not an object`
    );
  }
  const c = candidate as Record<string, unknown>;
  for (const field of [
    'actionType',
    'recommendation',
    'scopeId',
    'expectedImpact',
    'sourceId',
    'deepLink',
  ] as const) {
    if (!isNonEmptyString(c[field])) {
      throw new MarketingActionContractError(
        `Invalid marketing-action candidate at index ${index}: "${field}" must be a non-empty string`
      );
    }
  }
  if (!Array.isArray(c.evidence) || c.evidence.some((e) => typeof e !== 'string')) {
    throw new MarketingActionContractError(
      `Invalid marketing-action candidate at index ${index}: "evidence" must be an array of strings`
    );
  }
  if (!SOURCE_KINDS.includes(c.sourceKind as MarketingActionSourceKind)) {
    throw new MarketingActionContractError(
      `Invalid marketing-action candidate at index ${index}: "sourceKind" must be one of ${SOURCE_KINDS.join(', ')}`
    );
  }
  if (!CTA_TYPES.includes(c.ctaType as MarketingActionCtaType)) {
    throw new MarketingActionContractError(
      `Invalid marketing-action candidate at index ${index}: "ctaType" must be one of ${CTA_TYPES.join(', ')}`
    );
  }
  const priority = c.priority as Record<string, unknown> | null | undefined;
  if (priority === null || typeof priority !== 'object') {
    throw new MarketingActionContractError(
      `Invalid marketing-action candidate at index ${index}: "priority" must be an object`
    );
  }
  for (const factor of [
    'businessImpact',
    'campaignPriority',
    'urgency',
    'confidence',
    'easeOfExecution',
  ] as const) {
    if (!TIERS.includes(priority[factor] as MarketingActionTier)) {
      throw new MarketingActionContractError(
        `Invalid marketing-action candidate at index ${index}: priority "${factor}" must be one of ${TIERS.join(', ')}`
      );
    }
  }
  if (priority.critical !== undefined && typeof priority.critical !== 'boolean') {
    throw new MarketingActionContractError(
      `Invalid marketing-action candidate at index ${index}: priority "critical" must be a boolean when present`
    );
  }
}

/**
 * The deterministic top-3 selector.
 *
 * Given candidate actions derived from existing report/run data, returns the
 * 0–3 actions a surface should show, ranked, deduplicated, and stamped with
 * stable ids and status 'proposed'. Same inputs (in any order) → same ids in
 * the same order. Empty input → empty output. Structurally invalid input
 * throws MarketingActionContractError naming the field and index.
 */
export function selectTopMarketingActions(
  candidates: MarketingActionCandidate[]
): MarketingAction[] {
  if (!Array.isArray(candidates)) {
    throw new MarketingActionContractError('Candidates must be an array');
  }
  if (candidates.length === 0) return [];

  const ranked: RankedCandidate[] = candidates.map((candidate, index) => {
    assertCandidate(candidate, index);
    return {
      candidate,
      id: marketingActionId(candidate.actionType, candidate.scopeId),
      campaignTier: effectiveCampaignTier(candidate.priority),
      score: weightedScore(candidate.priority),
      canonical: canonicalJson(candidate),
    };
  });

  // Duplicate collapse (assertion 5): same underlying action/scope → one
  // representation. Keep the comparator-best variant so the collapse itself
  // is order-independent.
  const bestById = new Map<string, RankedCandidate>();
  for (const entry of ranked) {
    const existing = bestById.get(entry.id);
    if (existing === undefined || compareRanked(entry, existing) < 0) {
      bestById.set(entry.id, entry);
    }
  }

  return [...bestById.values()]
    .sort(compareRanked)
    .slice(0, MAX_MARKETING_ACTIONS)
    .map(({ candidate, id }) => ({ ...candidate, id, status: 'proposed' as const }));
}

/**
 * Pure status transition (assertion 7): returns a new action with the new
 * status and the SAME id. Unknown statuses throw.
 */
export function transitionMarketingActionStatus(
  action: MarketingAction,
  status: MarketingActionStatus
): MarketingAction {
  if (!STATUSES.includes(status)) {
    throw new MarketingActionContractError(
      `Invalid marketing-action status "${String(status)}": must be one of ${STATUSES.join(', ')}`
    );
  }
  return { ...action, status };
}

/** Serialize selected actions for transport/persistence (assertion 6). */
export function serializeMarketingActions(actions: MarketingAction[]): string {
  return JSON.stringify(actions);
}

/**
 * Parse + validate a serialized action list. The stored id and status are
 * preserved verbatim (round-trip stability); every field is re-validated so a
 * tampered or truncated payload fails loudly instead of flowing downstream.
 */
export function parseMarketingActions(json: string): MarketingAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new MarketingActionContractError(
      `Marketing-action payload is not valid JSON: ${(err as Error).message}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MarketingActionContractError(
      'Marketing-action payload must be a JSON array of actions'
    );
  }
  return parsed.map((entry, index) => {
    assertCandidate(entry, index);
    const record = entry as unknown as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) {
      throw new MarketingActionContractError(
        `Invalid marketing action at index ${index}: "id" must be a non-empty string`
      );
    }
    if (!STATUSES.includes(record.status as MarketingActionStatus)) {
      throw new MarketingActionContractError(
        `Invalid marketing action at index ${index}: "status" must be one of ${STATUSES.join(', ')}`
      );
    }
    return entry as unknown as MarketingAction;
  });
}
