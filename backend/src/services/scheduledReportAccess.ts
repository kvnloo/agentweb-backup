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

// Admin-only tools that READ other users' cross-account data. Curated subset of
// ADMIN_SKILL_TOOL_NAMES (agentModeService) — only the tools whose output can
// place another account's data into a report. Keep this list complete: a
// missing entry is a false-negative that lets cross-account data through.
export const CROSS_ACCOUNT_USER_DATA_TOOLS = [
  'get_chat_history',
  'list_all_clients',
  'assess_client_health',
  'manage_user_notes',
  'get_users_by_lifecycle_stage',
  'get_registration_status',
];

/**
 * True when the run called any tool that reads cross-account user data, so its
 * report must be treated as sensitive for distribution. Accepts the session's
 * `calledFunctions` in either shape (map of name->count, or an array of names).
 */
export function reportContainsCrossAccountData(
  calledFunctions?: Record<string, number> | string[] | null
): boolean {
  if (!calledFunctions) return false;
  const names = Array.isArray(calledFunctions)
    ? calledFunctions
    : Object.keys(calledFunctions);
  return names.some((n) => CROSS_ACCOUNT_USER_DATA_TOOLS.includes(n));
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
  messages: Array<Record<string, any>> | null | undefined
): boolean {
  if (!messages || messages.length === 0) return false;
  for (const m of messages) {
    const toolCalls = m?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const name = tc?.function?.name ?? tc?.name;
        if (name && CROSS_ACCOUNT_USER_DATA_TOOLS.includes(name)) return true;
      }
    }
    const directName = m?.name; // tool-result messages carry the tool name
    if (directName && CROSS_ACCOUNT_USER_DATA_TOOLS.includes(directName)) return true;
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
