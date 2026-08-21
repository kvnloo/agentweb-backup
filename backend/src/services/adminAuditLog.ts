/**
 * Minimal structured audit trail for admin cross-account mutations (ENG-721).
 *
 * Emits one structured JSON line per event, prefixed with `[admin-audit]`, so
 * the record survives in the EB application logs and is grep-able without a new
 * table (a durable audit store would be a database/data-plane change and is
 * deliberately out of this slice). Kept as its own module so routes can be
 * tested with a spy and so a durable sink can replace the implementation
 * without touching call sites.
 */

export interface AdminAuditEvent {
  /** Admin who performed the action. */
  actorUserId: string;
  actorEmail?: string;
  /** Stable action name, e.g. "landing_page_org_share". */
  action: string;
  /** Affected resource/context — free-form but stable per action. */
  [key: string]: unknown;
}

export function recordAdminAudit(event: AdminAuditEvent): void {
  try {
    console.log(
      `[admin-audit] ${JSON.stringify({ ts: new Date().toISOString(), ...event })}`
    );
  } catch {
    // An audit failure must never break the mutation path; the mutation is
    // already authorization-checked. Log the degradation loudly instead.
    console.error("[admin-audit] failed to serialize audit event", event?.action);
  }
}
