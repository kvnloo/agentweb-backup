/**
 * FAIL-LOUD selected model: an explicit model selection (a model the REQUEST
 * carries: `/generate` `llmModel`, `requestedLlmModel` at session creation; or a
 * schedule pin) must run on exactly that model or not run at all. A model merely
 * STORED on a session is not explicit and falls back to the default, EXCEPT when it is
 * outside the owner's plan (ENG-669 `not_in_plan`): that is refused, never swapped.
 * `resolveEffectiveModelForUser` throws this instead of silently substituting the
 * default; interactive handlers translate it into the 422 body built here. This
 * file is the ONLY producer of the user-facing message text.
 */

import { AGENTWEB_MODEL_DISPLAY_NAME, AGENTWEB_MODEL_ID } from './agentWebModelIds';

/**
 * `not_in_plan` (ENG-669): the model is served and selectable, but the owner's subscription tier does
 * not include it (services/agentMode/modelAccess.ts). It is never swapped for another model either.
 */
export type ModelUnavailableReason = 'not_served' | 'not_selectable' | 'not_in_plan';

/** ENG-669: what the owner's plan allows, carried by a `not_in_plan` refusal so the 422 can say how to fix it. */
export interface ModelPlanDetails {
  /** The canonical id that was refused (after legacy-alias resolution). */
  model: string;
  /** The owner's effective tier name (null when it could not be named). */
  tier: string | null;
  /** The tier's allowlist, canonical ids. */
  allowedModels: string[];
  /** Tier names whose allowlist includes `model` (empty when none does). */
  upgradeRequired: string[];
}

/** Human wording of a reason, for logs, run results and alerts. */
export function describeModelUnavailableReason(reason: ModelUnavailableReason): string {
  if (reason === 'not_served') return 'not served';
  if (reason === 'not_in_plan') return "not included in the account's plan";
  return 'not selectable';
}

export class ModelUnavailableError extends Error {
  readonly code = 'model_unavailable' as const;
  readonly requestedModel: string;
  readonly reason: ModelUnavailableReason;
  /** Set only for `not_in_plan`. */
  readonly plan?: ModelPlanDetails;

  constructor(requestedModel: string, reason: ModelUnavailableReason, plan?: ModelPlanDetails) {
    super(`model_unavailable: requested model is ${describeModelUnavailableReason(reason)}`);
    this.name = 'ModelUnavailableError';
    this.requestedModel = requestedModel;
    this.reason = reason;
    if (plan) this.plan = plan;
  }
}

export function isModelUnavailableError(error: unknown): error is ModelUnavailableError {
  return error instanceof ModelUnavailableError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'model_unavailable'
      && typeof (error as { requestedModel?: unknown }).requestedModel === 'string');
}

const MAX_MODEL_LABEL_CHARS = 120;

/**
 * The id is user-controlled and echoed back (JSON-encoded, never HTML), so
 * bound its length and charset: strip C0/C1 control characters and line/
 * paragraph separators, collapse nothing else, truncate to 120 chars.
 */
export function sanitizeModelLabel(raw: string): string {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .trim();
  if (!cleaned) return 'unknown model';
  // Truncate by code points: slicing UTF-16 units can split a surrogate pair.
  const points = Array.from(cleaned);
  return points.length > MAX_MODEL_LABEL_CHARS
    ? `${points.slice(0, MAX_MODEL_LABEL_CHARS - 1).join('')}…`
    : cleaned;
}

export interface ModelUnavailableBody {
  error: string;
  code: 'model_unavailable';
  requestedModel: string;
  reason: ModelUnavailableReason;
  /** ENG-669, `not_in_plan` only, and never for a share viewer: see ModelPlanDetails. */
  model?: string;
  tier?: string | null;
  allowedModels?: string[];
  upgradeRequired?: string[];
}

export type ModelUnavailableSubject = 'selection' | 'work_plan_pin';

/**
 * Who reads the body. `owner` is the account the session (or plan) belongs to; a `share_viewer`
 * (interactive-share / conversable link) is someone else and must not learn the owner's tier, its
 * allowlist or which tiers include the model, so those fields and the plan wording are left out.
 */
export type ModelUnavailableAudience = 'owner' | 'share_viewer';

/**
 * The single producer of the 422 body (and its message text). `subject` says whose
 * choice failed: a `selection` is something the caller picked in the request; a
 * `work_plan_pin` is the plan author's pinned model, which the launching user did not
 * choose and cannot change, so the copy must not say "you selected".
 */
export function buildModelUnavailableBody(
  err: ModelUnavailableError,
  displayName?: string | null,
  subject: ModelUnavailableSubject = 'selection',
  audience: ModelUnavailableAudience = 'owner',
): ModelUnavailableBody {
  const agentWebModel = err.requestedModel.trim() === AGENTWEB_MODEL_ID;
  // ENG-669 PR-C: the AgentWeb Model is not a registry model, so it has no registry display name; customers never see
  // the raw id.
  const label = sanitizeModelLabel(agentWebModel ? AGENTWEB_MODEL_DISPLAY_NAME : (displayName || err.requestedModel));
  const body: ModelUnavailableBody = {
    error: agentWebModel && subject === 'selection' && err.reason !== 'not_in_plan'
      ? agentWebModelUnavailableMessage(err.reason)
      : modelUnavailableMessage(err.reason, label, subject, audience),
    code: 'model_unavailable',
    requestedModel: sanitizeModelLabel(err.requestedModel),
    reason: err.reason,
  };
  if (err.reason === 'not_in_plan' && err.plan && audience === 'owner') {
    body.model = err.plan.model;
    body.tier = err.plan.tier;
    body.allowedModels = [...err.plan.allowedModels];
    body.upgradeRequired = [...err.plan.upgradeRequired];
  }
  return body;
}


/**
 * A refused selection of the AgentWeb Model: the router is off or unavailable (for everyone, this plan, or this task),
 * or the id was sent somewhere it can never run (Compare-like operations, an explicit model for a single LLM call).
 * Same sentence for owners and share viewers: it names no plan.
 */
function agentWebModelUnavailableMessage(reason: ModelUnavailableReason): string {
  return reason === 'not_selectable'
    ? `${AGENTWEB_MODEL_DISPLAY_NAME} can't be used here. Choose a specific model to continue.`
    : `${AGENTWEB_MODEL_DISPLAY_NAME} isn't available right now. Choose another model to continue.`;
}

function modelUnavailableMessage(
  reason: ModelUnavailableReason,
  label: string,
  subject: ModelUnavailableSubject,
  audience: ModelUnavailableAudience,
): string {
  if (reason === 'not_in_plan') {
    if (audience === 'share_viewer') {
      return `The model selected for this chat (${label}) isn't available on this account, so nothing was sent to a different model. Choose another model and try again.`;
    }
    return subject === 'work_plan_pin'
      ? `This work plan's pinned model (${label}) isn't included in your plan, so the plan was not started and nothing was sent to a different model. Change the plan's model in the work plan settings, or upgrade your plan.`
      : `The model you selected (${label}) isn't included in your plan, so nothing was sent to a different model. Choose another model, or upgrade your plan to use this one.`;
  }
  return subject === 'work_plan_pin'
    ? `This work plan's pinned model (${label}) isn't available right now, so the plan was not started and nothing was sent to a different model. The plan's model needs to be changed in the work plan settings.`
    : `The model you selected (${label}) isn't available right now, so nothing was sent to a different model. Choose another model and try again.`;
}

export interface AnonymousModelUnavailableBody {
  error: string;
  code: 'model_unavailable';
}

/**
 * Body for an UNAUTHENTICATED caller: names no model id, display name or reason (an
 * anonymous visitor must not learn which models exist, are admin-only or internal).
 * Same `code`, so clients' `isModelUnavailableBody` guards still match.
 */
export function buildAnonymousModelUnavailableBody(): AnonymousModelUnavailableBody {
  return {
    error: "This work plan can't start right now because its model is unavailable.",
    code: 'model_unavailable',
  };
}

/** Emma tool-result text for a plan whose pinned model is unavailable (the LLM cannot change it). */
export function buildPlanModelToolMessage(body: ModelUnavailableBody): string {
  return `${body.error} Do not retry; tell the user the plan's model needs to be changed in the work plan settings.`;
}

/**
 * Emma tool-result text for an ANONYMOUS/visitor session: the same wording as the anonymous
 * 422 body, so the visitor (who sees the model's reply) learns no model id, name or reason.
 */
export function buildAnonymousPlanModelToolMessage(): string {
  return `${buildAnonymousModelUnavailableBody().error} Do not retry; tell the user the plan can't be started right now.`;
}

/** A model write to the session failed (storage), distinct from the model being unavailable. */
export const MODEL_SAVE_FAILED_MESSAGE =
  "This work plan couldn't be started because its model could not be saved to the session. Nothing was started; please try again in a moment.";
