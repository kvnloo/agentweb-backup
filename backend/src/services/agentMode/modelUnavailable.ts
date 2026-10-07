/**
 * FAIL-LOUD selected model: an explicit model selection (request `llmModel`,
 * session-stored `llmModel`, `requestedLlmModel` at session creation) must run
 * on exactly that model or not run at all. `resolveEffectiveModelForUser`
 * throws this instead of silently substituting the default; interactive
 * handlers translate it into the 422 body built here. This file is the ONLY
 * producer of the user-facing message text.
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

/** The single producer of the 422 body (and its message text). */
export function buildModelUnavailableBody(err: ModelUnavailableError, displayName?: string | null): ModelUnavailableBody {
  const label = sanitizeModelLabel(displayName || err.requestedModel);
  return {
    error: `The model you selected (${label}) isn't available right now, so nothing was sent to a different model. Choose another model and try again.`,
    code: 'model_unavailable',
    requestedModel: sanitizeModelLabel(err.requestedModel),
    reason: err.reason,
  };
}
