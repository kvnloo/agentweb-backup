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
  const base = process.env.BACKEND_URL?.trim().replace(/\/+$/, '') || localhostFallbackOrThrow();
  const query = new URLSearchParams({ listId: ctx.listId, leadId: ctx.leadId, jobKey: ctx.jobKey });
  return `${base}/api/webhooks/twilio-voice/${kind}?${query.toString()}`;
}

function localhostFallbackOrThrow(): string {
  const env = process.env.NODE_ENV;
  if (env && env !== 'development' && env !== 'test') {
    throw new Error('BACKEND_URL is not configured; cannot build a Twilio voice webhook URL');
  }
  return 'http://localhost:3001';
}
