import * as crypto from 'crypto';

/**
 * ENG-2321. Exactly-once create per (list, email) WITHOUT a new table.
 *
 * The email-keyed create used a random leadId plus two reads of the eventually-consistent
 * email-index GSI, so N concurrent same-email submissions each missed the others and wrote N rows
 * (measured 2-11 rows per email in production). A deterministic leadId turns the dedupe into a
 * conditional put on ONE primary key (the same device as ENG-2312's session leads), but a
 * submission's clock cannot be a fixed part of the id, so the time prefix is BUCKETED:
 *
 *   lead_<bucketStartMs>_<12 hex of HMAC(listId:emailLower)>
 *
 * Racers in one bucket collide on one key. Racers on either side of a bucket boundary are
 * serialised by also condition-checking the adjacent buckets' ids in the same transaction (see
 * db.createLead). Anything further apart than a bucket is left to the email-index pre-check, which
 * a bucket-sized gap lets catch up. The prefix stays a recent 13-digit ms timestamp (at most one
 * bucket old), so getLeadsByListId's newest-leadId-first ordering is preserved at bucket
 * granularity — a non-time-prefixed id (ENG-2082/2123 `lead_ph_<sha>`) would pin rows to the top.
 */

/** Tests replace `now` to force racers into adjacent buckets. Production never touches it. */
export const emailLeadClock = { now: (): number => Date.now() };

const DEFAULT_BUCKET_MS = 5000;
const MIN_BUCKET_MS = 1000;
const MAX_BUCKET_MS = 60000;

/** Kill switch. LEAD_EMAIL_UNIQUE_CREATE=false restores the random-id create path exactly. Default ON. */
export function isEmailUniqueCreateEnabled(): boolean {
  const raw = (process.env.LEAD_EMAIL_UNIQUE_CREATE ?? '').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

/** Bucket width. It must exceed email-index replication lag; invalid values fall back to the default. */
export function emailLeadBucketMs(): number {
  const n = Number(process.env.LEAD_EMAIL_UNIQUE_BUCKET_MS);
  return Number.isInteger(n) && n >= MIN_BUCKET_MS && n <= MAX_BUCKET_MS ? n : DEFAULT_BUCKET_MS;
}

function emailKeyHash(listId: string, emailLower: string, namespace = ''): string {
  // Keyed so the id never carries a plain, offline-guessable hash of the address. The id is
  // short-lived (it only has to agree between racers seconds apart), so rotating the secret is
  // harmless. JWT_SECRET is asserted at boot (server.ts:50 -> config/jwt.ts assertJwtSecretAtBoot); the unkeyed
  // fallback only serves unconfigured test envs. If two instances ever disagreed on it their ids would
  // differ, racers on different instances would not collide, and dedupe would silently degrade to the
  // pre-check (the pre-ENG-2321 behaviour): benign, and unrealistic since JWT verification needs one shared secret.
  // A non-empty namespace derives a DIFFERENT HMAC key, so ids in one namespace can never equal ids in another
  // whatever string a public caller sends (an "email" of literally `phone:2125551234` included).
  const secret = (process.env.JWT_SECRET || 'email-lead-id') + (namespace ? `\u0000${namespace}` : '');
  return crypto.createHmac('sha256', secret).update(`${listId}:${emailLower}`).digest('hex').slice(0, 12);
}

export interface EmailLeadIds {
  /** The id this submission creates. */
  leadId: string;
  /** The ids of the previous and next buckets, which the create condition-checks. */
  prevLeadId: string;
  nextLeadId: string;
}

/** `emailLower` must already be trimmed and lower-cased (createLead's own normalisation). */
export function emailLeadIds(listId: string, emailLower: string, nowMs: number = emailLeadClock.now(), namespace = ''): EmailLeadIds {
  const width = emailLeadBucketMs();
  const bucket = Math.floor(nowMs / width) * width;
  const hash = emailKeyHash(listId, emailLower, namespace);
  return {
    leadId: `lead_${bucket}_${hash}`,
    prevLeadId: `lead_${bucket - width}_${hash}`,
    nextLeadId: `lead_${bucket + width}_${hash}`,
  };
}

/** ENG-2123: the phone twin, in its own id namespace. */
export function phoneLeadIds(listId: string, phoneKey: string, nowMs: number = emailLeadClock.now()): EmailLeadIds {
  return emailLeadIds(listId, phoneKey, nowMs, 'phone');
}

const DEFAULT_TX_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Circuit breaker for the adjacency transaction. If the app role lacks permission for
 * TransactWriteItems / ConditionCheck on AW-Leads, every attempt would fail the same way, so after the
 * first AccessDeniedException the create degrades to a plain conditional put on the same bucketed id
 * (exact within one bucket; the boundary gap reopens) for LEAD_EMAIL_UNIQUE_TX_BACKOFF_MS (default 10 min,
 * accepted 1 s - 1 h), then tries the transaction again.
 */
export const emailTxBreaker = { openUntil: 0 };

function txBackoffMs(): number {
  const n = Number(process.env.LEAD_EMAIL_UNIQUE_TX_BACKOFF_MS);
  return Number.isInteger(n) && n >= 1000 && n <= 3600000 ? n : DEFAULT_TX_BACKOFF_MS;
}

export function emailTxAllowed(): boolean {
  return emailLeadClock.now() >= emailTxBreaker.openUntil;
}

/** Opens the breaker and logs once (the breaker only opens when closed, so once per interval). */
export function tripEmailTxBreaker(err: unknown): void {
  emailTxBreaker.openUntil = emailLeadClock.now() + txBackoffMs();
  console.error(
    `[ENG-2321] ConditionCheck denied on AW-Leads - degraded to conditional put for ${txBackoffMs()}ms ` +
      `(grant dynamodb:ConditionCheckItem + TransactWriteItems to restore boundary protection):`,
    (err as { message?: string })?.message,
  );
}
