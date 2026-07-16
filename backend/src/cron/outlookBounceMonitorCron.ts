/**
 * Outlook Bounce/Complaint Monitor (ENG-266 Part 3, option B+)
 *
 * Resend's webhook handler auto-flags bounced/complained leads as do-not-contact
 * — that is a compliance control, not analytics, and it structurally cannot fire
 * for a mailbox send: Graph produces no Resend webhooks. Sending from a real
 * customer domain without rebuilding that suppression would be self-defeating
 * (see tasks/eng-266-handoff.md §5) — we'd protect a domain's reputation by
 * removing the exact mechanism that protects it.
 *
 * This polls each connected Outlook mailbox's Inbox via Mail.Read for
 * delivery-failure notifications (NDRs), and applies the same auto-DNC that
 * routes/webhooks.ts's email.bounced handler applies for Resend.
 *
 * Registered in server.ts to run every 15 minutes.
 */

import { userDb, crmDb } from '../services/db';
import { ConnectedAccount, OutlookConfig, updateAccountConfig } from '../services/connectedAccountsDb';
import { outlookService } from '../services/outlookService';
import { isDoNotContact } from '../utils/leadContactStatus';

const TAG = '[outlookBounceMonitorCron]';

export interface OutlookBounceMonitorSummary {
  scannedUsers: number;
  outlookAccounts: number;
  messagesScanned: number;
  ndrCandidatesFound: number;
  leadsFlagged: number;
  failed: number;
}

interface InboxMessage {
  id: string;
  subject: string;
  receivedDateTime: string;
  from: string;
  body: string;
}

// Heuristic, not a hard classifier — Graph's Mail.Read has no structured bounce
// field via a plain $filter. False negatives just mean "wait for the next run";
// false positives are bounded by only acting when the extracted address matches
// a real lead (see runOutlookBounceMonitor).
const NDR_SUBJECT_PATTERN = /^(undeliverable|delivery status notification|mail delivery failed|returned mail|non-delivery report)/i;
const NDR_SENDER_PATTERN = /mailer-daemon|postmaster|delivery.*subsystem/i;
// "Delivery has failed to these recipients or groups:" is Microsoft's own
// documented Exchange Online/M365 NDR body phrasing (learn.microsoft.com,
// "How to interpret an Exchange NDR") — the address sits on its OWN LINE
// after the phrase, not on the same line, hence `[\s\S]` (matches newlines)
// instead of `[^\n]`. The other phrases are kept as a fallback for other
// mail systems / older NDR formats.
const RECIPIENT_PHRASE_PATTERN =
  /(?:delivery has failed to these recipients or groups|the following recipient|recipient|rcpt to|mailbox unavailable|user unknown)[\s\S]{0,80}?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
const ANY_EMAIL_PATTERN = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

/** Pure — no I/O, so it's unit-testable without mocking Graph or the DB. */
export function extractBounceCandidate(message: { subject: string; from: string; body: string }): string | null {
  const subject = message.subject || '';
  const from = message.from || '';
  const body = message.body || '';

  if (!NDR_SUBJECT_PATTERN.test(subject.trim()) && !NDR_SENDER_PATTERN.test(from)) {
    return null;
  }

  const phraseMatch = body.match(RECIPIENT_PHRASE_PATTERN);
  if (phraseMatch) return phraseMatch[1].toLowerCase();

  const anyMatch = body.match(ANY_EMAIL_PATTERN);
  return anyMatch ? anyMatch[1].toLowerCase() : null;
}

/**
 * Flags every list the candidate address appears in as a lead, not just the
 * first — mirrors webhooks.ts's Resend-side email.bounced handler, which does
 * the same full sweep. The same real person can be a lead in more than one
 * list (imports, org-shared lists); stopping at the first match would leave
 * them contactable through every other list, defeating the point of the
 * suppression. Returns the number of leads flagged.
 */
async function flagLeadIfMatched(userId: string, candidateEmail: string, subject: string): Promise<number> {
  const lists = await crmDb.getLeadListsByUserId(userId);
  let flagged = 0;
  for (const list of lists || []) {
    const lead = await crmDb.getLeadByEmail(list.listId, candidateEmail);
    if (lead && !isDoNotContact(lead)) {
      await crmDb.updateLead(list.listId, lead.leadId, {
        contactStatus: 'do-not-contact',
        contactStatusReason: 'bounced',
        contactStatusNote: `Outlook delivery failure: ${subject}`,
        contactStatusUpdatedAt: new Date().toISOString(),
        contactStatusUpdatedBy: 'system',
        unsubscribedFromGroupEmail: true,
        unsubscribedFromGroupEmailAt: new Date().toISOString(),
      });
      console.log(`${TAG} Flagged lead ${lead.leadId} in list ${list.listId} as do-not-contact (Outlook bounce)`);
      flagged++;
    }
  }
  return flagged;
}

/**
 * Scan every connected Outlook mailbox for NDRs since its last watermark and
 * auto-DNC any matching lead. Resilient: a failure on one account never aborts
 * the run for the rest.
 */
export async function runOutlookBounceMonitor(): Promise<OutlookBounceMonitorSummary> {
  const summary: OutlookBounceMonitorSummary = {
    scannedUsers: 0,
    outlookAccounts: 0,
    messagesScanned: 0,
    ndrCandidatesFound: 0,
    leadsFlagged: 0,
    failed: 0,
  };

  let users: any[];
  try {
    users = await userDb.getAllUsers();
  } catch (error) {
    console.error(`${TAG} Failed to enumerate users:`, error);
    return summary;
  }

  for (const user of users) {
    summary.scannedUsers++;
    const raw = (user as any).connected_accounts;
    const accounts: ConnectedAccount[] = Array.isArray(raw)
      ? raw.filter((acc: any) => acc && acc.platform === 'outlook' && acc.account_id && acc.config)
      : [];

    for (const account of accounts) {
      summary.outlookAccounts++;
      const storedCursor = (account.config as OutlookConfig)?.lastNdrCheckAt;
      // First-ever run for this account: seed the cursor to "now" instead of
      // scanning history — avoids a false-positive storm over years of old mail.
      const isFirstRun = !storedCursor;
      const sinceISO = storedCursor || new Date().toISOString();

      try {
        const messages: InboxMessage[] = await outlookService.listRecentInboxMessages(
          user.userId,
          account.account_id,
          sinceISO,
        );
        summary.messagesScanned += messages.length;

        let newCursor = sinceISO;
        for (const message of messages) {
          if (message.receivedDateTime > newCursor) {
            newCursor = message.receivedDateTime;
          }

          if (isFirstRun) continue;

          const candidateEmail = extractBounceCandidate(message);
          if (!candidateEmail) continue;
          summary.ndrCandidatesFound++;

          summary.leadsFlagged += await flagLeadIfMatched(user.userId, candidateEmail, message.subject);
        }

        if (isFirstRun || newCursor !== sinceISO) {
          await updateAccountConfig(user.userId, 'outlook', account.account_id, { lastNdrCheckAt: newCursor });
        }
      } catch (error) {
        summary.failed++;
        console.error(`${TAG} Failed to process account ${account.account_id} for user ${user.userId}:`, error);
      }
    }
  }

  console.log(
    `${TAG} Run complete — users=${summary.scannedUsers} accounts=${summary.outlookAccounts} ` +
      `scanned=${summary.messagesScanned} candidates=${summary.ndrCandidatesFound} ` +
      `flagged=${summary.leadsFlagged} failed=${summary.failed}`,
  );
  return summary;
}
