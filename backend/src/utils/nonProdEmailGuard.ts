/**
 * ENG-1215 — stop non-production environments emailing real people.
 *
 * Staging and every preview run with `NODE_ENV=development` against `Dev-`
 * prefixed tables, and `Dev-AW-Users` is a CLONE OF PRODUCTION: it holds real
 * customer addresses. Until now nothing stood between that data and the mail
 * provider. The only environment check in `emailService` guarded
 * `sendOncallAlert` — an internal alert to our own oncall — while every
 * customer-facing send went straight out. A preview booting the full cron stack
 * could therefore mail a real customer from an environment nobody treats as
 * live.
 *
 * The guard is an ALLOWLIST rather than a blanket block, because staging still
 * has to be able to prove that mail actually leaves the box. Suppression is the
 * default; delivery in non-prod is opt-in and explicit.
 *
 * Configuration (all no-ops in production, where the guard never runs):
 *
 *   NONPROD_EMAIL_ALLOWLIST   Comma-separated. An entry beginning with `@` is a
 *                             domain suffix (`@example.com`); anything else is
 *                             an exact address. Unset defaults to
 *                             `@example.com`, which keeps existing test
 *                             fixtures working while blocking real domains.
 *                             Set to an empty string for total silence.
 *
 *   NONPROD_EMAIL_ALLOW_ALL   `true` disables the guard entirely for a
 *                             deliberate staging delivery test. Deliberately
 *                             separate from the allowlist so it cannot be
 *                             switched on by accident while editing recipients.
 */

const DEFAULT_ALLOWLIST = ['@example.com'];

/** Marks a suppressed send. Never a real provider id. */
export const SUPPRESSED_MESSAGE_ID = 'nonprod-suppressed';

/**
 * Whether a send result came from the guard rather than the provider.
 *
 * The distinction has to survive all the way to the audit layer. A suppressed
 * send resolves with a string `id` so that `sendEmailStrict`'s "no messageId"
 * check does not misread it as a provider failure — but a string id is exactly
 * what every delivery-status consumer treats as proof of delivery. Without this
 * predicate a blocked message is recorded as delivered, which is a worse
 * failure than the one the guard prevents.
 */
export function isSuppressedSendResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { id?: unknown }).id === SUPPRESSED_MESSAGE_ID
  );
}

export function isNonProdEmailGuardActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return false;
  return String(env.NONPROD_EMAIL_ALLOW_ALL || '').toLowerCase() !== 'true';
}

function parseAllowlist(env: NodeJS.ProcessEnv): string[] {
  const raw = env.NONPROD_EMAIL_ALLOWLIST;
  // Unset is not the same as empty: unset takes the default, empty means the
  // operator asked for total silence.
  if (raw === undefined) return DEFAULT_ALLOWLIST;
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isRecipientAllowed(
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = String(address || '').trim().toLowerCase();
  if (!normalized) return false;
  return parseAllowlist(env).some((entry) =>
    entry.startsWith('@') ? normalized.endsWith(entry) : normalized === entry,
  );
}

/** Normalizes Resend's `string | string[] | undefined` recipient shape. */
function toList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

export interface RecipientPartition {
  allowedTo: string[];
  blockedTo: string[];
  allowedCc: string[];
  blockedCc: string[];
  /** True when nothing survives in `to` — the send must not go out at all. */
  suppressEntirely: boolean;
}

/**
 * Split recipients into those the current environment may mail and those it may
 * not.
 *
 * `to` is what decides suppression. A send whose every primary recipient is
 * blocked must not go out, even if a cc happens to be allowlisted — delivering
 * it would silently change who the message was addressed to.
 */
export function partitionRecipients(
  to: string | string[] | undefined,
  cc: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RecipientPartition {
  const allowedTo: string[] = [];
  const blockedTo: string[] = [];
  const allowedCc: string[] = [];
  const blockedCc: string[] = [];

  for (const address of toList(to)) {
    (isRecipientAllowed(address, env) ? allowedTo : blockedTo).push(address);
  }
  for (const address of toList(cc)) {
    (isRecipientAllowed(address, env) ? allowedCc : blockedCc).push(address);
  }

  return {
    allowedTo,
    blockedTo,
    allowedCc,
    blockedCc,
    suppressEntirely: allowedTo.length === 0,
  };
}
