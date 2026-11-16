/** ENG-2902 — pure classification of an executed Zoma toolkit write (scoreboard + gateway metering). */
export type ZomaWriteKind = 'create' | 'edit' | 'pause' | 'approve';
export const ZOMA_WRITE_KINDS: readonly ZomaWriteKind[] = ['create', 'edit', 'pause', 'approve'];
const CREATE_ACTIONS = new Set(['CREATE', 'BULK_CREATE', 'UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'COPY']);

/** Explicit writeKind (recorded since ENG-2902) wins; older events fall back on the action. */
export function classifyZomaWrite(event: { action?: string; writeKind?: string }): ZomaWriteKind {
  if (ZOMA_WRITE_KINDS.includes(event.writeKind as ZomaWriteKind)) return event.writeKind as ZomaWriteKind;
  return CREATE_ACTIONS.has(String(event.action ?? '').toUpperCase()) ? 'create' : 'edit';
}

/**
 * writeKind for a guarded toolkit write: the status change that starts delivery is the go-live
 * approval. Meta calls that status ACTIVE (the default); Google Ads calls it ENABLED (ENG-3072).
 */
export function zomaWriteKindFor(action: unknown, params: unknown, liveStatus: 'ACTIVE' | 'ENABLED' = 'ACTIVE'): ZomaWriteKind {
  const status = params && typeof params === 'object' ? (params as Record<string, unknown>).status : undefined;
  if (String(action).toUpperCase() === 'UPDATE' && status === liveStatus) return 'approve';
  if (String(action).toUpperCase() === 'UPDATE' && status === 'PAUSED') return 'pause';
  return classifyZomaWrite({ action: String(action) });
}
