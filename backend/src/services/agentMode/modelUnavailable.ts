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
  return cleaned.length > MAX_MODEL_LABEL_CHARS
    ? `${cleaned.slice(0, MAX_MODEL_LABEL_CHARS - 1)}…`
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

export interface SharedModelUnavailableBody {
  error: string;
  code: 'model_unavailable';
}

/**
 * Body for ANONYMOUS / share-link visitors. They selected nothing, and the
 * owner's stored model must not be disclosed to them, so there is no model id,
 * name or "you selected" wording here.
 */
// `reason` is deliberately omitted: it would tell an anonymous visitor that the owner's model is internal/admin-only.
export function buildSharedModelUnavailableBody(_err: ModelUnavailableError): SharedModelUnavailableBody {
  return {
    error: "This shared conversation can't continue right now because its model is no longer available. Ask the person who shared it to choose another model.",
    code: 'model_unavailable',
  };
}

/**
 * Message for chat channels (Slack, Teams, ...): nobody picked a model in the
 * thread and there is no picker, and the stored id must never be echoed into
 * channel markup (mrkdwn would render <!channel>/<@U..>), so no model id or name.
 */
export function buildChannelModelUnavailableMessage(): string {
  return "I can't answer in this thread because the model it was started with is no longer available. Please start a new thread, or switch the model in the AgentWeb app.";
}
