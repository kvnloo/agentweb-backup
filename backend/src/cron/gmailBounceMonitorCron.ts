/**
 * Gmail Bounce Monitor (ENG-2981) — parity with the Resend webhook
 * (routes/webhooks.ts email.bounced) and the Outlook NDR monitor
 * (cron/outlookBounceMonitorCron.ts).
 *
 * Gmail-connected senders previously got no bounce suppression: permanent
 * delivery failures sat in the mailbox and the same dead addresses were re-sent
 * across campaigns (Nu|Erraa incident, 181 DSNs / 90 addresses). This polls
 * each connected Gmail mailbox (gmail.readonly) for DSNs from
 * mailer-daemon/postmaster, treats only permanent 5.x failures as hard bounces,
 * auto-DNCs matching leads across all of the owner's lists, and records an
 * `email.bounced` event so Gmail-sender bounce metrics populate.
 *
 * Registered in server.ts to run every 15 minutes.
 */

import { userDb, crmDb } from '../services/db';
import { ConnectedAccount, GmailConfig, updateAccountConfig } from '../services/connectedAccountsDb';
import { gmailService } from '../services/gmailService';
import { emailEventsDb } from '../services/emailEventsDb';
import { isDoNotContact } from '../utils/leadContactStatus';

const TAG = '[gmailBounceMonitorCron]';
const DSN_QUERY = 'from:(mailer-daemon OR postmaster)';
const MAX_MESSAGES_PER_RUN = 100;

export interface GmailBounceMonitorSummary {
  scannedUsers: number;
  gmailAccounts: number;
  messagesScanned: number;
  hardBouncesFound: number;
  leadsFlagged: number;
  eventsRecorded: number;
  failed: number;
}

export interface HardBounce {
  recipient: string;
  status: string;
}

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

function headerValue(raw: string, name: string): string {
  // Top-level headers end at the first blank line; unfold continuation lines.
  const head = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  const m = head.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Pure — parses a raw DSN and returns the permanently failed recipients.
 * Per-recipient blocks (Final-Recipient + Action + Status) are authoritative:
 * only `Action: failed` with a 5.x.x status counts. Delay DSNs
 * (`Action: delayed` / 4.x.x) never count. X-Failed-Recipients is used only
 * when no per-recipient block exists and nothing in the message signals a
 * transient failure. The sender's own address is always excluded.
 */
export function parseHardBounces(raw: string, senderEmail: string): HardBounce[] {
  if (!raw) return [];
  const from = headerValue(raw, 'From');
  if (!/mailer-daemon|postmaster/i.test(from)) return [];

  const sender = (senderEmail || '').toLowerCase();
  const found = new Map<string, HardBounce>();
  const add = (addr: string, status: string) => {
    const a = addr.toLowerCase();
    if (a && a !== sender && !found.has(a)) found.set(a, { recipient: a, status });
  };

  const blocks = raw.split(/^(?=Final-Recipient:)/im).slice(1);
  for (const rawBlock of blocks) {
    // RFC 3464 §2.1.1: fields may fold onto continuation lines.
    const block = rawBlock.replace(/\r?\n[ \t]+/g, ' ');
    const recipientLine = block.match(/^Final-Recipient:[ \t]*(?:rfc822;)?[ \t]*<?([^\s>]+)>?/im);
    const action = (block.match(/^Action:[ \t]*(\S+)/im)?.[1] || '').toLowerCase();
    const status = block.match(/^Status:[ \t]*(\d\.\d{1,3}\.\d{1,3})/im)?.[1] || '';
    if (!recipientLine || !EMAIL.test(recipientLine[1])) continue;
    if (action === 'failed' && status.startsWith('5.')) add(recipientLine[1].match(EMAIL)![0], status);
  }
  if (blocks.length > 0) return [...found.values()];

  // Only the DSN's own explanation counts: cut the body before any quoted
  // original-message headers so e.g. `Subject: Order 550` cannot qualify.
  const body = raw.split(/\r?\n\r?\n/).slice(1).join('\n');
  const quoted = body.search(/^(?:Received|Subject|Message-ID|From|To|Date|Return-Path):/im);
  const explanation = quoted >= 0 ? body.slice(0, quoted) : body;
  const transient =
    /^Action:[ \t]*delayed/im.test(raw) ||
    /^Status:[ \t]*4\./im.test(raw) ||
    /\b4\.\d{1,3}\.\d{1,3}\b/.test(raw) ||
    /^[ \t]*4\d\d[ \t-]/m.test(explanation) ||
    /^Diagnostic-Code:[^\n]*\b4\d\d\b/im.test(explanation);
  if (transient) return [];
  // X-Failed-Recipients alone does not prove permanence (delay notices carry it
  // too). Require a delivery-status value, not an arbitrary body number: a
  // `Status: 5.x.x` field, a Diagnostic-Code with a 5yz reply, or an SMTP reply
  // line that starts with 5yz, in the DSN explanation (not the quoted original).
  const permanent =
    /^Status:[ \t]*5\.\d{1,3}\.\d{1,3}/im.test(explanation) ||
    /^Diagnostic-Code:[^\n]*\b5\d\d\b/im.test(explanation) ||
    /^[ \t]*5\d\d[ \t-]/m.test(explanation);
  if (!permanent) return [];
  const failedHeader = headerValue(raw, 'X-Failed-Recipients');
  for (const part of failedHeader.split(',')) {
    const m = part.match(EMAIL);
    if (m) add(m[0], '5.0.0');
  }
  return [...found.values()];
}

/**
 * Pure — Message-ID of the original outbound message embedded in a DSN
 * (text/rfc822-headers or message/rfc822 part), i.e. a Message-ID header that
 * is not the DSN's own top-level one.
 */
export function originalMessageId(raw: string): string | null {
  if (!raw) return null;
  const parts = raw.split(/\r?\n\r?\n/);
  const body = parts.slice(1).join('\n\n').replace(/\r?\n[ \t]+/g, ' ');
  const m = body.match(/^Message-ID:[ \t]*(<[^>\s]+>)/im);
  return m ? m[1] : null;
}

/**
 * Forged-DSN guard (RFC 3464 §6.2): a mailer-daemon/postmaster From header is
 * not proof of a failed delivery. Only suppress when the DSN correlates to an
 * outbound message actually in this mailbox's Sent folder: by the embedded
 * original Message-ID when present, otherwise by a sent message to the
 * recipient.
 */
async function hasOutboundCorrelation(
  userId: string,
  accountId: string,
  raw: string,
  recipient: string,
): Promise<boolean> {
  const msgId = originalMessageId(raw);
  // Gmail's rfc822msgid: operator takes the bare id, without angle brackets.
  const bareId = msgId ? msgId.replace(/^<|>$/g, '') : null;
  const query = bareId ? `in:sent rfc822msgid:${bareId} to:${recipient}` : `in:sent to:${recipient}`;
  return gmailService.hasMessages(userId, accountId, query);
}

async function flagLeadIfMatched(userId: string, candidateEmail: string, status: string): Promise<number> {
  const lists = await crmDb.getLeadListsByUserId(userId);
  let flagged = 0;
  for (const list of lists || []) {
    const lead = await crmDb.getLeadByEmail(list.listId, candidateEmail);
    if (lead && !isDoNotContact(lead)) {
      const now = new Date().toISOString();
      await crmDb.updateLead(list.listId, lead.leadId, {
        contactStatus: 'do-not-contact',
        contactStatusReason: 'bounced',
        contactStatusNote: `Gmail permanent delivery failure (${status})`,
        contactStatusUpdatedAt: now,
        contactStatusUpdatedBy: 'system',
        unsubscribedFromGroupEmail: true,
        unsubscribedFromGroupEmailAt: now,
      });
      console.log(`${TAG} Flagged lead ${lead.leadId} in list ${list.listId} as do-not-contact (Gmail bounce)`);
      flagged++;
    }
  }
  return flagged;
}

async function recordBounceEvent(
  emailDomain: string,
  senderEmail: string,
  messageId: string,
  receivedAt: string,
  bounce: HardBounce,
): Promise<boolean> {
  const eventId = `gmail-bounce:${messageId}:${bounce.recipient}`;
  try {
    await emailEventsDb.addEmailEvent(
      {
        type: 'email.bounced',
        created_at: receivedAt,
        data: {
          created_at: receivedAt,
          email_id: `gmail-dsn:${messageId}`,
          from: senderEmail,
          to: [bounce.recipient],
          subject: '',
          bounce: { type: 'Permanent', reason: `DSN status ${bounce.status}`, timestamp: receivedAt },
          tags: { source: 'gmail' },
        },
      },
      emailDomain,
      eventId,
      bounce.recipient,
    );
    return true;
  } catch (error: any) {
    if (error?.isDuplicateEventId) return false;
    throw error;
  }
}

export async function runGmailBounceMonitor(): Promise<GmailBounceMonitorSummary> {
  const summary: GmailBounceMonitorSummary = {
    scannedUsers: 0,
    gmailAccounts: 0,
    messagesScanned: 0,
    hardBouncesFound: 0,
    leadsFlagged: 0,
    eventsRecorded: 0,
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
      ? raw.filter((acc: any) => acc && acc.platform === 'gmail' && acc.account_id && acc.config)
      : [];

    for (const account of accounts) {
      summary.gmailAccounts++;
      const config = account.config as GmailConfig;
      const senderEmail = (config?.email || account.account_id || '').toLowerCase();
      const storedCursor = config?.lastBounceCheckAt;
      // First run: seed the watermark to now rather than scanning history.
      if (!storedCursor) {
        try {
          await updateAccountConfig(user.userId, 'gmail', account.account_id, { lastBounceCheckAt: new Date().toISOString() });
        } catch (error) {
          summary.failed++;
          console.error(`${TAG} Failed to seed cursor for user ${user.userId} (gmail account):`, error);
        }
        continue;
      }

      // Only the tenant's own domain partitions email.bounced events. Never fall back to the
      // sender mail domain: a public domain (gmail.com) would be shared across tenants.
      // Without a tenant domain the DNC flag still applies; the event is skipped.
      const emailDomain = (user as any).emailDomain || '';
      try {
        const afterSec = Math.floor(new Date(storedCursor).getTime() / 1000);
        const messages = await gmailService.listRawMessages(
          user.userId,
          account.account_id,
          `${DSN_QUERY} after:${afterSec}`,
          MAX_MESSAGES_PER_RUN,
        );
        let newCursor = storedCursor;
        // Process oldest first so the watermark only ever covers handled mail.
        const ordered = [...messages].sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''));
        for (const message of ordered) {
          const receivedAt = message.receivedAt || new Date().toISOString();
          if (receivedAt <= storedCursor) continue; // after: is second-granular
          summary.messagesScanned++;
          if (receivedAt > newCursor) newCursor = receivedAt;

          for (const bounce of parseHardBounces(message.raw, senderEmail)) {
            if (!(await hasOutboundCorrelation(user.userId, account.account_id, message.raw, bounce.recipient))) {
              console.warn(`${TAG} Ignoring uncorrelated DSN ${message.id} (no matching sent message)`);
              continue;
            }
            summary.hardBouncesFound++;
            summary.leadsFlagged += await flagLeadIfMatched(user.userId, bounce.recipient, bounce.status);
            if (emailDomain && (await recordBounceEvent(emailDomain, senderEmail, message.id, receivedAt, bounce))) {
              summary.eventsRecorded++;
            }
          }
        }
        if (newCursor !== storedCursor) {
          await updateAccountConfig(user.userId, 'gmail', account.account_id, { lastBounceCheckAt: newCursor });
        }
      } catch (error) {
        summary.failed++;
        console.error(`${TAG} Failed to process gmail account for user ${user.userId}:`, error);
      }
    }
  }

  console.log(
    `${TAG} Run complete — users=${summary.scannedUsers} accounts=${summary.gmailAccounts} ` +
      `scanned=${summary.messagesScanned} hardBounces=${summary.hardBouncesFound} ` +
      `flagged=${summary.leadsFlagged} events=${summary.eventsRecorded} failed=${summary.failed}`,
  );
  return summary;
}
