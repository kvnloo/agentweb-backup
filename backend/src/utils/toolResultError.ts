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

  if (obj.isError === true) {
    return new Error(extractToolResultMessage(obj) || 'Tool returned isError=true');
  }

  if (obj.success === false) {
    return new Error(extractToolResultMessage(obj) || 'Tool returned success=false');
  }

  return null;
}
