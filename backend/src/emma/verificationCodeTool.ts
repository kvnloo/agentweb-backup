/**
 * ENG-795: read_verification_code — pull a one-time login code (or magic link)
 * out of the user's CONNECTED mailbox.
 *
 * Emma could already reach the mailbox by chaining list_connected_accounts →
 * email(search) → email(get) and reading the digits herself, but that chain has
 * no freshness contract: the previous run's code is still sitting in the inbox,
 * and re-typing it fails the login with an error the model reads as "the site is
 * broken". This tool makes the window explicit — a message older than `since`
 * can never produce a code — and returns a structured reason when there is
 * nothing to return, so a failed login stays a failed login instead of becoming
 * a fabricated one.
 *
 * Deliberately site-agnostic: the RankAI report (ENG-795/ENG-494) is the first
 * caller, but the same flow is every magic-link site we automate (ENG-475,
 * ENG-507).
 */

import { emmaToolRegistry } from './registry';
import { extractMagicLink, extractVerificationCode } from './verificationCodeExtract';

const DEFAULT_CODE_LENGTH = 6;
const DEFAULT_WAIT_SECONDS = 90;
/**
 * A whole agent-mode turn is capped at AGENT_MODE_GENERATION_TIMEOUT_MS (600s).
 * A single tool holding a big slice of that is how a turn gets killed with
 * completed work unsaved (ENG-510), so this ceiling stays well under it. Login
 * codes arrive in seconds — a longer wait buys nothing but risk.
 */
const MAX_WAIT_SECONDS = 180;
const POLL_INTERVAL_MS = 5_000;
/** How far back a message may be and still count as "this login attempt". */
const DEFAULT_FRESHNESS_GRACE_MS = 2 * 60 * 1000;
const INBOX_SCAN_SIZE = 25;
/** Bodies fetched per pass — codes land at the top of the inbox, not page 3. */
const MAX_BODIES_PER_PASS = 5;

/** Email platforms tried, in order, when the caller does not name an account. */
const AUTO_RESOLVE_PLATFORMS = ['gmail', 'outlook'] as const;

const NO_FABRICATION_NOTE =
  'Do NOT guess a code and do NOT continue as if the login succeeded — report the failure instead.';

function contains(haystack: unknown, needle?: string): boolean {
  if (!needle) return true;
  return String(haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

/** Strip the characters that would break out of a quoted Gmail search operand. */
function sanitizeQueryTerm(value: string): string {
  return value.replace(/["\\]/g, '').trim();
}

/**
 * Gmail-native query for the code email. The INBOX scan alone misses a message
 * a user filter archived, or one pushed past the scan size by a busy inbox —
 * search sees both. Deliberately wider than the caller's window (`newer_than`
 * has day granularity in Gmail, and hours are not a supported unit): the
 * precise freshness cut is applied locally against `since`, so a wide query
 * costs nothing in correctness.
 */
function buildGmailQuery(subjectContains?: string, fromContains?: string): string {
  const parts = ['newer_than:1d'];
  if (subjectContains) parts.push(`subject:"${sanitizeQueryTerm(subjectContains)}"`);
  if (fromContains) parts.push(`from:${sanitizeQueryTerm(fromContains)}`);
  return parts.join(' ');
}

function parsedTime(value: unknown): number {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Clamp the caller's wait into [0, MAX_WAIT_SECONDS]; non-numeric → the default. */
export function resolveWaitSeconds(raw: unknown): number {
  // Number(null) is 0 and Number('') is 0 — neither means "wait zero seconds",
  // they mean the caller said nothing.
  if (raw === null || raw === undefined || raw === '') return DEFAULT_WAIT_SECONDS;
  const requested = Number(raw);
  if (!Number.isFinite(requested)) return DEFAULT_WAIT_SECONDS;
  return Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS);
}

emmaToolRegistry.register({
  name: 'read_verification_code',
  definition: {
    name: 'read_verification_code',
    description:
      'Read a one-time login/verification code (or magic link) that a website just emailed to the user, from their connected mailbox (Gmail or Outlook). ' +
      'Use this for any email-code or magic-link login during browser automation: trigger the "send code" step in the browser FIRST, then call this tool. ' +
      'It only accepts messages that arrived AFTER the login attempt, so it can never hand back a stale code from a previous run. ' +
      'It polls for up to wait_seconds while the email is in flight. ' +
      'If it returns success=false, the login has NOT been unblocked: report the failure — never invent a code, and never continue as if you were logged in.',
    inputSchema: {
      type: 'object',
      properties: {
        subject_contains: {
          type: 'string',
          description: 'Only consider emails whose subject contains this text (e.g. "Login Code"). Strongly recommended.',
        },
        from_contains: {
          type: 'string',
          description: 'Only consider emails whose sender contains this text (e.g. "rankai.ai" or a full address).',
        },
        code_length: {
          type: 'number',
          description: `Number of characters in the code. Defaults to ${DEFAULT_CODE_LENGTH}.`,
        },
        alphanumeric: {
          type: 'boolean',
          description: 'Set true when the site sends letter+digit codes (e.g. "A1B2C3"). Defaults to false (digits only).',
        },
        account_id: {
          type: 'string',
          description: 'Mailbox to read, from list_connected_accounts. Omit to use the user\'s connected Gmail (or Outlook) automatically.',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp. Emails received before this are ignored. Defaults to ~2 minutes before this call, which is what makes stale codes impossible.',
        },
        wait_seconds: {
          type: 'number',
          description: `How long to keep polling while the email is in flight (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). Use 0 for a single check.`,
        },
        return_link: {
          type: 'boolean',
          description: 'Also return the sign-in link found in the email (for magic-link logins that have no typed code).',
        },
        search_query: {
          type: 'string',
          description:
            'Advanced: a provider-native search query (Gmail syntax) used instead of the query built from subject_contains/from_contains. ' +
            'On Gmail the mailbox is searched as well as scanned, so a code email a filter archived is still found; subject_contains/from_contains still apply to whatever the search returns.',
        },
      },
      required: [],
    },
  },
  internal: true,
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const codeLength = Number(args?.code_length) > 0 ? Number(args.code_length) : DEFAULT_CODE_LENGTH;
    const alphanumeric = args?.alphanumeric === true;
    const returnLink = args?.return_link === true;
    const waitSeconds = resolveWaitSeconds(args?.wait_seconds);
    const since = args?.since && !Number.isNaN(Date.parse(args.since))
      ? Date.parse(args.since)
      : Date.now() - DEFAULT_FRESHNESS_GRACE_MS;

    const { bootstrapEmailProviders, resolveEmailAccount, getEmailProvider } = await import(
      '../services/emailProviderService'
    );
    await bootstrapEmailProviders();

    // ── Resolve the mailbox ────────────────────────────────────────────────
    let provider: any;
    let accountId: string;
    let platform: string;

    if (args?.account_id) {
      try {
        const resolved = await resolveEmailAccount(userId, args.account_id);
        provider = resolved.provider;
        platform = resolved.platform;
        accountId = args.account_id;
      } catch (error: any) {
        return {
          success: false,
          reason: 'no_email_account',
          message: `${error?.message || 'Could not resolve that email account.'} ${NO_FABRICATION_NOTE}`,
        };
      }
    } else {
      const { getAccountByPlatform } = await import('../services/connectedAccountsDb');
      let account: any = null;
      let foundPlatform = '';
      for (const candidate of AUTO_RESOLVE_PLATFORMS) {
        account = await getAccountByPlatform(userId, candidate as any);
        if (account) {
          foundPlatform = candidate;
          break;
        }
      }
      if (!account) {
        return {
          success: false,
          reason: 'no_email_account',
          message:
            'No connected mailbox to read the code from. Connect Gmail or Outlook in Settings → Connected Accounts, ' +
            `then retry. ${NO_FABRICATION_NOTE}`,
        };
      }
      provider = getEmailProvider(foundPlatform as any);
      platform = foundPlatform;
      accountId = account.account_id;
    }

    // ── Poll for a fresh matching message ──────────────────────────────────
    const deadline = Date.now() + waitSeconds * 1000;
    let sawStaleMatch = false;
    let sawFreshMatchWithoutCode = false;

    for (;;) {
      // Two sources, unioned: a provider search (sees archived/filtered mail and
      // is not bounded by the scan size) and the INBOX scan (needs no query
      // support and is the only source for non-Gmail providers). A search
      // failure is non-fatal — it can only ever ADD candidates, so falling back
      // to the scan alone is exactly the behaviour we had before it existed. An
      // INBOX failure stays fatal: that is the mailbox itself being unreadable
      // (revoked token), which must not be reported as "no code arrived".
      const query = args?.search_query
        ? String(args.search_query)
        : platform === 'gmail'
          ? buildGmailQuery(args?.subject_contains, args?.from_contains)
          : null;

      let searched: any[] = [];
      if (query) {
        try {
          searched = (await provider.searchEmails(userId, accountId, query, INBOX_SCAN_SIZE)) || [];
        } catch (error: any) {
          console.warn(`[read_verification_code] Mailbox search failed, using the inbox scan only: ${error?.message || error}`);
        }
      }

      let listed: any[] = [];
      try {
        listed = (await provider.listEmails(userId, accountId, 'INBOX', INBOX_SCAN_SIZE)) || [];
      } catch (error: any) {
        return {
          success: false,
          reason: 'mailbox_error',
          message: `Could not read the mailbox: ${error?.message || String(error)}. ${NO_FABRICATION_NOTE}`,
        };
      }

      const byId = new Map<string, any>();
      for (const email of [...searched, ...listed]) {
        if (email?.id && !byId.has(email.id)) byId.set(email.id, email);
      }
      const summaries = [...byId.values()];

      const matched = (summaries || []).filter(
        (email: any) => contains(email?.subject, args?.subject_contains) && contains(email?.from, args?.from_contains)
      );
      const fresh = matched
        .filter((email: any) => parsedTime(email?.date) >= since)
        .sort((a: any, b: any) => parsedTime(b?.date) - parsedTime(a?.date));

      if (matched.length > fresh.length) sawStaleMatch = true;

      if (fresh.length > 0) {
        const ids = fresh.slice(0, MAX_BODIES_PER_PASS).map((email: any) => email.id);
        let details: any[] = [];
        try {
          details = await provider.getEmails(userId, accountId, ids);
        } catch (error: any) {
          return {
            success: false,
            reason: 'mailbox_error',
            message: `Could not read the matching email: ${error?.message || String(error)}. ${NO_FABRICATION_NOTE}`,
          };
        }

        for (const detail of details || []) {
          if (!detail || detail.error || !detail.body) continue;
          const summary = fresh.find((email: any) => email.id === detail.id);
          const code = extractVerificationCode(detail.body, { codeLength, alphanumeric });
          const magicLink = returnLink ? extractMagicLink(detail.body) : null;
          if (!code && !magicLink) continue;

          return {
            success: true,
            code: code ?? undefined,
            magic_link: magicLink ?? undefined,
            subject: detail.subject ?? summary?.subject,
            from: detail.from ?? summary?.from,
            received_at: detail.date ?? summary?.date,
            account: { platform, account_id: accountId },
          };
        }
        sawFreshMatchWithoutCode = true;
      }

      if (Date.now() + POLL_INTERVAL_MS > deadline) break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (sawFreshMatchWithoutCode) {
      return {
        success: false,
        reason: 'code_not_found',
        message:
          'A matching email arrived but no code could be read from it. Open it with the email tool to check the format ' +
          `(it may use a different length, or be a link-only email — retry with return_link=true). ${NO_FABRICATION_NOTE}`,
      };
    }

    if (sawStaleMatch) {
      return {
        success: false,
        reason: 'only_stale_matches',
        message:
          'Only older matching emails are in the mailbox — no new code has arrived for this login attempt. ' +
          'Re-trigger the "send code" step in the browser, then call this tool again. ' +
          `The old code will NOT work. ${NO_FABRICATION_NOTE}`,
      };
    }

    return {
      success: false,
      reason: 'no_matching_email',
      message:
        'No matching email arrived within the wait window. Confirm the "send code" step actually submitted ' +
        `(a failed request means no email is ever sent), then retry. ${NO_FABRICATION_NOTE}`,
    };
  },
});
