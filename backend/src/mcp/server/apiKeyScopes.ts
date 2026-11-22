/**
 * ENG-1083 (decision A, 2026-08-17): API key scopes are an enforced permission
 * boundary for `aw_` keys at the MCP boundary.
 *
 *   tools:read    — may call tools registered `readOnly: true`
 *   tools:execute — may call every tool (writes included; implies read)
 *
 * Tools not declared read-only are treated as writes (fail closed), matching
 * the ENG-336 annotation default. Discovery methods (initialize, tools/list)
 * are not gated so a restricted key can still see the surface.
 *
 * Grandfathering: keys have defaulted to both scopes since creation; a legacy
 * record with no `scopes` array is treated the same, so no live integration
 * loses access. No stored data is rewritten.
 */
export const API_KEY_SCOPE_READ = 'tools:read';
export const API_KEY_SCOPE_EXECUTE = 'tools:execute';
export const DEFAULT_API_KEY_SCOPES = [API_KEY_SCOPE_READ, API_KEY_SCOPE_EXECUTE];

export function effectiveApiKeyScopes(scopes: unknown): string[] {
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [...DEFAULT_API_KEY_SCOPES];
}

export interface ScopeDenial {
  tool: string;
  requiredScope: string;
}

type ToolLookup = (name: string) => { readOnly?: boolean } | undefined;

export function requiredScopeForTool(name: string, lookup: ToolLookup): string {
  return lookup(name)?.readOnly === true ? API_KEY_SCOPE_READ : API_KEY_SCOPE_EXECUTE;
}

function scopeSatisfies(granted: string[], required: string): boolean {
  if (granted.includes(API_KEY_SCOPE_EXECUTE)) return true;
  return granted.includes(required);
}

/** Returns the first tools/call in a (possibly batched) JSON-RPC body the key may not make. */
export function findScopeDenial(body: unknown, granted: string[], lookup: ToolLookup): ScopeDenial | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if ((message as any)?.method !== 'tools/call') continue;
    const tool = String((message as any)?.params?.name ?? '');
    const requiredScope = requiredScopeForTool(tool, lookup);
    if (!scopeSatisfies(granted, requiredScope)) return { tool, requiredScope };
  }
  return null;
}
