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
 *
 * Opt-in scopes (e.g. `email:read`) are different: a tool that declares one via
 * its registry `requiredScope` is callable only by an `aw_` key that holds that
 * exact scope. `tools:execute` does NOT imply it, and it is not in the default
 * set, so no existing or default key gains the capability. Every other auth
 * method (OAuth, anonymous) is refused such tools outright.
 */
export const API_KEY_SCOPE_READ = 'tools:read';
export const API_KEY_SCOPE_EXECUTE = 'tools:execute';
export const API_KEY_SCOPE_EMAIL_READ = 'email:read';
/**
 * Smartlead over MCP (ENG-673 follow-on, for the Hermes agents). Opt-in like email:read, and for `aw_` keys only: a signed-in OAuth
 * client (including marketplace clients) does not get them. `smartlead:read` reads the user's own campaigns, their numbers, a push
 * preview and push progress; `smartlead:control` pauses or cancels a push (stop actions only). Starting, resuming or releasing a push is
 * never offered over MCP: a person approves those in the portal.
 */
export const API_KEY_SCOPE_SMARTLEAD_READ = 'smartlead:read';
export const API_KEY_SCOPE_SMARTLEAD_CONTROL = 'smartlead:control';
export const DEFAULT_API_KEY_SCOPES = [API_KEY_SCOPE_READ, API_KEY_SCOPE_EXECUTE];

export function effectiveApiKeyScopes(scopes: unknown): string[] {
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [...DEFAULT_API_KEY_SCOPES];
}

export interface ScopeDenial {
  tool: string;
  requiredScope: string;
}

type ToolLookup = (name: string) => { readOnly?: boolean; requiredScope?: string; apiKeyOnly?: boolean } | undefined;

export function requiredScopeForTool(name: string, lookup: ToolLookup): string {
  const tool = lookup(name);
  if (tool?.requiredScope) return tool.requiredScope;
  return tool?.readOnly === true ? API_KEY_SCOPE_READ : API_KEY_SCOPE_EXECUTE;
}

function isOptInScope(scope: string): boolean {
  return scope !== API_KEY_SCOPE_READ && scope !== API_KEY_SCOPE_EXECUTE;
}

function scopeSatisfies(granted: string[], required: string): boolean {
  // An opt-in scope must be held explicitly — tools:execute never implies it.
  if (isOptInScope(required)) return granted.includes(required);
  if (granted.includes(API_KEY_SCOPE_EXECUTE)) return true;
  return granted.includes(required);
}

/**
 * For non-API-key external callers (OAuth, anonymous): returns the first
 * tools/call that targets a tool gated on an opt-in scope. Those tools exist
 * only for `aw_` keys explicitly granted the scope, so any other auth method is
 * refused regardless of what else it may do.
 */
export function findApiKeyOnlyToolCall(body: unknown, lookup: ToolLookup): ScopeDenial | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if ((message as any)?.method !== 'tools/call') continue;
    const tool = String((message as any)?.params?.name ?? '');
    const requiredScope = lookup(tool)?.requiredScope;
    if (requiredScope && isOptInScope(requiredScope)) return { tool, requiredScope };
  }
  return null;
}

/**
 * For any external caller that is not an `aw_` key (OAuth included): the first tools/call that targets an `apiKeyOnly` tool. Checked on
 * the request's own auth method, so an OAuth request cannot borrow a session that a key opened.
 */
export function findApiKeyOnlyToolCallForNonKey(body: unknown, lookup: ToolLookup): ScopeDenial | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if ((message as any)?.method !== 'tools/call') continue;
    const tool = String((message as any)?.params?.name ?? '');
    const handler = lookup(tool);
    if (handler?.apiKeyOnly) return { tool, requiredScope: handler.requiredScope ?? '' };
  }
  return null;
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
