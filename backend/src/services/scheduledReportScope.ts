/**
 * ENG-1904: can a NON-admin recipient safely receive a report that an admin-owned run produced from cross-account tools?
 *
 * The ENG-500 guard (`scheduledReportAccess.ts`) treats a run as sensitive when it called ANY cross-account tool and then only
 * lets admins receive the report. That is right for "an admin read someone else's data", but it also withholds the report
 * from the client an admin ran it FOR (the report goes to the admin instead). This module answers one narrower question,
 * per recipient: is EVERYTHING this run read about that recipient, and nothing else?
 *
 * It is a pure function of the run's persisted tool-call messages and the recipient's identity. It can only ADD a recipient
 * to those the guard already lets through; it never removes one. Every unclear case answers "no" (fail closed):
 *  - a cross-account tool that is not listed as scopable (multi-subject tools such as list_all_clients, tools that return
 *    internal data such as billing owners or admin notes, tools that match a name loosely) always stays admin-only;
 *  - a scoped call counts only if it names the recipient exactly (an email or user id, never a name), and, when the saved
 *    tool RESULT says which account it resolved, that account must be the recipient's too (a loose name match is caught here);
 *  - a call with no scope (the Meta and Google Ads tools read the CALLER's own account when `client_id` is omitted: the admin's)
 *    is not the recipient's;
 *  - any tool in the run that is neither scopable nor on the short list of tools that read no tenant data (the report
 *    builders) means the run may have read something else (the admin's own CRM, memory or files), so the recipient is not
 *    authorized;
 *  - messages that could not be read, unparseable arguments, and unknown recipients are "no".
 */

/** Argument names that name WHOSE account a tool call is about, per scopable tool. The gateway rewrites aliases before a tool runs (ENG-2610). */
const CLIENT_NAME_OR_EMAIL_KEYS = ['client_name_or_email', 'client_id', 'client_email', 'client'];
const CLIENT_ID_KEYS = ['client_id'];

export interface ScopableToolRule {
  /** Argument names that carry the subject, in the order they are read. */
  keys: string[];
  /** true: the value must be an exact email (`@`), because the tool matches names loosely. false: an email or a user id. */
  emailOnly: boolean;
}

/**
 * Cross-account tools that read ONE named account and can be scoped to a recipient. Everything else on
 * CROSS_ACCOUNT_USER_DATA_TOOLS stays admin-only for ever here.
 *  - monitor_lead_volume / read_client_meta_activity: `client_name_or_email`, matched loosely by the tool, so only an exact
 *    email counts and the saved result's own `client.userId` must agree.
 *  - the three Meta tools and the two Google Ads tools: `client_id` (email or user id, exact, admin-only, target must be a customer).
 */
export const RECIPIENT_SCOPABLE_TOOLS: Readonly<Record<string, ScopableToolRule>> = {
  monitor_lead_volume: { keys: CLIENT_NAME_OR_EMAIL_KEYS, emailOnly: true },
  read_client_meta_activity: { keys: CLIENT_NAME_OR_EMAIL_KEYS, emailOnly: true },
  list_meta_ads_campaigns: { keys: CLIENT_ID_KEYS, emailOnly: false },
  get_meta_ads_metrics: { keys: CLIENT_ID_KEYS, emailOnly: false },
  call_meta_ads_insights_api: { keys: CLIENT_ID_KEYS, emailOnly: false },
  call_google_ads_api: { keys: CLIENT_ID_KEYS, emailOnly: false },
  call_google_ads_reporting_api: { keys: CLIENT_ID_KEYS, emailOnly: false },
};

/**
 * Tools that read no tenant data of their own, so they may appear in a run that is delivered to a client: the skill
 * installer and the report builders the autonomous report plan uses. Anything not here and not scopable means the run may
 * have read something else, so the recipient is not authorized. `perform_data_analysis` reads a file by key and runs under
 * the caller's own storage access (a tool never carries admin power there), so it can read the admin's own files: a
 * documented residual (an admin-owned run also carries the admin's own memory), not something a tool-name check can see.
 */
export const RECIPIENT_NEUTRAL_REPORT_TOOLS: ReadonlyArray<string> = [
  'install_skills',
  'list_available_skills',
  'resolve_skill',
  'list_html_templates',
  'create_html_from_template',
  'perform_data_analysis',
];

export interface ToolCallRecord {
  tool: string;
  /** Where the record came from. */
  source: 'request' | 'ledger' | 'result';
  toolCallId?: string;
  /** Parsed arguments; null when there were none or they could not be parsed. */
  args: Record<string, unknown> | null;
  /** From a tool-result message: the account the tool says it resolved (`client.userId` / `client.email`), when it says. */
  resultSubject?: { userId?: string; email?: string } | null;
}

export interface RunScope {
  /** false when the messages could not be read or there were none: nothing can be proven. */
  readOk: boolean;
  /** Every tool name that appears anywhere in the run (request list, executed ledger, tool-result rows). */
  toolNames: string[];
  records: ToolCallRecord[];
}

export interface RecipientIdentity {
  userId: string;
  email: string;
}

export interface ScopeDecision {
  ok: boolean;
  /** Fixed short reasons only (never message text), for logs and tests. */
  reason?: string;
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resultSubjectOf(content: unknown): { userId?: string; email?: string } | null {
  let parsed: any = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
  }
  const client = parsed && typeof parsed === 'object' ? parsed.client : null;
  if (!client || typeof client !== 'object') return null;
  const userId = typeof client.userId === 'string' && client.userId ? client.userId : undefined;
  const email = typeof client.email === 'string' && client.email ? client.email : undefined;
  return userId || email ? { userId, email } : null;
}

/**
 * Read a run's persisted messages (the strongly consistent read of AW-ChatMessages) into a RunScope. Three sources are
 * unioned, because none is complete on its own: the assistant message's `tool_calls` (the arguments the model wrote, before
 * the gateway rewrote aliases), the executed ledger in `metadata.toolCalls` (the prepared arguments that actually ran), and
 * the tool-result rows (the only place the resolved account is recorded). Nothing is deduplicated: every record must pass.
 */
export function extractRunScope(messages: Array<Record<string, any>> | null | undefined): RunScope {
  if (!Array.isArray(messages) || messages.length === 0) return { readOk: false, toolNames: [], records: [] };
  const records: ToolCallRecord[] = [];
  const names = new Set<string>();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const tool = tc?.function?.name ?? tc?.name;
        if (typeof tool !== 'string' || !tool) continue;
        names.add(tool);
        records.push({ tool, source: 'request', toolCallId: typeof tc?.id === 'string' ? tc.id : undefined, args: parseArgs(tc?.function?.arguments ?? tc?.arguments) });
      }
    }
    const ledger = m?.metadata?.toolCalls;
    if (Array.isArray(ledger)) {
      for (const l of ledger) {
        const tool = l?.name;
        if (typeof tool !== 'string' || !tool) continue;
        names.add(tool);
        records.push({ tool, source: 'ledger', toolCallId: typeof l?.id === 'string' ? l.id : undefined, args: parseArgs(l?.arguments) });
      }
    }
    if (m.role === 'tool' && typeof m.name === 'string' && m.name) {
      names.add(m.name);
      records.push({ tool: m.name, source: 'result', toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined, args: null, resultSubject: resultSubjectOf(m.content) });
    }
  }
  return { readOk: true, toolNames: [...names], records };
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/** The subject value a call's arguments name, per the tool's rule: the first non-empty string among its keys. */
function subjectValue(rule: ScopableToolRule, args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  for (const key of rule.keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Is everything in this run about `recipient`, and nothing else? `crossAccountTools` is the guard's current list for the
 * run owner (after the ENG-2785 relaxation), so a tool the guard does not count here is not counted either.
 */
export function evaluateRunForRecipient(scope: RunScope, recipient: RecipientIdentity, crossAccountTools: ReadonlyArray<string>): ScopeDecision {
  if (!scope.readOk) return { ok: false, reason: 'messages_unreadable' };
  if (!recipient.userId || !recipient.email) return { ok: false, reason: 'recipient_unresolved' };
  const recipientEmail = norm(recipient.email);

  // Every tool the run used must be one that reads only the named client, or one that reads no tenant data at all.
  for (const tool of scope.toolNames) {
    const scopable = Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPABLE_TOOLS, tool);
    if (!scopable && !RECIPIENT_NEUTRAL_REPORT_TOOLS.includes(tool)) {
      return { ok: false, reason: crossAccountTools.includes(tool) ? 'tool_not_scopable' : 'tool_not_neutral' };
    }
  }

  // Each scopable call (every record, from every source) must name the recipient, and any resolved account must be theirs.
  let scopedRecords = 0;
  for (const r of scope.records) {
    const rule = RECIPIENT_SCOPABLE_TOOLS[r.tool];
    if (!rule || !Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPABLE_TOOLS, r.tool)) continue;
    scopedRecords++;
    if (r.source === 'result') {
      const subj = r.resultSubject;
      if (subj?.userId && subj.userId !== recipient.userId) return { ok: false, reason: 'result_other_account' };
      if (subj?.email && norm(subj.email) !== recipientEmail) return { ok: false, reason: 'result_other_account' };
      continue;
    }
    const value = subjectValue(rule, r.args);
    if (value === null) return { ok: false, reason: r.args === null ? 'arguments_unreadable' : 'scope_missing' };
    const isEmail = value.includes('@');
    if (rule.emailOnly && !isEmail) return { ok: false, reason: 'scope_not_exact' };
    if (isEmail ? norm(value) !== recipientEmail : value !== recipient.userId) return { ok: false, reason: 'scope_other_account' };
  }
  if (scopedRecords === 0) return { ok: false, reason: 'no_scoped_call' };
  // At least one request/ledger record must have carried the arguments (a lone tool-result row proves only what it resolved).
  if (!scope.records.some((r) => r.source !== 'result' && RECIPIENT_SCOPABLE_TOOLS[r.tool])) return { ok: false, reason: 'arguments_missing' };
  return { ok: true };
}
