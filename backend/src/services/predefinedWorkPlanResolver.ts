/**
 * predefinedWorkPlanResolver — the single, canonical "which predefined work plan
 * templates can this caller see/use" access resolver.
 *
 * Extracted (ENG-1472, behavior-preserving) out of the private/org/system/public
 * candidate-building logic that was previously duplicated inline inside
 * `agentModeService.applyPredefinedWorkPlan`. That function now imports
 * `getAccessiblePredefinedWorkPlanCandidates` from here instead of re-querying
 * DynamoDB itself; its title-or-planId matching and error messages are otherwise
 * untouched (see the characterization tests in
 * `__tests__/predefinedWorkPlanResolver.test.ts` and the extended
 * `__tests__/agentModeService.applyWorkPlan.test.ts`).
 *
 * `resolveAccessiblePredefinedWorkPlan` is the new, stricter, planId-ONLY lookup
 * used by the `recommend_predefined_work_plan` Emma tool and the
 * work-plan-recommendation accept endpoint: recommendation must never resolve by
 * title (a title can collide across visibility scopes; a stable planId cannot),
 * and every lookup re-reads the canonical DynamoDB record at call time rather
 * than trusting anything cached or model-supplied.
 */
import { workPlanService, type WorkPlan } from './workPlanService';

/** The persisted shape of a `recommend_predefined_work_plan` tool result (ENG-1472). */
export interface PersistedWorkPlanRecommendation {
  type: 'workplan_recommendation';
  version: 1;
  recommendationId: string;
  plan: {
    id: string;
    title: string;
    summary: string;
    steps: Array<{ position: number; label: string }>;
  };
  reason: string;
  source?: string;
}

/**
 * Scan a session's persisted assistant messages for a `workplan_recommendation`
 * (v1) tool-call result matching `predicate`. Shared by
 * `AgentModeService.recommendPredefinedWorkPlan` (dedupe by planId) and the
 * work-plan-recommendation accept endpoint (lookup by recommendationId) so the
 * "how do I find a previously-persisted recommendation" scan lives in exactly
 * one place instead of being copy-pasted into the controller.
 */
export function findWorkPlanRecommendationToolResult(
  messages: any[] | undefined,
  predicate: (result: PersistedWorkPlanRecommendation) => boolean,
): PersistedWorkPlanRecommendation | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    const toolCalls = message?.metadata?.toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const toolCall of toolCalls) {
      const result = toolCall?.result;
      if (
        result
        && result.type === 'workplan_recommendation'
        && result.version === 1
        && predicate(result)
      ) {
        return result as PersistedWorkPlanRecommendation;
      }
    }
  }
  return null;
}

/**
 * Build the full candidate list of predefined work plan templates a given user
 * (or anonymous caller) may resolve, honoring the existing private/org/system/
 * public visibility rules:
 *   - authenticated, non-anonymous callers may resolve their own private plans
 *     and their org's private plans;
 *   - anonymous callers (no userId, or a userId starting with "anon_") never
 *     see private plans;
 *   - every caller may resolve published `system` and `public` plans.
 * `pending_review` plans are never included — they are fetched by neither the
 * owner/org query (which filters to `visibility === 'private'`) nor the
 * system/public visibility queries, so an unpublished draft can never resolve
 * through this path.
 */
export async function getAccessiblePredefinedWorkPlanCandidates(userId?: string): Promise<WorkPlan[]> {
  const candidates: WorkPlan[] = [];
  if (userId && !userId.startsWith('anon_')) {
    try {
      const { userDb } = await import('./db');
      const user = await userDb.getUserById(userId);
      const [ownPlans, orgPlans] = await Promise.all([
        workPlanService.getWorkPlansByOwner(userId),
        user?.orgId ? workPlanService.getWorkPlansByOrg(user.orgId) : Promise.resolve([]),
      ]);
      const seen = new Set<string>();
      for (const p of [...ownPlans, ...orgPlans]) {
        if (p.visibility === 'private' && !seen.has(p.planId)) {
          seen.add(p.planId);
          candidates.push(p);
        }
      }
    } catch (err) {
      console.warn('[predefinedWorkPlanResolver] Error loading private plans:', (err as Error).message);
    }
  }
  const [systemPlans, publicPlans] = await Promise.all([
    workPlanService.getWorkPlansByVisibility('system'),
    workPlanService.getWorkPlansByVisibility('public'),
  ]);
  candidates.push(...systemPlans, ...publicPlans);
  return candidates;
}

/**
 * Defensive shape guard. A malformed or wrong-type DynamoDB row (missing title,
 * steps not an array, an unrecognized/legacy visibility value) must never be
 * surfaced as a resolved, launchable plan — it returns "unavailable" instead of
 * partial display data.
 */
function isWellFormedAccessiblePlan(plan: unknown): plan is WorkPlan {
  if (!plan || typeof plan !== 'object') return false;
  const p = plan as Record<string, unknown>;
  return (
    typeof p.planId === 'string' && p.planId.trim() !== '' &&
    typeof p.title === 'string' && p.title.trim() !== '' &&
    Array.isArray(p.steps) &&
    (p.visibility === 'system' || p.visibility === 'private' || p.visibility === 'public')
  );
}

/**
 * Resolve exactly one predefined work plan template by its stable planId, honoring
 * the same accessible-candidate rules as {@link getAccessiblePredefinedWorkPlanCandidates}.
 * Returns `null` — never a partial/malformed object — when the plan:
 *   - does not exist (deleted),
 *   - is `pending_review` (never published),
 *   - is a private plan the caller does not own / share an org with,
 *   - is anonymous-and-private (defense in depth; anonymous callers are never
 *     given private candidates in the first place, but this guard holds even if
 *     that ever changes),
 *   - or is a malformed / wrong-type record.
 *
 * Never matches by title — recommendation and acceptance must be pinned to the
 * immutable planId the model/tool actually resolved, not a human-readable string
 * that can be renamed or collide across visibility scopes.
 */
export async function resolveAccessiblePredefinedWorkPlan(input: {
  planId: string;
  userId?: string;
}): Promise<WorkPlan | null> {
  const { planId, userId } = input;
  if (typeof planId !== 'string' || planId.trim() === '') return null;

  const candidates = await getAccessiblePredefinedWorkPlanCandidates(userId);
  const match = candidates.find((p) => p && p.planId === planId);
  if (!match) return null;
  if (!isWellFormedAccessiblePlan(match)) return null;
  if (match.visibility === 'private' && (!userId || userId.startsWith('anon_'))) return null;
  return match;
}

/**
 * ENG-1472 completion-recommendation extension: given a just-completed template
 * plan record, resolve its author-approved "what to do next" plan IDs into real,
 * currently-accessible WorkPlan records for `userId`.
 *
 * `display.nextPlanIds` is read defensively (optional chaining / duck typing,
 * never a typed property access): ENG-1469 (the workplan display-metadata
 * schema) is a separate, not-yet-merged PR, so the `WorkPlan` type declared in
 * `workPlanService.ts` does not carry this field yet and no plan in any
 * environment has it populated today. Any shape from "field entirely absent" to
 * a fully-formed string array is handled without throwing.
 *
 * Every ID is re-resolved AT RUNTIME through {@link resolveAccessiblePredefinedWorkPlan}
 * — the exact same access rules as everything else in this module — rather than
 * trusted as authored, so a deleted, unpublished, or now-inaccessible target is
 * silently omitted instead of surfacing a broken suggestion. Malformed entries
 * (non-string, empty/whitespace-only) are dropped the same way. A self-referential
 * ID (a plan naming itself as its own "next" plan) is dropped too: completing a
 * plan should never suggest starting the very same plan again. Duplicate IDs
 * collapse to one entry.
 */
export async function resolveEligibleNextWorkPlans(
  completedPlan: { planId?: unknown; display?: { nextPlanIds?: unknown } } | null | undefined,
  userId?: string,
): Promise<WorkPlan[]> {
  const completedPlanId = typeof completedPlan?.planId === 'string' ? completedPlan.planId : undefined;
  const rawNextPlanIds = (completedPlan as any)?.display?.nextPlanIds;
  if (!Array.isArray(rawNextPlanIds) || rawNextPlanIds.length === 0) return [];

  const candidateIds = Array.from(new Set(
    rawNextPlanIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== '')
  )).filter((id) => id !== completedPlanId);
  if (candidateIds.length === 0) return [];

  const resolved = await Promise.all(
    candidateIds.map((planId) => resolveAccessiblePredefinedWorkPlan({ planId, userId }))
  );

  const eligible: WorkPlan[] = [];
  const seen = new Set<string>();
  for (const plan of resolved) {
    if (!plan || seen.has(plan.planId)) continue;
    seen.add(plan.planId);
    eligible.push(plan);
  }
  return eligible;
}
