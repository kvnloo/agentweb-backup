/**
 * ENG-2163 — serve-side redaction of admin/support activity from a customer's own view.
 *
 * Admin-only tools (get_pr_digest, read_linear_issues, manage_user_notes, …) can run in a
 * session DELEGATED into a customer's account. Their raw tool-result messages and the assistant
 * NARRATION that summarizes them persist in the session — so a customer reopening their own
 * session could read internal AgentWeb data an admin surfaced while helping them.
 *
 * Per the 2026-09-26 decision (persist + mark-admin-only + filter from the customer view), a
 * turn (user message → next user message) whose stream contains an admin-tool RESULT message is
 * "admin-tainted". We key off the tool-result message actually present in the stream, NOT
 * metadata.toolCalls, because a timed-out turn (the exact incident case, session e278986c-…)
 * has no toolCalls ledger.
 *
 * Two consumers, sharing the same taint computation:
 *   - filterMessagesForClient  — the AGENT-MODE serve filter (base strip + admin-taint drop).
 *   - redactAdminActivity      — a SCOPED redaction for the Emma chatbot serve paths, which
 *                                historically return raw messages. It removes ONLY admin content
 *                                (admin-tool result messages + admin-tainted assistant messages)
 *                                and leaves every other message untouched, so it cannot regress
 *                                the chatbot's existing message shape for non-admin sessions.
 *
 * `viewerIsAdmin` defaults to false everywhere so a caller that forgets it fails CLOSED (hides
 * admin content) rather than leaking. Over-hiding within an admin-tainted turn is deliberate:
 * those turns are internal support activity and a security filter must fail closed.
 */

export interface AdminRedactionOptions {
  /** True only for a real admin viewer or an admin viewing via delegation. Defaults to false. */
  viewerIsAdmin?: boolean;
  /** The set/list of admin-only tool names. Passed in so this stays a pure, dependency-free util. */
  adminToolNames?: Iterable<string>;
  /**
   * ENG-112: drop `metadata.branchOrigin` (chat-branching provenance: the source session id/title) from the
   * returned rows. Set for viewers who are not the session owner (share / conversable links). Default false.
   * ENG-113: the same flag also drops `metadata.compareAlternatives` (the saved unchosen Compare answers are
   * owner-only) via the same mechanism. `compareAlternativesOmitted`/`compareId` carry no answer text and stay.
   */
  omitBranchOrigin?: boolean;
}

// Back-compat alias for the original name.
export type FilterForClientOptions = AdminRedactionOptions;

/**
 * Mark every message index that falls inside an admin-tainted turn. Returns an all-false array
 * when the viewer is an admin or no admin tool names are supplied (nothing to redact).
 */
export function computeAdminTaintedTurns(messages: any[], viewerIsAdmin: boolean, adminToolNameSet: Set<string>): boolean[] {
  const adminTainted = new Array(messages.length).fill(false);
  if (viewerIsAdmin || adminToolNameSet.size === 0) return adminTainted;

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
    // Agent-mode persists a role:'tool' result message per admin tool.
    if (m && m.role === 'tool' && typeof m.name === 'string' && adminToolNameSet.has(m.name)) {
      turnHasAdminTool = true;
    }
    // The Emma chatbot does NOT persist tool-role messages — it persists ONLY the final
    // assistant message, carrying each tool's name+result inside metadata.toolCalls. Detect
    // admin activity there too, or chatbot-originated admin turns are never tainted (ENG-2163
    // re-review finding: the tool-role-only check was a no-op on the chatbot persisted shape).
    if (m && m.role === 'assistant' && Array.isArray(m.metadata?.toolCalls)) {
      for (const tc of m.metadata.toolCalls) {
        if (tc && typeof tc.name === 'string' && adminToolNameSet.has(tc.name)) { turnHasAdminTool = true; break; }
      }
    }
  }
  markTurn(turnStart, messages.length); // final turn
  return adminTainted;
}

/**
 * AGENT-MODE serve filter. Base behavior: strip tool messages and intermediate
 * assistant-with-tool_calls messages (unchanged, pre-existing). ENG-2163 addition: for a
 * non-admin viewer, also drop assistant messages inside an admin-tainted turn.
 */
export function filterMessagesForClient(messages: any[], opts: AdminRedactionOptions = {}): any[] {
  if (!Array.isArray(messages)) return [];
  const viewerIsAdmin = opts.viewerIsAdmin === true;
  const adminToolNameSet = new Set<string>(opts.adminToolNames ?? []);
  const adminTainted = computeAdminTaintedTurns(messages, viewerIsAdmin, adminToolNameSet);

  // `omitBranchOrigin` is the legacy flag name for "this viewer is not the session owner": it strips BOTH owner-only
  // metadata keys (ENG-112 branchOrigin and ENG-113 compareAlternatives). Both share the one call-site rule on purpose
  // (every non-owner view must hide both); the adminOnlyMessageFilter tripwire tests pin each key.
  const stripOwnerOnlyMetadata = (message: any) => {
    if (!opts.omitBranchOrigin || !message?.metadata) return message;
    if (!('branchOrigin' in message.metadata) && !('compareAlternatives' in message.metadata)) return message;
    const { branchOrigin: _origin, compareAlternatives: _alternatives, ...metadata } = message.metadata;
    return { ...message, metadata };
  };

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

    // ENG-2163: for a non-admin viewer, drop the human-readable messages of an admin-tainted
    // turn — the assistant narration AND the user prompt that triggered the admin tool (in a
    // delegated flow that prompt is the admin's typed request, e.g. "run get_pr_digest for this
    // org", persisted as role:'user'; leaving it reveals the admin activity's subject). Tool
    // messages in the turn are already dropped by the base strip above.
    if (!viewerIsAdmin && adminTainted[i] && (message.role === 'assistant' || message.role === 'user')) {
      return false;
    }

    return true;
  }).map(stripOwnerOnlyMetadata);
}

/**
 * ENG-2163 — SCOPED admin redaction for serve paths that historically return raw messages (the
 * Emma chatbot endpoints in controllers/chatbot.ts, and sessionSummaryService's summary input).
 *
 * Unlike filterMessagesForClient this does NOT apply the agent-mode base strip — it leaves normal
 * tool/assistant messages exactly as-is, so it cannot change the chatbot's existing shape for a
 * session with no admin activity. For a non-admin viewer it removes ONLY:
 *   (a) tool-result messages whose `name` is an admin tool (the raw internal payload), and
 *   (b) assistant messages inside an admin-tainted turn (the narration/paraphrase source).
 * For an admin viewer it is a no-op (returns the input unchanged).
 */
export function redactAdminActivity(messages: any[], opts: AdminRedactionOptions = {}): any[] {
  if (!Array.isArray(messages)) return messages;
  const viewerIsAdmin = opts.viewerIsAdmin === true;
  const adminToolNameSet = new Set<string>(opts.adminToolNames ?? []);
  if (viewerIsAdmin || adminToolNameSet.size === 0) return messages;

  const adminTainted = computeAdminTaintedTurns(messages, viewerIsAdmin, adminToolNameSet);

  return messages.filter((message, i) => {
    // Drop the raw admin-tool RESULT message (its content is the internal payload).
    if (message && message.role === 'tool' && typeof message.name === 'string' && adminToolNameSet.has(message.name)) {
      return false;
    }
    // Drop the human-readable messages of an admin-tainted turn — assistant narration AND the
    // user prompt that triggered the admin tool (ENG-2163 F1: in a delegated flow the prompt is
    // the admin's request and reveals the activity's subject). Non-admin tool results elsewhere
    // in the turn are left intact — only admin-tool results (handled above) are removed.
    if (adminTainted[i] && message && (message.role === 'assistant' || message.role === 'user')) {
      return false;
    }
    return true;
  });
}

/**
 * Owner-only attribute: remove `branchedFrom` from a session-level object before it is shown to anyone but
 * the owner's own portal (MCP tools and any other external view). Works on one session or `{sessions: []}`.
 */
export function omitBranchedFrom<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const strip = (s: any) => {
    if (!s || typeof s !== 'object' || !('branchedFrom' in s)) return s;
    const { branchedFrom: _b, ...rest } = s;
    return rest;
  };
  const v: any = value;
  if (Array.isArray(v.sessions)) return { ...strip(v), sessions: v.sessions.map(strip) } as T;
  return strip(v) as T;
}
