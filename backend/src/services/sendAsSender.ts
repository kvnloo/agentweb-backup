/**
 * Send through a CRM sender's real provider — Resend, Gmail, or Outlook.
 *
 * Bridges two incompatible send interfaces (ENG-266 Part 3): Resend's params
 * (explicit `from`, `html` + `text`, `inReplyTo` = an RFC Message-ID, returns
 * `null` on failure) and IEmailService's SendEmailParams (no `from` — the
 * provider stamps the authenticated mailbox — single `body` + `isHtml`,
 * `replyToMessageId` = a provider-native handle, throws on failure).
 *
 * Callers get one params shape in, one result shape out, and don't need to
 * know which provider a sender resolves to.
 */

import { resendService } from './resendService';
import { getEmailProvider, bootstrapEmailProviders, type SentEmailResult } from './emailProviderService';
import { CrmSender, SenderProvider, PROVIDER_TO_PLATFORM } from './crmSenderTypes';

export interface SendAsSenderParams {
  to: string | string[];
  subject: string;
  /** At least one of html/text is required. */
  html?: string;
  /** Only used for the resend branch — dropped for mailbox providers (no multipart support). */
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  /** Best-effort passthrough. Only meaningful if it happens to be a native id for the resolved provider. */
  replyToMessageId?: string;
}

export interface SendAsSenderResult {
  provider: SenderProvider;
  messageId: string;
  threadId?: string;
}

export class SenderSendError extends Error {
  public readonly provider: SenderProvider;
  public readonly senderId: string;

  constructor(sender: Pick<CrmSender, 'senderProvider' | 'id'>, cause?: string) {
    super(cause ?? `Failed to send through the ${sender.senderProvider} sender.`);
    this.name = 'SenderSendError';
    this.provider = sender.senderProvider;
    this.senderId = sender.id;
  }
}

// resendService throttles itself via its own send queue. Mailbox providers
// (Gmail/Graph) have no equivalent, and bypass that queue entirely — so a
// bulk send through a mailbox sender needs its own floor between requests to
// avoid tripping per-mailbox rate limits.
const MAILBOX_SEND_INTERVAL_MS = 300;
let lastMailboxSendAt = 0;

async function waitForMailboxSendWindow(): Promise<void> {
  const elapsed = Date.now() - lastMailboxSendAt;
  if (elapsed < MAILBOX_SEND_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MAILBOX_SEND_INTERVAL_MS - elapsed));
  }
  lastMailboxSendAt = Date.now();
}

export async function sendAsSender(
  userId: string,
  sender: CrmSender,
  params: SendAsSenderParams,
): Promise<SendAsSenderResult> {
  if (sender.senderProvider === 'resend') {
    // resendService has never supported bcc (checked as of this branch: neither the
    // service nor any pre-existing caller ever wired it up) — fail loud instead of
    // silently dropping recipients a caller believed were bcc'd.
    if (params.bcc) {
      throw new SenderSendError(sender, 'This Resend sender does not support bcc.');
    }
    const from = sender.fromName ? `${sender.fromName} <${sender.email}>` : sender.email;
    const result = await resendService.sendEmail({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      cc: params.cc,
      inReplyTo: params.replyToMessageId,
    });
    if (!result || !result.id) {
      throw new SenderSendError(sender, 'Resend did not return a message id — the send may have failed.');
    }
    return { provider: 'resend', messageId: result.id };
  }

  const platform = PROVIDER_TO_PLATFORM[sender.senderProvider];
  if (!platform) {
    throw new SenderSendError(sender, `Unsupported sender provider: ${sender.senderProvider}`);
  }
  if (!sender.connectedAccountId) {
    throw new SenderSendError(sender, `${sender.senderProvider} sender is missing its connected account id.`);
  }

  await bootstrapEmailProviders();
  await waitForMailboxSendWindow();

  const provider = getEmailProvider(platform);
  const result: SentEmailResult = await provider.sendEmail(userId, sender.connectedAccountId, {
    to: params.to,
    subject: params.subject,
    body: params.html ?? params.text ?? '',
    isHtml: params.html != null,
    cc: params.cc,
    bcc: params.bcc,
    replyToMessageId: params.replyToMessageId,
  });

  return { provider: sender.senderProvider, messageId: result.messageId, threadId: result.threadId };
}
