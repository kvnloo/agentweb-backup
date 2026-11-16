/**
 * ENG-2496 — structured tracing for Zoma setup. One JSON line per event on stdout
 * (`event: "zoma_setup"`), queryable in CloudWatch Logs Insights, e.g.
 *   fields @timestamp, setup_id, user_id, step, outcome, reason
 *   | filter event = "zoma_setup" and setup_id = "<setup_id>" | sort @timestamp asc
 *
 * Never logged: device codes, user codes, OAuth/Meta authorization codes, Zoma tokens, Meta
 * access tokens, Stripe ids/secrets. `setup_id` is a one-way short hash of the deviceId (itself
 * a hash of the device code), so it identifies a setup without granting anything.
 */
import crypto from 'crypto';

export interface ZomaSetupEvent {
  at: string;
  step: string;
  outcome: string;
  reason?: string;
}

export const zomaSetupId = (deviceId: string) =>
  crypto.createHash('sha256').update(`zoma-setup-id:${deviceId}`).digest('hex').slice(0, 12);

const SECRET_PATTERNS: RegExp[] = [
  /zoma_[A-Za-z0-9_-]+/g, // Zoma tokens
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, // Stripe keys
  /\b(?:cs|seti|pm|cus)_(?:live|test)?_?[A-Za-z0-9]{8,}/g, // Stripe object ids / client secrets
  /\bEA[A-Za-z0-9]{20,}/g, // Meta access tokens
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWTs (signed state, link tokens)
  /((?:access_token|code|device_code|user_code|client_secret|state|token)=)[^&\s"']+/gi,
];

/** Free-text reasons pass through this; codes and tokens never reach a log line. */
export function scrubReason(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let text = raw instanceof Error ? raw.message : String(raw);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, (_m, prefix?: string) => `${typeof prefix === 'string' ? prefix : ''}[redacted]`);
  return text.slice(0, 200);
}

export function logZomaSetup(fields: { deviceId?: string; userId?: string; step: string; outcome: string; reason?: unknown }): ZomaSetupEvent {
  const event: ZomaSetupEvent = { at: new Date().toISOString(), step: fields.step, outcome: fields.outcome };
  const reason = scrubReason(fields.reason);
  if (reason) event.reason = reason;
  console.log(
    JSON.stringify({
      event: 'zoma_setup',
      ts: event.at,
      ...(fields.deviceId ? { setup_id: zomaSetupId(fields.deviceId) } : {}),
      ...(fields.userId ? { user_id: fields.userId } : {}),
      step: event.step,
      outcome: event.outcome,
      ...(event.reason ? { reason: event.reason } : {}),
    }),
  );
  return event;
}
