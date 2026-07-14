/**
 * Read, normalize, validate and persist CRM outbound senders.
 *
 * Every reader of the `crm_sender_emails_${userId}` setting must go through
 * loadSenderConfig() so legacy records are normalized in exactly one place.
 * There is deliberately no backfill script: old and new shapes coexist, old
 * records upgrade the next time they are saved, and a rollback needs no data
 * migration.
 */

import { settingsService } from './settingsService';
import {
  CrmSender,
  CrmSenderConfig,
  MAILBOX_PROVIDERS,
  PROVIDER_TO_PLATFORM,
  SenderProvider,
  isMailboxSender,
} from './crmSenderTypes';

const ALL_PROVIDERS: SenderProvider[] = ['resend', 'gmail', 'outlook'];

export const senderSettingName = (userId: string) => `crm_sender_emails_${userId}`;

/**
 * Thrown when a mailbox-backed sender reaches a send path that cannot honour it.
 *
 * The campaign, sequence and drip paths still send unconditionally through
 * Resend (ENG-266 Part 3). Until they route by provider, a mailbox sender
 * reaching them would silently send from the wrong system — so we refuse
 * loudly instead.
 */
export class MailboxSenderNotSupportedError extends Error {
  public readonly provider: SenderProvider;
  public readonly senderId: string;

  constructor(sender: Pick<CrmSender, 'senderProvider' | 'id'>) {
    super(
      `This sender uses a connected ${sender.senderProvider} mailbox, which cannot be used for ` +
        `campaigns or sequences yet. Pick a custom-domain sender, or send from Emma chat.`,
    );
    this.name = 'MailboxSenderNotSupportedError';
    this.provider = sender.senderProvider;
    this.senderId = sender.id;
  }
}

/** Normalize one persisted sender record (legacy or current) into a CrmSender. */
export function normalizeSender(raw: any): CrmSender {
  const persisted = raw?.senderType;
  const senderProvider: SenderProvider = ALL_PROVIDERS.includes(persisted) ? persisted : 'resend';

  return {
    id: raw?.id,
    email: raw?.email,
    fromName: raw?.fromName,
    notes: raw?.notes,
    senderProvider,
    // `gmailAccountId` is the pre-Outlook key. Prefer the neutral one when both exist.
    connectedAccountId: raw?.connectedAccountId ?? raw?.gmailAccountId,
  };
}

export function normalizeSenderConfig(raw: any): CrmSenderConfig {
  const senders = Array.isArray(raw?.senders) ? raw.senders.map(normalizeSender) : [];
  return {
    senders,
    defaultSenderId: raw?.defaultSenderId ?? null,
    defaultLinkedInAccountId: raw?.defaultLinkedInAccountId ?? null,
  };
}

/**
 * Convert a CrmSender back to its persisted shape.
 *
 * A resend sender omits `senderType` entirely, preserving the legacy
 * "absence means Resend" discriminant so older code can still read it.
 * A gmail sender also dual-writes `gmailAccountId`, so a rollback to the
 * pre-Outlook code still resolves the account.
 */
export function serializeSender(sender: CrmSender): any {
  const base: any = {
    id: sender.id,
    email: sender.email,
    fromName: sender.fromName,
    notes: sender.notes,
  };

  if (!isMailboxSender(sender)) {
    return base;
  }

  base.senderType = sender.senderProvider;
  base.connectedAccountId = sender.connectedAccountId;
  if (sender.senderProvider === 'gmail') {
    base.gmailAccountId = sender.connectedAccountId;
  }
  return base;
}

export interface SenderValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate one sender against the user's connected accounts.
 *
 * The From-identity check matters more than it looks: IEmailService has no
 * `from` field, and gmailService builds its MIME headers without a `From:` line
 * — the provider stamps the authenticated mailbox. So a mismatched sender email
 * is silently ignored on the wire. Rejecting at save time is the only place we
 * can tell the user the truth.
 */
export function validateSender(raw: any, connectedAccounts: any[]): SenderValidationResult {
  const provider = raw?.senderType;

  if (provider !== undefined && !ALL_PROVIDERS.includes(provider)) {
    return { ok: false, error: `Invalid senderType: ${provider}` };
  }

  if (provider === undefined || provider === 'resend') {
    return { ok: true };
  }

  const connectedAccountId = raw?.connectedAccountId ?? raw?.gmailAccountId;
  if (!connectedAccountId) {
    return { ok: false, error: `${provider} senders must include a connectedAccountId` };
  }

  const platform = PROVIDER_TO_PLATFORM[provider];
  const account = (connectedAccounts || []).find(
    (a: any) => a?.account_id === connectedAccountId && a?.platform === platform,
  );
  if (!account) {
    return { ok: false, error: `Connected ${provider} account "${connectedAccountId}" not found` };
  }

  const mailbox = (account?.config?.email || account?.account_id || '').toLowerCase();
  const claimed = String(raw?.email || '').toLowerCase();
  if (mailbox && claimed !== mailbox) {
    return {
      ok: false,
      error:
        `A ${provider} sender's email must match the connected mailbox (${mailbox}). ` +
        `${provider} sends as the authenticated account, so "${raw?.email}" would be ignored.`,
    };
  }

  return { ok: true };
}

/**
 * Guard for the bulk send paths (campaign / sequence / drip).
 *
 * Remove this once those paths route by provider (ENG-266 Part 3).
 */
export function assertSenderUsableForBulkSend(sender: CrmSender): void {
  if (isMailboxSender(sender)) {
    throw new MailboxSenderNotSupportedError(sender);
  }
}

/**
 * Guard for bulk send routes that only receive a bare `senderEmail`.
 *
 * The campaign composer discards the sender's provider before posting, so these
 * routes cannot tell a Resend sender from a connected mailbox. Resolve the email
 * back to the configured sender and report whether the send must be refused.
 *
 * Returns an error message to surface to the user, or null if the send may proceed.
 * Remove once these routes take a senderId and route by provider (ENG-266 Part 3).
 */
export async function bulkSendGuardMessage(
  userId: string,
  senderEmail: string,
): Promise<string | null> {
  const needle = String(senderEmail || '').toLowerCase();
  const config = await loadSenderConfig(userId);

  const matches = config.senders.filter((s) => s.email?.toLowerCase() === needle);

  if (matches.length === 0) {
    // Not a configured sender (e.g. an ad-hoc custom-domain address) — leave the
    // existing behaviour untouched.
    return null;
  }

  // A single address can legitimately have BOTH a mailbox sender and a custom-domain
  // sender configured on it (e.g. a Google Workspace address whose domain is also
  // verified in Resend). The composer only posts the address, so we cannot tell which
  // one the user picked — and refusing would break a configuration that works today.
  // Give them the benefit of the doubt: only refuse when EVERY sender on this address
  // is mailbox-backed, i.e. when there is no way this send could have gone via Resend.
  if (matches.some((s) => !isMailboxSender(s))) {
    return null;
  }

  return new MailboxSenderNotSupportedError(matches[0]).message;
}

/** The one loader. Every reader of the sender blob goes through this. */
export async function loadSenderConfig(userId: string): Promise<CrmSenderConfig> {
  const setting = await settingsService.getSetting(senderSettingName(userId));
  if (!setting?.settingValue) {
    return { senders: [], defaultSenderId: null, defaultLinkedInAccountId: null };
  }
  try {
    return normalizeSenderConfig(JSON.parse(setting.settingValue));
  } catch (error) {
    console.error('Error parsing CRM sender emails:', error);
    return { senders: [], defaultSenderId: null, defaultLinkedInAccountId: null };
  }
}

export { MAILBOX_PROVIDERS, isMailboxSender };
export type { CrmSender, CrmSenderConfig, SenderProvider };
