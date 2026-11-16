import { emmaToolRegistry } from '../emma/registry';

// Detection is fail-SAFE: rather than enumerate write verbs (an allowlist that
// leaks — `email`, `add_*`, `assign_*`, `manage_*`, `freeze_*` all slipped past an
// earlier verb list), we allowlist READ/CONTEXT tools and treat EVERYTHING ELSE as
// a side effect. A new or unrecognized tool therefore counts as a write until
// proven read-only, so no write can be silently concealed.
// Reads are named verb-FIRST (get_*, read_*, list_*, describe_*, analyze_*), so
// anchor to the leading token — otherwise a write like `add_leads_to_list` or
// `create_lead_list` would be mistaken for a read because it merely CONTAINS a read
// word. Irregular read names that don't lead with a read verb are listed exactly.
// perform_data_analysis belongs here too (ENG-1276): it runs code on caller-supplied
// data with no external side effects — the same as analyze_*/read_* — but its name
// doesn't lead with a recognized verb, so without this it was misclassified as a
// write and vetoed a legitimate skip whose FIRST step is calling it to compute
// today's weekday (real prod session 17834849…, 2026-08-16).
const READ_ONLY_TOOL = /^(?:get|read|list|fetch|search|describe|analy[sz]e|ask|audit|lookup|view|show|load|query|count|retrieve|summari[sz]e|inspect)(?:_|$)/i;
const READ_ONLY_TOOL_EXACT = new Set(['account_summary', 'you_search_web', 'web_search', 'perform_data_analysis']);
// ENG-1276 follow-up: the exact-name allowlist above is reactive — it only grows
// once a new read-only tool's odd name has ALREADY broken a real schedule
// (perform_data_analysis was one such case). perform_deep_research is a live,
// still-unpatched analog: same "no external side effects" shape, same
// non-read-verb name, just not yet observed breaking a run. Rather than wait for
// that, the tool's OWN registration can declare `readOnly: true` (see
// McpToolHandler in mcp/server/registry.ts) when EVERY possible call is
// side-effect-free, and this consults it. Checked last, after the free name
// checks — cheaper and requires no registry state for the common case.
// Tools whose name leads with a read verb but which mutate state. Checked first so
// the verb-prefix heuristic can't launder a write: load_browser_cookies injects
// cookies into the live browser context via addCookies (ENG-1337 review).
const MUTATING_DESPITE_READ_VERB = new Set(['load_browser_cookies']);
export function isReadOnlyToolName(name: string): boolean {
  if (MUTATING_DESPITE_READ_VERB.has(name)) return false;
  if (READ_ONLY_TOOL_EXACT.has(name) || READ_ONLY_TOOL.test(name)) return true;
  return emmaToolRegistry.getTool(name)?.readOnly === true;
}
// ENG-2863: linkedin_outreach multiplexes reads and sends behind one name. Its
// discovery actions never contact anyone or change account state, so a run that
// only searched/read profiles must not be reported as having "completed writes".
// Action-scoped and fail-safe: an unknown, missing or unparseable action stays a write.
// Spelling is folded the same way the dispatcher does (`_` -> `-`).
const LINKEDIN_OUTREACH_READ_ACTIONS = new Set([
  'search-people', 'get-profile', 'get-company', 'search-parameters',
  'list-connections', 'list-sent-invitations', 'list-received-invitations', 'list-post-engagers',
]);
function isReadOnlyLinkedInOutreachCall(toolCall: any): boolean {
  let args = toolCall?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return false; }
  }
  const action = args && typeof args === 'object' ? (args as any).action : undefined;
  return typeof action === 'string' && LINKEDIN_OUTREACH_READ_ACTIONS.has(action.trim().toLowerCase().replace(/_/g, '-'));
}
export function isWriteToolCall(toolCall: any): boolean {
  const name = typeof toolCall?.name === 'string' ? toolCall.name : '';
  if (name === 'linkedin_outreach' && isReadOnlyLinkedInOutreachCall(toolCall)) return false;
  return name.length > 0 && !isReadOnlyToolName(name);
}
