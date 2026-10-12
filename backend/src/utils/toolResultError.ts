/**
 * toolResultError / extractToolResultMessage — turn a tool's structured result
 * into an Error when it represents a failure, surfacing the most specific reason
 * the result carries.
 *
 * Extracted from agentModeService and HARDENED (dev.md 2026-06-13, "Theme 1 —
 * opaque error propagation"): the original only read `error`/`message`/`content`
 * as STRINGS, so object-shaped errors (Meta Graph `{ error: { message, code,
 * error_subcode } }`) and status-only failures were dropped — the caller fell
 * back to the opaque "Tool returned success=false", which blinded both the model
 * (it retried with no new information) and the failure telemetry. We now also
 * read object-shaped errors and a status/reason fallback before giving up.
 */

/** Preserves a structured, intentional tool refusal at the telemetry boundary. */
export class ToolResultPolicyBlockedError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'ToolResultPolicyBlockedError';
  }
}

/**
 * Pull the most specific human-readable reason out of a (failed) tool result.
 * Returns '' only when the result genuinely carries no reason.
 */
export function extractToolResultMessage(obj: Record<string, any>): string {
  if (typeof obj.error === 'string' && obj.error.trim()) return obj.error.trim();
  if (typeof obj.message === 'string' && obj.message.trim()) return obj.message.trim();
  if (typeof obj.content === 'string' && obj.content.trim()) return obj.content.trim();

  if (Array.isArray(obj.content)) {
    const text = obj.content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) return text;
  }

  // Object-shaped errors (Meta Graph / nested SDK errors). Previously dropped
  // because the string checks above failed, so the real reason was lost.
  if (obj.error && typeof obj.error === 'object') {
    const e = obj.error as Record<string, any>;
    const text =
      (typeof e.error_user_msg === 'string' && e.error_user_msg.trim()) ||
      (typeof e.message === 'string' && e.message.trim()) ||
      (typeof e.error_user_title === 'string' && e.error_user_title.trim()) ||
      (typeof e.detail === 'string' && e.detail.trim()) ||
      '';
    if (text) {
      const code = e.code ?? e.error_subcode ?? e.subcode ?? e.status;
      return code != null && code !== '' ? `${text} (code ${code})` : text;
    }
  }

  // Tools that set no message but carry a status/reason — name the failure
  // instead of letting the caller emit an opaque "success=false".
  for (const key of ['statusText', 'reason', 'detail', 'details', 'status']) {
    const v = obj[key];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t && t.toLowerCase() !== 'error' && t.toLowerCase() !== 'false') {
        return `${key}: ${t}`;
      }
    }
  }

  return '';
}

/**
 * Returns an Error if the tool result represents a failure (`isError: true` or
 * `success: false`), else null. The Error message is the most specific reason
 * available, with the legacy generic strings only as a last resort.
 */
export function toolResultError(result: unknown): Error | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, any>;

  const policyBlock = () => {
    if (obj.blocked !== true || typeof obj.reason !== 'string' || !obj.reason.trim()) return null;
    return new ToolResultPolicyBlockedError(
      extractToolResultMessage(obj) || `Tool was blocked by policy: ${obj.reason}`,
      obj.reason,
    );
  };

  // ENG-1300: a handler that catches its own thrown error and re-surfaces it as a
  // structured { success: false, ... } result (e.g. twitterOutreach's catch-all)
  // only carries the error MESSAGE by the time it gets here — the numeric HTTP
  // status the original error threw with (`.code`, e.g. twitter-api-v2's 403) is
  // gone unless the handler also copies it onto the result object. When it does,
  // attach it to the reconstructed Error so classifyToolErrorClass's status-based
  // branch still fires instead of falling back to the generic 'Error' class the
  // message text alone cannot match.
  //
  // Two field names are read because two conventions already exist in the
  // codebase: `code` (twitterOutreach/twitterManagePost, mirroring twitter-api-v2's
  // own ApiResponseError.code) and `status` (handleHubspotApi/handleAttioApi,
  // mirroring axios's error.response.status). Both are guarded to the HTTP range
  // (100-599) — same guard classifyToolErrorClass already applies to `.code` —
  // because this field is caller-supplied and not itself proof the number is an
  // HTTP status: a handler that naively forwards a vendor BUSINESS error code
  // (e.g. Meta Graph's `error.code`, which is not an HTTP status and can still
  // land in 100-599 by coincidence) would misclassify through this same path.
  // The guard cannot fully prevent that — it only rejects obvious garbage — so
  // each call site is still responsible for extracting the correct field.
  const isHttpRange = (n: unknown): n is number => typeof n === 'number' && n >= 100 && n <= 599;
  const withCode = (err: Error): Error => {
    // statusCode checked first: a field named exactly that (the AWS SDK v2
    // convention — S3 upload failures thread it through as `code` today, but
    // a future caller could pass it through verbatim under its own name) is
    // an unambiguous signal that the number is a transport status, unlike
    // `code`, which is overloaded with vendor business codes elsewhere in
    // this codebase (Meta, Google Ads) — preferring it when present is
    // defense-in-depth against exactly that collision.
    const code = isHttpRange(obj.statusCode) ? obj.statusCode
      : isHttpRange(obj.code) ? obj.code
      : isHttpRange(obj.status) ? obj.status
      : undefined;
    if (code !== undefined) (err as { code?: number }).code = code;
    // ENG-1949: a tool-declared semantic class (validated by the classifier).
    if (typeof obj.errorClass === 'string' && obj.errorClass) {
      (err as { toolErrorClass?: string }).toolErrorClass = obj.errorClass;
    }
    return err;
  };

  if (obj.isError === true) {
    const blocked = policyBlock();
    if (blocked) return blocked;
    return withCode(new Error(extractToolResultMessage(obj) || 'Tool returned isError=true'));
  }

  if (obj.success === false) {
    const blocked = policyBlock();
    if (blocked) return blocked;
    return withCode(new Error(extractToolResultMessage(obj) || 'Tool returned success=false'));
  }

  return null;
}
