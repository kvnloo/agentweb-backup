/**
 * FAIL-LOUD selected model: an explicit model selection (a model the REQUEST
 * carries: `/generate` `llmModel`, `requestedLlmModel` at session creation; or a
 * schedule pin) must run on exactly that model or not run at all. A model merely
 * STORED on a session is not explicit and falls back to the default.
 * `resolveEffectiveModelForUser` throws this instead of silently substituting the
 * default; interactive handlers translate it into the 422 body built here. This
 * file is the ONLY producer of the user-facing message text.
 */

export type ModelUnavailableReason = 'not_served' | 'not_selectable';

export class ModelUnavailableError extends Error {
  readonly code = 'model_unavailable' as const;
  readonly requestedModel: string;
  readonly reason: ModelUnavailableReason;

  constructor(requestedModel: string, reason: ModelUnavailableReason) {
    super(`model_unavailable: requested model is ${reason === 'not_served' ? 'not served' : 'not selectable'}`);
    this.name = 'ModelUnavailableError';
    this.requestedModel = requestedModel;
    this.reason = reason;
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
}

export type ModelUnavailableSubject = 'selection' | 'work_plan_pin';

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
): ModelUnavailableBody {
  const label = sanitizeModelLabel(displayName || err.requestedModel);
  const error = subject === 'work_plan_pin'
    ? `This work plan's pinned model (${label}) isn't available right now, so the plan was not started and nothing was sent to a different model. The plan's model needs to be changed in the work plan settings.`
    : `The model you selected (${label}) isn't available right now, so nothing was sent to a different model. Choose another model and try again.`;
  return {
    error,
    code: 'model_unavailable',
    requestedModel: sanitizeModelLabel(err.requestedModel),
    reason: err.reason,
  };
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
