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
/**
 * How far back a message may be and still count as "this login attempt" — only
 * as a last resort (see partitionByArrival). Sized to cover clock skew on the
 * sender's Date header plus the seconds between triggering "send code" and this
 * call, and no more: every extra second widens the window in which the previous
 * attempt's code could be mistaken for this one's.
 */
const DEFAULT_FRESHNESS_GRACE_MS = 60 * 1000;
const INBOX_SCAN_SIZE = 25;
/** Bodies fetched per pass — codes land at the top of the inbox, not page 3. */
const MAX_BODIES_PER_PASS = 5;

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

/**
 * When the provider received the message.
 *
 * Deliberately NOT the Date header: Gmail populates `date` from the sender's own
 * header, so a sender whose clock runs fast stamps a previous email into our
 * future and it would be read as having arrived after this call — the stale-code
 * path all over again (Greptile P1). `receivedAt` is server-stamped (Gmail
 * internalDate, Outlook receivedDateTime) and cannot be moved by the sender.
 *
 * A message with no server timestamp gets 0, i.e. sorts as stale: unknown
 * arrival is not evidence of a fresh code.
 */
function arrivalTime(email: any): number {
  return parsedTime(email?.receivedAt);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Split matching messages by when they arrived relative to THIS call.
 *
 * The grace window exists to absorb clock skew and the seconds between the
 * agent triggering "send code" and calling this tool. On its own it also admits
 * the PREVIOUS attempt's code when that happened to arrive moments earlier —
 * exactly the stale-code failure this tool exists to prevent (Greptile P1). So
 * the buckets stay separate and the caller prefers `arrivedAfterCall`, falling
 * back to `withinGrace` only once there is no time left for a newer message.
 *
 * An unparseable or absent server timestamp sorts as stale: a message we cannot
 * place in time is not evidence of a fresh code.
 */
export function partitionByArrival(
  emails: any[],
  window: { since: number; invokedAt: number }
): { arrivedAfterCall: any[]; withinGrace: any[]; stale: any[] } {
  const arrivedAfterCall: any[] = [];
  const withinGrace: any[] = [];
  const stale: any[] = [];

  for (const email of emails || []) {
    const at = arrivalTime(email);
    if (at >= window.invokedAt) arrivedAfterCall.push(email);
    else if (at >= window.since) withinGrace.push(email);
    else stale.push(email);
  }

  const newestFirst = (a: any, b: any) => arrivalTime(b) - arrivalTime(a);
  return {
    arrivedAfterCall: arrivedAfterCall.sort(newestFirst),
    withinGrace: withinGrace.sort(newestFirst),
    stale: stale.sort(newestFirst),
  };
}

/** Domain of an email address, from a bare or display-name form. Null if absent. */
export function senderDomain(from: unknown): string | null {
  const match = String(from ?? '').match(/[^\s<>"']+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Does this message's From satisfy the caller's sender filter?
 *
 * A bare substring test is too loose when the filter is a domain: "rankai.ai"
 * appears in `no-reply@rankai.ai.evil.example.com`, so a lookalike sender would
 * pass the filter and get its content treated as the expected email. When the
 * filter looks like a domain it is matched against the parsed sender domain
 * (exact or subdomain); anything else (a full address, a display name) keeps the
 * substring behaviour.
 */
export function senderMatches(from: unknown, filter?: string): boolean {
  if (!filter) return true;
  const wanted = filter.toLowerCase().trim();
  const looksLikeDomain = !wanted.includes('@') && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(wanted);
  if (looksLikeDomain) {
    const domain = senderDomain(from);
    return domain === wanted || Boolean(domain?.endsWith(`.${wanted}`));
  }
  return String(from ?? '').toLowerCase().includes(wanted);
}

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
      'It only accepts messages that arrived AFTER this call, so it can never hand back a stale code from a previous run — ' +
      'trigger the "send code" step FIRST, then call this. If it reports code_predates_call, re-trigger the send and call again. ' +
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
          description:
            'ISO 8601 timestamp — the moment you triggered the "send code" step. Emails received before it are ignored. ' +
            'Omit it and only emails arriving AFTER this call are accepted, which is what makes a stale code impossible: ' +
            'set it only when the code email may have landed before you got here, and you know it belongs to this attempt.',
        },
        wait_seconds: {
          type: 'number',
          description: `How long to keep polling while the email is in flight (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). Use 0 for a single check.`,
        },
        return_link: {
          type: 'boolean',
          description:
            'Also return the sign-in link found in the email (for magic-link logins that have no typed code). ' +
            'Only a link on the sender\'s own domain is returned — a link pointing anywhere else is ignored, not handed back.',
        },
        link_host: {
          type: 'string',
          description:
            'REQUIRED with return_link — the domain the sign-in link must be on (e.g. "lu.ma"). ' +
            'It is not inferred from the email: the expected domain has to come from you, or a spoofed sender would ' +
            'choose where you get sent. A link pointing anywhere else is ignored, not returned.',
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
    const linkHost = typeof args?.link_host === 'string' ? args.link_host.trim().toLowerCase() : '';
    const invokedAt = Date.now();
    const hasExplicitSince = Boolean(args?.since) && !Number.isNaN(Date.parse(args?.since));
    const since = hasExplicitSince
      ? Date.parse(args.since)
      : invokedAt - DEFAULT_FRESHNESS_GRACE_MS;

    const { bootstrapEmailProviders, resolveEmailAccount, resolveDefaultEmailAccount } = await import(
      '../services/emailProviderService'
    );
    await bootstrapEmailProviders();

    // ── Resolve the mailbox ────────────────────────────────────────────────
    // Both paths resolve over the accounts the caller can actually reach — own
    // AND org-shared — which is the same set list_connected_accounts reports.
    // Reading only the caller's own record made a shared mailbox listed as
    // active unusable here, and left an unattended run with no way to finish an
    // email-code login (ENG-943).
    let provider: any;
    let accountId: string;
    let platform: string;
    // The mailbox's owner, which is whose record the provider must authenticate
    // against — not necessarily the caller.
    let mailboxUserId: string;

    if (args?.account_id) {
      try {
        const resolved = await resolveEmailAccount(userId, args.account_id);
        provider = resolved.provider;
        platform = resolved.platform;
        accountId = resolved.accountId;
        mailboxUserId = resolved.ownerUserId;
      } catch (error: any) {
        return {
          success: false,
          reason: 'no_email_account',
          message: `${error?.message || 'Could not resolve that email account.'} ${NO_FABRICATION_NOTE}`,
        };
      }
    } else {
      // A lookup failure here is not "no mailbox connected" — saying so would
      // send an unattended run off to report a missing account when the account
      // is fine and the read simply failed. Report it as a mailbox error, the
      // same reason the provider read failures below use.
      let resolved: Awaited<ReturnType<typeof resolveDefaultEmailAccount>>;
      try {
        resolved = await resolveDefaultEmailAccount(userId);
      } catch (error: any) {
        return {
          success: false,
          reason: 'mailbox_error',
          message: `Could not resolve a mailbox to read the code from: ${error?.message || error}. ${NO_FABRICATION_NOTE}`,
        };
      }
      if (!resolved) {
        return {
          success: false,
          reason: 'no_email_account',
          message:
            'No connected mailbox to read the code from. Connect Gmail or Outlook in Settings → Connected Accounts, ' +
            `then retry. ${NO_FABRICATION_NOTE}`,
        };
      }
      provider = resolved.provider;
      platform = resolved.platform;
      accountId = resolved.accountId;
      mailboxUserId = resolved.ownerUserId;
    }

    // Sharing is checked once, above, but the loop below reads the mailbox for
    // up to MAX_WAIT_SECONDS across ~36 rounds, always authenticating as the
    // owner captured at resolution. On a teammate's shared mailbox that leaves a
    // window in which the owner stops sharing and the caller still receives a
    // code that arrived afterwards. The share dialog tells an admin they can
    // "stop sharing at any time", so revocation has to bite inside the call.
    //
    // The caller's OWN mailbox cannot be un-shared from under them, so it is
    // never re-checked and pays nothing — which is every caller outside an org.
    const stillAccessible = async (): Promise<boolean> => {
      if (mailboxUserId === userId) return true;
      try {
        const recheck = await resolveEmailAccount(userId, accountId);
        // Owner changed ⇒ this is no longer the mailbox we were authorised for.
        return recheck.ownerUserId === mailboxUserId;
      } catch {
        return false;
      }
    };

    // ── Poll for a fresh matching message ──────────────────────────────────
    const deadline = Date.now() + waitSeconds * 1000;
    let sawStaleMatch = false;
    let sawPreCallMatch = false;
    let sawFreshMatchWithoutCode = false;

    for (;;) {
      if (!(await stillAccessible())) {
        return {
          success: false,
          reason: 'mailbox_error',
          message:
            `Access to mailbox "${accountId}" ended while waiting for the code — its owner stopped sharing it ` +
            `with your organization. ${NO_FABRICATION_NOTE}`,
        };
      }

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
          searched = (await provider.searchEmails(mailboxUserId, accountId, query, INBOX_SCAN_SIZE)) || [];
        } catch (error: any) {
          console.warn(`[read_verification_code] Mailbox search failed, using the inbox scan only: ${error?.message || error}`);
        }
      }

      let listed: any[] = [];
      try {
        listed = (await provider.listEmails(mailboxUserId, accountId, 'INBOX', INBOX_SCAN_SIZE)) || [];
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
        (email: any) => contains(email?.subject, args?.subject_contains) && senderMatches(email?.from, args?.from_contains)
      );
      const arrival = partitionByArrival(matched, { since, invokedAt });
      // A message that predates this call is only acceptable when the CALLER
      // anchored the window with an explicit `since` — they know when they
      // triggered the send, we don't. On a default call it is never returned:
      // it may be the previous attempt's code, and handing back a stale code
      // with success:true is the precise failure this tool exists to prevent.
      // The honest alternative ("no code arrived — re-trigger the send") is
      // recoverable in a way that typing the wrong code is not.
      const fresh = hasExplicitSince
        ? [...arrival.arrivedAfterCall, ...arrival.withinGrace]
        : arrival.arrivedAfterCall;

      if (arrival.stale.length > 0) sawStaleMatch = true;
      if (!hasExplicitSince && arrival.withinGrace.length > 0) sawPreCallMatch = true;

      if (fresh.length > 0) {
        const ids = fresh.slice(0, MAX_BODIES_PER_PASS).map((email: any) => email.id);
        let details: any[] = [];
        try {
          details = await provider.getEmails(mailboxUserId, accountId, ids);
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

          // A sign-in link is only trustworthy if it goes where the mail came
          // from: anyone can send a message matching the filters, and a link
          // carrying "token=" is not evidence it belongs to the sender
          // (Greptile P1, security). The caller can name the host explicitly for
          // senders that mail from a different domain than they link to.
          let magicLink: string | null = null;
          let linkOmitted: string | undefined;
          if (returnLink) {
            if (!linkHost) {
              // The expected host must come from the CALLER, never from the
              // message: an attacker who gets one email past the filters would
              // otherwise define its own trusted origin and have the agent
              // navigate there (Greptile P1, security).
              linkOmitted =
                'No link was returned because link_host was not supplied. The expected domain must come from you, ' +
                'not from the email — otherwise a spoofed sender chooses where you get sent. ' +
                'Call again with link_host set to the domain the sign-in link should be on.';
            } else {
              magicLink = extractMagicLink(detail.body, { allowedHost: linkHost });
              if (!magicLink) {
                linkOmitted =
                  `No sign-in link on ${linkHost} was found in the email — any link pointing elsewhere was ignored, ` +
                  'not returned.';
              }
            }
          }

          if (!code && !magicLink) continue;

          // A code is the most sensitive thing this tool can hand back, so the
          // share is checked once more before it leaves — not only before the
          // read that found it. A revocation landing mid-round discloses
          // nothing. The read itself already happened; see stillAccessible.
          if (!(await stillAccessible())) {
            return {
              success: false,
              reason: 'mailbox_error',
              message:
                `Access to mailbox "${accountId}" ended while the code was being read — its owner stopped sharing ` +
                `it with your organization. The code was not returned. ${NO_FABRICATION_NOTE}`,
            };
          }

          return {
            success: true,
            code: code ?? undefined,
            magic_link: magicLink ?? undefined,
            link_omitted: linkOmitted,
            subject: detail.subject ?? summary?.subject,
            from: detail.from ?? summary?.from,
            received_at: detail.receivedAt ?? summary?.receivedAt ?? detail.date ?? summary?.date,
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

    if (sawPreCallMatch) {
      return {
        success: false,
        reason: 'code_predates_call',
        message:
          'The only matching email arrived BEFORE this check, so it cannot be told apart from a previous ' +
          'attempt\'s code — it was not returned. Re-trigger the "send code" step in the browser and call this ' +
          'tool again; if you know the email is from the attempt you just made, call it again with ' +
          `since set to the moment you triggered the send. ${NO_FABRICATION_NOTE}`,
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
