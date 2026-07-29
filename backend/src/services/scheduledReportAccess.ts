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
  const authorized: string[] = [];
  const withheld: string[] = [];

  for (const email of recipients) {
    const normalized = (email || '').toLowerCase();
    if (!normalized) {
      continue;
    }
    // Owner is always authorized to receive their own run's output.
    if (normalized === normalizedOwner) {
      authorized.push(email);
      continue;
    }
    let isAdmin = false;
    try {
      const user = await userDb.getUserByEmail(normalized);
      isAdmin = (user as any)?.isAdmin === true;
    } catch {
      isAdmin = false; // fail-closed: unverifiable recipient is withheld
    }
    if (isAdmin) {
      authorized.push(email);
    } else {
      withheld.push(email);
    }
  }

  // Ensure the owner receives the report + the withholding notice (custodian of
  // the run's output) when something was withheld, or when no authorized
  // recipient remains so the deliverable is not silently dropped.
  if (
    ownerEmail &&
    normalizedOwner &&
    !authorized.some((e) => e.toLowerCase() === normalizedOwner) &&
    (withheld.length > 0 || authorized.length === 0)
  ) {
    authorized.push(ownerEmail);
  }

  return { authorized, withheld, restricted: true };
}
