/**
 * ENG-2163 — serve-side redaction of admin/support activity from a customer's own view.
 *
 * Admin-only tools (get_pr_digest, read_linear_issues, manage_user_notes, …) can run in a
 * session DELEGATED into a customer's account. Their raw tool-result messages are already
 * stripped for every client (see the base filter below), but the assistant NARRATION that
 * summarizes them is not — so a customer reopening their own session could read internal
 * AgentWeb data an admin surfaced while helping them.
 *
 * Per the 2026-09-26 decision (persist + mark-admin-only + filter from the customer view),
 * this filter drops, for a NON-admin viewer, the assistant messages that belong to an
 * "admin-tainted" turn — a turn (user message → next user message) that contains an admin-tool
 * RESULT message. We key off the tool-result message actually present in the stream, NOT
 * metadata.toolCalls, because a timed-out turn (the exact incident case, session
 * e278986c-…) has no toolCalls ledger.
 *
 * `viewerIsAdmin` defaults to false so a caller that forgets it fails CLOSED (hides admin
 * content) rather than leaking. Over-hiding within an admin-tainted turn is deliberate: those
 * turns are internal support activity and a security filter must fail closed.
 */

export interface FilterForClientOptions {
  /** True only for a real admin viewer or an admin viewing via delegation. Defaults to false. */
  viewerIsAdmin?: boolean;
  /** The set/list of admin-only tool names. Passed in so this stays a pure, dependency-free util. */
  adminToolNames?: Iterable<string>;
}

export function filterMessagesForClient(messages: any[], opts: FilterForClientOptions = {}): any[] {
  if (!Array.isArray(messages)) return [];
  const viewerIsAdmin = opts.viewerIsAdmin === true;
  const adminToolNameSet = new Set<string>(opts.adminToolNames ?? []);

  // Mark every index that falls inside an admin-tainted turn (only relevant for non-admins).
  const adminTainted = new Array(messages.length).fill(false);
  if (!viewerIsAdmin && adminToolNameSet.size > 0) {
    let turnStart = 0;
    let turnHasAdminTool = false;
    const markTurn = (start: number, endExclusive: number) => {
      if (!turnHasAdminTool) return;
      for (let i = start; i < endExclusive; i++) adminTainted[i] = true;
    };
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m && m.role === 'user') {
        markTurn(turnStart, i); // close previous turn
        turnStart = i;
        turnHasAdminTool = false;
      }
      if (m && m.role === 'tool' && typeof m.name === 'string' && adminToolNameSet.has(m.name)) {
        turnHasAdminTool = true;
      }
    }
    markTurn(turnStart, messages.length); // final turn
  }

  return messages.filter((message, i) => {
    // Remove tool messages (all viewers).
    if (message.role === 'tool') return false;

    // Remove assistant messages that have tool_calls (intermediate messages during tool execution)
    // BUT keep assistant messages that have metadata.toolCalls (final messages with tool results).
    if (
      message.role === 'assistant' &&
      message.tool_calls &&
      message.tool_calls.length > 0 &&
      !message.metadata?.toolCalls
    ) {
      return false;
    }

    // ENG-2163: for a non-admin viewer, also drop assistant messages in an admin-tainted turn.
    if (!viewerIsAdmin && adminTainted[i] && message.role === 'assistant') {
      return false;
    }

    return true;
  });
}
