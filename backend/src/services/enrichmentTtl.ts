// Stateless TTL freshness + field-to-group lookup helpers for v3.1 CRM
// enrichment. Tier 1 (CRM) of the waterfall consults `isFresh` to decide
// whether to honor a value already on the lead or fall through to Apollo / web.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.2 step 1, §7.2.
// TTL is derived at read time — no `expiresAt` column on `AW-Leads`.

import { FIELD_GROUPS } from './enrichmentGroups';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';

const DAY_MS = 24 * 60 * 60 * 1000;

// Built once at module load: O(1) lookup from field name → group name.
const FIELD_TO_GROUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [groupName, config] of Object.entries(FIELD_GROUPS)) {
    for (const field of config.fields) {
      map.set(field, groupName);
    }
  }
  return map;
})();

export function groupOf(fieldName: string): string {
  if (typeof fieldName !== 'string') return 'ungrouped';
  const trimmed = fieldName.trim();
  if (!trimmed) return 'ungrouped';
  return FIELD_TO_GROUP.get(trimmed) ?? 'ungrouped';
}

export function isFresh(
  meta: EnrichedFieldMeta | undefined | null,
  fieldName: string,
): boolean {
  if (!meta || typeof meta.enrichedAt !== 'string') return false;

  const enrichedAtMs = Date.parse(meta.enrichedAt);
  if (Number.isNaN(enrichedAtMs)) return false;

  const group = groupOf(fieldName);
  if (group === 'ungrouped') return false;

  const ttlDays = FIELD_GROUPS[group].ttlDays;
  return Date.now() - enrichedAtMs < ttlDays * DAY_MS;
}
