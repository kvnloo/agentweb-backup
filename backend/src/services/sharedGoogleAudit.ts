/**
 * Log-only audit of the reads that go through AgentWeb's OWN shared Google service account on behalf of a user (step 1 of a two-step fix).
 *
 * Places where a caller names a Google resource that nothing proves they own, and it is then read with the platform's service account:
 *  - `readGoogleFileById` (a `gdoc:<id>` / `gsheet:<id>` knowledge-base identifier, or Emma's Google file reader) falls back to the service
 *    account when the caller has no Google Drive login or their own login is refused (401/403);
 *  - the analytics readers (`fetchGoogleAnalyticsMetrics`, `fetchGa4KeyEvents`, `fetchSearchConsoleMetrics`, and the portal's
 *    `GET /api/seo/metrics` and `/product-metrics`) read the GA4 property ids and Search Console domains SAVED in the user's or the
 *    organization's analytics config, which is validated for format only.
 * (Registered Google Drive folders are a third: they are read only with the service account and are counted from the stored registrations,
 * not from this log. See the dev note.)
 *
 * Enforcement changes what customers can do (they are told to "share the file with the service account"), so it waits for numbers: this
 * writes ONE structured line per configured resource per call to the application log and changes nothing else. A line says WHO (user and
 * organization) read WHICH resource (hashed) through the shared account, from which config (`configSource`), whether the resource is one of
 * the platform's own landing-page analytics ids (`platform`, which every user with a deployed landing page has), and for Drive why the shared
 * account was used and whether the read worked. The hash keeps raw Drive file ids out of the log; it is NOT secret for GA4 property ids and
 * domains (short or guessable values can be recovered by trying candidates). Nothing here throws: an audit that cannot be written must never
 * break the read it describes.
 */
import { createHash } from 'crypto';

export type SharedGoogleKind = 'drive-file' | 'ga4' | 'gsc';

export interface SharedGoogleReadAudit {
  kind: SharedGoogleKind;
  userId: string;
  /** The caller's organization, when it has one (members of one organization legitimately share its analytics config). */
  orgId?: string | null;
  /** Analytics only: whose config the ids came from (`self`: the caller's own; `org`: the organization's, shared with a member). */
  configSource?: string | null;
  /** The ids read (a Drive file id, GA4 property ids, Search Console domains). Hashed before logging; anything not text or a number is skipped. */
  ids: unknown[];
  /** Which function made the read (e.g. 'readGoogleFileById', 'fetchGa4KeyEvents'). */
  source: string;
  /** Drive only: why the shared account was used. */
  reason?: 'no_oauth' | 'oauth_denied';
  /** Drive only: whether the read worked. */
  outcome?: 'ok' | 'failed';
}

const MAX_IDS = 50;
const PLATFORM_IDS_TTL_MS = 10 * 60_000;

/** 12 hex characters of the SHA-256 of an id: enough to see the same resource twice. Not secret for short or guessable ids. */
export function hashShared(id: string): string {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

/**
 * The platform's own landing-page GA4 property ids and Search Console domains (`getLandingPagesConfig`), loaded in the background at most
 * once per PLATFORM_IDS_TTL_MS and never awaited by a read. Until a load has worked, lines carry no `platform` field.
 */
const platformIds: { ids: Set<string> | null; at: number; loading: boolean } = { ids: null, at: 0, loading: false };

function refreshPlatformIds(): void {
  if (platformIds.loading || (platformIds.ids && Date.now() - platformIds.at < PLATFORM_IDS_TTL_MS)) return;
  platformIds.loading = true;
  import('../utils/secretsManager')
    .then((m) => m.getLandingPagesConfig())
    .then((config: any) => {
      const ids = new Set<string>();
      for (const mapping of [config, ...(Array.isArray(config?.additionalDomains) ? config.additionalDomains : [])]) {
        if (typeof mapping?.ga4PropertyId === 'string' && mapping.ga4PropertyId) ids.add(mapping.ga4PropertyId);
        if (typeof mapping?.gscDomain === 'string' && mapping.gscDomain) ids.add(mapping.gscDomain);
      }
      platformIds.ids = ids;
    })
    .catch(() => {
      // Unknown, not "none": lines keep no `platform` field (or the last known set) until a later load works.
    })
    .finally(() => {
      platformIds.at = Date.now();
      platformIds.loading = false;
    });
}

/** Tests only. */
export function resetPlatformIdsForTest(): void {
  platformIds.ids = null;
  platformIds.at = 0;
  platformIds.loading = false;
}

export function auditSharedGoogleRead(entry: SharedGoogleReadAudit): void {
  try {
    const ids = (Array.isArray(entry.ids) ? entry.ids : [])
      .filter((id) => (typeof id === 'string' && id !== '') || (typeof id === 'number' && Number.isFinite(id)))
      .map((id) => String(id));
    if (ids.length === 0) return;
    const analytics = entry.kind === 'ga4' || entry.kind === 'gsc';
    if (analytics) refreshPlatformIds();
    const known = analytics ? platformIds.ids : null;
    for (const id of ids.slice(0, MAX_IDS)) {
      console.info(
        JSON.stringify({
          audit: 'shared_google_read',
          at: new Date().toISOString(),
          kind: entry.kind,
          userId: entry.userId,
          idHash: hashShared(id),
          source: entry.source,
          ...(entry.orgId ? { orgId: entry.orgId } : {}),
          ...(entry.configSource ? { configSource: entry.configSource } : {}),
          ...(known ? { platform: known.has(id) } : {}),
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
