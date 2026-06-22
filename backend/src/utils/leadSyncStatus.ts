/**
 * Per-lead external-CRM (HubSpot) sync status helpers.
 *
 * This is a LEAF module: it must not import from services/ or adapters/ so the
 * adapter (which imports these builders) doesn't create a require cycle.
 */

export type LeadSyncStatus = 'synced' | 'sync_pending' | 'update_pending' | 'sync_failed';

export interface HubspotConnection {
  connected: boolean;
  autoSyncEnabled: boolean;
  /** The raw stored ExternalCrmSyncConfig for the hubspot provider, or null. */
  config: any | null;
}

// Native lead fields we treat as "mapped" when a connected config has no
// enabled mappings of its own (defensive fallback only — real configs always
// carry contactFieldMapping). Kept local to avoid importing the service module.
const DEFAULT_MAPPED_FIELDS = [
  'email', 'firstName', 'lastName', 'phone', 'company', 'title',
  'linkedin', 'notes', 'status', 'dealValue', 'dealCurrency',
];

/** Read the HubSpot connection state off a lead-list record. */
export function getHubspotConnection(list: any): HubspotConnection {
  const config = list?.externalCrmSyncConfigs?.hubspot ?? null;
  const connected = !!config && (!!config.accountId || !!config.apiKeyEncrypted);
  return { connected, autoSyncEnabled: !!config?.autoSyncEnabled, config };
}

/**
 * Resolve a lead's sync status for display/filtering. Authoritative when the
 * persisted field is present; otherwise derives a value for legacy leads:
 *   hubspot_contact_id present -> 'synced', else 'sync_pending'.
 * Returns null when the list isn't connected (no chip / no filter).
 */
export function resolveSyncStatus(lead: any, connected: boolean): LeadSyncStatus | null {
  if (!connected) return null;
  const persisted = lead?.syncMetadata?.syncStatus as LeadSyncStatus | undefined;
  if (persisted) return persisted;
  return lead?.syncMetadata?.hubspot_contact_id ? 'synced' : 'sync_pending';
}

/** Set of agentwebField names that are pushed to HubSpot (enabled, not pull-only). */
export function getMappedAgentwebFields(config: any): Set<string> {
  const all = [
    ...(config?.contactFieldMapping || []),
    ...(config?.dealFieldMapping || []),
    ...(config?.customFieldMapping || []),
  ];
  const fields = new Set<string>();
  for (const m of all) {
    if (m?.enabled && m?.direction !== 'pull' && m?.agentwebField) {
      fields.add(m.agentwebField);
    }
  }
  if (fields.size === 0) {
    for (const f of DEFAULT_MAPPED_FIELDS) fields.add(f);
  }
  return fields;
}

// Treat null / undefined / '' as the same "empty" value so clearing a field or
// re-saving an unchanged blank doesn't read as a change.
function norm(v: any): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * True if `updates` changes the value of any HubSpot-mapped field relative to
 * `existing`. Checks top-level fields and nested customFields. Over-marking is
 * acceptable (worst case: one extra re-push); under-marking is not.
 */
export function mappedFieldChanged(existing: any, updates: any, mappedFields: Set<string>): boolean {
  for (const f of mappedFields) {
    if (updates && Object.prototype.hasOwnProperty.call(updates, f)) {
      if (norm(existing?.[f]) !== norm(updates[f])) return true;
    }
    if (updates?.customFields && Object.prototype.hasOwnProperty.call(updates.customFields, f)) {
      if (norm(existing?.customFields?.[f]) !== norm(updates.customFields[f])) return true;
    }
  }
  return false;
}

/**
 * Merge for a successful per-lead push: stamp contact id + synced + lastSyncedAt,
 * preserve any other ids (e.g. hubspot_deal_id), and CLEAR a prior syncError.
 */
export function buildSyncedMetadata(
  existing: Record<string, any> | undefined,
  contactId: string,
  nowIso: string,
): Record<string, any> {
  const merged: Record<string, any> = {
    ...(existing || {}),
    hubspot_contact_id: contactId,
    syncStatus: 'synced',
    lastSyncedAt: nowIso,
  };
  delete merged.syncError; // omit (not undefined) so DynamoDB drops it cleanly
  return merged;
}

/** Merge for a failed per-lead push: stamp sync_failed + error, preserve ids. */
export function buildFailedMetadata(
  existing: Record<string, any> | undefined,
  errorMsg: string,
): Record<string, any> {
  return { ...(existing || {}), syncStatus: 'sync_failed', syncError: errorMsg };
}
