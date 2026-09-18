/**
 * ENG-567: canonical connection catalog — the ONE metadata source for the
 * outcome-first Connected Accounts experience (child of ENG-526).
 *
 * Pure data + pure selectors: no I/O, no OAuth, no DB. The route layer and
 * any frontend surface project this catalog into views; nothing hard-codes
 * a second catalog elsewhere.
 */

export type ConnectionStatusBucket =
  | 'connected'
  | 'available'
  | 'unavailable'
  | 'action_required';

export interface ConnectionCatalogEntry {
  /** Stable platform key, matching `platform` on stored accounts + allowed lists. */
  platform: string;
  /** Human label. */
  label: string;
  /** What Emma can read through this connection. */
  emmaCanRead: string;
  /** Actions Emma / the user can take through this connection. */
  emmaCanDo: string;
  /** GTM outcomes this connection enables (outcome keys, see OUTCOME_FILTERS). */
  outcomes: string[];
  /** Hard limitation or approval boundary, when one exists. */
  limitation?: string;
}

export interface OutcomeFilter {
  /** Stable outcome key referenced by catalog entries. */
  key: string;
  label: string;
  /** Why this set matters for the outcome. */
  why: string;
  /** Minimum useful connection set for the outcome. */
  minimumPlatforms: string[];
}

export const OUTCOME_FILTERS: OutcomeFilter[] = [
  {
    key: 'run_paid_media',
    label: 'Run paid media',
    why: 'Ad platforms plus measurement so spend ties back to pipeline.',
    minimumPlatforms: ['meta', 'google_ads'],
  },
  {
    key: 'generate_pipeline',
    label: 'Generate pipeline',
    why: 'Capture intent (meetings, calls) and keep outreach accounts healthy.',
    minimumPlatforms: ['calendly', 'fathom', 'linkedin'],
  },
  {
    key: 'nurture_leads',
    label: 'Nurture leads',
    why: 'Reach the inbox and stay in sync with the CRM.',
    minimumPlatforms: ['gmail', 'hubspot'],
  },
  {
    key: 'publish_content',
    label: 'Publish content',
    why: 'Distribute organic content across social surfaces.',
    minimumPlatforms: ['linkedin', 'twitter', 'youtube', 'instagram'],
  },
  {
    key: 'measure_performance',
    label: 'Measure performance',
    why: 'Attribute bookings and spend to real outcomes.',
    minimumPlatforms: ['google_ads', 'meta', 'calendly'],
  },
];

export const CONNECTION_CATALOG: ConnectionCatalogEntry[] = [
  {
    platform: 'linkedin',
    label: 'LinkedIn',
    emmaCanRead: 'Profile, network, and outreach engagement state.',
    emmaCanDo: 'Draft and send outreach within pacing limits; sync engagement.',
    outcomes: ['generate_pipeline', 'publish_content'],
    limitation: 'Invite volume is paced; Premium accounts allow longer invites.',
  },
  {
    platform: 'unipile',
    label: 'LinkedIn via Unipile',
    emmaCanRead: 'LinkedIn account status and messaging state.',
    emmaCanDo: 'Send managed LinkedIn outreach; monitor account health.',
    outcomes: ['generate_pipeline'],
    limitation: 'Requires a healthy Unipile account; orphaned accounts need reassignment.',
  },
  {
    platform: 'meta',
    label: 'Meta Ads',
    emmaCanRead: 'Ad accounts, campaigns, and ads reporting data.',
    emmaCanDo: 'Report on performance; manage campaigns with approval.',
    outcomes: ['run_paid_media', 'measure_performance'],
    limitation: 'Requires ads_read/ads_management grant; revoked grants need reconnect.',
  },
  {
    platform: 'google_ads',
    label: 'Google Ads',
    emmaCanRead: 'Accounts, campaigns, and spend data.',
    emmaCanDo: 'Report on performance; manage campaigns with approval.',
    outcomes: ['run_paid_media', 'measure_performance'],
    limitation: 'Test accounts cannot spend; billable accounts need spend approval.',
  },
  {
    platform: 'gmail',
    label: 'Gmail',
    emmaCanRead: 'Inbox threads relevant to GTM workflows.',
    emmaCanDo: 'Draft and send mail with approval; auto-renews via refresh token.',
    outcomes: ['nurture_leads'],
  },
  {
    platform: 'outlook',
    label: 'Outlook',
    emmaCanRead: 'Inbox threads relevant to GTM workflows.',
    emmaCanDo: 'Draft and send mail with approval.',
    outcomes: ['nurture_leads'],
  },
  {
    platform: 'calendly',
    label: 'Calendly',
    emmaCanRead: 'Event types and bookings.',
    emmaCanDo: 'Resolve booking attribution; forward bookings to a lead list.',
    outcomes: ['generate_pipeline', 'measure_performance'],
    limitation: 'Free-tier plans do not support booking webhooks.',
  },
  {
    platform: 'youtube',
    label: 'YouTube',
    emmaCanRead: 'Channel and video metadata.',
    emmaCanDo: 'Publish and measure video content with approval.',
    outcomes: ['publish_content'],
  },
  {
    platform: 'fathom',
    label: 'Fathom',
    emmaCanRead: 'Call recordings and summaries.',
    emmaCanDo: 'Attach meeting intelligence to leads and workplans.',
    outcomes: ['generate_pipeline'],
    limitation: 'Tokens can be revoked server-side; reconnect when flagged.',
  },
  {
    platform: 'instagram',
    label: 'Instagram',
    emmaCanRead: 'Profile and media insights via the Meta OAuth flow.',
    emmaCanDo: 'Publish and measure content with approval.',
    outcomes: ['publish_content'],
  },
  {
    platform: 'twitter',
    label: 'X (Twitter)',
    emmaCanRead: 'Posts and engagement.',
    emmaCanDo: 'Publish and measure content with approval.',
    outcomes: ['publish_content'],
    limitation: 'Revoked refresh tokens require reconnect via OAuth.',
  },
  {
    platform: 'hubspot',
    label: 'HubSpot',
    emmaCanRead: 'Contacts, companies, and deals.',
    emmaCanDo: 'Sync leads and keep CRM records current.',
    outcomes: ['nurture_leads'],
  },
  {
    platform: 'attio',
    label: 'Attio',
    emmaCanRead: 'Contacts and pipelines.',
    emmaCanDo: 'Sync leads and keep CRM records current.',
    outcomes: ['nurture_leads'],
  },
  {
    platform: 'google_drive',
    label: 'Google Drive',
    emmaCanRead: 'Files the user has granted access to.',
    emmaCanDo: 'Attach GTM assets to workplans.',
    outcomes: ['nurture_leads'],
  },
];

/**
 * Minimum useful connection set for an outcome, resolved against the catalog
 * so the outcome filters can never drift from the entries they describe.
 */
export function connectionsForOutcome(outcomeKey: string): ConnectionCatalogEntry[] {
  const outcome = OUTCOME_FILTERS.find((o) => o.key === outcomeKey);
  if (!outcome) return [];
  const byPlatform = new Map(CONNECTION_CATALOG.map((c) => [c.platform, c]));
  return outcome.minimumPlatforms
    .map((p) => byPlatform.get(p))
    .filter((c): c is ConnectionCatalogEntry => c !== undefined);
}

/**
 * Search the full catalog — the "All connections" escape hatch. Matches
 * platform key, label, capabilities, and outcome keys.
 */
export function searchCatalog(query: string): ConnectionCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CONNECTION_CATALOG];
  return CONNECTION_CATALOG.filter((c) =>
    [c.platform, c.label, c.emmaCanRead, c.emmaCanDo, ...(c.outcomes ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(q),
  );
}

export interface AccountStatusInput {
  platform: string;
  /** Raw per-row status as produced by the connected-accounts route. */
  status: string;
}

/**
 * Map a raw per-account status string onto the four distinct AC buckets:
 * connected / available (never connected) / unavailable (not allowed) /
 * action_required (disconnected, expired, or reconnect-required).
 */
export function bucketForAccountStatus(
  input: AccountStatusInput,
  allowedPlatforms: string[],
): ConnectionStatusBucket {
  if (!allowedPlatforms.includes(input.platform)) return 'unavailable';
  const s = (input.status || '').toLowerCase();
  if (s === 'active' || s === 'connected') return 'connected';
  if (
    s === 'disconnected' ||
    s.includes('reconnect') ||
    s.includes('expir') ||
    s.includes('revok') ||
    s.includes('action')
  ) {
    return 'action_required';
  }
  return 'available';
}
