/**
 * ENG-2303 P3 — the guarded external write surface (pure; no I/O). Shared by the manifest
 * (advertised schema) and the gateway (routing) without importing the write executor.
 */
export const GUARDED_WRITE_ENTITIES = ['CAMPAIGN', 'AD_SET', 'AD'] as const;
export const GUARDED_WRITE_ACTIONS = ['CREATE', 'UPDATE'] as const;

export function isGuardedWriteRequest(toolName: string, args: any): boolean {
  return (
    toolName === 'call_meta_marketing_api' &&
    (GUARDED_WRITE_ENTITIES as readonly string[]).includes(String(args?.entity_type)) &&
    (GUARDED_WRITE_ACTIONS as readonly string[]).includes(String(args?.action))
  );
}
