const WEBHOOK_SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * Whether an id can travel in a webhook query and pass the voice webhooks' strict shape check. The
 * orchestrator must refuse to place a call for a list/lead/job id that fails this: Twilio would ring
 * the owner, and every callback would then be rejected.
 */
export function isWebhookSafeId(id: string): boolean {
  return WEBHOOK_SAFE_ID.test(id);
}

export type VoiceWebhookKind = 'owner' | 'gather' | 'dial' | 'status';

export interface VoiceWebhookContext {
  listId: string;
  leadId: string;
  jobKey: string;
}

/**
 * Public URL Twilio calls back for one step of a hot-lead call. Only opaque ids go in the query:
 * the lead's phone number must never appear in a URL (URLs land in Twilio and proxy logs).
 *
 * The base is BACKEND_URL, the same variable every other webhook/OAuth URL in the repo uses.
 * Those fall back to localhost, which is harmless for an OAuth redirect but would hand Twilio an
 * unreachable callback, so every deployed NODE_ENV (production, staging) throws instead.
 */
export function buildVoiceWebhookUrl(kind: VoiceWebhookKind, ctx: VoiceWebhookContext): string {
  const base = voiceWebhookBaseUrl();
  const query = new URLSearchParams({ listId: ctx.listId, leadId: ctx.leadId, jobKey: ctx.jobKey });
  return `${base}/api/webhooks/twilio-voice/${kind}?${query.toString()}`;
}

/**
 * The configured public origin, without a trailing slash. The webhook route rebuilds the URL
 * Twilio signed from this plus the request path, so it never has to trust the Host header.
 */
export function voiceWebhookBaseUrl(): string {
  return process.env.BACKEND_URL?.trim().replace(/\/+$/, '') || localhostFallbackOrThrow();
}

function localhostFallbackOrThrow(): string {
  const env = process.env.NODE_ENV;
  if (env && env !== 'development' && env !== 'test') {
    throw new Error('BACKEND_URL is not configured; cannot build a Twilio voice webhook URL');
  }
  return 'http://localhost:3001';
}
