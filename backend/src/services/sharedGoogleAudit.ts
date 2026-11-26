/**
 * Log-only audit of the reads that go through AgentWeb's OWN shared Google service account on behalf of a user (step 1 of a two-step fix).
 *
 * Two places let a caller name a Google resource that nothing proves they own, and then read it with the platform's service account:
 *  - `readGoogleFileById` (a `gdoc:<id>` / `gsheet:<id>` knowledge-base identifier, or Emma's Google file reader) falls back to the service
 *    account when the caller has no Google Drive login or their own login is refused (401/403);
 *  - the analytics readers (`fetchGoogleAnalyticsMetrics`, `fetchGa4KeyEvents`, `fetchSearchConsoleMetrics`) read the GA4 property ids and
 *    Search Console domains that were SAVED in the user's or the organization's analytics config, which is validated for format only.
 *
 * Enforcement changes what customers can do (they are told to "share the file with the service account"), so it waits for numbers: this
 * writes ONE structured line per read to the application log and changes nothing else. Ids are hashed (12 hex characters of a SHA-256), never
 * logged raw, so a line says WHO read WHICH (hashed) resource through the shared account, and whether it worked. A Logs Insights query such as
 *
 *   filter audit = "shared_google_read" | stats count_distinct(userId) as users, count(*) as reads by kind, idHash | sort users desc
 *
 * shows whether the same resource is read by more than one account (the cross-tenant signal), and `by reason` shows how many Drive reads
 * rely on the fallback at all. Nothing here throws: an audit that cannot be written must never break the read it describes.
 */
import { createHash } from 'crypto';

export type SharedGoogleKind = 'drive-file' | 'ga4' | 'gsc';

export interface SharedGoogleReadAudit {
  kind: SharedGoogleKind;
  userId: string;
  /** The ids read (a Drive file id, GA4 property ids, Search Console domains). Hashed before logging. */
  ids: string[];
  /** Which function made the read (e.g. 'readGoogleFileById', 'fetchGa4KeyEvents'). */
  source: string;
  /** Drive only: why the shared account was used. */
  reason?: 'no_oauth' | 'oauth_denied';
  /** Drive only: whether the read worked. */
  outcome?: 'ok' | 'failed';
}

const MAX_IDS = 50;

/** 12 hex characters of the SHA-256 of an id: enough to see the same resource twice, not enough to read it back. */
export function hashShared(id: string): string {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

export function auditSharedGoogleRead(entry: SharedGoogleReadAudit): void {
  try {
    const ids = (Array.isArray(entry.ids) ? entry.ids : []).filter((id) => typeof id === 'string' && id !== '');
    for (const idHash of ids.slice(0, MAX_IDS).map(hashShared)) {
      console.info(
        JSON.stringify({
          audit: 'shared_google_read',
          at: new Date().toISOString(),
          kind: entry.kind,
          userId: entry.userId,
          idHash,
          source: entry.source,
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(entry.outcome ? { outcome: entry.outcome } : {}),
          ...(ids.length > 1 ? { ofIds: ids.length } : {}),
        }),
      );
    }
  } catch {
    // never break the read this describes
  }
}
