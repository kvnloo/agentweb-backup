/**
 * ENG-2327: session tracking for landing pages.
 *
 * This module starts as the tracker-session-list creation logic EXTRACTED from routes/tracking.ts
 * (POST /api/tracking/session-lists, ENG-2315) so the landing-page paths and that route create
 * a session list through one function and cannot drift apart.
 */
import { crmDb } from './db';
import type { TrackingConfig } from '../utils/trackingConfig';

/** Columns a session list shows by default (customFields keys written by the ingest). */
export const SESSION_LIST_DISPLAY_FIELDS = [
  'channel', 'trafficType', 'channelGroup', 'sourceDetail', 'dwellSec', 'lastEvent', 'furthestStage', 'visitNo',
];

export function buildEmbedSnippet(listId: string): string {
  const base = (process.env.BACKEND_URL || 'https://api.agentweb.pro').replace(/\/+$/, '');
  return `<script src="${base}/sdk/v1/aw.js" data-aw-list="${listId}" async></script>`;
}

/**
 * Create a system-managed, public session list carrying `trackingConfig` from its first write.
 * The caller validates name/origins/label (the route and the landing-page service each own their
 * own input rules); this only performs the write.
 */
export async function createTrackerSessionList(
  userId: string,
  name: string,
  trackingConfig: TrackingConfig,
): Promise<Record<string, any>> {
  return crmDb.createLeadList(
    userId, name, '',
    [],              // alertEvents: a session row is telemetry, never an owner alert
    null, false, undefined, undefined, undefined,
    'session',
    true,            // isSystemManaged
    undefined,
    // publicAccessEnabled from the first write: the SDK posts anonymously, and ingest refuses a list without it.
    { publicAccessEnabled: true, displayFields: SESSION_LIST_DISPLAY_FIELDS, trackingConfig },
  );
}
