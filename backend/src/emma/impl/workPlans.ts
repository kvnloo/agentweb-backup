/**
 * ENG-2103 (F2) — work plans tool cluster, extracted from `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * createWorkPlan, applyPredefinedWorkPlan, recommendPredefinedWorkPlan,
 * setWorkPlanStatus — the 13th domain cluster in this series — plus two
 * private helpers used ONLY by one of these each (verified by whole-file
 * grep): `findPersistedWorkPlanRecommendation` (recommendPredefinedWorkPlan)
 * and `setWorkPlanStatusAttempt` (setWorkPlanStatus's retry wrapper). A fifth
 * method, `sendForReview`, is non-contiguous in the original file (it sits
 * ~11,600 lines away from the rest, next to the other lead/email tools) but
 * belongs to the same "work plan output" tool group and has zero callers or
 * dependencies in common with the other four beyond `chatbotDb` — moved here
 * rather than left behind or split into its own cluster.
 *
 * EXCLUDED from this cluster, confirmed independently (not just taking the
 * brief's word for it): `modifyWorkPlan` and its private helper
 * `wasStepRemovalUserAuthorized`. `wasStepRemovalUserAuthorized` makes a
 * direct `this.callLLM` call (an LLM judge deciding whether a user message
 * explicitly authorized a work-plan step removal) — the same
 * `this.callLLM`-coupling exclusion pattern already established for
 * `createHtmlFromTemplate`/`generateImage`/`updateEmailDraftForLead`/
 * `importLeadsFromSearch`. `modifyWorkPlan` is additionally billing-sensitive
 * (ENG-1816 F1 rounds 3/4 fixed a real `billingUserId`-forwarding bug at
 * `wasStepRemovalUserAuthorized`, with a regression test already in place) —
 * both stay exactly as they are on the class. No other hidden
 * `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling was found anywhere in the 5 moved
 * methods (grepped every method body individually before moving it).
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions rather
 * than duplicating them — ALL FIVE keep a one-line delegating wrapper (none
 * deleted), because each has a real second caller and/or a dedicated test
 * file that calls the class method directly on a real instance, found by
 * grepping the whole backend (not just `emma/tools.ts`):
 *   - `createWorkPlan`: `routes/emmaApi.ts`'s `POST /work-plans` handler, and
 *     `agentModeService.workPlan.test.ts` (`(agentModeService as
 *     any).createWorkPlan(...)`, ~10 call sites).
 *   - `applyPredefinedWorkPlan`: `controllers/agentModeController.ts`'s two
 *     `launch_predefined_work_plan`/accept-recommendation call sites, and
 *     `agentModeService.applyWorkPlan.test.ts` (`service.applyPredefinedWorkPlan(...)`
 *     on a real, freshly-constructed instance).
 *   - `recommendPredefinedWorkPlan`: `emma.workPlanRecommendationTool.test.ts`
 *     (`service.recommendPredefinedWorkPlan(...)` directly, ~19 call sites,
 *     plus a separate "tool delegates to the service method" spy test).
 *   - `setWorkPlanStatus`: `routes/emmaApi.ts`'s `PATCH /work-plans/status`
 *     handler, a genuine INTERNAL caller inside `AgentModeService`'s own
 *     turn-loop (`this.setWorkPlanStatus(...)` in the ENG-1682 forced-
 *     final-synthesis path, ~line 4408 — applying a discarded
 *     `set_work_plan_status` call before ending a time-budget-exhausted
 *     turn), and `agentModeService.workPlan.test.ts` (`(agentModeService as
 *     any).setWorkPlanStatus(...)`, ~10 call sites).
 *   - `sendForReview`: `routes/emmaApi.ts`'s `POST /send-for-review` handler,
 *     and `resultEndpoints.test.ts` (`agentModeService.sendForReview(...)`
 *     directly).
 *
 * Two real cross-dependencies found between the moved methods and class state
 * that stays on `AgentModeService` (neither is the `modifyWorkPlan` exclusion
 * — genuinely different, reported rather than silently worked around):
 *
 * 1. `applyPredefinedWorkPlan` calls `this.getSupportedModels()` to validate a
 *    predefined template's `defaultModel` before applying it. `getSupportedModels`
 *    reads real instance state (`this.llmModels`, built from
 *    `createLlmModelRegistry()`) and calls `this.getDefaultModel()` (a
 *    settings-backed DB lookup with alerting) — this is the class's shared LLM
 *    model-registry subsystem, used broadly across `agentModeService.ts`, not
 *    something specific to work plans, and promoting it to a standalone module
 *    is well outside this cluster's scope. Tests confirm this must stay a REAL
 *    per-instance call, not a hardcoded singleton reference:
 *    `agentModeService.applyWorkPlan.test.ts` constructs its own
 *    `new AgentModeService()` and does
 *    `jest.spyOn(service, 'getSupportedModels').mockResolvedValue(...)` — if
 *    this module instead lazily imported the `agentModeService` singleton and
 *    called ITS `getSupportedModels()`, that spy would never be observed and
 *    the test would silently exercise the real (unmocked) model registry
 *    instead. Fixed by passing the calling instance through explicitly: the
 *    class wrapper passes `this` as a 5th argument, typed here only by the
 *    minimal structural interface actually used (`WorkPlanModelRegistry`) so
 *    this module never needs to import `AgentModeService`'s type either.
 *    Flagging this as the real design point it is rather than silently
 *    choosing an approach: the alternative (a lazy singleton import) would
 *    have been simpler but both behaviorally wrong under test AND would have
 *    reintroduced a dependency on the full class for this one branch.
 *
 * 2. `setWorkPlanStatusAttempt` calls (originally) `AgentModeService.
 *    extractGeneratedImageFilenames(...)` — a `public static` method. Unlike
 *    the cross-dependency above, this one turned out to be a PURE function
 *    (no `this`, no instance state) that is ALSO called from a completely
 *    unrelated class method, `buildMarketingContext` (not part of this
 *    cluster, not moving) — so it is genuinely shared between an
 *    already-extracted module and code still living on the class, exactly the
 *    case the design draft calls out for `shared/` promotion. Promoted to
 *    `emma/impl/shared/generatedAssets.ts` as a plain exported function;
 *    `AgentModeService.extractGeneratedImageFilenames` is kept as a one-line
 *    delegating static wrapper (not deleted, not changed in behavior) because
 *    `agentModeService.buildWorkPlanContext.test.ts` calls it directly via
 *    `AgentModeService.extractGeneratedImageFilenames(...)` — that test needed
 *    NO changes since the wrapper preserves the exact same call shape.
 *
 * Two module-scope (not class-member) pure helpers used only by
 * `applyPredefinedWorkPlan` — `normalizeWorkPlanTitleForMatch` and
 * `areNearDuplicateWorkPlanTitles` — lived as plain `export function`s
 * alongside the class in `agentModeService.ts` (not inside it). Same
 * "promote-to-shared-and-reexport" treatment `htmlCreation.ts` (round 9) used
 * for its own module-scope exports: moved here, with
 * `agentModeService.ts` now re-exporting them from this module so
 * `controllers/agentModeController.ts`'s existing
 * `import { normalizeWorkPlanTitleForMatch } from '../services/agentModeService'`
 * keeps working unchanged.
 *
 * Transitive-import trap: `chatbotDb` was a STATIC top-level import in the
 * original file (`import { chatbotDb, ... } from './chatbotService'`) —
 * `chatbotService.ts` is one of the four files the extraction brief names as
 * a known trap (it top-level-imports `agentModeService.ts` back, circular,
 * and constructs a real `AWS.DynamoDB.DocumentClient` at module load). All
 * five methods use `chatbotDb` heavily for session read/write, so each one
 * lazy-`require`s it at the top of its own body — the exact idiom
 * `emma/impl/gtmPlans.ts` established for the same dependency
 * (`lesson-lazy-require-aws-sdk-modules`). `predefinedWorkPlanResolver.ts`
 * (`applyPredefinedWorkPlan`, `findPersistedWorkPlanRecommendation`,
 * `recommendPredefinedWorkPlan`) was ALREADY lazily `await import()`-ed in
 * the original code — kept exactly as-is, only the relative path changed.
 * `resendService`/`emailService`/`../config` (`sendForReview`) were likewise
 * already lazy in the original — kept as-is, path adjusted.
 * `utils/toolErrorClassifier.ts`, `services/agentMode/core/errorRetryability.ts`,
 * `services/agentMode/core/workPlanInputRequest.ts`,
 * `services/agentMode/core/scheduledAutocomplete.ts`, and
 * `services/agentMode/core/synthesisResidue.ts` were all checked (whole
 * import graph, not just the one file) for any AWS-SDK/`chatbotService.ts`/
 * `settingsService.ts`/`agentModeService.ts` entanglement — all are leaf or
 * near-leaf modules with no such risk, confirmed safe as static top-level
 * imports and by `npm run typecheck`, not assumed.
 *
 * No `billingUserId`/`currentRunFunding()` handling anywhere in this cluster
 * (grepped all 5 method bodies, zero matches) — none of these methods meter
 * LLM usage themselves, so the
 * lesson-forwarding-resolved-field-suppresses-downstream-resolver bug class
 * does not apply here.
 */
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { classifyToolErrorClass } from '../../utils/toolErrorClassifier';
import { isRetryableErrorClass } from '../../services/agentMode/core/errorRetryability';
import { buildWorkPlanInputRequest } from '../../services/agentMode/core/workPlanInputRequest';
import { shouldForceScheduledAutocomplete } from '../../services/agentMode/core/scheduledAutocomplete';
import { extractProducedAssetCount } from '../../services/agentMode/core/synthesisResidue';
import { extractGeneratedImageFilenames } from './shared/generatedAssets';

/**
 * The minimal slice of `AgentModeService` that `applyPredefinedWorkPlan`
 * needs to validate a predefined template's `defaultModel` — see the module
 * header comment (cross-dependency #1) for why this is a passed-in parameter
 * rather than an imported singleton. Deliberately a structural (duck-typed)
 * interface rather than `import type { AgentModeService }` from the class
 * file: even a type-only import would name-couple this module to
 * `agentModeService.ts`'s type for no real benefit, since only this one
 * method is ever used.
 */
export interface WorkPlanModelRegistry {
  getSupportedModels(isAdmin?: boolean): Promise<string[]>;
}


/**
 * ENG-1794: normalize a predefined-work-plan title for matching in
 * `applyPredefinedWorkPlan` (the `launch_predefined_work_plan` tool handler).
 *
 * Templates are stored with underscore-joined titles (e.g.
 * "Founder_Linkedin_Sales_Readiness_Eval"), but a user/model referring to one
 * in chat naturally types it with spaces and mixed case (e.g. "Founder
 * LinkedIn Sales Readiness Eval"). The previous match was `.toLowerCase()`
 * only, so that natural phrasing never matched the stored title at all — the
 * call failed with "not found" and the model fell back to grepping the full
 * (370KB+) plan listing via search_tool_response/read_tool_response to find
 * a title to retry with. When two templates are near-duplicates (identical
 * welcomeMessage/description, titles differing only by an "_Eval"/"_Audit"
 * suffix), that fallback search is exactly where the model can pick up the
 * WRONG template's title from a truncated snippet and silently launch it
 * with no error, since the retry is then a legitimate exact match against
 * the wrong record (confirmed live: ENG-1794, session
 * 3fce3c5a-6b25-4167-987b-b5bd8c7f4c5b launched
 * "Founder_Linkedin_Sales_Readiness_Audit" instead of "..._Eval").
 *
 * Folding underscores/hyphens to spaces and collapsing whitespace before the
 * case-insensitive comparison lets the natural-language phrasing resolve
 * directly on the FIRST call, so the risky multi-step fallback search never
 * has to run for this common case. This only smooths over separator/case
 * differences — it does not do fuzzy/substring/similarity matching, so two
 * templates whose titles genuinely differ (e.g. the "_Eval"/"_Audit" suffix
 * itself) never collide.
 */
export function normalizeWorkPlanTitleForMatch(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ENG-1814: does `a` look like a near-duplicate sibling of `b` -- same word count, differing
 * in exactly one token -- the shape of the two real, distinct, live-confirmed incidents this
 * ticket covers (`Founder_Linkedin_Sales_Readiness_Eval` vs `..._Audit`). Deliberately narrow
 * (exact word-count match, exactly one differing token) so it flags true near-duplicates
 * without over-triggering on templates that merely share some words -- a genuinely different
 * template (different word count, or differing in more than one token) never collides. Titles
 * are compared via normalizeWorkPlanTitleForMatch, so separator/case variance doesn't matter,
 * only the actual words.
 */
export function areNearDuplicateWorkPlanTitles(a: unknown, b: unknown): boolean {
  const wordsA = normalizeWorkPlanTitleForMatch(a).split(' ').filter(Boolean);
  const wordsB = normalizeWorkPlanTitleForMatch(b).split(' ').filter(Boolean);
  if (wordsA.length === 0 || wordsA.length !== wordsB.length) return false;
  let diffCount = 0;
  for (let i = 0; i < wordsA.length; i++) {
    if (wordsA[i] !== wordsB[i]) diffCount++;
  }
  return diffCount === 1;
}

export async function createWorkPlan(title: string, steps: Array<{ stepCount: number; title: string; description?: string; userInstructions?: string; requiredFunctionCalls?: string[]; skillIds?: string[]; expectedAssetCount?: number; expectedAssetCountTools?: string[] }>, sessionId: string, autocomplete?: boolean, isUnattendedRun?: boolean): Promise<any> {
  try {
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return {
        success: false,
        message: 'Session not found'
      };
    }

    // Create the work plan with all steps in pending status
    // Ensure stepCount is sequential starting from 1
    const workPlan = {
      title,
      steps: steps.map((step, index) => ({
        stepCount: index + 1, // Must be sequential: index+1
        title: step.title,
        description: step.description,
        // Preserve user-facing instructions through to the session.
        ...(step.userInstructions !== undefined && { userInstructions: step.userInstructions }),
        status: 'pending' as const,
        completedAt: undefined,
        notes: undefined,
        requiredFunctionCalls: step.requiredFunctionCalls,
        skillIds: step.skillIds,
        ...(step.expectedAssetCount !== undefined && { expectedAssetCount: step.expectedAssetCount }),
        ...(step.expectedAssetCountTools !== undefined && { expectedAssetCountTools: step.expectedAssetCountTools })
      })),
      // ENG-2058: an interactive (autocomplete: false) plan on a scheduled run stalls
      // forever — the "wait for the user to approve each step" contract has no user
      // to ask, so the run just burns its completion-gate continuation budget presenting
      // results and asking for approval, then records a deferredUnresolved failure. Force
      // hands-off mode whenever this turn is genuinely unattended — see
      // shouldForceScheduledAutocomplete (ENG-2072).
      autocomplete: shouldForceScheduledAutocomplete(session, isUnattendedRun) ? true : (autocomplete || false),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Update the session with the work plan
    await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

    // ENG-1698: session.calledFunctions accumulates for the life of the session with
    // no per-plan scoping. Without this reset, a brand new plan on an existing session
    // inherits whatever tool-call credit is left over from a completely unrelated
    // earlier plan (or an earlier attempt at this same plan) — a later step can be
    // marked completed via stale credit without the model calling the tool again for
    // it. Reset on every genuinely NEW plan start; modifyWorkPlan (steps added
    // mid-run) deliberately does NOT reset this, since that's still the same run.
    try {
      await chatbotDb.updateCalledFunctions(sessionId, {});
    } catch (resetError) {
      console.error('AgentMode: Error resetting calledFunctions for new work plan:', resetError);
    }

    return {
      success: true,
      message: `Work plan "${title}" created with ${steps.length} steps`,
      workPlan,
      formattedContent: `Created work plan "${title}" with ${steps.length} steps:\n${workPlan.steps.map(s => `${s.stepCount}. ${s.title}`).join('\n')}`
    };
  } catch (error) {
    console.error('AgentMode: Error creating work plan:', error);
    return {
      success: false,
      message: 'Failed to create work plan',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Instantiate a predefined work plan template into an existing chat session.
 *
 * This is the programmatic equivalent of Agent Mode's createSessionWithPlan, but
 * applied to a session that already exists (e.g. an Emma conversation). It:
 *   - resolves the template by title (case-insensitive) or planId, honoring the
 *     same system/public/private visibility rules as the listing tool;
 *   - copies the template's steps into session.workPlan with status 'pending';
 *   - carries welcomeMessage / autocomplete / userInstructions through;
 *   - auto-installs ALL skills referenced by the plan's steps so the required
 *     tools are available from the next message (tool filtering is computed per
 *     message, so skills must be installed upfront);
 *   - applies the plan's defaultModel when supported.
 *
 * Refuses to overwrite an existing active (non-empty) work plan unless force=true.
 */
export async function applyPredefinedWorkPlan(
  planTitleOrId: string,
  sessionId: string,
  userId: string | undefined,
  options: { force?: boolean; confirmedDeclinedPlan?: boolean; skipDeclineGate?: boolean; isUnattendedRun?: boolean } | undefined,
  modelRegistry: WorkPlanModelRegistry,
): Promise<any> {
  try {
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    const { getAccessiblePredefinedWorkPlanCandidates } = await import('../../services/predefinedWorkPlanResolver');

    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return { success: false, message: 'Session not found' };
    }

    // Guard: don't clobber an in-progress plan unless explicitly forced.
    const existing = session.workPlan;
    if (existing && Array.isArray(existing.steps) && existing.steps.length > 0 && !options?.force) {
      return {
        success: false,
        message: `A work plan "${existing.title}" is already active in this session. Ask the user to confirm, then call launch_predefined_work_plan again with force=true to replace it.`,
        requiresConfirmation: true,
      };
    }

    // ENG-1472: the private/org/system/public candidate-building logic that used
    // to be inlined here now lives in predefinedWorkPlanResolver.ts (shared with
    // the recommend_predefined_work_plan tool and the accept endpoint). This
    // method still matches by title OR planId (unlike the resolver's strict
    // planId-only lookup) to keep launch_predefined_work_plan's existing
    // behavior — title-based launches from Emma — unchanged.
    const candidates = await getAccessiblePredefinedWorkPlanCandidates(userId);

    // ENG-1794: case/whitespace/underscore-insensitive title match (see
    // normalizeWorkPlanTitleForMatch above) — planId still wins on an exact
    // match first, since a title collision must never shadow a stable id.
    const matchedByPlanId = candidates.some((p) => p.planId === planTitleOrId);
    const needle = normalizeWorkPlanTitleForMatch(planTitleOrId);
    const predefinedPlan = candidates.find((p) => p.planId === planTitleOrId)
      ?? candidates.find((p) => p.title && normalizeWorkPlanTitleForMatch(p.title) === needle);

    if (!predefinedPlan) {
      return { success: false, message: `Work plan template "${planTitleOrId}" not found` };
    }
    if (predefinedPlan.visibility === 'private' && (!userId || userId.startsWith('anon_'))) {
      return { success: false, message: 'Not authorized to use this private work plan' };
    }

    // ENG-1814: a title-based match (not a stable planId) that has a near-duplicate
    // sibling in the accessible set is exactly the shape of two real, live-confirmed
    // incidents (Founder_Linkedin_Sales_Readiness_Eval/_Audit) where the model picked
    // the wrong one of two similarly-named templates while sifting a large
    // list_predefined_work_plans result, then launched it without ever re-confirming
    // with the user. A planId-based match is exempt — an id is unambiguous by
    // construction, and this is exactly the retry path this response's own message
    // points the model at once the user disambiguates.
    //
    // Round-2 review: also catches an EXACT-duplicate title (a different planId whose
    // normalized title is identical, not just one-word-different) -- arguably more
    // dangerous than a near-duplicate, since normalizeWorkPlanTitleForMatch resolves
    // both candidates equally and `.find()` above silently picked whichever happened
    // to come first in the candidates array, with zero signal distinguishing intent.
    // Nothing in workPlanService.ts enforces title uniqueness across visibility scopes,
    // so this is a real (if narrow) possibility, not just theoretical.
    if (!matchedByPlanId) {
      const normalizedTargetTitle = normalizeWorkPlanTitleForMatch(predefinedPlan.title);
      const ambiguousSibling = candidates.find((p) =>
        p.planId !== predefinedPlan.planId && p.title
          // Exact-duplicate check needs the same empty-guard the near-duplicate
          // check already has -- otherwise two degenerately-titled (blank/
          // separator-only) but genuinely unrelated templates normalize to the
          // same '' and falsely pair up as ambiguous siblings.
          && ((normalizedTargetTitle !== '' && normalizeWorkPlanTitleForMatch(p.title) === normalizedTargetTitle)
            || areNearDuplicateWorkPlanTitles(p.title, predefinedPlan.title))
      );
      if (ambiguousSibling) {
        return {
          success: false,
          message: `"${predefinedPlan.title}" has a similarly-named template ("${ambiguousSibling.title}") that could easily be confused for it. Confirm with the user exactly which one they meant, then call launch_predefined_work_plan again with that plan's planId (not its title) to proceed.`,
          requiresConfirmation: true,
        };
      }
    }

    // ENG-1974: the user already declined this exact plan via "Keep chatting"
    // on its recommendation card. recommendationId is a deterministic hash
    // of (sessionId, planId) — recompute it here for the RESOLVED planId
    // (not the raw planTitleOrId argument) so this correlates exactly
    // whether launch_predefined_work_plan was called with a title or an id;
    // no fuzzy title matching needed. `accept` always passes
    // skipDeclineGate — the user's own explicit accept click must never be
    // blocked by an earlier decline of any recommendation. Same risk tier
    // as the force:true retry above (reversible, conversational), not the
    // harder human-attributed tier checkQuestionGate exists for.
    if (!options?.skipDeclineGate && !options?.confirmedDeclinedPlan) {
      const declinedRecommendationId = createHash('sha256')
        .update(`${sessionId}:${predefinedPlan.planId}`)
        .digest('hex')
        .slice(0, 32);
      const declined = session.declinedWorkPlanRecommendations?.[declinedRecommendationId];
      if (declined) {
        return {
          success: false,
          message: `The user already declined "${declined.planTitle}" (clicked "Keep chatting" on its recommendation). Ask the user to confirm they want to start it now, then call launch_predefined_work_plan again with confirmedDeclinedPlan=true to proceed.`,
          requiresConfirmation: true,
        };
      }
    }

    // Convert template steps -> session work plan (all steps start pending).
    const workPlan = {
      title: predefinedPlan.title,
      steps: (predefinedPlan.steps || []).map((step: any) => ({
        stepCount: step.stepCount,
        title: step.title,
        description: step.description,
        ...(step.userInstructions !== undefined && { userInstructions: step.userInstructions }),
        status: 'pending' as const,
        completedAt: undefined,
        notes: undefined,
        requiredFunctionCalls: step.requiredFunctionCalls,
        skillIds: step.skillIds,
        ...(step.expectedAssetCount !== undefined && { expectedAssetCount: step.expectedAssetCount }),
        ...(step.expectedAssetCountTools !== undefined && { expectedAssetCountTools: step.expectedAssetCountTools }),
        // ENG-1765: this whitelist previously omitted inputRequest, silently
        // dropping every predefined template's authored guided-input-card data
        // on launch -- the only code that reads step.inputRequest (below, in
        // setWorkPlanStatusAttempt) could therefore never fire for any
        // predefined-plan launch, live-confirmed dead against 26 of 28 real
        // production templates.
        ...(step.inputRequest !== undefined && { inputRequest: step.inputRequest }),
      })),
      welcomeMessage: predefinedPlan.welcomeMessage?.trim() || undefined,
      // ENG-2058: same rationale as createWorkPlan above — an unattended scheduled
      // run has no user to approve an interactive step, so a template's own
      // autocomplete (or lack of one) is overridden hands-off. ENG-2072: gated on
      // shouldForceScheduledAutocomplete, not sessionType alone — see its doc comment.
      autocomplete: shouldForceScheduledAutocomplete(session, options?.isUnattendedRun) ? true : (predefinedPlan.autocomplete || false),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // ENG-1472: which predefined template this session's plan was launched
      // from, so a completed run can traceably chain into its author-approved
      // "next plan" suggestions and so the accept endpoint can idempotently
      // detect "this recommendation was already applied".
      templatePlanId: predefinedPlan.planId,
    };
    await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

    // ENG-1765: the reactive "surface the next pending step's inputRequest"
    // check in setWorkPlanStatusAttempt only runs after a set_work_plan_status
    // call — it never runs on a fresh launch. Most predefined templates put
    // their inputRequest on step 1 itself, which starts pending with nothing
    // before it to trigger that reactive scan, so without this it would still
    // never surface even after restoring the field above. Surface it here too,
    // the same way, so a launch's own first pending input-requesting step is
    // never silently skipped.
    //
    // Reviewer finding: this write must use the same failIfAwaitingExists
    // guard as the reactive block. Without it, updateSessionWorkPlanInputRequest
    // attaches no ConditionExpression at all and blindly overwrites
    // pendingWorkPlanInput — a force=true relaunch could silently clobber a
    // genuinely still-awaiting card from whatever was active before, leaving
    // it orphaned (pointing at a step that's no longer in the active plan)
    // instead of failing closed. On a guard failure this just logs and skips
    // surfacing the new step's card rather than blocking the launch — the
    // plan itself is still valid without it, and the model can still recover
    // by asking conversationally like it already does today.
    // User-facing signal (not just a server log) when this doesn't surface:
    // the model is told via the returned message so it can ask for the same
    // information conversationally instead of the user silently never seeing
    // a card and the model never knowing to ask.
    let inputRequestNotSurfaced: { title: string; prompt?: string } | null = null;
    const launchInputStep = workPlan.steps
      .slice()
      .sort((a, b) => a.stepCount - b.stepCount)
      .find((s) => s.status === 'pending' && (s as any).inputRequest);
    if (launchInputStep) {
      const req = (launchInputStep as any).inputRequest;
      try {
        const written = await chatbotDb.updateSessionWorkPlanInputRequest(
          sessionId,
          buildWorkPlanInputRequest({
            ...req,
            requestId: uuidv4(),
            stepCount: launchInputStep.stepCount,
          }),
          { failIfAwaitingExists: true },
        );
        if (!written) {
          // Guarded off: a genuinely still-awaiting request from before this
          // launch won the race, per design (see comment above) — not an error.
          inputRequestNotSurfaced = { title: req.title, prompt: req.prompt };
        }
      } catch (inputRequestError) {
        console.error('AgentMode: Error surfacing input request for launched work plan:', inputRequestError);
        inputRequestNotSurfaced = { title: req.title, prompt: req.prompt };
      }
    }

    // ENG-1698: same reset as createWorkPlan — see that call site's comment. A
    // predefined-plan launch on an existing session (including a force=true
    // relaunch of the same plan) must not inherit tool-call credit from before.
    try {
      await chatbotDb.updateCalledFunctions(sessionId, {});
    } catch (resetError) {
      console.error('AgentMode: Error resetting calledFunctions for new predefined work plan:', resetError);
    }

    // Auto-install ALL skills from ALL steps upfront so their tools are available
    // from the next message (tool filtering is computed at the start of each message).
    const allSkillIds = new Set<string>();
    for (const step of predefinedPlan.steps || []) {
      if (step.skillIds?.length) {
        step.skillIds.forEach((id: string) => allSkillIds.add(id));
      }
    }
    if (allSkillIds.size > 0) {
      try {
        await chatbotDb.addAssociatedSkills(sessionId, Array.from(allSkillIds));
      } catch (skillErr) {
        console.error('[applyPredefinedWorkPlan] Error auto-installing plan skills:', skillErr);
      }
    }

    // Apply the plan's default model when it is supported.
    if (predefinedPlan.defaultModel) {
      try {
        const supportedModels = await modelRegistry.getSupportedModels();
        if (supportedModels.includes(predefinedPlan.defaultModel)) {
          await chatbotDb.updateSessionLlmModel(sessionId, predefinedPlan.defaultModel);
        } else {
          console.warn(`[applyPredefinedWorkPlan] Plan model "${predefinedPlan.defaultModel}" not supported; leaving session model unchanged`);
        }
      } catch (modelErr) {
        console.warn('[applyPredefinedWorkPlan] Error applying plan model:', (modelErr as Error).message);
      }
    }

    // ENG-1765: tell the model when step 1's input card didn't surface, so it
    // asks for the same information conversationally instead of the session
    // silently sitting on a step whose required input nobody was ever asked for.
    const inputRequestNote = inputRequestNotSurfaced
      ? ` Note: this plan's first step normally asks "${inputRequestNotSurfaced.title}" via a structured card, but that card could not be shown right now — ask the user for this information directly instead: ${inputRequestNotSurfaced.prompt || inputRequestNotSurfaced.title}`
      : '';

    return {
      success: true,
      message: `Started work plan "${predefinedPlan.title}" with ${workPlan.steps.length} steps${inputRequestNote}`,
      workPlan,
      welcomeMessage: workPlan.welcomeMessage,
      formattedContent: `Started work plan "${predefinedPlan.title}":\n${workPlan.steps.map((s: any) => `${s.stepCount}. ${s.title}`).join('\n')}`,
    };
  } catch (error) {
    console.error('AgentMode: Error applying predefined work plan:', error);
    return {
      success: false,
      message: 'Failed to start work plan',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Scan a session's persisted assistant messages for an existing
 * `workplan_recommendation` (v1) result naming `planId`, so a repeated
 * recommend call returns the SAME proposal instead of adding another
 * (ENG-1472 closed decision #8: a plan is proposed at most once per session).
 * Thin wrapper over the shared scan in predefinedWorkPlanResolver.ts, which
 * the accept endpoint also uses (lookup by recommendationId instead).
 */
async function findPersistedWorkPlanRecommendation(messages: any[] | undefined, planId: string): Promise<any | null> {
  const { findWorkPlanRecommendationToolResult } = await import('../../services/predefinedWorkPlanResolver');
  return findWorkPlanRecommendationToolResult(messages, (r) => r.plan?.id === planId);
}

/**
 * Propose (but never instantiate) an existing, accessible predefined work plan
 * inline during chat (ENG-1472). The proposal is a persisted structured tool
 * result — `session.workPlan` is never mutated here; the plan only starts when
 * the owner explicitly accepts it via the work-plan-recommendation accept
 * endpoint, which itself calls `applyPredefinedWorkPlan`.
 *
 * The backend trusts only `planId` and the model's short `reason` — title,
 * summary, and steps always come from the canonical server record resolved
 * through `resolveAccessiblePredefinedWorkPlan`, never from anything the model
 * supplied. `options.source` is an optional marker ("completion_next") for the
 * completion-recommendation extension so the UI can distinguish an ordinary
 * in-chat proposal from one following a just-completed plan's author-approved
 * "what's next" suggestions; every other rule (dedupe, ownership, access,
 * boundary validation) is identical for both.
 */
export async function recommendPredefinedWorkPlan(
  planId: string,
  reason: string,
  sessionId: string,
  userId?: string,
  options?: { source?: string },
): Promise<any> {
  try {
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    // Boundary validation first — structured, non-customer-sensitive errors
    // that never touch the database. Empty strings are already rejected by
    // the tool-gateway's required-argument check upstream; these guards make
    // the contract hold even when this method is called directly (as the
    // accept-endpoint's sibling paths and tests do).
    if (typeof planId !== 'string' || planId.trim() === '') {
      return { success: false, message: 'recommend_predefined_work_plan requires a non-empty planId.' };
    }
    if (planId.length > 128) {
      return { success: false, message: 'recommend_predefined_work_plan requires planId to be at most 128 characters.' };
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      return { success: false, message: 'recommend_predefined_work_plan requires a non-empty reason.' };
    }
    if (reason.length > 240) {
      return { success: false, message: 'recommend_predefined_work_plan requires reason to be at most 240 characters.' };
    }
    if (!sessionId) {
      return { success: false, message: 'recommend_predefined_work_plan requires an active session.' };
    }

    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return { success: false, message: 'Session not found' };
    }

    // Dedupe: an already-persisted recommendation for this exact plan wins
    // outright — including its ORIGINAL reason. A second call (the model
    // re-proposing, or asking again with different wording) never overwrites
    // the first proposal the user is looking at.
    const existing = await findPersistedWorkPlanRecommendation(session.messages, planId);
    if (existing) {
      return { success: true, ...existing };
    }

    const { resolveAccessiblePredefinedWorkPlan } = await import('../../services/predefinedWorkPlanResolver');
    const plan = await resolveAccessiblePredefinedWorkPlan({ planId, userId });
    if (!plan) {
      // Deliberately the SAME message for deleted / pending-review / private-
      // inaccessible / malformed — never leaks WHY a plan can't be recommended.
      return { success: false, message: `Work plan template "${planId}" is not available.` };
    }

    const trimmedReason = reason.trim();
    const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
    const steps = rawSteps.slice(0, 4).map((step: any, idx: number) => ({
      position: typeof step?.stepCount === 'number' ? step.stepCount : idx + 1,
      // Until ENG-1469's customer-readable display metadata exists, fall back
      // to the step's raw title (documented fallback per the ENG-1472 spec).
      label: typeof step?.title === 'string' && step.title.trim() !== '' ? step.title : `Step ${idx + 1}`,
    }));

    // Deterministic opaque id: the SAME session recommending the SAME plan
    // twice (with no persisted history to dedupe against yet, e.g. two
    // concurrent turns) converges on one id instead of two unrelated ones.
    const recommendationId = createHash('sha256').update(`${sessionId}:${plan.planId}`).digest('hex').slice(0, 32);

    const source = options?.source === 'completion_next' ? 'completion_next' as const : undefined;

    // Same source fields ENG-1469's customer projection uses — no new
    // persisted data, just surfacing what the plan record already has.
    const thumbnailUrl = typeof (plan as any).thumbnail_url === 'string' ? (plan as any).thumbnail_url.trim() : '';
    const thumbnail = thumbnailUrl
      ? {
          url: thumbnailUrl,
          alt: typeof (plan as any).thumbnail_alt_text === 'string' ? (plan as any).thumbnail_alt_text.trim() : '',
        }
      : undefined;

    return {
      success: true,
      type: 'workplan_recommendation' as const,
      version: 1 as const,
      recommendationId,
      plan: {
        id: plan.planId,
        title: plan.title,
        summary: typeof plan.description === 'string' ? plan.description : '',
        steps,
        ...(thumbnail ? { thumbnail } : {}),
      },
      reason: trimmedReason,
      ...(source ? { source } : {}),
      formattedContent: `Recommended work plan "${plan.title}" — ${trimmedReason}`,
    };
  } catch (error) {
    console.error('AgentMode: Error recommending predefined work plan:', error);
    return {
      success: false,
      message: 'Failed to recommend work plan',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function setWorkPlanStatus(
  updates: Array<{ stepCount: number; status: 'pending' | 'completed' | 'skipped'; notes?: string }>,
  sessionId: string
): Promise<any> {
  // ENG-1626: set_work_plan_status persists workplan step progression — a
  // production session (822c1ed4) hit set_work_plan_status twice while the
  // customer watched "Step 9 of 10" live, with no system-level retry, so a
  // transient DynamoDB/network blip anywhere in the read-modify-write below
  // surfaced immediately as a customer-visible failure. One transparent retry
  // for a classified-transient error (timeout/network/rate_limit/upstream_5xx)
  // before giving up — the same classifier the model-visible retry guidance
  // already uses, so this and that guidance never disagree about what's
  // retryable. Deliberate gate refusals (missing steps, out-of-order
  // completion, etc.) never throw, so they pass straight through on the
  // first attempt untouched.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await setWorkPlanStatusAttempt(updates, sessionId);
    } catch (error) {
      lastError = error;
      const errorClass = classifyToolErrorClass(error);
      if (attempt < 2 && isRetryableErrorClass(errorClass)) {
        console.warn(`AgentMode: set_work_plan_status failed with a transient error (${errorClass}) for session ${sessionId}; retrying once`);
        continue;
      }
      break;
    }
  }
  console.error('AgentMode: Error setting work plan status:', lastError);
  return {
    success: false,
    message: 'Failed to update work plan status',
    error: lastError instanceof Error ? lastError.message : 'Unknown error'
  };
}

async function setWorkPlanStatusAttempt(
  updates: Array<{ stepCount: number; status: 'pending' | 'completed' | 'skipped'; notes?: string }>,
  sessionId: string
): Promise<any> {
  const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
  // ENG-1188 (Greptile): consistentRead, not the default eventually-consistent
  // read -- a turn that writes an "Image generated" marker and then
  // immediately calls set_work_plan_status in the same turn can otherwise race
  // a stale replica and see too few images, rejecting genuinely-complete work
  // as insufficientAssets. ENG-510 built this parameter for exactly this "just
  // wrote it, must see it now" shape (agentModeController.ts already uses it
  // for the analogous timed-out-run read).
  const session = await chatbotDb.getChatSession(sessionId, true);
  if (!session || !session.workPlan) {
    return {
      success: false,
      message: 'No work plan found in this session. Create one first using create_work_plan.'
    };
  }

  // ENG-1626 (code review): the retry wrapper in setWorkPlanStatus can re-invoke
  // this attempt after a classified-transient error whose underlying DynamoDB
  // writes actually committed server-side (ack-lost) -- the client sees a
  // timeout/network failure, but updateSessionWorkPlan/updateCalledFunctions
  // below are unconditional SETs with no idempotency key. Blindly re-running a
  // step's mutation would re-decrement an already-decremented
  // calledFunctionCounts and re-stamp resolvedAt, corrupting the asset-count
  // cutoff window for later steps.
  //
  // ENG-1626 (CodeRabbit follow-up): an early return here for the whole batch
  // was too broad -- it also skipped the post-write side effects below
  // (updateSessionWorkPlanInputRequest, i.e. the NEXT step's decision card,
  // and addAssociatedSkills). If attempt 1's updateSessionWorkPlan committed
  // but a later call in that same attempt threw, the retry would see every
  // step already at its target status and return success WITHOUT ever
  // creating the decision card or installing the next step's skills -- the
  // exact "customer never sees a card" failure this issue is about. Those
  // calls are independently safe to repeat (updateSessionWorkPlanInputRequest
  // is guarded by failIfAwaitingExists and returns null rather than
  // throwing if one already exists; addAssociatedSkills filters against
  // already-associated ids), so only the unsafe per-step mutation
  // (calledFunctionCounts decrement, resolvedAt/completedAt stamp) is
  // skipped below -- scoped per step, not per batch, so a batch mixing an
  // already-applied step with a genuinely new one handles each correctly.
  const alreadyAppliedStepCounts = new Set(
    updates
      .filter(update => {
        const step = session.workPlan!.steps.find((s: any) => s.stepCount === update.stepCount);
        return !!step && step.status === update.status;
      })
      .map(update => update.stepCount)
  );

  // ENG-1188 (Greptile follow-up): each step's PRE-BATCH resolvedAt/completedAt
  // AND status, captured before any update in THIS call runs. workPlan.steps
  // below starts as the SAME array session.workPlan.steps points at (the
  // spread on the next line only copies the top-level object), so an
  // in-place `workPlan.steps[i] = {...}` replacement further down is visible
  // through both references — reading a "live" cutoff would see this batch's
  // OWN just-assigned timestamps, collapsing every step resolved together in
  // one call to the same instant and wrongly excluding assets a later step in
  // that same batch actually produced in an earlier turn.
  //
  // Status is captured alongside the timestamp (CodeRabbit, PR #2430): a step
  // that was completed/skipped and later reset to 'pending' (e.g. its assets
  // need regenerating) keeps its old resolvedAt/completedAt untouched — only
  // a 'completed'/'skipped' transition refreshes those fields. Blindly trusting
  // that stale timestamp as a cutoff for a later step would wrongly widen the
  // asset-count window with assets from the step's earlier, now-superseded
  // attempt — see the cutoff walk below for how a reset step's PRE-BATCH
  // status routes it to its fresh LIVE timestamp instead.
  const originalStepStateByCount = new Map<number, { resolvedAt: string | undefined; status: string }>(
    session.workPlan.steps.map((s: any) => [s.stepCount, { resolvedAt: s.resolvedAt || s.completedAt, status: s.status }])
  );

  const workPlan = { ...session.workPlan };
  const updatedSteps: Array<{ stepCount: number; title: string; status: string }> = [];
  const notFoundSteps: number[] = [];
  const missingFunctionCalls: Array<{ stepCount: number; title: string; missing: string[] }> = [];
  const outOfOrderSteps: Array<{ stepCount: number; title: string; pendingSteps: string[] }> = [];

  // Get function call counts from session (make a copy to modify). This local
  // copy drives this call's own gating decisions (does THIS step have enough
  // available calls) and is inherently a single-request snapshot. The actual
  // persisted decrement (see countsModified below) is applied as a delta
  // against a fresh read at write time, not this snapshot, to avoid clobbering
  // a concurrent writer (ENG-1698).
  const calledFunctionCounts = { ...(session.calledFunctions || {}) };
  let countsModified = false;
  const pendingCalledFunctionDecrements: Record<string, number> = {};

  const insufficientAssets: Array<{ stepCount: number; title: string; expected: number; produced: number }> = [];

  // Process each update
  for (const update of updates) {
    const stepIndex = workPlan.steps.findIndex(s => s.stepCount === update.stepCount);

    if (stepIndex < 0) {
      notFoundSteps.push(update.stepCount);
      continue;
    }

    const step = workPlan.steps[stepIndex];

    // ENG-1626 (CodeRabbit follow-up): this step already carries the
    // requested status from a prior (ack-lost) attempt -- report it as
    // updated so the persistence/input-request/skills block below still
    // runs, and still apply `notes` (a plain overwrite with no side
    // effects, same as the normal path below), but skip every gate and the
    // resolvedAt/completedAt/calledFunctionCounts mutation for it (those
    // already ran once; re-running them would corrupt state).
    if (alreadyAppliedStepCounts.has(update.stepCount)) {
      workPlan.steps[stepIndex] = { ...workPlan.steps[stepIndex], notes: update.notes };
      updatedSteps.push({ stepCount: update.stepCount, title: step.title, status: update.status });
      continue;
    }

    // Cross-step ordering gate (ENG-1188 root cause fault #3): the xCures
    // incident marked "QA, Contact Sheet & Delivery" completed while "Render
    // the Full Size Matrix" — an earlier step — was still pending, so delivery
    // never actually gated on the rendering it claimed to deliver. Neither gate
    // below catches this: both only look at the step being completed, never at
    // whether the steps before it are actually done. Checked against the
    // in-progress workPlan.steps (not a snapshot from before the loop), so
    // several steps completed in the same batch, in order, chain correctly —
    // and a batch that completes them out of order is caught per-step.
    if (update.status === 'completed') {
      const pendingEarlierSteps = workPlan.steps.filter(
        (s: any) => s.stepCount < step.stepCount && s.status !== 'completed' && s.status !== 'skipped'
      );
      if (pendingEarlierSteps.length > 0) {
        outOfOrderSteps.push({
          stepCount: update.stepCount,
          title: step.title,
          pendingSteps: pendingEarlierSteps.map((s: any) => `${s.stepCount} "${s.title}"`),
        });
        continue; // Skip updating this step
      }
    }

    // Validate required function calls if marking as completed
    if (update.status === 'completed' && step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0) {
      // Count how many times each function is required
      const requiredCounts: Record<string, number> = {};
      for (const fn of step.requiredFunctionCalls) {
        requiredCounts[fn] = (requiredCounts[fn] || 0) + 1;
      }

      // Check if we have enough calls for each required function
      const missing: string[] = [];
      for (const [fn, requiredCount] of Object.entries(requiredCounts)) {
        const availableCount = calledFunctionCounts[fn] || 0;
        if (availableCount < requiredCount) {
          missing.push(`${fn} (need ${requiredCount}, have ${availableCount})`);
        }
      }

      if (missing.length > 0) {
        missingFunctionCalls.push({
          stepCount: update.stepCount,
          title: step.title,
          missing
        });
        continue; // Skip updating this step
      }

      // If validation passed and marking as completed, decrement the function counts
      for (const fn of step.requiredFunctionCalls) {
        calledFunctionCounts[fn] = (calledFunctionCounts[fn] || 0) - 1;
        pendingCalledFunctionDecrements[fn] = (pendingCalledFunctionDecrements[fn] || 0) + 1;
        countsModified = true;
      }
    }

    // ENG-1698: a skipped step never reaches the 'completed' branch above, so any
    // calls it DID make toward its own requiredFunctionCalls (before being skipped)
    // were never decremented — that credit stays in the shared pool, available to
    // silently satisfy ANY later step requiring the same tool name without the model
    // calling it again for that step's own purpose. Mirror the completed-branch
    // decrement here, clamped at 0 (not gated on availability like completed's is,
    // since a step can be skipped without ever having made its required calls at
    // all — clamping avoids driving the count negative and over-penalizing a later
    // step that makes a genuinely fresh call).
    if (update.status === 'skipped' && step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0) {
      for (const fn of step.requiredFunctionCalls) {
        const current = calledFunctionCounts[fn] || 0;
        if (current > 0) {
          calledFunctionCounts[fn] = current - 1;
          pendingCalledFunctionDecrements[fn] = (pendingCalledFunctionDecrements[fn] || 0) + 1;
          countsModified = true;
        }
      }
    }

    // Asset-count completion gate. When a step declares expectedAssetCount, it may
    // not be marked completed until IT has actually produced that many media
    // assets. This prevents the xCures failure mode: a "Generate 3 Images Per
    // Hook — 18 total" step being marked done with only 3 images produced (the model
    // self-reported "Hooks 2-6 generate-pending" yet completed the step). The
    // required-function-calls gate above could not catch this — it only checked that
    // generate_image was called ≥1×, and the call counter was inflated to 76 by
    // non-producing confirmation-gate returns. Counting real assets is the fix.
    // The user can still legitimately reduce scope via modify_work_plan (lowering or
    // clearing expectedAssetCount), so this never becomes an unrecoverable block.
    //
    // ENG-1188: scoped to images generated SINCE the previous step resolved, not
    // the whole session — otherwise an earlier step's images satisfy a later
    // step's requirement without it producing anything of its own (e.g. step 1's
    // 18 hero images would silently cover step 2's own "3 required" declaration).
    // No earlier step (or none with a resolvedAt yet) means no cutoff, matching
    // the session-wide count this replaces for step 1.
    //
    // ENG-1188 (Greptile follow-up): the cutoff comes from each earlier step's
    // PRE-BATCH resolvedAt (originalStepStateByCount, captured before this call
    // started), walking back to the nearest earlier step that already had one —
    // NOT the live in-progress workPlan.steps. A step resolved earlier in this
    // SAME batch shares this instant as its live timestamp, which would exclude
    // assets this step actually produced in an earlier turn; a step resolved
    // in this same batch simply contributes no cutoff of its own, same as a
    // step that has never resolved.
    //
    // ENG-1188 (CodeRabbit follow-up): a step can be reset to 'pending' after
    // having been completed/skipped before (e.g. its assets need
    // regenerating) — only 'completed'/'skipped' transitions stamp
    // resolvedAt/completedAt, so a reset step KEEPS its stale timestamp from
    // the earlier, now-superseded attempt. The ordering gate above means the
    // only way we can reach a 'completed' update here with an earlier step's
    // PRE-BATCH status of 'pending' is if that earlier step is ALSO being
    // resolved within this very batch (otherwise it would still be pending
    // live, too, and the ordering gate would have rejected this update
    // already). In that case, trust the fresh, just-stamped LIVE timestamp
    // for that step instead of its stale pre-batch one — that boundary is
    // exactly "when did this step's redo actually finish," which correctly
    // excludes both the stale pre-reset attempt's assets AND any redo-work
    // assets produced leading up to this exact re-completion. A step with NO
    // prior resolution at all (genuinely first-time-completed within this
    // batch) still contributes no cutoff, same as the existing behavior.
    if (update.status === 'completed'
      && typeof step.expectedAssetCount === 'number'
      && step.expectedAssetCount > 0) {
      const earlierStepCounts = workPlan.steps
        .filter((s: any) => s.stepCount < step.stepCount)
        .map((s: any) => s.stepCount as number)
        .sort((a: number, b: number) => b - a); // nearest first
      let sinceIso: string | undefined;
      for (const count of earlierStepCounts) {
        const preBatch = originalStepStateByCount.get(count);
        if (!preBatch) continue;
        if (preBatch.status === 'completed' || preBatch.status === 'skipped') {
          if (preBatch.resolvedAt) { sinceIso = preBatch.resolvedAt; break; }
          continue;
        }
        if (preBatch.resolvedAt) {
          const live = workPlan.steps.find((s: any) => s.stepCount === count);
          if (live?.resolvedAt) { sinceIso = live.resolvedAt; break; }
        }
      }
      // ENG-1331: extractGeneratedImageFilenames only recognizes generate_image's
      // own marker, so a step whose deliverable is Playwright-rendered
      // screenshots (no generate_image call at all) would always read 0 there.
      // extractProducedAssetCount reads the same persisted toolCalls ledger for
      // every known asset-producing tool.
      //
      // When the step names its own expectedAssetCountTools, trust that
      // explicitly and skip the max-with-legacy-signal blend below: the whole
      // point of naming the tool(s) is precision, and blending in
      // extractGeneratedImageFilenames' generate_image count would reopen the
      // exact ambiguity the author resolved by naming their tool(s) at all (e.g.
      // an unrelated generate_image call elsewhere in the step inflating a
      // screenshot-only count). Without a declared list, take the max of both
      // signals so neither detection path can pull the count DOWN relative to
      // the other — the safe default for a step that hasn't disambiguated.
      const producedAssetCount = step.expectedAssetCountTools?.length
        ? extractProducedAssetCount(session.messages, sinceIso, step.expectedAssetCountTools)
        : Math.max(
            extractGeneratedImageFilenames(session.messages, sinceIso).length,
            extractProducedAssetCount(session.messages, sinceIso),
          );
      if (producedAssetCount < step.expectedAssetCount) {
        insufficientAssets.push({
          stepCount: update.stepCount,
          title: step.title,
          expected: step.expectedAssetCount,
          produced: producedAssetCount,
        });
        continue; // Skip updating this step
      }
    }

    // Update the step status
    const resolvedNow = update.status === 'completed' || update.status === 'skipped'
      ? new Date().toISOString()
      : undefined;
    workPlan.steps[stepIndex] = {
      ...workPlan.steps[stepIndex],
      status: update.status,
      notes: update.notes,
      completedAt: update.status === 'completed' ? resolvedNow : workPlan.steps[stepIndex].completedAt,
      // ENG-1188 (Greptile follow-up): set for 'skipped' too, unlike completedAt
      // — see the field's doc comment in chatbotService.ts for why this can't
      // just reuse completedAt.
      resolvedAt: resolvedNow || workPlan.steps[stepIndex].resolvedAt,
    };

    updatedSteps.push({
      stepCount: update.stepCount,
      title: workPlan.steps[stepIndex].title,
      status: update.status
    });
  }

  // Ordering gate failure — a step was completed while an earlier step in the
  // plan is still pending. Same all-or-nothing shape as the two gates below:
  // the caller can just resend the batch in the correct order.
  if (outOfOrderSteps.length > 0) {
    const errorDetails = outOfOrderSteps.map(oos =>
      `Step ${oos.stepCount} "${oos.title}": earlier step(s) not yet done: ${oos.pendingSteps.join(', ')}`
    ).join('\n');

    return {
      success: false,
      // ENG-1626: this is a deliberate business-rule gate, not a malfunction --
      // blocked/reason lets recordToolFailure (agentToolGatewayService) recognize
      // it as a ToolResultPolicyBlockedError and skip it, the same telemetry
      // carve-out ENG-1636 established. Without this, a self-corrected refusal
      // like this one incremented failedFunctions.set_work_plan_status and read
      // as an infra flake on the failure-cluster dashboard.
      blocked: true,
      reason: 'workplan_out_of_order',
      message: 'Cannot mark steps as completed. Earlier steps in the plan are not done yet.',
      outOfOrderSteps,
      formattedContent: `❌ Cannot complete these steps yet:\n${errorDetails}\n\nComplete (or explicitly skip) the earlier step(s) first, then mark this step as completed.`
    };
  }

  // Check if there are missing function calls - this is a critical error
  if (missingFunctionCalls.length > 0) {
    const errorDetails = missingFunctionCalls.map(mfc =>
      `Step ${mfc.stepCount} "${mfc.title}": missing required function calls: ${mfc.missing.join(', ')}`
    ).join('\n');

    return {
      success: false,
      // ENG-1626: deliberate gate, see the out-of-order gate above for why
      // blocked/reason is set here.
      blocked: true,
      reason: 'workplan_missing_function_calls',
      message: 'Cannot mark steps as completed. Required function calls have not been made yet.',
      missingFunctionCalls,
      formattedContent: `❌ Cannot complete these steps yet:\n${errorDetails}\n\nPlease make the required function calls first, then mark the steps as completed.`
    };
  }

  // Asset-count gate failure — the step's declared media assets are not all produced.
  if (insufficientAssets.length > 0) {
    const errorDetails = insufficientAssets.map(ia =>
      `Step ${ia.stepCount} "${ia.title}": ${ia.produced} of ${ia.expected} required images/assets have been generated (${ia.expected - ia.produced} still missing)`
    ).join('\n');

    return {
      success: false,
      // ENG-1626: deliberate gate, see the out-of-order gate above for why
      // blocked/reason is set here.
      blocked: true,
      reason: 'workplan_insufficient_assets',
      message: 'Cannot mark steps as completed. The required number of assets has not been generated yet.',
      insufficientAssets,
      formattedContent: `❌ Cannot complete these steps yet:\n${errorDetails}\n\nGenerate the remaining assets with generate_image, then mark the step completed. If the user has explicitly approved a smaller set, call modify_work_plan to lower the step's expected asset count first.`
    };
  }

  // ENG-1811: a step removed via modify_work_plan's removeStepCounts can carry
  // requiredFunctionCalls that never succeeded -- genuinely necessary work that
  // was never done. Refuse to let this batch finish the WHOLE plan (resolve the
  // last remaining pending step(s)) while any such debt is still outstanding,
  // regardless of whether any current step still lists it as required. Scoped to
  // "finishing the plan" rather than every individual step transition so
  // unrelated, still-in-progress steps keep completing normally in the
  // meantime -- only the moment the run would otherwise look fully done is
  // gated, which is the only place a silently-dropped requirement actually
  // matters.
  //
  // Reads session.calledFunctions directly (the raw, never-mutated snapshot
  // from the top of this function), NOT the local calledFunctionCounts copy --
  // that copy gets decremented in-place, once per required call, as THIS SAME
  // batch's own steps pass their gates above (the pre-existing ENG-1698
  // credit-consumption mechanic). A debt name that's ALSO genuinely required
  // and satisfied by an ordinary step completing earlier in this very loop
  // would decrement calledFunctionCounts back toward 0, making a real success
  // moments earlier look like it never happened -- a real bug found by review,
  // reproduced standalone before this comment was written: a session with a
  // pending debt for `list_html_templates`, a single step requiring exactly
  // that function, called exactly once and genuinely succeeding, still got
  // permanently blocked from ever finishing. The real persisted decrement
  // (decrementCalledFunctionsClamped) only runs after this whole gate passes
  // anyway, so there's no correctness reason to consult the hypothetical
  // post-decrement value at decision time -- only whether the function
  // actually succeeded at all this session.
  const rawCalledFunctionCounts = session.calledFunctions || {};
  const unresolvedPendingRequiredFunctionCalls = (workPlan.pendingRequiredFunctionCalls || [])
    .filter(fn => (rawCalledFunctionCounts[fn] || 0) === 0);
  if (unresolvedPendingRequiredFunctionCalls.length > 0) {
    const noStepsRemainPending = !workPlan.steps.some(s => s.status === 'pending');
    if (noStepsRemainPending) {
      return {
        success: false,
        // ENG-1626: deliberate gate, see the out-of-order gate above for why
        // blocked/reason is set here.
        blocked: true,
        reason: 'workplan_unresolved_removed_requirements',
        message: 'Cannot finish this work plan. A required function call from a removed step was never made.',
        pendingRequiredFunctionCalls: unresolvedPendingRequiredFunctionCalls,
        formattedContent: `❌ Cannot mark this plan finished yet: ${unresolvedPendingRequiredFunctionCalls.join(', ')} ${unresolvedPendingRequiredFunctionCalls.length === 1 ? 'was' : 'were'} required by a step that got removed, but never actually succeeded.\n\nCall it for real, or use modify_work_plan to add back a step that genuinely does this work, before finishing the plan.`
      };
    }
  }
  // Auto-clear any debts that have since genuinely succeeded (by any means --
  // not necessarily via the stepCount that originally required them), so the
  // ledger doesn't grow stale forever once real work actually happens.
  if (workPlan.pendingRequiredFunctionCalls && workPlan.pendingRequiredFunctionCalls.length > 0) {
    workPlan.pendingRequiredFunctionCalls = unresolvedPendingRequiredFunctionCalls;
  }

  // Check if any steps were not found
  if (notFoundSteps.length > 0 && updatedSteps.length === 0) {
    return {
      success: false,
      // ENG-1626: deliberate gate (bad stepCount), see the out-of-order gate
      // above for why blocked/reason is set here.
      blocked: true,
      reason: 'workplan_step_not_found',
      message: `Steps not found: ${notFoundSteps.join(', ')}`
    };
  }

  // Only update if there are changes
  if (updatedSteps.length > 0) {
    workPlan.updatedAt = new Date().toISOString();
    // Update the session (will throw error if stepCount is not sequential)
    await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

    // A configured input belongs to the step that just became active, not
    // to a particular portal. Persist the same request the customer portal
    // renders and an MCP client elicits natively. Answered historical
    // requests may be replaced; a concurrent live request never is.
    const nextInputStep = workPlan.steps
      .sort((a: any, b: any) => a.stepCount - b.stepCount)
      .find((s: any) => s.status === 'pending' && s.inputRequest);

    // ENG-1682: a step's own pendingWorkPlanInput is only cleared by the
    // structured WorkPlanInputCard submission (updateSessionWorkPlanInputRequest
    // with a null value). A user who answers the step conversationally in chat
    // instead -- the ordinary way people talk to Emma -- never hits that path,
    // so the now-resolved step's request stays status:'awaiting' forever. The
    // customer portal's Details surface (the default landing view) treats any
    // 'awaiting' input as still-active and hides the entire message list --
    // every later step's deliverable included -- behind that stale card for
    // the rest of the session. Clear it the moment its own step resolves, the
    // same instant we'd otherwise replace it with the next step's request.
    const resolvedStepCounts = new Set(
      updatedSteps
        .filter(s => s.status === 'completed' || s.status === 'skipped')
        .map(s => s.stepCount),
    );
    const staleInputForResolvedStep = Boolean(
      session.pendingWorkPlanInput
        && session.pendingWorkPlanInput.status === 'awaiting'
        && resolvedStepCounts.has(session.pendingWorkPlanInput.stepCount),
    );

    // CodeRabbit (PR #2713): bypassing failIfAwaitingExists entirely for the write
    // below would also skip its pendingUserQuestion check, letting a NEW work-plan
    // input land while a genuinely concurrent ask_user_question is still awaiting --
    // two simultaneous prompts, an invalid state neither surface expects. Clear the
    // known-stale record as its OWN guarded step first (matched by requestId, so a
    // race that already replaced it fails closed instead of clobbering the newer
    // one), THEN let the write below keep its full, unmodified guard -- it now
    // correctly finds pendingWorkPlanInput cleared while still enforcing the
    // pendingUserQuestion half of the check.
    if (staleInputForResolvedStep) {
      await chatbotDb.updateSessionWorkPlanInputRequest(sessionId, null, {
        requireStillAwaiting: session.pendingWorkPlanInput!.requestId,
      });
    }

    if (nextInputStep?.inputRequest) {
      await chatbotDb.updateSessionWorkPlanInputRequest(
        sessionId,
        buildWorkPlanInputRequest({
          ...nextInputStep.inputRequest,
          requestId: uuidv4(),
          stepCount: nextInputStep.stepCount,
        }),
        { failIfAwaitingExists: true },
      );
    }

    // Update function counts if they were modified. Applied as a clamped delta
    // against a fresh read (ENG-1698) rather than this call's local snapshot,
    // so it can't clobber a concurrent writer (e.g. a new plan's reset, or
    // another in-flight tool-dispatch increment).
    if (countsModified) {
      await chatbotDb.decrementCalledFunctionsClamped(sessionId, pendingCalledFunctionDecrements);
    }

    // Auto-install skills for the next pending step
    const completedStepCounts = updatedSteps.filter(s => s.status === 'completed').map(s => s.stepCount);
    if (completedStepCounts.length > 0) {
      const nextPendingStep = workPlan.steps
        .sort((a: any, b: any) => a.stepCount - b.stepCount)
        .find((s: any) => s.status === 'pending');
      if (nextPendingStep?.skillIds?.length) {
        try {
          const currentAssociated = session.associatedSkills || [];
          const newSkillIds = nextPendingStep.skillIds.filter((id: string) => !currentAssociated.includes(id));
          if (newSkillIds.length > 0) {
            await chatbotDb.addAssociatedSkills(sessionId, newSkillIds);
            console.log(`AgentMode: Auto-installed skills for step ${nextPendingStep.stepCount}: ${newSkillIds.join(', ')}`);
          }
        } catch (skillErr) {
          console.error('AgentMode: Error auto-installing skills for next step:', skillErr);
        }
      }
    }
  }

  const message = updatedSteps.length === 1
    ? `Step ${updatedSteps[0].stepCount} status updated to ${updatedSteps[0].status}`
    : `Updated ${updatedSteps.length} step${updatedSteps.length > 1 ? 's' : ''}`;

  const formattedContent = updatedSteps.map(s =>
    `Updated step ${s.stepCount} "${s.title}" to ${s.status}`
  ).join('\n');

  return {
    success: updatedSteps.length > 0,
    message: notFoundSteps.length > 0
      ? `${message}. Steps not found: ${notFoundSteps.join(', ')}`
      : message,
    updatedSteps,
    notFoundSteps: notFoundSteps.length > 0 ? notFoundSteps : undefined,
    formattedContent
  };
}

export async function sendForReview(
  subject: string,
  sessionId: string,
  userId: string,
  contentUrl?: string,
  contentHtml?: string
): Promise<{ success: boolean; message: string; to?: string }> {
  try {
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session?.resultEndpointMetadata) {
      return { success: false, message: 'No result endpoint metadata found on session' };
    }

    const metadata = session.resultEndpointMetadata;
    const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    const reviewerEmail = metadata.reviewerEmail || (metadata as any).testEmail;

    // Store content references and subject on session metadata for the review page
    const updatedMetadata = {
      ...metadata,
      contentUrl: contentUrl || metadata.contentUrl,
      contentHtml: contentHtml || metadata.contentHtml,
      contentSubject: subject,
    };
    await chatbotDb.updateSessionResultEndpointMetadata(sessionId, updatedMetadata);

    const reviewUrl = `${customerFrontendUrl}/review/${sessionId}`;

    // --- skipReview mode: auto-send to lead, CC reviewer ---
    if (metadata.skipReview && metadata.leadEmail) {
      const { resendService: resendSvc } = await import('../../services/resendService');
      const { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } = await import('../../config');

      // Collect assets from session messages to send the latest one
      const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
      let latestAssetUrl: string | undefined;
      for (const msg of messages) {
        if (msg.role === 'tool' && msg.content && msg.name) {
          let result: any;
          try { result = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content; } catch { continue; }
          if (!result || result.success === false) continue;
          if (result.s3_url) latestAssetUrl = result.s3_url;
          if (result.imageUrl) latestAssetUrl = result.imageUrl;
          if (result.videoUrl) latestAssetUrl = result.videoUrl;
        }
      }

      const assetUrl = contentUrl || latestAssetUrl;
      const resultLabel = metadata.resultTitle || metadata.resultName || 'your report';
      const replyToAddr = reviewerEmail || RESEND_SYSTEM_EMAIL;

      // Build asset block
      let assetBlock = '';
      if (assetUrl) {
        if (assetUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i) || assetUrl.includes('image')) {
          assetBlock = `<p style="text-align: center;"><img src="${assetUrl}" alt="${resultLabel}" style="max-width: 100%; border-radius: 8px;" /></p>`;
        } else if (assetUrl.match(/\.(mp4|webm|mov)$/i) || assetUrl.includes('video')) {
          assetBlock = `<div style="text-align: center; margin: 20px 0;"><a href="${assetUrl}" style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Watch Video</a></div>`;
        } else {
          assetBlock = `<div style="text-align: center; margin: 20px 0;"><a href="${assetUrl}" style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">View Your Result</a></div>`;
        }
      }

      // Formal email to lead, CC reviewer
      const leadEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
            <p style="color: #666; margin: 5px 0;">${resultLabel}</p>
          </div>
          <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1B2549; margin-top: 0;">Your ${resultLabel} is Ready!</h2>
            <p style="color: #333; line-height: 1.6;">We're excited to send you the requested ${resultLabel}. Our team has prepared this content specifically for you.</p>
            ${assetBlock}
            <p style="color: #333; line-height: 1.6; margin-top: 20px;">
              If you have any questions or would like to request changes, simply reply to this email or reach out to us at
              <a href="mailto:${replyToAddr}" style="color: #643B7E; text-decoration: none;">${replyToAddr}</a>
              and we'll be happy to assist.
            </p>
          </div>
          <div style="text-align: center; color: #666; font-size: 12px;">
            <p>Powered by <a href="https://agentweb.pro" style="color: #643B7E; text-decoration: none;">AgentWeb</a></p>
          </div>
        </div>`;

      const leadSubject = metadata.contentSubject || `Your ${resultLabel} is ready`;
      await resendSvc.sendEmail({
        from: `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`,
        to: metadata.leadEmail,
        subject: leadSubject,
        html: leadEmailHtml,
        cc: reviewerEmail,
        replyTo: replyToAddr,
      });

      // Record in send history
      const sendHistoryEntry = {
        assetUrl: assetUrl || '__auto_sent__',
        recipientEmail: metadata.leadEmail,
        customMessage: 'Auto-sent (no review required)',
        sentAt: new Date().toISOString(),
      };
      await chatbotDb.updateSessionResultEndpointMetadata(sessionId, {
        ...updatedMetadata,
        sendHistory: [...(updatedMetadata.sendHistory || []), sendHistoryEntry],
      });

      return { success: true, message: `Result sent to ${metadata.leadEmail} (reviewer ${reviewerEmail} CC'd)`, to: metadata.leadEmail };
    }

    // --- Standard review mode: send review email to reviewer ---
    const { emailService: emailSvc } = await import('../../services/emailService');
    let contentSection = '';
    if (contentUrl) {
      contentSection = `<p><a href="${contentUrl}" style="color: #1976d2;">View Generated Content</a></p>`;
    }
    if (contentHtml) {
      contentSection += `<div style="margin: 16px 0; padding: 16px; border: 1px solid #e0e0e0; border-radius: 8px; background: #fafafa;">${contentHtml}</div>`;
    }

    const argsEntries = Object.entries(metadata.args || {});
    const paramsSummary = argsEntries.length > 0
      ? `<table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
          <tr style="background: #f5f5f5;"><th style="text-align: left; padding: 8px; border: 1px solid #e0e0e0;">Parameter</th><th style="text-align: left; padding: 8px; border: 1px solid #e0e0e0;">Value</th></tr>
          ${argsEntries.map(([k, v]) => `<tr><td style="padding: 8px; border: 1px solid #e0e0e0;">${k}</td><td style="padding: 8px; border: 1px solid #e0e0e0;">${v}</td></tr>`).join('')}
        </table>`
      : '';

    const reviewHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
        <div style="background: #1976d2; color: white; padding: 12px 20px; border-radius: 8px 8px 0 0; font-weight: bold;">
          Review: ${subject}
        </div>
        <div style="padding: 20px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="color: #666;">A new result has been generated for "<strong>${metadata.resultTitle || metadata.resultName}</strong>". Please review the content below.</p>
          ${contentSection}
          ${paramsSummary ? `<h3 style="margin-top: 20px; color: #333;">Parameters</h3>${paramsSummary}` : ''}
          ${metadata.leadEmail ? `<p><strong>Lead email:</strong> ${metadata.leadEmail}</p>` : ''}
          <div style="margin-top: 24px; text-align: center;">
            <a href="${reviewUrl}" style="display: inline-block; background: #1976d2; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 16px;">Review & Send Result</a>
          </div>
        </div>
      </div>`;

    await emailSvc.sendEmail(reviewerEmail, `Review: ${subject}`, `Review result for ${metadata.resultTitle || metadata.resultName}`, reviewHtml);
    return { success: true, message: `Review email sent to ${reviewerEmail}`, to: reviewerEmail };

  } catch (error) {
    console.error('AgentMode: Error sending for review:', error);
    return { success: false, message: 'Failed to send for review', error: error instanceof Error ? error.message : 'Unknown error' } as any;
  }
}
