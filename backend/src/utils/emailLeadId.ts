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

function emailKeyHash(listId: string, emailLower: string): string {
  // Keyed so the id never carries a plain, offline-guessable hash of the address. The id is
  // short-lived (it only has to agree between racers seconds apart), so rotating the secret is
  // harmless. JWT_SECRET is asserted at boot; the unkeyed fallback only serves unconfigured test envs.
  const secret = process.env.JWT_SECRET || 'email-lead-id';
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
export function emailLeadIds(listId: string, emailLower: string, nowMs: number = emailLeadClock.now()): EmailLeadIds {
  const width = emailLeadBucketMs();
  const bucket = Math.floor(nowMs / width) * width;
  const hash = emailKeyHash(listId, emailLower);
  return {
    leadId: `lead_${bucket}_${hash}`,
    prevLeadId: `lead_${bucket - width}_${hash}`,
    nextLeadId: `lead_${bucket + width}_${hash}`,
  };
}
