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
/**
 * Org memory writes over MCP (ENG-2840 wave 2, W2-2). Opt-in like the others, and for `aw_` keys only: what an org memory says is put into
 * EVERY member's Emma prompt, so the person who owns the account decides which keys may call `save_org_memory` and `delete_org_memory` by
 * minting a scoped key. A signed-in OAuth client does not get it. Reading org memory (`list_memories`, scope org) and the user's own
 * memory tools need no opt-in scope.
 *
 * It controls those two TOOLS, not every route to org memory: a key that may start an Emma agent run (`emma_send_message` and the others in
 * AGENT_EXECUTION_TOOLS) reaches Emma's own org memory tool inside that run, with no scope and no cap, as for `email:read` and the
 * Smartlead scopes. Keeping those agent-run tools out of an outside agent's allowlist is the control for that.
 */
export const API_KEY_SCOPE_MEMORY_ORG = 'memory:org';
/**
 * Emailing GTM status reports over MCP (ENG-2840 wave 2, W2-4 follow-up). Opt-in like the others, and for `aw_` keys only: a report goes out
 * from AgentWeb's system sender to the contacts on a plan, so the person who owns the account decides which keys may send one by minting a
 * scoped key. A signed-in OAuth client does not get it, and a delegated (admin-as-customer) session cannot grant it. `send_gtm_status_report`
 * is bounded on top of the scope: at most 10 people a call, about 50 emails an hour per key, no identical report within 10 minutes, and an
 * audit line per attempt that never holds the message or an address (mcp/server/gtmEmailTool.ts).
 *
 * It controls that TOOL, not every route to a GTM email: a key that may start an Emma run (`emma_send_message` and the others in
 * AGENT_EXECUTION_TOOLS) reaches Emma's own `send_gtm_status_report` inside the run with no scope and no cap, as for `memory:org`. Keeping
 * those agent-run tools out of an outside agent's allowlist is the control for that.
 */
export const API_KEY_SCOPE_GTM_EMAIL = 'gtm:email';
export const DEFAULT_API_KEY_SCOPES = [API_KEY_SCOPE_READ, API_KEY_SCOPE_EXECUTE];

export function effectiveApiKeyScopes(scopes: unknown): string[] {
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : [...DEFAULT_API_KEY_SCOPES];
}

export interface ScopeDenial {
  tool: string;
  requiredScope: string;
}

/**
 * The tool a JSON-RPC message names, or '' when `params.name` is not text. `String(x)` on a hostile value (an object whose `toString` is not
 * a function) throws inside an async Express handler, which leaves the request hanging; a name that is not text is simply an unknown tool.
 */
function toolNameOf(message: unknown): string {
  const name = (message as any)?.params?.name;
  return typeof name === 'string' ? name : '';
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
    const tool = toolNameOf(message);
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
    const tool = toolNameOf(message);
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
    const tool = toolNameOf(message);
    const requiredScope = requiredScopeForTool(tool, lookup);
    if (!scopeSatisfies(granted, requiredScope)) return { tool, requiredScope };
  }
  return null;
}
