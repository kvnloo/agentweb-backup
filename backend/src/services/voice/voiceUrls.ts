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
 * Connection override appended to STATUS callback URLs (https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides,
 * checked 2026-10-19): `rc` = retry count (0-5, default 1), `rp` = retry policy (default `ct`, i.e. only TCP connect /
 * TLS handshake failures, so a 5xx is NOT retried by default). `5xx,ct` retries a server error we answer, up to 3 times.
 * The fragment is never sent on the wire and Twilio omits it when signing, so req.originalUrl (what the webhook
 * validates against) has none. Only status callbacks get it: they carry the metering input and every handler is
 * idempotent on a redelivery. The TwiML fetches (/owner, /gather, /dial) happen while a person is on the line under
 * Twilio's 15 second cap for call requests, so a retry would not help them and they answer a hangup instead.
 */
const STATUS_RETRY_FRAGMENT = '#rc=3&rp=5xx,ct';

/**
 * Public URL Twilio calls back for one step of a hot-lead call. Only opaque ids go in the query:
 * the lead's phone number must never appear in a URL (URLs land in Twilio and proxy logs).
 *
 * The base is BACKEND_URL, the same variable every other webhook/OAuth URL in the repo uses.
 * Those fall back to localhost, which is harmless for an OAuth redirect but would hand Twilio an
 * unreachable callback, so every deployed NODE_ENV (production, staging) throws instead.
 */
export function buildVoiceWebhookUrl(kind: VoiceWebhookKind, ctx: VoiceWebhookContext, opts: { leg?: 'lead' } = {}): string {
  const base = voiceWebhookBaseUrl();
  const query = new URLSearchParams({ listId: ctx.listId, leadId: ctx.leadId, jobKey: ctx.jobKey });
  // The lead's <Number> callback adds leg=lead so the status route knows which leg it is for.
  if (opts.leg) query.set('leg', opts.leg);
  return `${base}/api/webhooks/twilio-voice/${kind}?${query.toString()}${kind === 'status' ? STATUS_RETRY_FRAGMENT : ''}`;
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
