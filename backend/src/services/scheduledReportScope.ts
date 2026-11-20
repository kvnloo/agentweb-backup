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
 *  - a scoped call counts only if it names the recipient exactly (an email or user id, never a name), in EVERY subject
 *    argument the call carries (the gateway repairs aliases and only treats "", null and undefined as missing, so a blank or
 *    padded `client_name_or_email` next to a good `client_id` still reaches the tool as the blank one, and the tool then
 *    matches a loose name), and, for the two tools that match names loosely, the saved tool RESULT must say which account it
 *    resolved and that account must be the recipient's (a missing or unreadable subject is a "no");
 *  - for those two loosely matching tools EVERY call must be paired, by tool-call id, with a saved result that names the
 *    recipient: a call whose result row is missing (a lost message row, a padded value) is a "no", and so is a key the gateway
 *    would repair from another spelling (`clientNameOrEmail`, `Client_ID`, a wrapper object) that this module does not read;
 *  - a call with no scope (the Meta and Google Ads tools read the CALLER's own account when `client_id` is omitted: the admin's)
 *    is not the recipient's;
 *  - any tool in the run that is neither scopable nor on the short list of tools that read no tenant data (the report
 *    builders) means the run may have read something else (the admin's own CRM, memory or files), so the recipient is not
 *    authorized. Tool names come from the messages AND from the session's own `calledFunctions` counter, so a tool whose
 *    message rows were lost (the message write only logs after three failed retries) still counts against the recipient;
 *  - messages that could not be read or whose shape this module does not recognize, unparseable arguments, and unknown
 *    recipients are "no".
 */

import { extractToolResponseS3Ref } from '../utils/toolResponseS3Ref';

/** Argument names that name WHOSE account a tool call is about, per scopable tool. The gateway rewrites aliases before a tool runs (ENG-2610). */
const CLIENT_NAME_OR_EMAIL_KEYS = ['client_name_or_email', 'client_id', 'client_email', 'client'];
const CLIENT_ID_KEYS = ['client_id'];

export interface ScopableToolRule {
  /** Every argument name that can carry the subject. A key that is PRESENT must name the recipient, whatever its value. */
  keys: string[];
  /**
   * true: the tool matches names loosely (substring, first hit wins), so every subject value must be an exact email AND the
   * saved result must name the account it resolved. false: an email or a user id, exact (no fuzzy matching in the tool).
   */
  emailOnly: boolean;
}

/**
 * Cross-account tools that read ONE named account and can be scoped to a recipient. Everything else on
 * CROSS_ACCOUNT_USER_DATA_TOOLS stays admin-only for ever here.
 *  - monitor_lead_volume / read_client_meta_activity: `client_name_or_email`, matched loosely by the tool.
 *  - the three Meta tools and the two Google Ads tools: `client_id` (email or user id, exact, admin-only, target must be a
 *    customer; an `account_id` / `customer_id` is validated against the scoped client's own connected accounts).
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
 * installer/lister and the report builders the autonomous report plan uses. Anything not here and not scopable means the run
 * may have read something else, so the recipient is not authorized.
 *  - `resolve_skill` is NOT here: for an admin caller it scans EVERY tenant's skills and returns owner emails and visibility.
 *  - `perform_data_analysis` reads a file by key under the caller's own storage access (a tool never carries admin power
 *    there), so it can read the admin's own files and fetch public URLs: a documented residual, as is the fact that an
 *    admin-owned run also carries the admin's own memory, which no tool-name check can see.
 */
export const RECIPIENT_NEUTRAL_REPORT_TOOLS: ReadonlyArray<string> = [
  'install_skills',
  'list_available_skills',
  'list_html_templates',
  'create_html_from_template',
  'perform_data_analysis',
  // The scheduled report plan is launched and stepped through these two (copy a plan template into the session; set a step's status).
  // They read a plan definition and write session state, not tenant data.
  'launch_predefined_work_plan',
  'set_work_plan_status',
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
  /** The dispatcher collapsed this call as a same-turn duplicate of an earlier identical one: it did not run, so it read nothing. */
  suppressed?: boolean;
}

export interface RunScope {
  /** false when the messages could not be read or there were none: nothing can be proven. */
  readOk: boolean;
  /** true when a row had a shape this module does not understand (a legacy `function_call`, a nameless tool entry...): nothing can be proven. */
  unrecognized: boolean;
  /** Every tool name that appears anywhere in the run (request list, executed ledger, tool-result rows, the session's calledFunctions). */
  toolNames: string[];
  /** The session's own per-tool success counter, when it is a map (it never exceeds the number of calls that left rows). */
  toolCounts: Record<string, number>;
  /** Every tool NAME that is a key of the session's counter, zero included (a work plan decrements it per step but keeps the key). */
  countedNames: string[];
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

function subjectFrom(client: any): { userId?: string; email?: string } | null {
  if (!client || typeof client !== 'object') return null;
  const userId = typeof client.userId === 'string' && client.userId ? client.userId : undefined;
  const email = typeof client.email === 'string' && client.email ? client.email : undefined;
  return userId || email ? { userId, email } : null;
}

/** The balanced `{...}` that starts at `from` (a `{`), or null. String-aware, bounded: a tool result can be very large. */
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  const limit = Math.min(text.length, from + 4000);
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/**
 * The `client` object at the TOP LEVEL of a tool result that no longer parses as a whole. A result over the offload threshold
 * is replaced in the saved message by an S3 header (and possibly an inline-citation block) plus the first 20,000 characters of
 * the JSON, so the content has a prefix and a cut-off end. The top-level object starts at the first `{` that begins a line and
 * is followed by a key; from there a depth-tracking scan accepts a `client` key ONLY at depth 1, so a nested `client`, a `client`
 * inside a string, or a forged key whose text contains `"client":{` (JSON.stringify escapes the quote but the key text still
 * matches a naive pattern) is never read as the subject. Returns null when there is none.
 */
function topLevelClientObject(content: string): unknown | null {
  // The saved content is: [S3 header] [inline-citation block] {top-level JSON, cut off}. Strip exactly those two known
  // prefixes and require the JSON object to start right there, so a `{"client":...}` forged inside a header, a citation block or
  // a plain-text error row is never read as the top level.
  let text = content;
  const header = extractToolResponseS3Ref(text);
  if (header) text = text.slice(header.length);
  const cite = /^\[INLINE CITATIONS[\s\S]*?\n\]\n*/.exec(text);
  if (cite) text = text.slice(cite[0].length);
  text = text.replace(/^[\s\uFEFF]+/, '');
  if (!/^\{\s*"/.test(text)) return null;
  let i = 0;
  const limit = Math.min(text.length, 60000);
  let depth = 0;
  let inString = false;
  let strStart = -1;
  let expectKey = false;
  let lastKey: string | null = null;
  for (; i < limit; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') {
        inString = false;
        if (depth === 1 && expectKey) {
          try {
            lastKey = JSON.parse(text.slice(strStart, i + 1));
          } catch {
            lastKey = null;
          }
          expectKey = false;
        }
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      strStart = i;
    } else if (c === '{' || c === '[') {
      if (c === '{' && depth === 1 && lastKey === 'client') {
        const object = balancedObject(text, i);
        if (!object) return null;
        try {
          return JSON.parse(object);
        } catch {
          return null;
        }
      }
      depth++;
      if (depth === 1) expectKey = true;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth <= 0) return null;
    } else if (c === ',' && depth === 1) {
      expectKey = true;
      lastKey = null;
    }
  }
  return null;
}

/**
 * The account a tool result says it resolved. Complete JSON is read as is; an offloaded or prefixed result is read by
 * `topLevelClientObject`. When no subject can be read this returns null and the caller treats it as "no".
 */
function resultSubjectOf(content: unknown): { userId?: string; email?: string } | null {
  if (content && typeof content === 'object') return subjectFrom((content as any).client);
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content);
    return subjectFrom(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.client : null);
  } catch {
    // fall through to the offloaded / prefixed preview
  }
  return subjectFrom(topLevelClientObject(content));
}

/**
 * Read a run's persisted messages (the strongly consistent read of AW-ChatMessages) into a RunScope. Three sources are
 * unioned, because none is complete on its own: the assistant message's `tool_calls` (the arguments the model wrote, before
 * the gateway rewrote aliases), the executed ledger in `metadata.toolCalls` (the prepared arguments that actually ran, and the
 * real safeguard when the request list and the ledger differ), and the tool-result rows (the only place the resolved account
 * is recorded). Nothing is deduplicated: every record must pass. `calledFunctions` (the session's own counter) only adds tool
 * NAMES, as a second record of what ran, since the message write can fail after retries.
 */
export function extractRunScope(
  messages: Array<Record<string, any>> | null | undefined,
  calledFunctions?: Record<string, number> | string[] | null,
): RunScope {
  if (!Array.isArray(messages) || messages.length === 0) return { readOk: false, unrecognized: false, toolNames: [], toolCounts: {}, countedNames: [], records: [] };
  const records: ToolCallRecord[] = [];
  const names = new Set<string>();
  let unrecognized = false;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.function_call !== undefined) unrecognized = true; // the legacy single-call shape: not read by this module
    if (m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls)) unrecognized = true;
      else {
        for (const tc of m.tool_calls) {
          const tool = tc?.function?.name ?? tc?.name;
          if (typeof tool !== 'string' || !tool) {
            unrecognized = true;
            continue;
          }
          names.add(tool);
          records.push({ tool, source: 'request', toolCallId: typeof tc?.id === 'string' ? tc.id : undefined, args: parseArgs(tc?.function?.arguments ?? tc?.arguments) });
        }
      }
    }
    const ledger = m?.metadata?.toolCalls;
    if (ledger !== undefined) {
      if (!Array.isArray(ledger)) unrecognized = true;
      else {
        for (const l of ledger) {
          const tool = l?.name;
          if (typeof tool !== 'string' || !tool) {
            unrecognized = true;
            continue;
          }
          names.add(tool);
          records.push({ tool, source: 'ledger', toolCallId: typeof l?.id === 'string' ? l.id : undefined, args: parseArgs(l?.arguments), suppressed: l?.duplicateOf !== undefined && l?.duplicateOf !== null });
        }
      }
    }
    if (m.role === 'tool') {
      if (typeof m.name !== 'string' || !m.name) {
        unrecognized = true;
        continue;
      }
      names.add(m.name);
      // The subject is only needed (and only read, which can be costly for a large result) for the tools this module can scope.
      const scopable = Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPABLE_TOOLS, m.name);
      records.push({
        tool: m.name,
        source: 'result',
        toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined,
        args: null,
        resultSubject: scopable ? resultSubjectOf(m.content) : null,
        suppressed: m?.metadata?.duplicateSuppressed === true,
      });
    }
  }
  const counted = Array.isArray(calledFunctions) ? calledFunctions : calledFunctions && typeof calledFunctions === 'object' ? Object.keys(calledFunctions) : [];
  for (const n of counted) if (typeof n === 'string' && n) names.add(n);
  const toolCounts: Record<string, number> = {};
  if (calledFunctions && typeof calledFunctions === 'object' && !Array.isArray(calledFunctions)) {
    for (const [k, v] of Object.entries(calledFunctions)) if (typeof v === 'number' && Number.isFinite(v)) toolCounts[k] = v;
  }
  return { readOk: true, unrecognized, toolNames: [...names], toolCounts, countedNames: counted.filter((n): n is string => typeof n === 'string' && !!n), records };
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');
/** The gateway matches argument names after this normalisation (agentToolGatewayService normalizeArgName), so a spelling it repairs must be seen here. */
const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Is any key at any depth (bounded) a spelling of a subject key other than the exact top-level key this module reads? */
function hasSubjectKeyVariant(args: Record<string, unknown>, rule: ScopableToolRule): boolean {
  const subjectNorms = new Set(rule.keys.map(normKey));
  const exact = new Set(rule.keys);
  let budget = 2000;
  // Fail closed when the arguments are deeper or larger than this walk will read: a subject key could hide there.
  const walk = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (depth > 4 || budget <= 0) return true;
    if (Array.isArray(value)) {
      for (const v of value) if (v && typeof v === 'object' && walk(v, depth + 1)) return true; // primitives cannot carry a key
      return false;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      budget--;
      if (subjectNorms.has(normKey(k)) && !(depth === 0 && exact.has(k))) return true;
      if (walk(v, depth + 1)) return true;
    }
    return false;
  };
  return walk(args, 0);
}

/**
 * Is everything in this run about `recipient`, and nothing else?
 */
export function evaluateRunForRecipient(scope: RunScope, recipient: RecipientIdentity): ScopeDecision {
  if (!scope.readOk) return { ok: false, reason: 'messages_unreadable' };
  if (scope.unrecognized) return { ok: false, reason: 'messages_unrecognized' };
  if (!recipient.userId || !recipient.email) return { ok: false, reason: 'recipient_unresolved' };
  const recipientEmail = norm(recipient.email);

  // Every tool the run used must be one that reads only the named client, or one that reads no tenant data at all.
  for (const tool of scope.toolNames) {
    const scopable = Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPABLE_TOOLS, tool);
    if (!scopable && !RECIPIENT_NEUTRAL_REPORT_TOOLS.includes(tool)) return { ok: false, reason: 'tool_not_allowed' };
  }

  // Pair every call with its result by tool-call id. The message write can lose rows (it only logs after three failed retries),
  // so a loosely matching tool needs a result that names the account for EACH call it made, and the session's own counter must
  // not show more calls to a scopable tool than left rows.
  const idsByTool: Record<string, Set<string>> = {};
  const resultIdsByTool: Record<string, Set<string>> = {};
  for (const r of scope.records) {
    const rule = Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPABLE_TOOLS, r.tool) ? RECIPIENT_SCOPABLE_TOOLS[r.tool] : null;
    if (!rule) continue;
    if (!r.toolCallId) {
      if (r.source !== 'result' && rule.emailOnly) return { ok: false, reason: 'call_id_missing' };
      continue;
    }
    (idsByTool[r.tool] ||= new Set()).add(r.toolCallId);
    if (r.source === 'result') (resultIdsByTool[r.tool] ||= new Set()).add(r.toolCallId);
  }
  const suppressedIds = new Set(scope.records.filter((r) => r.suppressed && r.toolCallId).map((r) => r.toolCallId as string));
  for (const tool of Object.keys(RECIPIENT_SCOPABLE_TOOLS)) {
    const ids = idsByTool[tool]?.size ?? 0;
    if ((scope.toolCounts[tool] ?? 0) > ids) return { ok: false, reason: 'rows_missing' };
    // A work plan decrements the counter per step (to 0, keeping the key) and resets it on launch, so the count cannot show a
    // missing call there; but a scopable tool that is a KEY of the counter and left no row at all lost every one of its rows.
    if (scope.countedNames.includes(tool) && !scope.records.some((r) => r.tool === tool)) return { ok: false, reason: 'rows_missing' };
    if (RECIPIENT_SCOPABLE_TOOLS[tool].emailOnly) {
      // A call the dispatcher collapsed as a same-turn duplicate never ran, so it has no result of its own.
      for (const id of idsByTool[tool] ?? []) if (!resultIdsByTool[tool]?.has(id) && !suppressedIds.has(id)) return { ok: false, reason: 'result_missing' };
    }
  }

  // Each scopable call (every record, from every source) must name the recipient, and any resolved account must be theirs.
  let scopedRecords = 0;
  for (const r of scope.records) {
    if (!Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPABLE_TOOLS, r.tool)) continue;
    const rule = RECIPIENT_SCOPABLE_TOOLS[r.tool];
    scopedRecords++;
    if (r.source === 'result') {
      if (r.suppressed) continue;
      const subj = r.resultSubject;
      if (!subj && rule.emailOnly) return { ok: false, reason: 'result_subject_unreadable' };
      if (subj?.userId && subj.userId !== recipient.userId) return { ok: false, reason: 'result_other_account' };
      if (subj?.email && norm(subj.email) !== recipientEmail) return { ok: false, reason: 'result_other_account' };
      continue;
    }
    if (r.args === null) return { ok: false, reason: 'arguments_unreadable' };
    if (hasSubjectKeyVariant(r.args, rule)) return { ok: false, reason: 'scope_key_variant' };
    // EVERY subject key the call carries must name the recipient: a present key of any type, blank included, is a subject.
    let named = 0;
    for (const key of rule.keys) {
      if (!Object.prototype.hasOwnProperty.call(r.args, key)) continue;
      const raw = r.args[key];
      if (raw === undefined || raw === null) continue; // the gateway treats these as missing too
      if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'scope_blank' };
      const value = raw.trim();
      const isEmail = value.includes('@');
      if (rule.emailOnly && !isEmail) return { ok: false, reason: 'scope_not_exact' };
      if (isEmail ? norm(value) !== recipientEmail : value !== recipient.userId) return { ok: false, reason: 'scope_other_account' };
      named++;
    }
    if (named === 0) return { ok: false, reason: 'scope_missing' };
  }
  if (scopedRecords === 0) return { ok: false, reason: 'no_scoped_call' };
  // At least one request/ledger record must have carried the arguments (a lone tool-result row proves only what it resolved).
  if (!scope.records.some((r) => r.source !== 'result' && Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPABLE_TOOLS, r.tool))) return { ok: false, reason: 'arguments_missing' };
  return { ok: true };
}
