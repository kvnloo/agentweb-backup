import { userDb } from './db';

/**
 * Recipient-authorization guard for scheduled-report email delivery (ENG-500
 * follow-up).
 *
 * A scheduled report is auto-emailed to whatever addresses the schedule owner
 * configured (`emailNotifications`) with no recipient-level authorization. That
 * is fine for ordinary reports, but when a run read CROSS-ACCOUNT user data via
 * an admin-only tool (e.g. list_all_clients / get_chat_history), the rendered
 * report can contain other users' identities/records. Distributing that to a
 * recipient who is not entitled to see it is a data-exposure. This guard
 * restricts such reports to authorized (admin) recipients, always keeping the
 * schedule owner, and reports which recipients were withheld so the owner can
 * fix the configuration.
 *
 * Ordinary reports (no cross-account tool used) are a no-op — full recipient
 * list, unchanged behavior.
 */

// Tools whose output can place another account's data into a report. Mostly a
// curated subset of ADMIN_SKILL_TOOL_NAMES (agentModeService) — those are
// admin-only end to end. The 3 ENG-1801 entries below are an exception: they
// are ordinary customer-facing tools that only read cross-account data when
// the caller is an admin AND passes client_id (see getMetaCredentials);
// listed here unconditionally since this guard has no way to see whether a
// given historical run's calledFunctions entry was client_id-scoped, and
// treating every call as potentially cross-account is the safe direction of
// error. Keep this list complete: a missing entry is a false-negative that
// lets cross-account data through.
export const CROSS_ACCOUNT_USER_DATA_TOOLS = [
  'get_chat_history',
  'get_session_transcript',
  'get_user_by_id',
  'inspect_client_usage',
  'list_all_clients',
  'assess_client_health',
  'monitor_lead_volume',
  'check_account_tracking_health',
  'read_client_meta_activity',
  'diagnose_leads_at_zero',
  'manage_user_notes',
  'get_users_by_lifecycle_stage',
  'get_registration_status',
  'list_meta_ads_campaigns',
  'call_meta_ads_insights_api',
  'get_meta_ads_metrics',
  // ENG-1904: the Google Ads tools take the same admin-only `client_id` as the Meta tools (resolveGoogleAdsCredentialScope)
  // and were never on this list, so an admin-run report built from a client's Google Ads account reached any recipient.
  // Treated exactly like the Meta tools: see ADMIN_SCOPED_CROSS_ACCOUNT_TOOLS.
  'call_google_ads_api',
  'call_google_ads_reporting_api',
];

// ENG-2785: the ENG-1801 Meta Ads tools are customer-facing. They can only read
// another account's data when the CALLER is a platform admin passing client_id
// (getMetaCredentials ignores client_id for everyone else), so for a run owned
// by a positively-verified NON-admin they read only the owner's own account and
// must not make the report sensitive. Unknown owner admin status stays on the
// safe side (full list).
export const ADMIN_SCOPED_CROSS_ACCOUNT_TOOLS = [
  'list_meta_ads_campaigns',
  'call_meta_ads_insights_api',
  'get_meta_ads_metrics',
  // ENG-1904: same rule for the Google Ads tools (customer tools; only an admin's `client_id` reaches another account).
  'call_google_ads_api',
  'call_google_ads_reporting_api',
];

export interface CrossAccountClassifyOptions {
  /**
   * The run/schedule owner's platform admin status. Only an explicit `false`
   * (owner looked up and verified non-admin) relaxes classification.
   */
  ownerIsAdmin?: boolean;
}

export function crossAccountToolsFor(opts?: CrossAccountClassifyOptions): string[] {
  if (opts?.ownerIsAdmin === false) {
    return CROSS_ACCOUNT_USER_DATA_TOOLS.filter((t) => !ADMIN_SCOPED_CROSS_ACCOUNT_TOOLS.includes(t));
  }
  return CROSS_ACCOUNT_USER_DATA_TOOLS;
}

/**
 * True when the run called any tool that reads cross-account user data, so its
 * report must be treated as sensitive for distribution. Accepts the session's
 * `calledFunctions` in either shape (map of name->count, or an array of names).
 */
export function reportContainsCrossAccountData(
  calledFunctions?: Record<string, number> | string[] | null,
  opts?: CrossAccountClassifyOptions,
): boolean {
  if (!calledFunctions) return false;
  const names = Array.isArray(calledFunctions)
    ? calledFunctions
    : Object.keys(calledFunctions);
  const tools = crossAccountToolsFor(opts);
  return names.some((n) => tools.includes(n));
}

/**
 * Authoritative cross-account detection from the run's tool-call MESSAGE
 * records. `calledFunctions` is a best-effort aggregate counter whose write
 * errors are swallowed at the call site (agentModeService), so a successful
 * cross-account tool call can be missing from it — relying on the counter alone
 * fails open. The tool-call messages are the source of truth for what actually
 * ran, so this is used to confirm a report is safe before broadcasting it.
 *
 * Scans each message for a cross-account tool name in either an assistant
 * message's `tool_calls[].function.name` or a tool-result message's `name`.
 */
export function messagesReferenceCrossAccountTool(
  messages: Array<Record<string, any>> | null | undefined,
  opts?: CrossAccountClassifyOptions,
): boolean {
  if (!messages || messages.length === 0) return false;
  const tools = crossAccountToolsFor(opts);
  for (const m of messages) {
    const toolCalls = m?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const name = tc?.function?.name ?? tc?.name;
        if (name && tools.includes(name)) return true;
      }
    }
    const directName = m?.name; // tool-result messages carry the tool name
    if (directName && tools.includes(directName)) return true;
  }
  return false;
}

export interface RecipientAuthzResult {
  /** Addresses the report may be delivered to. */
  authorized: string[];
  /** Configured addresses withheld because they are not authorized. */
  withheld: string[];
  /** Whether any filtering was applied (i.e. the report was treated sensitive). */
  restricted: boolean;
}

/**
 * Restrict a sensitive scheduled report to recipients authorized to see
 * cross-account user data (admins), always keeping the owner.
 *
 * Fail-closed: any recipient we cannot POSITIVELY verify as an admin (lookup
 * miss, deleted user, or lookup error) is withheld. The owner is always treated
 * as authorized (they own the run and are an admin, since they invoked the
 * admin tool) and, when anything was withheld or no authorized recipient
 * remains, is added so the report — and the withholding notice — still lands.
 *
 * For a non-sensitive report this is a pass-through: the full recipient list is
 * returned unchanged.
 */
export async function resolveAuthorizedReportRecipients(params: {
  recipients: string[];
  ownerEmail?: string | null;
  isSensitive: boolean;
}): Promise<RecipientAuthzResult> {
  const { recipients, ownerEmail, isSensitive } = params;

  if (!isSensitive) {
    return { authorized: [...recipients], withheld: [], restricted: false };
  }

  const normalizedOwner = ownerEmail ? ownerEmail.toLowerCase() : undefined;

  // Verify current admin status per address, cached so the owner (which may also
  // appear in the recipient list) is looked up at most once. Fail-closed: an
  // unverifiable address is treated as non-admin.
  const adminCache = new Map<string, boolean>();
  const isAdminEmail = async (normalized: string): Promise<boolean> => {
    if (adminCache.has(normalized)) return adminCache.get(normalized)!;
    let ok = false;
    try {
      ok = ((await userDb.getUserByEmail(normalized)) as any)?.isAdmin === true;
    } catch {
      ok = false;
    }
    adminCache.set(normalized, ok);
    return ok;
  };

  const authorized: string[] = [];
  const withheld: string[] = [];

  for (const email of recipients) {
    const normalized = (email || '').toLowerCase();
    if (!normalized) {
      continue;
    }
    // No special-casing for the owner: authorization is the recipient's CURRENT
    // admin status, so an owner whose admin access was revoked before delivery
    // is withheld like anyone else.
    if (await isAdminEmail(normalized)) {
      authorized.push(email);
    } else {
      withheld.push(email);
    }
  }

  // Add the owner (custodian of the run's output) so the report + withholding
  // notice still lands when something was withheld or no authorized recipient
  // remains — but ONLY if the owner is CURRENTLY an admin (revocation-safe).
  if (
    ownerEmail &&
    normalizedOwner &&
    !authorized.some((e) => e.toLowerCase() === normalizedOwner) &&
    (withheld.length > 0 || authorized.length === 0) &&
    (await isAdminEmail(normalizedOwner))
  ) {
    authorized.push(ownerEmail);
  }

  return { authorized, withheld, restricted: true };
}

// ── Delivery state + remediation (ENG-1552) ─────────────────────────────────
//
// SHADOW MODE BY DEFAULT. Everything customer-visible that ENG-1552 adds — the
// activation 400s, skipping generation, withholding empty reports, restricting
// digests, the read-back field — only takes effect when
// SCHEDULED_REPORT_DELIVERY_ENFORCEMENT=true. Until then each check still runs and
// what it WOULD have done is logged (`[ENG-1552 shadow]`) and recorded internally,
// so it can be watched and tuned before any customer sees it (user decision,
// 2026-09-18). Customer behavior with the flag unset is unchanged from before.

export function deliveryEnforcementEnabled(): boolean {
  return process.env.SCHEDULED_REPORT_DELIVERY_ENFORCEMENT === 'true';
}

/**
 * ENG-1904: whether a NON-admin recipient may receive an admin-owned run's report when everything the run read was about
 * that recipient (`scheduledReportScope.ts`). OFF by default: with the flag unset the guard behaves exactly as before and
 * only logs what it WOULD have done (`[ENG-1904 shadow]`). A separate flag from ENG-1552's, because that one is already
 * understood as the delivery-log rollout and this one widens who receives data.
 */
export function recipientScopingEnabled(): boolean {
  return process.env.SCHEDULED_REPORT_RECIPIENT_SCOPING === 'true';
}

/** One grep-able line per decision shadow mode did not act on. */
export function logShadowDecision(wouldHave: string, detail: Record<string, unknown>): void {
  console.warn(`[ENG-1552 shadow] would have ${wouldHave}: ${JSON.stringify(detail)}`);
}
//
// The guard above decides WHO may receive a sensitive report, but only at send
// time and without leaving a trace. What follows is the state around it: each
// run's delivery outcome is persisted on the schedule as a `deliveryLog`, and a
// schedule that cannot deliver gets one remediation object naming the fix.

export type ReportDeliveryState =
  | 'generated'
  | 'withheld'
  | 'delivery_attempted'
  | 'delivered'
  | 'recipient_confirmed';

export type ReportDeliveryReason =
  | 'no_authorized_recipients'
  | 'empty_content'
  | 'provider_error'
  | 'suppressed_nonprod';

export interface ReportDeliveryLogEntry {
  runId: string;
  state: ReportDeliveryState;
  reason?: ReportDeliveryReason;
  authorizedRecipients?: string[];
  withheldRecipients?: string[];
  missingPermission?: string;
  /** recipient_confirmed only: who recorded the confirmation. */
  confirmedBy?: string;
  at: string;
}

export type RecipientRemediationCode = 'no_authorized_recipients';

export interface RecipientRemediation {
  code: RecipientRemediationCode;
  scheduleId: string;
  runId?: string;
  owner: string;
  /**
   * ONLY the subset of the schedule's OWN configured recipients that qualify —
   * never the platform admin roster. Listing that to a customer would itself be
   * the cross-account leak this guard exists to prevent.
   */
  eligibleRecipients: string[];
  missingPermission: string;
  /** One of a fixed set of sentences — never interpolated upstream error text. */
  safeAction: string;
}

const REMEDIATION_SAFE_ACTION: Record<RecipientRemediationCode, string> = {
  no_authorized_recipients:
    'This report uses cross-account data, so it can only be sent to admin users. Add an admin recipient, or remove the cross-account tools from the schedule, then run it again.',
};

const REMEDIATION_MISSING_PERMISSION: Record<RecipientRemediationCode, string> = {
  no_authorized_recipients: 'isAdmin',
};

export function buildRecipientRemediation(params: {
  code: RecipientRemediationCode;
  scheduleId: string;
  owner?: string | null;
  runId?: string;
  eligibleRecipients?: string[];
}): RecipientRemediation {
  return {
    code: params.code,
    scheduleId: params.scheduleId,
    ...(params.runId ? { runId: params.runId } : {}),
    owner: params.owner || 'unknown',
    eligibleRecipients: [...(params.eligibleRecipients || [])],
    missingPermission: REMEDIATION_MISSING_PERMISSION[params.code],
    safeAction: REMEDIATION_SAFE_ACTION[params.code],
  };
}

/**
 * Whether a schedule should be treated as producing a sensitive report BEFORE it
 * runs. Two cheap signals: the previous run actually used a cross-account tool
 * (`lastKnownSensitive`), or the schedule requires one. The second matters
 * because the first only exists after a run has already paid for generation.
 * This only decides whether to check recipients early; the send-time guard
 * still re-classifies every run on its own.
 */
export function scheduleLikelySensitive(schedule: {
  lastKnownSensitive?: boolean;
  requiredFunctionCalls?: string[] | null;
} | null | undefined, opts?: CrossAccountClassifyOptions): boolean {
  if (!schedule) return false;
  return schedule.lastKnownSensitive === true || reportContainsCrossAccountData(schedule.requiredFunctionCalls || null, opts);
}

/**
 * Persist one delivery-state transition. Best-effort by design: losing a log
 * entry must never fail a run or an email, so this never throws.
 */
export async function recordReportDeliveryState(
  scheduleId: string | undefined | null,
  entry: Omit<ReportDeliveryLogEntry, 'at'> & { at?: string },
  extra?: { lastKnownSensitive?: boolean },
): Promise<void> {
  if (!scheduleId) return;
  try {
    const { scheduleDb } = await import('./db');
    await scheduleDb.appendDeliveryLogEntry(scheduleId, { ...entry, at: entry.at || new Date().toISOString() }, extra);
  } catch (error) {
    console.error(`Failed to record delivery state "${entry.state}" for schedule ${scheduleId}:`, error);
  }
}

/**
 * ENG-1552 activation gate: a schedule that will deliver a cross-account report
 * must have at least one recipient allowed to receive it. Returns the remediation
 * to send back, or null when the schedule may go live.
 *
 * Only the "authorized" half is checked here. "At least one recipient" is already
 * held where it applies (create falls back to the requester's address; update
 * refuses to clear the last one, ENG-1836), and a schedule with no recipients —
 * a pre-filled silent run, an auto-created outreach schedule (ENG-1723) —
 * delivers nothing externally, so there is nothing to authorize.
 */
export async function checkScheduleActivationRecipients(params: {
  scheduleId: string;
  recipients: string[];
  ownerEmail?: string | null;
  schedule: { lastKnownSensitive?: boolean; requiredFunctionCalls?: string[] | null };
  ownerIsAdmin?: boolean;
}): Promise<RecipientRemediation | null> {
  const recipients = (params.recipients || []).filter(Boolean);
  if (recipients.length === 0 || !scheduleLikelySensitive(params.schedule, { ownerIsAdmin: params.ownerIsAdmin })) return null;
  const authz = await resolveAuthorizedReportRecipients({ recipients, ownerEmail: params.ownerEmail, isSensitive: true });
  if (authz.authorized.length > 0) return null;
  return buildRecipientRemediation({
    code: 'no_authorized_recipients',
    scheduleId: params.scheduleId,
    owner: params.ownerEmail,
    eligibleRecipients: authz.authorized,
  });
}

/**
 * ENG-1552 read-back: the most recent delivery-state entry for each run, keyed by
 * runId. The log is append-only and ordered, so the last entry for a run wins.
 */
export function latestDeliveryByRun(
  log: ReportDeliveryLogEntry[] | null | undefined,
): Record<string, ReportDeliveryLogEntry> {
  const latest: Record<string, ReportDeliveryLogEntry> = {};
  for (const entry of Array.isArray(log) ? log : []) {
    if (entry && typeof entry.runId === 'string') latest[entry.runId] = entry;
  }
  return latest;
}
