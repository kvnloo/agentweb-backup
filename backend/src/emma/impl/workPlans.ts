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
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A) — `modifyWorkPlan`
 * and its private helper `wasStepRemovalUserAuthorized` MOVED HERE, in a
 * later round than the other 5. Originally flagged and excluded from this
 * cluster (see the design-decision list) because `wasStepRemovalUserAuthorized`
 * makes a direct `this.callLLM` call (an LLM judge deciding whether a user
 * message explicitly authorized a work-plan step removal) — the same
 * `this.callLLM`-coupling exclusion pattern already established for
 * `createHtmlFromTemplate`/`generateImage`/`updateEmailDraftForLead`/
 * `importLeadsFromSearch`. Read `modifyWorkPlan`'s full body before moving it
 * (not just the helper): it has exactly ONE `this.*` reference in its ~370
 * lines (the call to `this.wasStepRemovalUserAuthorized`) — no other direct
 * or indirect `this.callLLM` coupling, confirmed by grepping the full method
 * body for `this\.`.
 *
 * This is the highest-stakes move in the whole F2 series: `wasStepRemovalUserAuthorized`'s
 * `usageContext` has a documented, TWICE-regressed billing bug history
 * (`lesson-forwarding-resolved-field-suppresses-downstream-resolver` — F1
 * rounds 3 and 4 both fixed a real `billingUserId`-forwarding bug at this
 * exact call site, round 4 finding round 3's own fix at this site had been
 * incomplete elsewhere). The billing-critical block — the comment and the
 * `usageContext` object it documents — moved CHARACTER-FOR-CHARACTER
 * identical, not paraphrased:
 *
 * ```
 *           // ENG-1816 F1: this judge previously carried no userId, so its spend booked
 *           // to "system" and escaped both billing and the funding policy. Read the
 *           // run's owner from the ambient store instead of threading a new parameter
 *           // through this method's signature. billingUserId deliberately omitted: this
 *           // reaches meterWithResolvedBilling, which only resolves the org-root billing
 *           // subject when billingUserId is absent (ENG-1858) — passing ownerUserId here
 *           // would re-suppress that resolution for org members, the exact ENG-1217 bug.
 *           usageContext: {
 *             feature: 'step_removal_authorization_judge',
 *             userId: currentRunFunding()?.ownerUserId,
 *           },
 * ```
 *
 * NOT changed, per the explicit brief for this round: no `billingUserId`
 * field added to this object, what `userId` is set to, or how
 * `currentRunFunding()` is called. `currentRunFunding` is a module-level
 * AsyncLocalStorage reader (not a `this`-bound instance method) — imported
 * directly here, statically, the identical import path
 * `agentModeService.ts` itself already uses
 * (`import { currentRunFunding } from './funding/runFunding'`), NOT injected
 * like `callLLM`. `RunFunding`'s module (`services/funding/runFunding.ts`) is
 * a pure `AsyncLocalStorage` wrapper with no AWS-SDK/DB dependency at module
 * scope (it lazily requires the one config module that does), so a static
 * top-level import here carries none of the transitive-import risk the other
 * four named traps do.
 *
 * `callLLM` is injected into `wasStepRemovalUserAuthorized` as
 * `ModifyWorkPlanLlmCall` (a narrow structural type covering only the one
 * call shape this call site actually sends — `temperature`,
 * `max_completion_tokens`, `taskClass`, `usageContext` — not the full private
 * `LLMCallOptions` interface this module must not import anyway, same
 * discipline as `CreateHtmlFromTemplateLlmCall`/`DescribeImageLlmCall`).
 * `modifyWorkPlan`'s own internal call to
 * `this.wasStepRemovalUserAuthorized(...)` collapses to a plain internal
 * function call now that both live in the same module — `callLLM` is
 * injected ONCE at `modifyWorkPlan`'s own top level and threaded straight
 * through to the helper, not a second injection point for the same
 * capability (same shape as `mediaVideo.ts`'s `generateImage` →
 * `describeImage` chain). `wasStepRemovalUserAuthorized` is called as a
 * plain local function (not via a same-module self-import) because nothing
 * spies on the exported reference while `modifyWorkPlan` runs — same as this
 * module's own pre-existing `setWorkPlanStatus` → `setWorkPlanStatusAttempt`
 * call, which also skips the self-import for the same reason.
 *
 * `STEP_REMOVAL_JUDGE_MODEL`/`STEP_REMOVAL_JUDGE_TIMEOUT_MS` were `private
 * readonly` instance fields with no dependents beyond this one method
 * (confirmed by whole-backend grep) — demoted to plain module-level `const`s
 * here, the same treatment `DEFAULT_DESCRIBE_IMAGE_TIMEOUT_MS` got in
 * `mediaVideo.ts`.
 *
 * `wasStepRemovalUserAuthorized` is `private` on the class and has exactly
 * one production caller (`modifyWorkPlan`, confirmed by whole-backend grep)
 * — no class wrapper is needed or added, matching this series' established
 * "a private-only helper needs no public delegate" treatment. It IS exported
 * from this module, though, for one disclosed reason: `eng1858.usageAttribution.test.ts`
 * has a dedicated F1-era regression test asserting on this exact call site's
 * `usageContext` shape (`'wasStepRemovalUserAuthorized (agentModeService.ts)
 * carries the run owner and never forwards billingUserId'`) that called
 * `(agentModeService as any).wasStepRemovalUserAuthorized(...)` directly on
 * the singleton — retargeted to import `wasStepRemovalUserAuthorized` from
 * this module and call it directly with a mock `callLLM`, the same
 * "export a private-shaped helper because a real test needs to call it
 * directly" treatment `resolveDescribeImageTimeoutMs` got in `mediaVideo.ts`.
 *
 * `modifyWorkPlan` is kept as a delegating wrapper on the class (not
 * deleted): real callers beyond `emma/tools.ts` (whole-backend grep)  are
 * `routes/emmaApi.ts`'s `POST /work-plans/modify`-style handler and
 * `agentModeService.workPlan.test.ts` (`(agentModeService as
 * any).modifyWorkPlan(...)`, ~35 call sites including the 6 dedicated
 * ENG-1875 judge tests that `jest.spyOn(agentModeService, 'callLLM')` and
 * expect the class wrapper's `this.callLLM.bind(this)` to route through the
 * spy — verified this still works exactly like `describeImage`'s already-
 * proven identical mechanism, since the wrapper re-binds `this.callLLM`
 * fresh on every call rather than capturing it at construction time).
 *
 * `AgentModeService.extractGeneratedImageFilenames(...)` (used by
 * `modifyWorkPlan`'s asset-count gate to measure produced images) is
 * unchanged from cross-dependency #2 above: this module already imports the
 * real, promoted `extractGeneratedImageFilenames` from
 * `./shared/generatedAssets` directly, so `modifyWorkPlan`'s body uses that
 * import rather than the static class reference (which would otherwise force
 * this module to import `AgentModeService`'s type for one call).
 *
 * `chatbotDb` (session read/write, `getMostRecentRealUserMessage`) is
 * lazy-`require`'d inside both functions' bodies, the same established idiom
 * every other method in this module already uses for the same trap.
 *
 * No other hidden `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling was found anywhere in the 5
 * originally-moved methods (grepped every method body individually before
 * moving it, unchanged from the earlier round's finding).
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
 * No `billingUserId`/`currentRunFunding()` handling anywhere in the
 * originally-moved 5 methods (grepped all 5 method bodies, zero matches) —
 * none of them meter LLM usage themselves, so the
 * lesson-forwarding-resolved-field-suppresses-downstream-resolver bug class
 * did not apply to that round. It DOES apply to the later-added
 * `wasStepRemovalUserAuthorized` (see the Pattern-A section above) — the one
 * `currentRunFunding()` use in this file is exactly that pre-existing,
 * unchanged fix, not a new instance of the bug class.
 */
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { classifyToolErrorClass } from '../../utils/toolErrorClassifier';
import { isRetryableErrorClass } from '../../services/agentMode/core/errorRetryability';
import { buildWorkPlanInputRequest } from '../../services/agentMode/core/workPlanInputRequest';
import { shouldForceScheduledAutocomplete } from '../../services/agentMode/core/scheduledAutocomplete';
import { extractProducedAssetCount } from '../../services/agentMode/core/synthesisResidue';
import { extractGeneratedImageFilenames } from './shared/generatedAssets';
import { currentRunFunding } from '../../services/funding/runFunding';
import { isNonConsumableRequiredFunctionCall } from '../../services/agentMode/workPlanRequiredCallsPolicy';
import { resolvePlanLaunchModel, isUserAdminSafe, type ModelPinRegistry } from '../../services/agentMode/modelPin';
import { isSystemAuthoredPlan, storedModelSource } from '../../services/agentMode/modelAccess';
import { assertSequentialStepCounts } from '../../services/workPlanSteps';
import { anyStepCarriesModel, isStepModelUnavailableError, modelBoundToStep, resolvePlanStepModelsForLaunch } from '../../services/agentMode/workPlanStepModels';
import { buildAnonymousModelUnavailableBody, buildAnonymousPlanModelToolMessage, buildModelUnavailableBody, buildPlanModelToolMessage, isModelUnavailableError, MODEL_SAVE_FAILED_MESSAGE } from '../../services/agentMode/modelUnavailable';
import type { GatewayTaskClass } from '../../utils/openRouterGatewayContract';
import type { LLMUsageContext } from '../../utils/llmService';
import { isAgentWebModelId } from '../../services/agentMode/agentWebModelRouter';
import { buildResultDeliveryEmailHtml, buildReviewUrl, isValidRecipientEmail } from '../../services/resultEndpointReview';
import { escapeHtml } from './shared/htmlEscaping';

/**
 * ENG-1816 F2 follow-up: a production session reported "No work plan found in
 * this session" on `set_work_plan_status` immediately after an earlier step on
 * the SAME session had completed successfully. Direct reproduction (same
 * sequence, real backend, real DynamoDB reads in between) could not trigger it
 * -- the create -> complete-step-1 -> complete-step-2 round trip is reliable
 * every time it was tried. Since the failure couldn't be caught live, this logs
 * the exact shape of the miss (session missing entirely vs. present with no
 * workPlan vs. present with a workPlan that calledFunctions disagrees with)
 * so the next real occurrence leaves forensic evidence instead of just the
 * user-facing message. Remove once the real cause is found and fixed, or once
 * this has run long enough with zero hits to downgrade the finding.
 */
function logMissingWorkPlanForDiagnosis(
  caller: 'setWorkPlanStatus' | 'modifyWorkPlan',
  sessionId: string,
  session: { workPlan?: unknown; calledFunctions?: Record<string, number>; createdAt?: string; updatedAt?: string } | null,
): void {
  const calledFunctionNames = session?.calledFunctions ? Object.keys(session.calledFunctions) : [];
  console.warn(
    `AgentMode: ${caller} found no work plan for session ${sessionId} (ENG-1816 diagnostic). ` +
    `sessionExists=${!!session} ` +
    `sessionCreatedAt=${session?.createdAt ?? 'n/a'} sessionUpdatedAt=${session?.updatedAt ?? 'n/a'} ` +
    // If create_work_plan shows up here despite workPlan being absent, the plan
    // was created and then lost -- a very different bug than "never created".
    `calledFunctionsSeenOnSession=[${calledFunctionNames.join(', ')}]`
  );
}

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
export interface WorkPlanModelRegistry extends ModelPinRegistry {
  getSupportedModels(isAdmin?: boolean): Promise<string[]>;
  getDefaultModel?: () => Promise<string>;
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
      // ENG-1993: a bare "not found" left the model nothing to recover with, so it
      // re-tried the same unresolvable name (7/9 failures in one reliability run).
      // Return the closest accessible templates by stable planId and point at
      // list_predefined_work_plans. Never auto-launch a guess: the ENG-1794/1814
      // wrong-template incidents came from exactly that kind of silent fallback.
      const needleTokens = needle.split(' ').filter((t) => t.length > 2);
      const suggestions = candidates
        .filter((p) => p.title && p.planId)
        .map((p) => {
          const title = normalizeWorkPlanTitleForMatch(p.title);
          const score = needleTokens.filter((t) => title.includes(t)).length;
          return { planId: p.planId as string, title: p.title as string, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(({ planId, title }) => ({ planId, title }));
      const hint = suggestions.length > 0
        ? ` Closest accessible templates: ${suggestions.map((s) => `"${s.title}" (planId ${s.planId})`).join(', ')}. Confirm with the user which one they meant, then call launch_predefined_work_plan with that planId.`
        : ' Call list_predefined_work_plans to see the templates available to this user, then retry with an exact planId.';
      return {
        success: false,
        errorType: 'not_found',
        message: `Work plan template "${planTitleOrId}" not found.${hint} Do not retry with the same name.`,
        suggestions,
      };
    }
    if (predefinedPlan.visibility === 'private' && (!userId || userId.startsWith('anon_'))) {
      return { success: false, message: 'Not authorized to use this private work plan' };
    }

    // ENG-903 FAIL-LOUD: a plan's non-empty `defaultModel` is an explicit pin. Resolve it
    // for the LAUNCHING (session-owner) user BEFORE any session mutation; an unserved or
    // unselectable pin refuses the launch with the shared model_unavailable sentence
    // instead of launching on another model. Empty = account default (unchanged).
    //
    // ENG-2378: with per-step models enabled, EVERY step's model gets the same treatment up front -- the
    // launching user must be able to select it, or the whole launch is refused with no state written.
    // (Lazy import: this module must not load settingsService at module scope -- see the isolation test.)
    // Only plans that carry a step model read the switch at all.
    // A stored step model is honoured unless the switch is definitely off (an unknown state after a settings outage is not "off").
    const stepModelsEnabled = anyStepCarriesModel(predefinedPlan.steps)
      && await (await import('../../services/agentMode/workPlanStepModelsInstance')).workPlanStepModels.shouldHonor();
    let planPinnedModel: string | undefined;
    let stepModelIds = new Map<number, string>();
    // ENG-669: an admin-authored plan's pins are AgentWeb's choice (no tier check); any other plan's pins must be in
    // the launching (session-owner) user's plan.
    const planPinSourceAtLaunch: 'system' | 'user' = isSystemAuthoredPlan(predefinedPlan) ? 'system' : 'user';
    const tierOwner = planPinSourceAtLaunch === 'system' ? undefined : (userId || undefined);
    try {
      planPinnedModel = await resolvePlanLaunchModel(
        modelRegistry,
        () => isUserAdminSafe(userId),
        predefinedPlan.defaultModel,
        tierOwner,
        // ENG-669 PR-C: an admin plan's AgentWeb Model pin must still route for the launching user's tier.
        userId || undefined,
      );
      if (stepModelsEnabled) {
        stepModelIds = await resolvePlanStepModelsForLaunch(
          modelRegistry, () => isUserAdminSafe(userId), predefinedPlan.steps || [], tierOwner, userId || undefined,
        );
      }
    } catch (launchModelError) {
      const stepError = isStepModelUnavailableError(launchModelError) ? launchModelError : undefined;
      const modelError = stepError ? stepError.cause : launchModelError;
      if (!isModelUnavailableError(modelError)) throw launchModelError;
      const body = {
        ...buildModelUnavailableBody(
          modelError,
          typeof modelRegistry.getModelDisplayName === 'function' ? modelRegistry.getModelDisplayName(modelError.requestedModel) : undefined,
          'work_plan_pin',
        ),
        ...(stepError && { stepCount: stepError.stepCount }),
      };
      // An anonymous/visitor session can reach this tool (public plan sessions): the visitor
      // sees the model's reply, so they learn no model id, name or reason. Server logs and the
      // oncall alert below still carry the details.
      const isAnonymousCaller = !userId || userId.startsWith('anon_');
      console.warn(`[applyPredefinedWorkPlan] "${predefinedPlan.title}" not launched — plan model "${body.requestedModel}" is ${modelError.reason}.`);
      // ENG-669 PR-C: a pin of the AgentWeb Model refused as unavailable is the router being off or unavailable, which
      // its own deduped alert already covers (a switch-off is a deliberate rollback): no page per launch.
      const routerUnavailable = isAgentWebModelId(modelError.requestedModel) && modelError.reason !== 'not_in_plan';
      if (options?.isUnattendedRun && !routerUnavailable) {
        void import('../../utils/agentModeAlerts')
          .then(({ sendAgentModeOncallAlert }) => sendAgentModeOncallAlert({
            subject: stepError
              ? 'AgentMode: unavailable model on a Work Plan step launched by an unattended run'
              : 'AgentMode: unavailable model pinned on a Work Plan launched by an unattended run',
            message: `Work plan "${predefinedPlan.title}" (${predefinedPlan.planId}) ${stepError ? `step ${stepError.stepCount} uses` : 'pins'} model "${body.requestedModel}", which is not available (${modelError.reason}). The unattended launch was refused and nothing ran on another model. Choose a served model for the plan${stepError ? ' step' : ''}.`,
            context: { Plan: String(predefinedPlan.planId), 'Pinned Model': body.requestedModel, ...(stepError && { Step: String(stepError.stepCount) }) },
            dedupeKey: `workplan_model_invalid:${predefinedPlan.planId}:${stepError ? `step${stepError.stepCount}:` : ''}${body.requestedModel}`,
            dedupeWindowMs: 60 * 60 * 1000,
          }))
          .catch((alertError) => console.error('[applyPredefinedWorkPlan] Failed to send unavailable plan-model alert:', alertError));
      }
      return {
        success: false,
        errorType: 'model_unavailable',
        code: 'model_unavailable',
        modelUnavailable: isAnonymousCaller ? buildAnonymousModelUnavailableBody() : body,
        message: isAnonymousCaller ? buildAnonymousPlanModelToolMessage() : buildPlanModelToolMessage(body),
      };
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
      steps: (predefinedPlan.steps || []).map((step: any, stepIndex: number) => ({
        stepCount: step.stepCount,
        title: step.title,
        description: step.description,
        ...(step.userInstructions !== undefined && { userInstructions: step.userInstructions }),
        // ENG-2378: the step's validated canonical model (only while the switch is on; otherwise it is not copied).
        // ENG-669: with who chose it (the plan's author), recorded with the model and moved with it.
        ...(stepModelIds.has(stepIndex) && { model: stepModelIds.get(stepIndex), modelSource: planPinSourceAtLaunch }),
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
      // ENG-2378: what a step WITHOUT a model falls back to: the plan default, then the model the session had before.
      ...(stepModelIds.size > 0 && {
        ...(planPinnedModel && { planDefaultModel: planPinnedModel, planDefaultModelSource: planPinSourceAtLaunch }),
        ...(session.llmModel && { launchModel: session.llmModel, launchModelSource: storedModelSource(session) }),
      }),
      // ENG-1472: which predefined template this session's plan was launched
      // from, so a completed run can traceably chain into its author-approved
      // "next plan" suggestions and so the accept endpoint can idempotently
      // detect "this recommendation was already applied".
      templatePlanId: predefinedPlan.planId,
      // ENG-669: recorded now, so a later edit or deletion of the template cannot change whose pins these are.
      planAuthor: planPinSourceAtLaunch,
    };
    // Validate the plan structure BEFORE the model write: updateSessionWorkPlan rejects a
    // non-sequential stepCount, and by then the model would already have been changed.
    // A malformed plan must fail with no state change at all.
    assertSequentialStepCounts(workPlan.steps);

    // Apply the plan's pinned model FIRST (already validated above): it is the one write
    // that may not fail silently. If it fails nothing else has been written, so the plan
    // is not started rather than running on the session's previous model. Capture what the
    // write replaces (updateSessionLlmModel also clears llmUsagePolicyDecision) so a LATER
    // failure can put the session back exactly as it was.
    const previousModel = session.llmModel;
    const previousPolicyDecision = session.llmUsagePolicyDecision;
    const previousModelSource = session.llmModelSource;
    if (planPinnedModel) {
      try {
        // ENG-669: an admin-authored plan's pin is AgentWeb's choice; a user plan's pin is a user's.
        await chatbotDb.updateSessionLlmModel(sessionId, planPinnedModel, undefined, planPinSourceAtLaunch);
      } catch (modelErr) {
        console.error('[applyPredefinedWorkPlan] Failed to save plan model; launch refused:', (modelErr as Error).message);
        return {
          success: false,
          errorType: 'model_save_failed',
          code: 'model_save_failed',
          retryable: true,
          message: `${MODEL_SAVE_FAILED_MESSAGE} Do not retry automatically; tell the user it failed to start.`,
        };
      }
    }
    try {
      await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);
    } catch (planWriteErr) {
      // The plan did not start, so the session must not keep the plan's model (with force=true
      // the OLD plan would otherwise keep running on the NEW model). Restore, then fail.
      if (planPinnedModel) {
        try {
          // Conditional on the model THIS launch wrote: if a user changed it since, keep theirs.
          const restored = await chatbotDb.restoreSessionLlmModelIfUnchanged(sessionId, planPinnedModel, {
            llmModel: previousModel,
            llmUsagePolicyDecision: previousPolicyDecision,
            llmModelSource: previousModelSource,
          });
          if (!restored) {
            console.info(`[applyPredefinedWorkPlan] plan write failed for session ${sessionId}; model no longer "${planPinnedModel}" (changed since the launch's write), so the previous model was NOT restored over it.`);
          }
        } catch (restoreErr) {
          console.error(
            `[applyPredefinedWorkPlan] CRITICAL: plan write failed for session ${sessionId} AND restoring the previous model "${previousModel}" failed; the session is left on "${planPinnedModel}":`,
            restoreErr,
          );
        }
      }
      throw planWriteErr;
    }

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
    logMissingWorkPlanForDiagnosis('setWorkPlanStatus', sessionId, session);
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
      // Status-only retries are not evidence updates. Explicit notes (including
      // an empty string after recovery) still replace the previous evidence.
      workPlan.steps[stepIndex] = { ...workPlan.steps[stepIndex], notes: update.notes === undefined ? step.notes : update.notes };
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

      // If validation passed and marking as completed, decrement the function counts.
      // ENG-2206: skip tools whose credit is a session-wide fact, not a per-step
      // artifact — see workPlanRequiredCallsPolicy.ts's doc comment.
      for (const fn of step.requiredFunctionCalls) {
        if (isNonConsumableRequiredFunctionCall(fn)) continue;
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
        // ENG-2206: same carve-out as the completed branch above.
        if (isNonConsumableRequiredFunctionCall(fn)) continue;
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

    // --- skipReview mode: auto-send to lead, CC reviewer ---
    if (metadata.skipReview && metadata.leadEmail && isValidRecipientEmail(metadata.leadEmail)) {
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

      // ENG-2650: same escaped template as POST /review/:sessionId/send.
      const leadEmailHtml = buildResultDeliveryEmailHtml({ resultLabel, replyTo: replyToAddr, assetUrl });

      const leadSubject = (metadata.contentSubject || `Your ${resultLabel} is ready`).replace(/[\r\n]+/g, ' ');
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
    // ENG-2650: the link carries the per-session reviewer capability token;
    // the /review API routes reject the bare session id.
    const reviewUrl = buildReviewUrl(customerFrontendUrl, sessionId);
    const { emailService: emailSvc } = await import('../../services/emailService');
    let contentSection = '';
    if (contentUrl) {
      contentSection = `<p><a href="${escapeHtml(String(contentUrl))}" style="color: #1976d2;">View Generated Content</a></p>`;
    }
    if (contentHtml) {
      contentSection += `<div style="margin: 16px 0; padding: 16px; border: 1px solid #e0e0e0; border-radius: 8px; background: #fafafa;">${contentHtml}</div>`;
    }

    // ENG-2650: trigger args are public input and subject/content_url come from
    // the model, so every value below is escaped. contentHtml is the generated
    // content under review and is shown as-is.
    const argsEntries = Object.entries(metadata.args || {});
    const paramsSummary = argsEntries.length > 0
      ? `<table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
          <tr style="background: #f5f5f5;"><th style="text-align: left; padding: 8px; border: 1px solid #e0e0e0;">Parameter</th><th style="text-align: left; padding: 8px; border: 1px solid #e0e0e0;">Value</th></tr>
          ${argsEntries.map(([k, v]) => `<tr><td style="padding: 8px; border: 1px solid #e0e0e0;">${escapeHtml(k)}</td><td style="padding: 8px; border: 1px solid #e0e0e0;">${escapeHtml(String(v))}</td></tr>`).join('')}
        </table>`
      : '';

    const reviewHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
        <div style="background: #1976d2; color: white; padding: 12px 20px; border-radius: 8px 8px 0 0; font-weight: bold;">
          Review: ${escapeHtml(String(subject))}
        </div>
        <div style="padding: 20px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="color: #666;">A new result has been generated for "<strong>${escapeHtml(String(metadata.resultTitle || metadata.resultName))}</strong>". Please review the content below.</p>
          ${contentSection}
          ${paramsSummary ? `<h3 style="margin-top: 20px; color: #333;">Parameters</h3>${paramsSummary}` : ''}
          ${metadata.leadEmail ? `<p><strong>Lead email:</strong> ${escapeHtml(String(metadata.leadEmail))}</p>` : ''}
          <div style="margin-top: 24px; text-align: center;">
            <a href="${escapeHtml(reviewUrl)}" style="display: inline-block; background: #1976d2; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 16px;">Review & Send Result</a>
          </div>
        </div>
      </div>`;

    await emailSvc.sendEmail(reviewerEmail, `Review: ${String(subject).replace(/[\r\n]+/g, ' ')}`, `Review result for ${metadata.resultTitle || metadata.resultName}`, reviewHtml);
    return { success: true, message: `Review email sent to ${reviewerEmail}`, to: reviewerEmail };

  } catch (error) {
    console.error('AgentMode: Error sending for review:', error);
    return { success: false, message: 'Failed to send for review', error: error instanceof Error ? error.message : 'Unknown error' } as any;
  }
}

// ENG-1875: LLM-judge check for whether the user's most recent REAL message
// explicitly authorized removing the scope named in `candidates`, so a
// `modify_work_plan removeStepCounts` call that would otherwise create new
// ENG-1811 debt doesn't ledger it when the user genuinely asked for the cut.
// Sibling to ENG-1819's userExplicitlyRequestedStop (agentModeController.ts)
// -- same model/timeout/parse shape, reusing that ticket's live-tested
// finding that gemini-3.1-flash-lite needs headroom for an internal
// reasoning trace before it emits "yes"/"no". Deliberately a separate
// function rather than a shared refactor: the two fail in different
// directions on purpose (see below), and this codebase already accepts
// duplicating debt-check logic outright (workPlanCompletedWithoutDebt's own
// comment, ~line 3735 in agentModeController.ts) rather than risk a shared
// path used by ~150 mocking test files.
//
// Fails SAFE toward "not authorized": any error/timeout/no-message returns
// `false`, so the debt is ledgered exactly as before this fix existed. This
// is the opposite bias from ENG-1819 (which fails toward NOT suppressing a
// continuation) because the risk here is asymmetric the other way -- a
// false "yes" would silently reopen the exact ENG-1811 gaming hole this
// ledger exists to close, while a false "no" only costs one harmless extra
// attempt at already-removed scope.
//
// Known, accepted limitation (fresh-eyes review, PR #2959): the judge only
// sees the user's raw message text, not the assistant's preceding turn. A
// common real flow -- assistant proposes "I'll skip step 2 since X, sound
// good?" and the user replies with a bare "yes"/"go ahead" -- won't mention
// the scope by name and will likely be judged "no", ledgering debt even
// though the removal was genuinely authorized. This under-covers the fix's
// own motivating scenario, but fails in the SAFE direction (extra debt, not
// a reopened gaming hole) -- not fixed here because doing so needs the
// assistant's own preceding message as judge context too, a real scope
// increase for a Low-priority, narrowly-scoped ticket, not a copy of an
// existing pattern the way the rest of this fix is.
const STEP_REMOVAL_JUDGE_MODEL = 'gemini-3.1-flash-lite';
const STEP_REMOVAL_JUDGE_TIMEOUT_MS = 8000;

/** Matches the one call shape `wasStepRemovalUserAuthorized` actually sends. */
export type ModifyWorkPlanLlmCall = (
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  options: {
    temperature: number;
    max_completion_tokens: number;
    taskClass: GatewayTaskClass;
    usageContext: LLMUsageContext;
  },
) => Promise<{
  choices: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
}>;

/**
 * `private` on `AgentModeService` (no class wrapper — confirmed by
 * whole-backend grep to have exactly one caller, `modifyWorkPlan`, below).
 * Exported from this module only because `eng1858.usageAttribution.test.ts`
 * has a dedicated F1-era billing regression test that calls it directly —
 * see this module's header comment.
 */
export async function wasStepRemovalUserAuthorized(
  sessionId: string,
  candidates: Array<{ fn: string; stepTitle: string }>,
  callLLM: ModifyWorkPlanLlmCall,
): Promise<boolean> {
  try {
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    const recent = await chatbotDb.getMostRecentRealUserMessage(sessionId);
    if (!recent?.content) return false;
    const scopeList = candidates
      .map((c) => `- step "${c.stepTitle}" (still needs to call: ${c.fn})`)
      .join('\n');
    const system = `You classify one message from a user talking to an AI assistant that is running a multi-step work plan on their behalf.

The assistant is about to remove one or more steps from the plan before completing required actions those steps call for. Decide whether the user's message EXPLICITLY instructs removing, skipping, or dropping this specific scope -- as opposed to a general instruction, unrelated request, or the assistant's own unprompted decision.

The steps being removed:
${scopeList}

Answer "yes" only if the user's message clearly and explicitly authorizes skipping this scope (even if phrased casually -- "skip step 2", "don't bother with the export", "we don't need that anymore").

Answer "no" for everything else, including messages that don't mention this scope at all, or only vaguely relate to it.

Reply with ONLY one word: yes or no.`;
    const llmPromise = callLLM(
      STEP_REMOVAL_JUDGE_MODEL,
      [
        { role: 'system', content: system },
        { role: 'user', content: recent.content.slice(0, 2500) },
      ],
      {
        temperature: 0,
        max_completion_tokens: 500,
        taskClass: 'scheduled_background',
        // ENG-1816 F1: this judge previously carried no userId, so its spend booked
        // to "system" and escaped both billing and the funding policy. Read the
        // run's owner from the ambient store instead of threading a new parameter
        // through this method's signature. billingUserId deliberately omitted: this
        // reaches meterWithResolvedBilling, which only resolves the org-root billing
        // subject when billingUserId is absent (ENG-1858) — passing ownerUserId here
        // would re-suppress that resolution for org members, the exact ENG-1217 bug.
        usageContext: {
          feature: 'step_removal_authorization_judge',
          userId: currentRunFunding()?.ownerUserId,
        },
      },
    );
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('step-removal judge timed out')), STEP_REMOVAL_JUDGE_TIMEOUT_MS)
    );
    const res: any = await Promise.race([llmPromise, timeoutPromise]);
    if (res?.choices?.[0]?.finish_reason === 'length') {
      console.warn(
        `AgentMode: work-plan step-removal authorization judge for session ${sessionId} was ` +
        `truncated (finish_reason: length) before producing an answer -- treating as "no", but ` +
        `this may be silently missing a real authorization.`
      );
    }
    const raw = (res?.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
    return raw.startsWith('yes');
  } catch (err) {
    console.error(`AgentMode: work-plan step-removal authorization judge failed for session ${sessionId}:`, err);
    return false; // fail-safe: never skip debt on judge failure
  }
}

export async function modifyWorkPlan(
  steps: Array<{ stepCount: number; title: string; description?: string; userInstructions?: string; requiredFunctionCalls?: string[]; skillIds?: string[]; expectedAssetCount?: number; expectedAssetCountTools?: string[] }>,
  removeStepCounts: number[],
  sessionId: string,
  autocomplete: boolean | undefined,
  isUnattendedRun: boolean | undefined,
  callLLM: ModifyWorkPlanLlmCall,
): Promise<any> {
  try {
    const { chatbotDb } = require('../../services/chatbotService') as typeof import('../../services/chatbotService');
    // ENG-1793: consistentRead=true so this read of session.workPlan /
    // calledFunctions / failedFunctions / calledFunctionsVersion -- the fields
    // the requiredFunctionCalls protection below (see the update-loop comment)
    // depends on -- is strongly consistent, not the default eventually-consistent
    // read. Those fields live on the AW-ChatSessions record itself, so this needs
    // getChatSession -> getChatSessionRecord's own dynamodb.get to pass
    // ConsistentRead: true (see chatbotService.ts); it is NOT satisfied by
    // getMessagesFromMessagesTable's consistent read, which covers a different
    // table (AW-ChatMessages) that this call site does not depend on. Without a
    // strongly consistent read of the session record, a required call's failure
    // recorded earlier in this very turn, immediately before this modify_work_plan
    // call, could be missed.
    const session = await chatbotDb.getChatSession(sessionId, true);
    if (!session || !session.workPlan) {
      logMissingWorkPlanForDiagnosis('modifyWorkPlan', sessionId, session);
      return {
        success: false,
        message: 'No work plan found in this session. Create one first using create_work_plan.'
      };
    }

    // ENG-2400: deep-copy the steps (and the pending ledger) so a failed or
    // rejected modify never mutates the session object that was read; the
    // stored plan only changes through the single write at the end.
    const workPlan = {
      ...session.workPlan,
      steps: session.workPlan.steps.map((s: any) => ({ ...s })),
      ...(session.workPlan.pendingRequiredFunctionCalls && {
        pendingRequiredFunctionCalls: [...session.workPlan.pendingRequiredFunctionCalls],
      }),
    };

    // Snapshot of every step as it existed before this call's removeStepCounts
    // filtering runs below, keyed by stepCount. Still used further down for
    // expectedAssetCount/expectedAssetCountTools: when a step reusing a
    // just-removed stepCount reaches the "add new step" branch in THIS SAME
    // call, reattach the pre-removal asset-count requirement instead of
    // treating it as having no history. (requiredFunctionCalls no longer
    // uses this snapshot -- see pendingRequiredFunctionCalls below, which
    // closes the same gap completely instead of only within one call.)
    const originalStepsBeforeRemoval = new Map<number, (typeof workPlan.steps)[number]>(
      workPlan.steps.map((s: any) => [s.stepCount, s]),
    );

    // ENG-1811: before removing anything, carry forward any genuinely
    // unresolved requiredFunctionCalls from the steps about to be removed
    // into a session-lifetime, stepCount-agnostic debt ledger
    // (workPlan.pendingRequiredFunctionCalls). This is deliberately NOT
    // scoped to "does a later step reuse this same stepCount" -- that
    // per-call/per-stepCount approach (the first attempt at this fix) was
    // itself defeated live, unprompted, on test-env1: the model removed
    // steps 2 and 3 via removeStepCounts in one modify_work_plan call, then
    // re-added them with omitted requiredFunctionCalls in a SEPARATE, LATER
    // call that didn't mention removeStepCounts at all -- that later call's
    // own invocation has no memory of the earlier removal, so a per-call
    // snapshot can never see across it. A plain session-level ledger does,
    // because workPlan (and this field on it) is the one thing every
    // invocation reads fresh and writes back. See setWorkPlanStatusAttempt
    // for where this is enforced: it blocks a batch from resolving the LAST
    // remaining pending step(s) (finishing the plan) while any entry here
    // still hasn't succeeded, regardless of which step (if any) still lists
    // it as required.
    const priorPendingRequiredFunctionCalls = workPlan.pendingRequiredFunctionCalls || [];
    if (removeStepCounts && removeStepCounts.length > 0) {
      const succeededFunctionCountsAtRemoval = session.calledFunctions || {};
      const priorSet = new Set(priorPendingRequiredFunctionCalls);
      const newlyUnresolved = new Set(priorPendingRequiredFunctionCalls);
      // ENG-1875: only functions NEWLY going into debt by this call are
      // candidates for the authorization judge below -- debt already
      // standing from an earlier, unauthorized removal is never re-judged
      // or revoked here, only ever added to.
      //
      // Judged PER REMOVED STEP, not once for the whole call: a single
      // removeStepCounts batch can mix a step the user genuinely authorized
      // with one the model is removing for its own unrelated reason (or to
      // dodge a required call). A single call-wide yes/no would let one
      // authorized step's "yes" spare an unrelated, unauthorized step in
      // the same batch -- reopening ENG-1811's gaming hole through a
      // batching side door (found by fresh-eyes review of the original
      // single-verdict version). Each step's own requiredFunctionCalls are
      // still judged together as one unit -- they're removed as one
      // decision, not gameable by splitting further.
      const candidateNewDebtByStep = new Map<number, { stepTitle: string; fns: string[] }>();
      for (const step of workPlan.steps) {
        if (!removeStepCounts.includes(step.stepCount)) continue;
        for (const fn of step.requiredFunctionCalls || []) {
          if ((succeededFunctionCountsAtRemoval[fn] || 0) === 0) {
            if (!priorSet.has(fn)) {
              if (!candidateNewDebtByStep.has(step.stepCount)) {
                candidateNewDebtByStep.set(step.stepCount, { stepTitle: step.title, fns: [] });
              }
              candidateNewDebtByStep.get(step.stepCount)!.fns.push(fn);
            } else {
              newlyUnresolved.add(fn);
            }
          }
        }
      }
      await Promise.all(
        Array.from(candidateNewDebtByStep.values()).map(async ({ stepTitle, fns }) => {
          const authorized = await wasStepRemovalUserAuthorized(
            sessionId,
            fns.map((fn) => ({ fn, stepTitle })),
            callLLM,
          );
          for (const fn of fns) {
            if (authorized) {
              console.log(`ENG-1875: skipping debt for ${fn} in session ${sessionId} -- judged user-authorized removal`);
            } else {
              newlyUnresolved.add(fn);
            }
          }
        }),
      );
      workPlan.pendingRequiredFunctionCalls = Array.from(newlyUnresolved);
    }

    // Update autocomplete if explicitly provided. ENG-2058: a genuinely unattended
    // scheduled run always stays hands-off — there is no user to approve an
    // interactive step — so this overrides any explicit `false` (or a plan created
    // before this fix) rather than only applying when the caller passed a value.
    // ENG-2072: gated on shouldForceScheduledAutocomplete, not sessionType alone —
    // see its doc comment.
    if (shouldForceScheduledAutocomplete(session, isUnattendedRun)) {
      workPlan.autocomplete = true;
    } else if (autocomplete !== undefined) {
      workPlan.autocomplete = autocomplete;
    }

    // Remove steps if specified
    if (removeStepCounts && removeStepCounts.length > 0) {
      workPlan.steps = workPlan.steps.filter(s => !removeStepCounts.includes(s.stepCount));
    }

    // ENG-1793: a production predefined-plan session (a90b38fc-...) called
    // modify_work_plan mid-run for its "Create HTML report" step right after
    // that step's required create_html_from_template call had just FAILED.
    // The template authored requiredFunctionCalls: ["create_html_from_template"]
    // for that step, but the modify_work_plan update happened to pass
    // requiredFunctionCalls: [] for it -- a defined, non-undefined value, so
    // the old merge below ("use newStep's value if provided, else keep the
    // old one") silently replaced the real requirement with an empty one.
    // set_work_plan_status's completion gate (setWorkPlanStatusAttempt) then
    // had nothing left to check for that step and let it complete despite the
    // failed required call never succeeding.
    //
    // ENG-1799 (follow-up): the original fix here only protected a function
    // that had already FAILED at least once (failed>0 && succeeded===0). A
    // production predefined-plan session (3fce3c5a-...) showed the same class
    // of gap for functions that were simply never called at all -- never
    // attempted, so never in failedFunctions either, but still genuinely
    // required and unsatisfied. That shape passed the old check trivially
    // (failed===0 fails the `failed > 0` test), so modify_work_plan could
    // silently drop a still-unmet requirement the model had not gotten
    // around to calling yet, the same gate-bypass shape, just without a
    // prior failed attempt on record.
    //
    // Fix: requiredFunctionCalls can still be freely modified -- added to,
    // reordered, or have functions removed -- EXCEPT it may never silently
    // drop a function that has not yet SUCCEEDED for this session, whether
    // it previously failed or was never attempted at all. A function that
    // was never required to begin with, or that has already succeeded at
    // least once, is unaffected and can still be dropped normally (e.g. a
    // genuine, deliberate scope reduction).
    //
    // NOT exempt once a step has resolved (completed/skipped): a resolved
    // step can be reset back to 'pending' later (e.g. "assets need
    // regenerating" -- see the ENG-1188/CodeRabbit PR #2430 cutoff-timestamp
    // handling above, which explicitly treats that reset as a supported
    // transition) without restoring requiredFunctionCalls to anything. An
    // earlier version of this fix exempted resolved steps on the theory
    // that "the gate that mattered already ran" -- but that only holds
    // until the very next reset-to-pending, at which point a
    // never-actually-called requirement cleared while 'completed' stays
    // silently cleared through the reset and the step re-completes with no
    // gate at all. Note this protection is NOT a pure no-op for every
    // resolved step: `session.calledFunctions[fn]` decrements back toward 0
    // once the step consuming its credit completes (ENG-1698's
    // decrementCalledFunctionsClamped), so a function called exactly once
    // for its own step looks like `succeeded === 0` again immediately after
    // that step's own legitimate completion -- indistinguishable from
    // "never called." That's intentional, not a bug: it forces a genuine
    // scope-reduction edit on an already-resolved step to re-prove the
    // requirement rather than trust stale state, matching the
    // "fail closed" posture the rest of this fix takes, and is itself
    // covered by a dedicated test below rather than assumed harmless.
    const succeededFunctionCounts = session.calledFunctions || {};
    const mergeRequiredFunctionCalls = (
      existingRequired: string[] | undefined,
      requested: string[] | undefined,
    ): string[] | undefined => {
      if (requested === undefined) return existingRequired;
      const unresolvedRequirements = (existingRequired || []).filter((fn) => {
        if (requested.includes(fn)) return false;
        const succeeded = succeededFunctionCounts[fn] || 0;
        return succeeded === 0;
      });
      return unresolvedRequirements.length > 0 ? [...requested, ...unresolvedRequirements] : requested;
    };

    // ENG-1800: sibling protection for the asset-count completion gate
    // (expectedAssetCount/expectedAssetCountTools) -- see the merge call
    // below for the full incident writeup and the applied fix.
    const findAssetCountCutoff = (
      allSteps: Array<{ stepCount: number; status?: string; resolvedAt?: string; completedAt?: string }>,
      stepCount: number,
    ): string | undefined => {
      const earlier = allSteps
        .filter((s) => s.stepCount < stepCount)
        .sort((a, b) => b.stepCount - a.stepCount);
      for (const s of earlier) {
        if (s.status === 'completed' || s.status === 'skipped') {
          const resolvedAt = s.resolvedAt || s.completedAt;
          if (resolvedAt) return resolvedAt;
        }
      }
      return undefined;
    };
    const computeStepProducedAssetCount = (
      tools: string[] | undefined,
      sinceIso: string | undefined,
    ): number => tools?.length
      ? extractProducedAssetCount(session.messages, sinceIso, tools)
      : Math.max(
          extractGeneratedImageFilenames(session.messages, sinceIso).length,
          extractProducedAssetCount(session.messages, sinceIso),
        );

    // ENG-1800: a production predefined-plan session (ca06a9e0-...) hit the
    // asset-count gate's workplan_insufficient_assets block for "Render the
    // Full Size Matrix" (expectedAssetCount 12, expectedAssetCountTools
    // ["playwright_browser_take_screenshot"], only 1 real screenshot
    // produced). Instead of producing the remaining assets, the model called
    // modify_work_plan TWICE in the same run to shrink expectedAssetCount
    // first to 1, then to 0 for that step (and later 0 for two more steps) --
    // silently clearing the exact gate it was failing. Nothing distinguished
    // that self-serving edit from a genuine user-approved scope reduction
    // (the blocked response's own guidance tells the model to do exactly
    // this once the USER approves a smaller set), so the steps completed
    // with 1 of the promised 12 assets and the closing synthesis then
    // falsely claimed "✅ Deliverables Generated & Verified" across "all 12
    // units".
    //
    // Fix: expectedAssetCount can still be freely changed (raised, lowered,
    // or cleared) EXCEPT it may never be silently LOWERED while the step's
    // own actual produced-asset count has not yet met the EXISTING (pre-edit)
    // requirement -- the exact "shrink the goalpost to dodge a failing gate"
    // bypass this incident hit. The moment the step has genuinely produced
    // enough assets to meet its current target, the requirement is
    // unaffected and can be freely lowered or cleared afterward (the same
    // "failed and later succeeded" carve-out ENG-1793/ENG-1799 established
    // for requiredFunctionCalls above).
    //
    // NOT exempt once a step has resolved (completed/skipped) -- same
    // reasoning as mergeRequiredFunctionCalls above: a resolved step can be
    // reset back to 'pending' without restoring expectedAssetCount, and for
    // a step that resolved normally `produced` was already >= `existing`
    // when it completed, so this protection is a no-op in the normal case
    // and only bites the reset-then-shrink-then-recomplete abuse path.
    //
    // Fresh-eyes review of this PR also found `expectedAssetCountTools`
    // itself had ZERO protection: leaving expectedAssetCount unchanged
    // (e.g. still 12) while silently retargeting expectedAssetCountTools to
    // an unrelated tool the model already called 12+ times for other
    // reasons achieves the identical "dodge a failing gate" outcome through
    // a field this check never looked at. mergeExpectedAssetCountTools
    // below applies the same guard: don't allow the counted-tools list to
    // change while the CURRENT requirement (measured against the EXISTING
    // tools) hasn't genuinely been met.
    const mergeExpectedAssetCount = (
      existingStep: { stepCount: number; status?: string; expectedAssetCount?: number; expectedAssetCountTools?: string[] },
      requested: number | undefined,
    ): number | undefined => {
      if (requested === undefined) return existingStep.expectedAssetCount;
      const existing = existingStep.expectedAssetCount;
      if (typeof existing !== 'number' || existing <= 0 || requested >= existing) return requested;
      const sinceIso = findAssetCountCutoff(workPlan.steps, existingStep.stepCount);
      const produced = computeStepProducedAssetCount(existingStep.expectedAssetCountTools, sinceIso);
      return produced < existing ? existing : requested;
    };
    const mergeExpectedAssetCountTools = (
      existingStep: { stepCount: number; status?: string; expectedAssetCount?: number; expectedAssetCountTools?: string[] },
      requested: string[] | undefined,
    ): string[] | undefined => {
      if (requested === undefined) return existingStep.expectedAssetCountTools;
      const existing = existingStep.expectedAssetCount;
      if (typeof existing !== 'number' || existing <= 0) return requested;
      const sinceIso = findAssetCountCutoff(workPlan.steps, existingStep.stepCount);
      const produced = computeStepProducedAssetCount(existingStep.expectedAssetCountTools, sinceIso);
      return produced < existing ? existingStep.expectedAssetCountTools : requested;
    };

    // Update or add steps
    for (const newStep of steps) {
      const existingIndex = workPlan.steps.findIndex(s => s.stepCount === newStep.stepCount);
      if (existingIndex >= 0) {
        // Update existing step (preserve status and completion info)
        // ENG-2378: the step's model follows the STEP (by title), not the stepCount slot it happened to occupy:
        // after an insert/reorder the slot holds a different step. A new/retitled step starts with no model.
        // ENG-669: and the model's provenance (modelSource) moves WITH it, never stays with the slot.
        const { model: _slotModel, modelSource: _slotModelSource, ...slotWithoutModel } = workPlan.steps[existingIndex] as any;
        const boundModel = modelBoundToStep([...originalStepsBeforeRemoval.values()], newStep.stepCount, newStep.title);
        workPlan.steps[existingIndex] = {
          ...slotWithoutModel,
          ...boundModel,
          title: newStep.title,
          // ENG-2400: omitting description preserves the stored one (same
          // contract as userInstructions/skillIds); it used to be wiped.
          ...(newStep.description !== undefined && { description: newStep.description }),
          ...(newStep.userInstructions !== undefined && { userInstructions: newStep.userInstructions }),
          requiredFunctionCalls: mergeRequiredFunctionCalls(
            workPlan.steps[existingIndex].requiredFunctionCalls,
            newStep.requiredFunctionCalls,
          ),
          skillIds: newStep.skillIds !== undefined ? newStep.skillIds : workPlan.steps[existingIndex].skillIds,
          // Allow scope changes: an explicit expectedAssetCount/expectedAssetCountTools
          // overrides (including 0/[] to clear the asset gate when the user approves a
          // smaller set) UNLESS the step hasn't actually produced enough assets to meet
          // its current requirement yet -- see mergeExpectedAssetCount/
          // mergeExpectedAssetCountTools (ENG-1800) above. Omitting either preserves the
          // existing value.
          expectedAssetCount: mergeExpectedAssetCount(workPlan.steps[existingIndex], newStep.expectedAssetCount),
          expectedAssetCountTools: mergeExpectedAssetCountTools(workPlan.steps[existingIndex], newStep.expectedAssetCountTools)
        };
      } else {
        // Add new step (stepCount will be fixed by updateSessionWorkPlan).
        //
        // requiredFunctionCalls is taken as given here, unprotected -- ENG-1811's
        // pendingRequiredFunctionCalls ledger (populated above whenever a step is
        // removed) is what actually guarantees a genuinely unresolved requirement
        // can't be walked away from, enforced at completion time in
        // setWorkPlanStatusAttempt regardless of which step (if any) still lists
        // it. That covers this stepCount being reused in this same call, a later
        // separate call, or never being reused at all -- strictly more than a
        // per-call reattachment here could.
        //
        // expectedAssetCount/expectedAssetCountTools have no equivalent
        // session-level ledger yet (the "produced count" calculation is inherently
        // step-relative, not easily genericized the way a function name is) -- if
        // this stepCount was just removed via removeStepCounts in THIS SAME call,
        // still reattach its pre-removal asset-count requirement as a best-effort
        // guard using the pre-removal step as the baseline. A genuinely new
        // stepCount, or one whose removal happened in an earlier, separate call,
        // has no such reattachment (a known, narrower residual gap -- see ENG-1808).
        const removedOriginal = removeStepCounts?.includes(newStep.stepCount)
          ? originalStepsBeforeRemoval.get(newStep.stepCount)
          : undefined;
        const addedModel = modelBoundToStep([...originalStepsBeforeRemoval.values()], newStep.stepCount, newStep.title);
        workPlan.steps.push({
          stepCount: newStep.stepCount,
          title: newStep.title,
          ...addedModel,
          description: newStep.description,
          ...(newStep.userInstructions !== undefined && { userInstructions: newStep.userInstructions }),
          status: 'pending',
          completedAt: undefined,
          notes: undefined,
          requiredFunctionCalls: newStep.requiredFunctionCalls,
          skillIds: newStep.skillIds,
          ...(removedOriginal
            ? { expectedAssetCount: mergeExpectedAssetCount(removedOriginal, newStep.expectedAssetCount) }
            : (newStep.expectedAssetCount !== undefined && { expectedAssetCount: newStep.expectedAssetCount })),
          ...(removedOriginal
            ? { expectedAssetCountTools: mergeExpectedAssetCountTools(removedOriginal, newStep.expectedAssetCountTools) }
            : (newStep.expectedAssetCountTools !== undefined && { expectedAssetCountTools: newStep.expectedAssetCountTools }))
        });
      }
    }

    // Sort steps by stepCount before saving
    workPlan.steps.sort((a, b) => a.stepCount - b.stepCount);
    workPlan.updatedAt = new Date().toISOString();

    // Update the session (will throw error if stepCount is not sequential)
    await chatbotDb.updateSessionWorkPlan(sessionId, workPlan);

    return {
      success: true,
      message: `Work plan modified successfully`,
      workPlan,
      formattedContent: `Modified work plan. Current steps:\n${workPlan.steps.map((s, i) => `${i + 1}. ${s.title} (${s.status})`).join('\n')}`
    };
  } catch (error) {
    console.error('AgentMode: Error modifying work plan:', error);
    // ENG-2400: the store rejects a non-sequential result before writing
    // (assertSequentialStepCounts). Surface that as an actionable, retryable
    // message instead of the opaque generic failure.
    if (error instanceof Error && /Invalid stepCount/.test(error.message)) {
      return {
        success: false,
        message:
          'Work plan not modified: stepCounts must be sequential from 1. When removing steps, renumber the ' +
          'remaining steps in the same call (send them in steps with their new stepCount). The stored plan is unchanged.',
        error: error.message,
      };
    }
    return {
      success: false,
      message: 'Failed to modify work plan',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
